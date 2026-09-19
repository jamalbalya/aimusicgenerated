"""Measuring the tempo a song actually came out at, and what that means.

Supplying `GenerationParams.bpm` tells ACE-Step what was wanted. It does not
make the audio come out at that tempo — it is a conditioning input, not a clock.
A real generation asked for 72 BPM and measured 99.4, and the consequences went
far past "the song is a bit fast":

The target melody is laid out on the *requested* tempo's timeline. At 72 BPM a
four-and-a-half minute song is about 80 bars; the delivered song had 110. A
planned note at t seconds belongs at t x 72/99.4 in the audio, so the plan and
the performance drift apart by 38% of elapsed time — 12 seconds by plan-time 44,
74 seconds by the end. Alignment searched a *constant* offset of at most 12
seconds, and a constant offset cannot absorb a rate mismatch. Past roughly 32
seconds of song, every planned note would match the wrong sung note, and
correction would then move the vocal toward pitches belonging to a different
part of the song.

So tempo is not a quality metric here. It decides whether the target melody
means anything at all, and therefore whether correcting against it is safe.
This module answers that question before any correction is authorised.

Pure numpy and scipy. No librosa, no torch: this runs inside the same GPU call
as the generation and must not add a dependency or a model download.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Optional, Sequence

import numpy as np

#: Tempo range worth considering, in BPM. Wide enough for a slow ballad and a
#: fast dance track; narrow enough that a detector cannot report a rumble.
TEMPO_MIN_BPM = 40.0
TEMPO_MAX_BPM = 220.0

#: How far the measured tempo may sit from the requested one before the result
#: is a mismatch, as a ratio.
#:
#: Three per cent. A generative model will not land on an exact integer BPM and
#: should not be failed for 71.4 against 72; but the failure this guards is a
#: 38% error, and anything approaching 3% already puts a four-minute plan eight
#: seconds out by the end, which is several notes.
TEMPO_TOLERANCE = 0.03

#: A measured tempo is accepted only if the independent methods agree this
#: closely with each other. They disagree when the song has no clear pulse, and
#: a number nobody can reproduce must not be used to fail a song.
METHOD_AGREEMENT = 0.04

#: How much the local tempo may wander across the song before the ratio between
#: plan and performance stops being one number.
#:
#: Five per cent, measured against a 30-second window, and both numbers were
#: chosen from the same table rather than guessed. Spread between window tempi:
#:
#:     window   steady   drift 90->99   drift 90->108   a real ACE-Step song
#:       30 s     0.0%           5.7%           16.7%                   1.0%
#:       20 s     0.0%           9.6%           16.7%                   5.0%
#:       15 s     0.0%           9.6%           16.7%                  34.6%
#:       10 s     0.0%           9.6%           18.8%                  70.7%
#:
#: A shorter window catches a mild drift more sharply on a click track and is
#: useless on music: a real song whose tempo is steady to 1% at 30 seconds
#: reports 35% at 15, because a ten-second window of a sparse intro genuinely
#: has no reliable tempo. Refusing that song would be a false refusal.
#:
#: So the window stays at 30 s and the tolerance comes down to 5%, which catches
#: the 10% end-to-end drift (5.7% as measured) while leaving the real song —
#: 1.0% — a fivefold margin.
LOCAL_DRIFT_TOLERANCE = 0.05

#: Verdicts.
TEMPO_OK = "TEMPO_OK"
TEMPO_MISMATCH = "TEMPO_MISMATCH"
TEMPO_UNSTABLE = "TEMPO_UNSTABLE"
TEMPO_UNMEASURABLE = "TEMPO_UNMEASURABLE"
TEMPO_NOT_REQUESTED = "TEMPO_NOT_REQUESTED"


#: The band a canonical musical tempo is folded into when nothing was requested.
#:
#: A ballad detected at 49.3 BPM and one detected at 98.7 are the same music —
#: half-time and double-time are a reading, not a fact. With a requested tempo
#: there is an obvious octave to prefer; without one there is not, so the raw
#: value is folded by powers of two into the range most music is counted in.
#: Both numbers are always reported, so 49 is never mistaken for a different
#: song from 99.
CANONICAL_BAND = (60.0, 160.0)


@dataclass
class TempoReading:
    """What the song's tempo is, measured several ways, and what follows.

    Four numbers, always, and they are not interchangeable:

      `requested_bpm`  what was asked for, or None
      `raw_bpm`        what the detectors actually found, unfolded
      `canonical_bpm`  the same performance read at the octave that compares
                       with the request (or, with no request, at the octave
                       music is normally counted in)
      `ratio`          canonical / requested

    Reporting only one of them is how a 49 gets mistaken for a different song
    from a 99 when they are the same recording.
    """

    #: What the detectors found, unfolded. 0.0 when they could not agree.
    raw_bpm: float = 0.0
    #: Every method's answer, by name, so a reader can see the disagreement.
    methods: dict[str, float] = field(default_factory=dict)
    #: Other tempi the evidence also supports — usually 2x and 1/2x.
    harmonics: list[float] = field(default_factory=list)
    #: The tempo that was asked for, or None.
    requested_bpm: Optional[float] = None
    #: The same performance at the octave that compares with the request.
    #:
    #: Which octave is printed does not matter; which one the *timeline* is
    #: compared against does, because the plan's note times scale by this ratio
    #: and getting the octave wrong inverts the sign of the drift.
    canonical_bpm: float = 0.0
    #: canonical_bpm / requested. 1.0 when they agree.
    ratio: Optional[float] = None
    #: How much the local tempo wanders, as a fraction of the global tempo.
    local_drift: float = 0.0
    verdict: str = TEMPO_UNMEASURABLE
    reasons: list[str] = field(default_factory=list)

    @property
    def folded(self) -> bool:
        """Whether raw and canonical are different readings of the same pulse."""
        return self.raw_bpm > 0 and abs(self.canonical_bpm - self.raw_bpm) >= 0.01

    def four_values(self) -> dict[str, Optional[float]]:
        """The four tempo numbers, always together, never one of them alone.

        Requested, raw, canonical and ratio. A report that prints one number is
        how a 49 gets read as a different song from a 99 when they are the same
        recording at half-time and double-time.
        """
        return {
            "requested_bpm": (round(float(self.requested_bpm), 2)
                              if self.requested_bpm else None),
            "raw_bpm": round(self.raw_bpm, 2) if self.raw_bpm else None,
            "canonical_bpm": (round(self.canonical_bpm, 2)
                              if self.canonical_bpm else None),
            "tempo_ratio": round(self.ratio, 4) if self.ratio else None,
        }

    def describe(self) -> str:
        """The four values on one line, with the folding shown when it happened."""
        values = self.four_values()
        requested = f"{values['requested_bpm']:.2f}" if values["requested_bpm"] else "none"
        raw = f"{values['raw_bpm']:.2f}" if values["raw_bpm"] else "unmeasured"
        canonical = f"{values['canonical_bpm']:.2f}" if values["canonical_bpm"] else "unmeasured"
        ratio = f"{values['tempo_ratio']:.4f}" if values["tempo_ratio"] else "n/a"
        line = (f"requested {requested} BPM | raw {raw} BPM | "
                f"canonical {canonical} BPM | ratio {ratio}")
        if self.folded:
            factor = self.canonical_bpm / self.raw_bpm
            line += (f"  [folded x{factor:g}: raw {raw} and canonical {canonical} are the "
                     f"same pulse counted at different octaves, not two tempi]")
        return line

    @property
    def usable_for_alignment(self) -> bool:
        """Whether a target melody laid out at the requested tempo can be aligned.

        True only when the tempo is measurable AND either matches what was asked
        for or differs by a single stable ratio the alignment can undo. An
        unstable tempo is not correctable by one ratio and is not authorised.
        """
        return self.verdict in (TEMPO_OK, TEMPO_MISMATCH) and self.raw_bpm > 0


def _onset_envelope(audio: np.ndarray, sample_rate: int,
                    hop: int = 512, n_fft: int = 2048) -> tuple[np.ndarray, float]:
    """Spectral flux: how much the spectrum grows, frame to frame.

    Growth only. A note starting adds energy; a note ending removes it, and
    counting that as an onset doubles the apparent tempo.
    """
    audio = np.asarray(audio, dtype=np.float64).reshape(-1)
    if audio.size < n_fft * 4:
        return np.zeros(0), 0.0
    window = np.hanning(n_fft)
    frames = 1 + (audio.size - n_fft) // hop
    spectrum = np.empty((n_fft // 2 + 1, frames))
    for index in range(frames):
        spectrum[:, index] = np.abs(
            np.fft.rfft(audio[index * hop: index * hop + n_fft] * window))
    # Log compression: a drum hit and a quiet guitar pluck should both count.
    spectrum = np.log1p(spectrum * 10.0)
    flux = np.maximum(np.diff(spectrum, axis=1), 0.0).sum(axis=0)
    flux -= flux.mean()
    return flux, sample_rate / hop


def _autocorrelation_bpm(flux: np.ndarray, rate: float) -> tuple[float, list[float]]:
    """The tempo the onset envelope repeats at, by autocorrelation."""
    if flux.size < 16:
        return 0.0, []
    size = 1 << int(np.ceil(np.log2(flux.size * 2)))
    spectrum = np.fft.rfft(flux, size)
    correlation = np.fft.irfft(spectrum * np.conj(spectrum), size)[: flux.size]
    if correlation[0] <= 0:
        return 0.0, []
    correlation = correlation / correlation[0]
    lags = np.arange(correlation.size) / rate
    with np.errstate(divide="ignore"):
        bpms = 60.0 / np.where(lags > 0, lags, np.inf)
    band = (bpms >= TEMPO_MIN_BPM) & (bpms <= TEMPO_MAX_BPM)
    if not band.any():
        return 0.0, []
    idx = np.flatnonzero(band)
    peaks = [i for i in idx[1:-1]
             if correlation[i] > correlation[i - 1] and correlation[i] > correlation[i + 1]]
    if not peaks:
        return 0.0, []
    peaks.sort(key=lambda i: -correlation[i])
    return float(bpms[peaks[0]]), [round(float(bpms[i]), 2) for i in peaks[:6]]


def _comb_bpm(flux: np.ndarray, rate: float) -> float:
    """The tempo whose grid the onsets land on best.

    Independent of autocorrelation: it scores a candidate by how much onset
    energy sits on its beats, which is a different question from how strongly
    the envelope correlates with a shifted copy of itself.
    """
    if flux.size < 16:
        return 0.0
    best, best_score = 0.0, -np.inf
    for bpm in np.arange(TEMPO_MIN_BPM, TEMPO_MAX_BPM, 0.25):
        period = 60.0 / bpm * rate
        if period < 4:
            continue
        index = np.round(np.arange(0, flux.size, period)).astype(int)
        index = index[index < flux.size]
        if index.size < 8:
            continue
        # On-beat against the off-beat midpoints, not the mean of the on-beats
        # alone. A bare mean rewards a long period for sampling fewer points:
        # scanning 40-220 BPM it picked 55.6 on a song the other two methods
        # both read as 49.1, purely because 55.6 sampled less of the envelope.
        # A contrast is scale-invariant — it asks whether the beats are louder
        # than what sits between them, which is what a tempo is.
        off = np.round(np.arange(period / 2, flux.size, period)).astype(int)
        off = off[off < flux.size]
        if off.size < 8:
            continue
        score = float(flux[index].mean() - flux[off].mean())
        if score > best_score:
            best_score, best = score, float(bpm)
    return best


def _interval_bpm(flux: np.ndarray, rate: float) -> float:
    """The most common gap between onsets, as a tempo.

    A third independent route: it never looks at periodicity at all, only at
    how far apart consecutive peaks are.
    """
    if flux.size < 16:
        return 0.0
    threshold = flux.mean() + flux.std()
    peaks = [i for i in range(1, flux.size - 1)
             if flux[i] > threshold and flux[i] >= flux[i - 1] and flux[i] > flux[i + 1]]
    if len(peaks) < 8:
        return 0.0
    gaps = np.diff(np.asarray(peaks)) / rate
    gaps = gaps[(gaps >= 60.0 / TEMPO_MAX_BPM) & (gaps <= 60.0 / TEMPO_MIN_BPM)]
    if gaps.size < 8:
        return 0.0
    hist, edges = np.histogram(gaps, bins=60)
    top = int(np.argmax(hist))
    return float(60.0 / ((edges[top] + edges[top + 1]) / 2))


def _fold_into_band(bpm: float, band: tuple[float, float] = CANONICAL_BAND) -> float:
    """Halves or doubles a tempo until it sits in the band music is counted in."""
    if bpm <= 0:
        return 0.0
    low, high = band
    value = float(bpm)
    for _ in range(6):
        if value < low:
            value *= 2.0
        elif value >= high:
            value /= 2.0
        else:
            break
    return value


def _fold_to(reference: float, candidate: float) -> float:
    """Brings a candidate onto the reference's octave, so 2x and 1/2x agree.

    Tempo detection's oldest ambiguity: half-time and double-time are the same
    music. Comparing methods without folding makes two correct answers look like
    a disagreement and throws away a usable measurement.
    """
    if candidate <= 0 or reference <= 0:
        return candidate
    best, best_error = candidate, abs(math.log2(candidate / reference))
    for factor in (0.25, 1 / 3, 0.5, 2.0, 3.0, 4.0):
        scaled = candidate * factor
        if not (TEMPO_MIN_BPM <= scaled <= TEMPO_MAX_BPM):
            continue
        error = abs(math.log2(scaled / reference))
        if error < best_error:
            best, best_error = scaled, error
    return best


def measure_local_tempo(audio: np.ndarray, sample_rate: int,
                        window_seconds: float = 30.0) -> list[float]:
    """The tempo of each window of the song, to see whether it holds steady."""
    audio = np.asarray(audio, dtype=np.float64).reshape(-1)
    span = int(window_seconds * sample_rate)
    if span <= 0 or audio.size < span * 2:
        return []
    out = []
    for start in range(0, audio.size - span + 1, span):
        flux, rate = _onset_envelope(audio[start: start + span], sample_rate)
        bpm, _ = _autocorrelation_bpm(flux, rate)
        if bpm > 0:
            out.append(bpm)
    return out


def measure_tempo(audio: np.ndarray, sample_rate: int,
                  requested_bpm: Optional[float] = None) -> TempoReading:
    """Measures the tempo three independent ways and says what it means.

    Three methods, because one is an opinion. Autocorrelation asks how the
    onset envelope repeats; the comb filter asks which grid the onsets land on;
    the interval histogram asks how far apart they are. They fail differently,
    so agreement between them is evidence and disagreement is a reason not to
    act.
    """
    reading = TempoReading(requested_bpm=requested_bpm)
    flux, rate = _onset_envelope(audio, sample_rate)
    if flux.size == 0:
        reading.reasons.append("the audio is too short to measure a tempo")
        return reading

    auto, harmonics = _autocorrelation_bpm(flux, rate)
    if auto <= 0:
        reading.reasons.append("no periodicity was found in the onsets")
        return reading
    comb = _fold_to(auto, _comb_bpm(flux, rate))
    interval = _fold_to(auto, _interval_bpm(flux, rate))
    reading.methods = {"autocorrelation": round(auto, 2),
                       "comb_filter": round(comb, 2),
                       "onset_intervals": round(interval, 2)}
    reading.harmonics = harmonics

    agreeing = [v for v in (auto, comb, interval) if v > 0]
    spread = max(agreeing) / min(agreeing) - 1.0 if len(agreeing) > 1 else 0.0
    if spread > METHOD_AGREEMENT:
        reading.verdict = TEMPO_UNMEASURABLE
        reading.reasons.append(
            f"the methods disagree by {spread * 100:.1f}% ({reading.methods}), so no single "
            f"tempo is established and none may be used to judge the song")
        return reading
    reading.raw_bpm = float(np.median(agreeing))

    local = measure_local_tempo(audio, sample_rate)
    if len(local) >= 2:
        folded = [_fold_to(reading.raw_bpm, v) for v in local]
        reading.local_drift = float(max(folded) / min(folded) - 1.0)

    if requested_bpm is None or requested_bpm <= 0:
        # No request, so no octave is privileged: fold into the band music is
        # normally counted in, and say plainly that both readings are the same
        # performance.
        reading.canonical_bpm = _fold_into_band(reading.raw_bpm)
        reading.verdict = TEMPO_NOT_REQUESTED
        reading.reasons.append(
            "no tempo was requested, so there is nothing for the measurement to disagree with")
        return reading

    reading.canonical_bpm = _fold_to(float(requested_bpm), reading.raw_bpm)
    reading.ratio = reading.canonical_bpm / float(requested_bpm)
    folded_ratio = reading.ratio

    if reading.local_drift > LOCAL_DRIFT_TOLERANCE:
        reading.verdict = TEMPO_UNSTABLE
        reading.reasons.append(
            f"the tempo wanders by {reading.local_drift * 100:.1f}% across the song, so the plan "
            f"and the performance are not related by any single ratio")
        return reading

    if abs(folded_ratio - 1.0) <= TEMPO_TOLERANCE:
        reading.verdict = TEMPO_OK
        reading.reasons.append(
            f"canonical {reading.canonical_bpm:.2f} (raw {reading.raw_bpm:.2f}) against "
            f"{requested_bpm:.0f} requested, within {TEMPO_TOLERANCE * 100:.0f}%")
        return reading

    reading.verdict = TEMPO_MISMATCH
    same = "" if abs(reading.canonical_bpm - reading.raw_bpm) < 0.01 else \
        f" (raw {reading.raw_bpm:.2f}; the same performance read at the octave nearest the request)"
    reading.reasons.append(
        f"canonical {reading.canonical_bpm:.2f} BPM against {requested_bpm:.0f} requested"
        f"{same}, ratio {reading.ratio:.4f}. The target melody is laid out on the requested "
        f"tempo's timeline, so plan and performance drift apart by "
        f"{abs(1 - 1 / reading.ratio) * 100:.0f}% of elapsed time.")
    return reading


def drift_seconds(reading: TempoReading, at_plan_seconds: float) -> float:
    """How far a planned note at `at_plan_seconds` is from where it belongs."""
    if not reading.ratio or reading.ratio <= 0:
        return 0.0
    return at_plan_seconds - at_plan_seconds / reading.ratio
