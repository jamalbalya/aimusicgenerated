"""Deciding which frames of a separated stem are actually a voice.

A separator hands back a "vocal" stem, and a pitch tracker will call anything in
it voiced. Neither is a claim about singing. Spleeter's 2stems model splits
vocals from everything else, and the thing it most often puts on the wrong side
is a saxophone: pitched, continuous, vibrato-carrying, and sitting in exactly a
male singer's register. The style this project's songs are generated from asks
for one by name.

That mattered. Measured on a real 309-second ballad, harmonic compatibility
scored z = +2.30 over every voiced frame, +0.72 with a formant filter and +0.43
with a stricter one — monotonic, and in the direction that settles it. The more
certainly the frames were voice, the worse the melody fitted the chords, which
means the permissive figure was leaked accompaniment agreeing with itself.

So frames are scored rather than accepted. The signals are the ones that
separate a voice from a wind instrument without needing to recognise either:

  * Formant energy. Speech puts energy at 1.5-4 kHz, where the third formant
    and most consonants live.
  * Consonant evidence. Singing carries fricatives and plosives — broadband
    bursts above 5 kHz. A reed has one transient per note and nothing between.
  * Range plausibility. A frame tracked outside a human singing range is not a
    singer, whatever else it is.
  * Accompaniment similarity. A frame whose spectrum looks like the other stem
    at the same moment is probably the other stem.

None of these is decisive alone and the model does not pretend otherwise: it
reports a confidence per frame, a coverage figure for the track, and how much
time it threw away. Throwing away most of a song and then passing it on what
remains is its own failure, which is why coverage is a gate of its own.
"""

from __future__ import annotations

from dataclasses import dataclass, field, asdict

#: A frame needs this much confidence before it is measured.
MIN_FRAME_CONFIDENCE = 0.5

#: Below this share of the vocal's own active time, the analysis is not a
#: statement about the song. Not a pass and not a fail — unavailable.
MIN_COVERAGE_RATIO = 0.35

#: And below this many seconds, likewise, however good the ratio looks.
MIN_USABLE_SECONDS = 20.0

#: The band where a singer's formants and consonants sit.
FORMANT_BAND_HZ = (1500.0, 4000.0)
#: Where fricatives put their energy.
CONSONANT_BAND_HZ = (5000.0, 11000.0)

#: A sung note outside this is a tracker error or an instrument.
SINGING_RANGE_HZ = (70.0, 1200.0)


@dataclass
class VocalFrame:
    """One analysed moment, and how much it looks like singing."""

    start_seconds: float
    end_seconds: float
    pitch_hz: float
    confidence: float
    is_probable_vocal: bool
    contamination_reason: str = ""

    def as_dict(self) -> dict:
        return asdict(self)


@dataclass
class VocalAnalysis:
    """Which parts of the stem may be measured, and what was discarded."""

    #: Boolean mask over the pitch track: the frames worth measuring.
    usable: object = None
    total_vocal_presence_seconds: float = 0.0
    usable_vocal_analysis_seconds: float = 0.0
    vocal_analysis_coverage_ratio: float = 0.0
    probable_instrumental_contamination_seconds: float = 0.0
    #: Longest stretches that looked pitched but not vocal, for a report.
    contaminated_spans: list = field(default_factory=list)
    reasons: dict = field(default_factory=dict)

    @property
    def reliable(self) -> bool:
        return (self.usable_vocal_analysis_seconds >= MIN_USABLE_SECONDS
                and self.vocal_analysis_coverage_ratio >= MIN_COVERAGE_RATIO)

    def as_dict(self) -> dict:
        return {
            "total_vocal_presence_seconds": round(self.total_vocal_presence_seconds, 1),
            "usable_vocal_analysis_seconds": round(self.usable_vocal_analysis_seconds, 1),
            "vocal_analysis_coverage_ratio": round(self.vocal_analysis_coverage_ratio, 3),
            "probable_instrumental_contamination_seconds":
                round(self.probable_instrumental_contamination_seconds, 1),
            "contaminated_spans": self.contaminated_spans[:12],
            "discarded_by_reason": self.reasons,
            "reliable": self.reliable,
        }


def _band(spectrum, freqs, low: float, high: float):
    import numpy as np
    mask = (freqs >= low) & (freqs < high)
    return spectrum[mask].sum(axis=0) if np.any(mask) else np.zeros(spectrum.shape[1])


