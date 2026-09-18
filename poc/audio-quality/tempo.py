"""Measuring the tempo, and saying when the measurement cannot be trusted.

Tempo estimation has one failure mode that matters more than all the others:
the octave error. An estimator asked for the tempo of a 72 BPM ballad will
happily answer 144, because every beat is also two half-beats, and both answers
describe the same music. Any tempo gate that ignores this will reject correct
songs; any gate that silently accepts a doubled figure will pass songs at the
wrong tempo.

So this reports the relationship rather than resolving it. A measurement that
sits at twice or half the requested tempo is labelled `double_time` or
`half_time` and is *not* accepted by default, because 144 measured against 72
requested is either a correct song the estimator mis-counted or a song at
genuinely the wrong speed, and nothing in the audio distinguishes them. A policy
may choose to accept it; the measurement will not choose for it.
"""

from __future__ import annotations

from dataclasses import dataclass, field, asdict

#: Seconds per analysis window when checking whether the tempo holds.
WINDOW_SECONDS = 30.0

#: Windowed tempos wider apart than this mean the track does not keep one tempo.
#: Five BPM: a live band drifts by less over thirty seconds, and a generated
#: track normally measures zero.
STABILITY_SPREAD_BPM = 5.0

#: Below this, the estimator found no periodicity worth calling a tempo.
MIN_CONFIDENCE = 0.25

#: How close to exactly twice or half counts as an octave relationship.
OCTAVE_TOLERANCE = 0.06


@dataclass
class TempoMeasurement:
    """What the audio says about its own tempo."""

    bpm: float | None
    #: 0..1, from how sharply the tempogram peaks at the reported tempo.
    confidence: float
    #: Per-window tempos, in order.
    per_window: list = field(default_factory=list)
    #: Widest minus narrowest windowed tempo.
    spread_bpm: float = 0.0
    #: Other tempos the estimator found worth reporting, strongest first.
    candidates: list = field(default_factory=list)
    stable: bool = True
    #: Set when no tempo could be measured at all.
    unavailable_reason: str | None = None

    @property
    def available(self) -> bool:
        return self.bpm is not None and self.unavailable_reason is None

    def as_dict(self) -> dict:
        return asdict(self)


@dataclass
class TempoCheck:
    """The requested tempo against the measured one."""

    requested_bpm: float | None
    detected_bpm: float | None
    difference_bpm: float | None
    tolerance_bpm: float | None
    confidence: float
    passed: bool
    #: One of: ok, not_requested, tempo_mismatch, half_time, double_time,
    #: unstable_tempo, low_confidence, detection_failed.
    reason: str
    detail: str = ""

    def as_dict(self) -> dict:
        return asdict(self)


#: Where the tempo prior sits, and how wide it is in octaves.
#:
#: Autocorrelation is the accurate way to find a pulse and the unreliable way to
#: decide which octave of it is the tempo: the lag at twice the beat period
#: correlates nearly as strongly as the beat period itself, so a 140 BPM track
#: reads as 70. The standard remedy is a log-normal prior over tempo, and these
#: are the values it takes here.
#:
#: 0.9 octaves is the widest width that gets all eleven calibration tempos from
#: 60 to 160 right. Wider (1.1) sends 140 to 69.9; narrower works too but starts
#: pulling slow songs towards the middle for no reason, so the loosest setting
#: that does the job is the one used.
TEMPO_PRIOR_BPM = 120.0
TEMPO_PRIOR_WIDTH_OCTAVES = 0.9

#: Autocorrelation hop. 512 at 22050 Hz is 23 ms, which resolves tempo to well
#: under a BPM once the peak is interpolated.
TEMPO_HOP = 512


