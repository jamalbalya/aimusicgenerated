"""The quality gate for a neural take, where the analysis can actually be done.

The browser cannot judge an ACE-Step song. It gets one mixed stereo file, and
separating a voice from a band needs a trained separator that does not fit in a
web page — and measuring the mix instead measures backwards, which
`separate_vocals.py` documents with the numbers. So the studio reports
ANALYSIS_UNAVAILABLE for every neural take and says where a real verdict comes
from. This is where.

Same four verdicts as the browser gate, same two absolute rules:

  * ANALYSIS_UNAVAILABLE never becomes PASS.
  * A take that failed is never returned. When the attempts run out, nothing is
    returned at all — falling back to the last failure would deliver exactly the
    songs the gate exists to catch while appearing to have checked them.
"""

from __future__ import annotations

import math
from dataclasses import asdict, dataclass, field
from pathlib import Path

import harmony
import intonation
import separate_vocals


@dataclass
class Thresholds:
    """What is acceptable. Strict, and the same figures the browser gate uses.

    The two that do the work are `min_harmony_z` and `max_severe_conflicts`.
    Everything else is a guard against a take that is bad in some other way.
    """

    #: Null standard deviations the melody must beat chance by before it counts
    #: as following the chords. Below 2.0 a melody is statistically
    #: indistinguishable from the same line sung over the wrong bars.
    min_harmony_z: float = harmony.Z_UNRELATED
    #: Per cent of sung frames whose pitch class is among the accompaniment's
    #: four weakest. High means the singer is spending real time on notes the
    #: band is not playing.
    max_weakest4_percent: float = 30.0
    #: Clash stretches long enough to be heard as one rather than passed through.
    max_severe_conflicts: int = 0
    #: Seconds a single clash may run.
    max_clash_seconds: float = 2.0
    #: Median distance to the nearest semitone, in cents.
    max_grid_median_cents: float = 25.0
    #: Per cent of held notes sliding more than half a semitone.
    max_drift_share_percent: float = 25.0
    #: Worst register's median centre error, in cents. A take is judged on its
    #: worst register rather than its average, because that is the one heard.
    max_register_centre_cents: float = 30.0
    #: Sung seconds below which nothing here means anything.
    min_analysed_seconds: float = 20.0


STRICT = Thresholds()

#: How much of the vocal stem is discarded as insufficiently vocal before any
#: measurement. Matches `analyze.py`, deliberately: the tool that decides whether
#: a song is delivered must never be more permissive than the one that only
#: reports on it.
FORMANT_PERCENTILE = 55


@dataclass
class GateReport:
    verdict: str
    reasons: list = field(default_factory=list)
    failed_checks: list = field(default_factory=list)
    measurements: dict = field(default_factory=dict)
    #: Where to listen, longest first.
    worst_moments: list = field(default_factory=list)
    limitations: list = field(default_factory=list)

    def as_dict(self) -> dict:
        return asdict(self)


def _unavailable(reason: str) -> GateReport:
    return GateReport(verdict="ANALYSIS_UNAVAILABLE", reasons=[reason], limitations=[reason])