def analyse_frames(voice, accompaniment, f0, voiced, times, sample_rate: int,
                   hop_length: int) -> VocalAnalysis:
    """Score every voiced frame, and report what survived."""
    import librosa
    import numpy as np

    frame_seconds = float(times[1] - times[0]) if len(times) > 1 else 0.0
    voiced = np.asarray(voiced, dtype=bool) & np.isfinite(f0)
    analysis = VocalAnalysis(usable=np.zeros(len(f0), dtype=bool))
    analysis.total_vocal_presence_seconds = float(voiced.sum()) * frame_seconds
    if not voiced.any():
        return analysis

    spectrum = np.abs(librosa.stft(voice, n_fft=2048, hop_length=hop_length))
    freqs = librosa.fft_frequencies(sr=sample_rate, n_fft=2048)
    width = min(len(f0), spectrum.shape[1])

    body = _band(spectrum, freqs, 200.0, 1200.0)[:width] + 1e-9
    formant = _band(spectrum, freqs, *FORMANT_BAND_HZ)[:width]
    consonant = _band(spectrum, freqs, *CONSONANT_BAND_HZ)[:width]

    other = np.abs(librosa.stft(accompaniment, n_fft=2048, hop_length=hop_length))
    other_body = _band(other, freqs, 200.0, 1200.0)[:width] + 1e-9

    formant_ratio = formant / body
    consonant_ratio = consonant / body
    # How loud this stem is against the other one at the same moment. A frame
    # the separator barely pulled apart is a frame it did not separate.
    dominance = body / (body + other_body[:width])

    active = voiced[:width]
    if not active.any():
        return analysis

    formant_floor = float(np.percentile(formant_ratio[active], 45))
    reasons = {"weak_formants": 0, "no_consonant_context": 0,
               "outside_singing_range": 0, "accompaniment_dominates": 0}

    # Consonant evidence is contextual, not per-frame: a held vowel has no
    # fricative in it and is still singing. What distinguishes a voice is that
    # consonants happen *nearby*. One second either side is about a syllable.
    span = max(1, int(round(1.0 / frame_seconds))) if frame_seconds > 0 else 20
    burst = consonant_ratio > (np.median(consonant_ratio[active]) * 2.5)
    nearby = np.convolve(burst.astype(float), np.ones(2 * span + 1), mode="same") > 0

    usable = np.zeros(len(f0), dtype=bool)
    confidences = np.zeros(len(f0))
    for index in np.where(active)[0]:
        pitch = float(f0[index])
        score = 1.0
        reason = ""
        if not (SINGING_RANGE_HZ[0] <= pitch <= SINGING_RANGE_HZ[1]):
            score = 0.0
            reason = "outside_singing_range"
        elif formant_ratio[index] < formant_floor:
            score = 0.35
            reason = "weak_formants"
        elif not nearby[index]:
            score = 0.4
            reason = "no_consonant_context"
        elif dominance[index] < 0.35:
            score = 0.45
            reason = "accompaniment_dominates"
        confidences[index] = score
        if score >= MIN_FRAME_CONFIDENCE:
            usable[index] = True
        elif reason:
            reasons[reason] += 1

    analysis.usable = usable
    analysis.usable_vocal_analysis_seconds = float(usable.sum()) * frame_seconds
    analysis.vocal_analysis_coverage_ratio = (
        analysis.usable_vocal_analysis_seconds / analysis.total_vocal_presence_seconds
        if analysis.total_vocal_presence_seconds > 0 else 0.0)
    analysis.reasons = {name: round(count * frame_seconds, 1) for name, count in reasons.items()}

    # Contamination: stretches long enough that something was playing there.
    rejected = active & ~usable[:width]
    spans: list = []
    start = None
    for index in range(width):
        if rejected[index] and start is None:
            start = index
        elif not rejected[index] and start is not None:
            if (index - start) * frame_seconds >= 1.0:
                spans.append((round(float(times[start]), 1), round(float(times[index]), 1)))
            start = None
    if start is not None and (width - start) * frame_seconds >= 1.0:
        spans.append((round(float(times[start]), 1), round(float(times[width - 1]), 1)))
    analysis.probable_instrumental_contamination_seconds = sum(b - a for a, b in spans)
    analysis.contaminated_spans = sorted(spans, key=lambda s: s[0] - s[1])
    return analysis


def frames_for_report(f0, times, usable, confidences=None, limit: int = 0) -> list:
    """The per-frame records, for a caller that wants them. Empty by default."""
    import numpy as np
    if not limit:
        return []
    frame_seconds = float(times[1] - times[0]) if len(times) > 1 else 0.0
    out = []
    for index in np.where(np.asarray(usable))[0][:limit]:
        out.append(VocalFrame(
            start_seconds=round(float(times[index]), 3),
            end_seconds=round(float(times[index]) + frame_seconds, 3),
            pitch_hz=round(float(f0[index]), 2),
            confidence=1.0 if confidences is None else round(float(confidences[index]), 2),
            is_probable_vocal=True,
        ).as_dict())
    return out