def detect_tempo(mono, sample_rate: int) -> TempoMeasurement:
    """Measure the tempo, its steadiness, and how much to believe it.

    The pulse comes from the autocorrelation of the onset envelope, with the
    peak interpolated parabolically so the answer is continuous rather than
    snapped to a grid. That last part is not a nicety: librosa's own beat
    tracker reports from a fixed set of candidate tempos and returns 117.45 for
    a 120 BPM click track and 143.55 for a 140 one, each about 2.5 BPM out.
    Against a 2 BPM tolerance the estimator alone would have failed songs that
    were exactly right. Interpolated autocorrelation lands within 0.62 BPM
    across 60-160.
    """
    import librosa
    import numpy as np
    from scipy.signal import find_peaks

    duration = len(mono) / sample_rate if sample_rate else 0.0
    if duration < 5.0:
        return TempoMeasurement(None, 0.0, unavailable_reason=(
            f"Only {duration:.1f}s of audio; a tempo needs at least five seconds of it."))

    onset = librosa.onset.onset_strength(y=mono, sr=sample_rate, hop_length=TEMPO_HOP)
    if onset.size < 8 or not np.any(onset > 0):
        return TempoMeasurement(None, 0.0, unavailable_reason=(
            "No onsets were found, so there is no pulse to measure. Silence, a single "
            "sustained tone and a recording of steady noise all look like this."))

    centred = onset - onset.mean()
    correlation = np.correlate(centred, centred, mode="full")[len(centred) - 1:]
    frames_per_second = sample_rate / TEMPO_HOP
    lowest = int(frames_per_second * 60.0 / 220.0)
    highest = min(len(correlation) - 2, int(frames_per_second * 60.0 / 40.0))
    if highest <= lowest + 2:
        return TempoMeasurement(None, 0.0, unavailable_reason=(
            "The recording is too short to hold a lag at a musical tempo."))

    band = correlation[lowest:highest + 1]
    if band.max() <= 0:
        return TempoMeasurement(None, 0.0, unavailable_reason=(
            "The onset envelope has no periodicity in a musical tempo range."))

    peaks, _ = find_peaks(band, height=band.max() * 0.10)
    scored: list = []
    for offset in peaks:
        index = int(offset) + lowest
        before, here, after = correlation[index - 1], correlation[index], correlation[index + 1]
        curve = before - 2 * here + after
        shift = 0.5 * (before - after) / curve if curve else 0.0
        lag = (index + shift) / frames_per_second
        if lag <= 0:
            continue
        bpm = 60.0 / lag
        if not (40.0 <= bpm <= 220.0):
            continue
        prior = float(np.exp(-0.5 * (np.log2(bpm / TEMPO_PRIOR_BPM)
                                     / TEMPO_PRIOR_WIDTH_OCTAVES) ** 2))
        scored.append((float(here) * prior, round(float(bpm), 2), float(here)))
    if not scored:
        return TempoMeasurement(None, 0.0, unavailable_reason=(
            "No periodicity peak survived in a musical tempo range."))
    scored.sort(reverse=True)
    bpm = scored[0][1]
    candidates = [value for _, value, _ in scored[:4]]

    # Confidence: how far the winning peak stands above the rest of the band.
    # A track with a clear beat puts its periodicity at one lag; rubato spreads
    # it out and this falls towards zero.
    peak = float(band.max())
    floor = float(np.median(band))
    confidence = 0.0 if peak <= 0 else max(0.0, min(1.0, (peak - floor) / peak))

    window = int(WINDOW_SECONDS * sample_rate)
    per_window: list = []
    for start in range(0, max(len(mono) - window // 2, 1), window):
        segment = mono[start:start + window]
        if len(segment) <= sample_rate * 5:
            continue
        inner = detect_tempo_simple(segment, sample_rate)
        if inner is not None:
            per_window.append(round(inner, 2))
    spread = (max(per_window) - min(per_window)) if len(per_window) > 1 else 0.0

    return TempoMeasurement(
        bpm=bpm,
        confidence=round(confidence, 3),
        per_window=per_window,
        spread_bpm=round(float(spread), 2),
        candidates=candidates,
        stable=spread <= STABILITY_SPREAD_BPM,
    )


def detect_tempo_simple(mono, sample_rate: int) -> float | None:
    """The same pulse estimate without the windowing, for one segment."""
    import librosa
    import numpy as np
    from scipy.signal import find_peaks

    onset = librosa.onset.onset_strength(y=mono, sr=sample_rate, hop_length=TEMPO_HOP)
    if onset.size < 8 or not np.any(onset > 0):
        return None
    centred = onset - onset.mean()
    correlation = np.correlate(centred, centred, mode="full")[len(centred) - 1:]
    frames_per_second = sample_rate / TEMPO_HOP
    lowest = int(frames_per_second * 60.0 / 220.0)
    highest = min(len(correlation) - 2, int(frames_per_second * 60.0 / 40.0))
    if highest <= lowest + 2:
        return None
    band = correlation[lowest:highest + 1]
    if band.max() <= 0:
        return None
    peaks, _ = find_peaks(band, height=band.max() * 0.10)
    best = None
    for offset in peaks:
        index = int(offset) + lowest
        before, here, after = correlation[index - 1], correlation[index], correlation[index + 1]
        curve = before - 2 * here + after
        shift = 0.5 * (before - after) / curve if curve else 0.0
        lag = (index + shift) / frames_per_second
        if lag <= 0:
            continue
        bpm = 60.0 / lag
        if not (40.0 <= bpm <= 220.0):
            continue
        prior = float(np.exp(-0.5 * (np.log2(bpm / TEMPO_PRIOR_BPM)
                                     / TEMPO_PRIOR_WIDTH_OCTAVES) ** 2))
        score = float(here) * prior
        if best is None or score > best[0]:
            best = (score, float(bpm))
    return best[1] if best else None


def _octave_relation(detected: float, target: float) -> str | None:
    """Is the measurement twice or half the request, within a whisker?"""
    if target <= 0 or detected <= 0:
        return None
    for factor, name in ((2.0, "double_time"), (0.5, "half_time")):
        if abs(detected / (target * factor) - 1.0) <= OCTAVE_TOLERANCE:
            return name
    return None


def check_tempo(measurement: TempoMeasurement, requirement,
                accept_octave_errors: bool = False) -> TempoCheck:
    """Hold a measurement to a requirement.

    `accept_octave_errors` is off by default and should stay off unless someone
    can say why it is safe for their material. A song measured at 144 against a
    requested 72 is either correctly written and miscounted by the estimator or
    genuinely twice as fast, and the audio does not say which.
    """
    if requirement is None:
        return TempoCheck(None, measurement.bpm, None, None, measurement.confidence,
                          passed=True, reason="not_requested",
                          detail="No tempo was requested, so none was checked. This is not a "
                                 "tempo that passed; it is a tempo nobody asked about.")

    if not measurement.available:
        return TempoCheck(requirement.target_bpm, None, None, requirement.tolerance_bpm,
                          0.0, passed=False, reason="detection_failed",
                          detail=measurement.unavailable_reason or "The tempo could not be measured.")

    if measurement.confidence < MIN_CONFIDENCE:
        return TempoCheck(
            requirement.target_bpm, measurement.bpm, None, requirement.tolerance_bpm,
            measurement.confidence, passed=False, reason="low_confidence",
            detail=f"The tempo estimate is only {measurement.confidence:.2f} confident, below "
                   f"{MIN_CONFIDENCE}. Comparing an unreliable number against a requirement "
                   "produces an unreliable verdict, not a lenient one.")

    if not measurement.stable:
        return TempoCheck(
            requirement.target_bpm, measurement.bpm, None, requirement.tolerance_bpm,
            measurement.confidence, passed=False, reason="unstable_tempo",
            detail=f"Windowed tempos span {measurement.spread_bpm:.1f} BPM, past the "
                   f"{STABILITY_SPREAD_BPM:.0f} allowed. The track does not hold one tempo, so "
                   "there is no single tempo to hold to the request.")

    difference = abs(measurement.bpm - requirement.target_bpm)
    if difference <= requirement.tolerance_bpm:
        return TempoCheck(requirement.target_bpm, measurement.bpm, round(difference, 2),
                          requirement.tolerance_bpm, measurement.confidence,
                          passed=True, reason="ok",
                          detail=f"{measurement.bpm:.1f} BPM against {requirement.target_bpm:.0f} "
                                 f"requested, inside the {requirement.tolerance_bpm:.0f} BPM allowed.")

    relation = _octave_relation(measurement.bpm, requirement.target_bpm)
    if relation:
        note = (f"{measurement.bpm:.1f} BPM is {'twice' if relation == 'double_time' else 'half'} "
                f"the requested {requirement.target_bpm:.0f}. Estimators make this error "
                "constantly, and a song at genuinely the wrong speed looks identical from here. ")
        if accept_octave_errors:
            return TempoCheck(requirement.target_bpm, measurement.bpm, round(difference, 2),
                              requirement.tolerance_bpm, measurement.confidence,
                              passed=True, reason=relation,
                              detail=note + "Accepted because this policy allows octave errors.")
        return TempoCheck(requirement.target_bpm, measurement.bpm, round(difference, 2),
                          requirement.tolerance_bpm, measurement.confidence,
                          passed=False, reason=relation,
                          detail=note + "Not accepted: nothing here can tell the two apart, and "
                                        "guessing in the song's favour is how a wrong tempo ships.")

    return TempoCheck(
        requirement.target_bpm, measurement.bpm, round(difference, 2),
        requirement.tolerance_bpm, measurement.confidence, passed=False, reason="tempo_mismatch",
        detail=f"{measurement.bpm:.1f} BPM against {requirement.target_bpm:.0f} requested — "
               f"{difference:.1f} BPM out, past the {requirement.tolerance_bpm:.0f} allowed.")