def judge(path: Path, thresholds: Thresholds = STRICT) -> GateReport:
    """Separate, measure, and decide. Never guesses, never passes on a mix."""
    import librosa
    import numpy as np

    stereo, native_sr = librosa.load(str(path), sr=None, mono=False)
    stereo = stereo.T if getattr(stereo, "ndim", 1) == 2 else np.stack([stereo, stereo], axis=1)

    state = separate_vocals.availability()
    if not state.ready:
        return _unavailable(
            f"The vocal could not be separated, so nothing measurable here is a measurement of "
            f"the singing: {state.reason}")
    try:
        voice, music, rate = separate_vocals.separate(stereo, native_sr)
    except separate_vocals.SeparatorUnavailable as error:
        return _unavailable(f"The vocal could not be separated: {error}")

    _, split_ok, why = separate_vocals.separation_quality(voice, music, rate)
    if not split_ok:
        return _unavailable(f"The separation could not be trusted: {why}")

    sr, hop = 22050, 256
    voice = librosa.resample(voice, orig_sr=rate, target_sr=sr)
    music = librosa.resample(music, orig_sr=rate, target_sr=sr)

    f0, flag, prob = librosa.pyin(
        voice, fmin=95, fmax=520, sr=sr, frame_length=2048, hop_length=hop, fill_na=np.nan)
    times = librosa.times_like(f0, sr=sr, hop_length=hop)

    # Voiced is not the same as vocal. A separator leaves some accompaniment in
    # the vocal stem — a tenor saxophone most of all, which is pitched,
    # continuous and in a male singer's register — and a pitch tracker is happy
    # to call all of it voiced. So a frame also has to carry energy where a
    # singer's consonants and formants live before it counts.
    #
    # This is not a refinement. Measured on a real 309-second ballad, the same
    # audio scored z = +2.30 over every voiced frame, +0.72 with this filter and
    # +0.43 with a stricter one: the more certainly the frames were voice, the
    # worse the harmonic fit looked, which means the permissive figure was
    # measuring leaked accompaniment agreeing with itself. The gate had the
    # permissive one and the diagnostic analyser had the filter, so the tool that
    # decides delivery was the more forgiving of the two — exactly backwards.
    spectrum = np.abs(librosa.stft(voice, n_fft=2048, hop_length=hop))
    freqs = librosa.fft_frequencies(sr=sr, n_fft=2048)
    formant = spectrum[(freqs >= 1500) & (freqs < 4000)].sum(axis=0)[:len(f0)]
    sung = (flag & np.isfinite(f0) & (prob > 0.5)
            & (formant > np.percentile(formant, FORMANT_PERCENTILE)))

    tuning = intonation.measure(
        times, f0, sung, len(voice) / sr, isolated_vocal=True,
        analysis_window_seconds=2048 / sr)
    fit = harmony.compatibility(times, f0, sung, music, sr, hop, isolated=True)

    if not tuning.sufficient or not fit.sufficient:
        return _unavailable(
            "Too little singing was found to judge this take: "
            + " ".join(tuning.limitations + fit.limitations))
    if tuning.analysed_seconds < thresholds.min_analysed_seconds:
        return _unavailable(
            f"Only {tuning.analysed_seconds:.1f}s of singing was measurable, below the "
            f"{thresholds.min_analysed_seconds:.0f}s a verdict needs.")

    registers = intonation.by_register(tuning.notes)
    worst_register = max(
        (r for r in registers if r.median_centre_error_cents is not None),
        key=lambda r: r.median_centre_error_cents, default=None)

    clashes = [(start, stop) for start, stop in fit.clashes
               if stop - start >= thresholds.max_clash_seconds]

    measurements = {
        "harmony_z": round(fit.z, 2),
        "harmony_in_key_percent": round(fit.in_key_percent, 1),
        "harmony_weakest4_percent": round(fit.weakest4_percent, 1),
        "harmony_top3_percent": round(fit.top3_percent, 1),
        "harmony_top3_percent_null": round(fit.null_top3_percent, 1),
        "key": fit.key,
        "grid_median_cents": round(tuning.grid_median_cents, 1),
        "notes_drifting_over_50c": round(tuning.notes_drifting_over_50c, 1),
        "analysed_seconds": round(tuning.analysed_seconds, 1),
        "severe_clashes": len(clashes),
        "worst_register": None if worst_register is None else {
            "register": worst_register.name,
            "median_centre_cents": round(worst_register.median_centre_error_cents, 1),
        },
    }

    reasons: list = []
    failed: list = []

    def fail(check: str, reason: str) -> None:
        failed.append(check)
        reasons.append(reason)

    # Condition B first, because it is the one that fails invisibly.
    if fit.z < thresholds.min_harmony_z:
        fail("harmonicCompatibility",
             f"The melody is not demonstrably related to the accompaniment (z = {fit.z:+.2f}; "
             f"anything under {thresholds.min_harmony_z} is indistinguishable from singing over "
             "the wrong bars).")
    if fit.weakest4_percent > thresholds.max_weakest4_percent:
        fail("weakestFour",
             f"{fit.weakest4_percent:.1f}% of sung frames sit on pitch classes among the band's "
             f"four weakest, above the {thresholds.max_weakest4_percent:.0f}% allowed.")
    if len(clashes) > thresholds.max_severe_conflicts:
        fail("severeConflicts",
             f"{len(clashes)} clash(es) run longer than {thresholds.max_clash_seconds:.0f}s, "
             f"above the {thresholds.max_severe_conflicts} allowed.")

    # Condition A.
    if tuning.grid_median_cents > thresholds.max_grid_median_cents:
        fail("pitchAccuracy",
             f"Median distance to the nearest semitone is {tuning.grid_median_cents:.1f} cents, "
             f"above the {thresholds.max_grid_median_cents:.0f} allowed.")
    if tuning.notes_drifting_over_50c > thresholds.max_drift_share_percent:
        fail("pitchStability",
             f"{tuning.notes_drifting_over_50c:.1f}% of held notes slide more than half a "
             f"semitone, above the {thresholds.max_drift_share_percent:.0f}% allowed.")
    if (worst_register is not None
            and worst_register.median_centre_error_cents > thresholds.max_register_centre_cents):
        fail("register",
             f"The {worst_register.name} register sits "
             f"{worst_register.median_centre_error_cents:.1f} cents off centre, above the "
             f"{thresholds.max_register_centre_cents:.0f} allowed.")

    worst_moments = [
        {"from_s": start, "to_s": stop, "seconds": round(stop - start, 1)}
        for start, stop in sorted(fit.clashes, key=lambda span: span[0] - span[1])[:12]
    ]
    limitations = list(tuning.limitations) + list(fit.limitations)

    if failed:
        harmonic = {"harmonicCompatibility", "weakestFour", "severeConflicts"}
        if harmonic.intersection(failed):
            reasons.append(
                "Pitch correction cannot fix this: the notes are on the grid and simply do not "
                "fit the chords under them. The repair is a different melody, not a retuned one.")
        return GateReport("REGENERATION_REQUIRED", reasons, failed, measurements,
                          worst_moments, limitations)

    return GateReport(
        "PASS",
        [f"Melody follows the harmony (z = {fit.z:+.2f}), median tuning error "
         f"{tuning.grid_median_cents:.1f} cents, no clash longer than "
         f"{thresholds.max_clash_seconds:.0f}s."],
        [], measurements, [], limitations)
