"""One analysis, one verdict, one place.

`gate.py` decided whether a song was delivered and `analyze.py` wrote a report
about it, and each measured the audio its own way. On a real 309-second ballad
they disagreed about the headline figure — z = +2.30 against +0.72 — because one
filtered the vocal stem for frames that looked like a voice and the other
counted everything the pitch tracker called voiced. The tool that decided
delivery was the more permissive of the two. Exactly backwards, and invisible
until someone ran both on the same file.

Two implementations of one measurement will always drift, and the drift will
always be discovered late. So there is one implementation. `evaluate_audio` does
the whole thing and both callers ask it; neither has any harmonic logic of its
own left to disagree with.

Verdict precedence is explicit and ordered, because "which check wins" is a
product decision and not something to leave to whichever `if` came first:

  1. audio unreadable                -> ANALYSIS_UNAVAILABLE
  2. separation unreliable           -> ANALYSIS_UNAVAILABLE
  3. vocal analysis unreliable       -> ANALYSIS_UNAVAILABLE
  4. tempo unmeasurable              -> ANALYSIS_UNAVAILABLE
  5. tempo outside tolerance         -> REGENERATION_REQUIRED
  6. harmony fails                   -> REGENERATION_REQUIRED
  7. severe conflicts                -> REGENERATION_REQUIRED
  8. pitch fails                     -> REGENERATION_REQUIRED
  9. everything required passed      -> PASS
 10. otherwise                       -> REVIEW_REQUIRED

Unavailable outranks failure on purpose. A song that could not be measured has
not failed; saying it did would send someone regenerating to fix a broken
analysis. And nothing outranks unavailable into a pass.
"""

from __future__ import annotations

from dataclasses import dataclass, field, asdict
from pathlib import Path

import harmony
import intonation
import separate_vocals
import tempo as tempo_module
import voice as voice_module
from requirements import QualityRequirements

#: Analysis rate and hop. Everything downstream assumes them.
SR = 22050
HOP = 256

#: Why a take was rejected. Stable strings — the regeneration loop branches on
#: them and a report shows them, so they are an interface, not a message.
TEMPO_MISMATCH = "TEMPO_MISMATCH"
HARMONIC_MISMATCH = "HARMONIC_MISMATCH"
WEAKEST_FOUR = "WEAKEST_FOUR"
SEVERE_CONFLICT = "SEVERE_CONFLICT"
PITCH_PROBLEM = "PITCH_PROBLEM"
SEPARATION_UNRELIABLE = "SEPARATION_UNRELIABLE"
VOCAL_ANALYSIS_UNRELIABLE = "VOCAL_ANALYSIS_UNRELIABLE"
TEMPO_UNMEASURABLE = "TEMPO_UNMEASURABLE"
AUDIO_CORRUPTED = "AUDIO_CORRUPTED"


@dataclass
class Thresholds:
    """What is acceptable. Strict, documented, and the same for both callers."""

    #: Null standard deviations the melody must beat chance by. Below 2.0 a
    #: melody is statistically indistinguishable from the same line sung over
    #: the wrong bars.
    min_harmony_z: float = harmony.Z_UNRELATED
    #: Per cent of sung frames on the accompaniment's four weakest pitch
    #: classes, after the jazz weighting below has excused what it can.
    max_weakest4_percent: float = 30.0
    #: Clash stretches long enough to be heard as one rather than passed through.
    max_severe_conflicts: int = 0
    max_clash_seconds: float = 2.0
    max_grid_median_cents: float = 25.0
    max_drift_share_percent: float = 25.0
    max_register_centre_cents: float = 30.0
    min_analysed_seconds: float = 20.0
    #: Octave errors are reported, never silently accepted. See `tempo.py`.
    accept_octave_errors: bool = False

    def as_dict(self) -> dict:
        return asdict(self)


STRICT = Thresholds()


@dataclass
class Check:
    """One named gate and how it went."""

    name: str
    passed: bool
    #: True when the check could not be run at all.
    unavailable: bool = False
    detail: str = ""
    value: object = None
    limit: object = None

    def as_dict(self) -> dict:
        return asdict(self)


@dataclass
class QualityReport:
    """Everything measured, everything decided, and whether it may be delivered."""

    verdict: str
    accepted: bool
    delivery_allowed: bool
    rejection_reasons: list = field(default_factory=list)
    request: dict = field(default_factory=dict)
    measurements: dict = field(default_factory=dict)
    validation: dict = field(default_factory=dict)
    worst_moments: list = field(default_factory=list)
    reasons: list = field(default_factory=list)
    limitations: list = field(default_factory=list)

    def as_dict(self) -> dict:
        return asdict(self)


def _unavailable(reason: str, code: str, request: dict,
                 measurements: dict | None = None) -> QualityReport:
    """No verdict, and never a pass. Delivery is refused either way."""
    return QualityReport(
        verdict="ANALYSIS_UNAVAILABLE",
        accepted=False,
        delivery_allowed=False,
        rejection_reasons=[code],
        request=request,
        measurements=measurements or {},
        validation={},
        reasons=[reason],
        limitations=[reason],
    )


def evaluate_audio(audio_path, requirements: QualityRequirements | None = None,
                   thresholds: Thresholds = STRICT) -> QualityReport:
    """The whole pipeline. The only place any of this is decided."""
    import librosa
    import numpy as np

    requirements = requirements or QualityRequirements()
    request = requirements.as_dict()
    path = Path(audio_path)

    # ---- 1. load -----------------------------------------------------------
    try:
        stereo, native_sr = librosa.load(str(path), sr=None, mono=False)
    except Exception as error:  # noqa: BLE001 - any decode failure is the same failure
        return _unavailable(f"The audio could not be read: {error}", AUDIO_CORRUPTED, request)
    stereo = stereo.T if getattr(stereo, "ndim", 1) == 2 else np.stack([stereo, stereo], axis=1)
    duration = len(stereo) / native_sr if native_sr else 0.0
    if duration < 5.0:
        return _unavailable(
            f"Only {duration:.1f}s of audio; nothing here means anything on that.",
            AUDIO_CORRUPTED, request, {"duration_seconds": round(duration, 2)})

    mono = librosa.resample(stereo.mean(axis=1), orig_sr=native_sr, target_sr=SR)

    # ---- 2. tempo, before anything expensive -------------------------------
    tempo_measurement = tempo_module.detect_tempo(mono, SR)
    tempo_check = tempo_module.check_tempo(
        tempo_measurement, requirements.tempo, thresholds.accept_octave_errors)

    base_measurements = {
        "duration_seconds": round(duration, 2),
        "detected_bpm": tempo_measurement.bpm,
        "tempo_confidence": tempo_measurement.confidence,
        "tempo_spread_bpm": tempo_measurement.spread_bpm,
        "tempo_per_window": tempo_measurement.per_window,
        "tempo_candidates": tempo_measurement.candidates,
    }

    # ---- 3. separation -----------------------------------------------------
    state = separate_vocals.availability()
    if not state.ready:
        return _unavailable(
            f"The vocal could not be separated, so nothing measurable here is a measurement of "
            f"the singing: {state.reason}", SEPARATION_UNRELIABLE, request, base_measurements)
    try:
        voice_stem, music_stem, rate = separate_vocals.separate(stereo, native_sr)
    except separate_vocals.SeparatorUnavailable as error:
        return _unavailable(f"The vocal could not be separated: {error}",
                            SEPARATION_UNRELIABLE, request, base_measurements)

    split_quality, split_ok, split_why = separate_vocals.separation_quality(
        voice_stem, music_stem, rate)
    base_measurements["separation_confidence"] = round(float(split_quality) / 100.0, 3)
    if not split_ok:
        return _unavailable(f"The separation could not be trusted: {split_why}",
                            SEPARATION_UNRELIABLE, request, base_measurements)

    voice_stem = librosa.resample(voice_stem, orig_sr=rate, target_sr=SR)
    music_stem = librosa.resample(music_stem, orig_sr=rate, target_sr=SR)

    # ---- 4. pitch track and vocal-frame confidence -------------------------
    f0, flag, prob = librosa.pyin(voice_stem, fmin=95, fmax=520, sr=SR,
                                  frame_length=2048, hop_length=HOP, fill_na=np.nan)
    times = librosa.times_like(f0, sr=SR, hop_length=HOP)
    voiced = flag & np.isfinite(f0) & (prob > 0.5)

    vocal = voice_module.analyse_frames(voice_stem, music_stem, f0, voiced, times, SR, HOP)
    base_measurements.update({
        "total_vocal_presence_seconds": round(vocal.total_vocal_presence_seconds, 1),
        "usable_vocal_analysis_seconds": round(vocal.usable_vocal_analysis_seconds, 1),
        "vocal_analysis_coverage_ratio": round(vocal.vocal_analysis_coverage_ratio, 3),
        "probable_instrumental_contamination_seconds":
            round(vocal.probable_instrumental_contamination_seconds, 1),
    })
    if not vocal.reliable:
        return _unavailable(
            f"Only {vocal.usable_vocal_analysis_seconds:.1f}s of the "
            f"{vocal.total_vocal_presence_seconds:.1f}s of singing "
            f"({vocal.vocal_analysis_coverage_ratio:.0%}) could be confidently attributed to a "
            "voice rather than to an instrument left in the stem. Measuring what is left and "
            "calling it a verdict on the song would be a verdict on a fragment.",
            VOCAL_ANALYSIS_UNRELIABLE, request, base_measurements)

    sung = vocal.usable

    # ---- 5. intonation and harmony, on the frames that survived ------------
    tuning = intonation.measure(times, f0, sung, len(voice_stem) / SR,
                                isolated_vocal=True, analysis_window_seconds=2048 / SR)
    fit = harmony.compatibility(times, f0, sung, music_stem, SR, HOP, isolated=True)

    if not tuning.sufficient or not fit.sufficient:
        return _unavailable(
            "Too little usable singing to judge this take: "
            + " ".join(tuning.limitations + fit.limitations),
            VOCAL_ANALYSIS_UNRELIABLE, request, base_measurements)
    if tuning.analysed_seconds < thresholds.min_analysed_seconds:
        return _unavailable(
            f"Only {tuning.analysed_seconds:.1f}s of singing was measurable, below the "
            f"{thresholds.min_analysed_seconds:.0f}s a verdict needs.",
            VOCAL_ANALYSIS_UNRELIABLE, request, base_measurements)

    registers = intonation.by_register(tuning.notes)
    worst_register = max(
        (r for r in registers if r.median_centre_error_cents is not None),
        key=lambda r: r.median_centre_error_cents, default=None)

    clashes = weigh_clashes(fit.clashes, tempo_measurement.bpm, thresholds)
    severe = [c for c in clashes if c["severe"]]

    measurements = dict(base_measurements)
    measurements.update({
        "harmonic_z": round(fit.z, 2),
        "harmony_in_key_percent": round(fit.in_key_percent, 1),
        "weakest_four_share": round(fit.weakest4_percent, 1),
        "harmony_top3_percent": round(fit.top3_percent, 1),
        "harmony_top3_percent_null": round(fit.null_top3_percent, 1),
        "key": fit.key,
        "median_tuning_error_cents": round(tuning.grid_median_cents, 1),
        "pitch_drift_ratio": round(tuning.notes_drifting_over_50c / 100.0, 3),
        "analysed_seconds": round(tuning.analysed_seconds, 1),
        "severe_conflicts": len(severe),
        "worst_register": None if worst_register is None else {
            "register": worst_register.name,
            "median_centre_cents": round(worst_register.median_centre_error_cents, 1),
        },
    })

    # ---- 6. the gates ------------------------------------------------------
    checks = [
        Check("tempo", tempo_check.passed, detail=tempo_check.detail,
              value=tempo_check.detected_bpm, limit=tempo_check.tolerance_bpm),
        Check("harmonic_compatibility", fit.z >= thresholds.min_harmony_z,
              detail=(f"z = {fit.z:+.2f} against a required {thresholds.min_harmony_z}. Below it "
                      "the melody is indistinguishable from the same line sung over the wrong bars."),
              value=round(fit.z, 2), limit=thresholds.min_harmony_z),
        Check("weakest_four", fit.weakest4_percent <= thresholds.max_weakest4_percent,
              detail=(f"{fit.weakest4_percent:.1f}% of sung frames sit on the band's four weakest "
                      f"pitch classes, against {thresholds.max_weakest4_percent:.0f}% allowed."),
              value=round(fit.weakest4_percent, 1), limit=thresholds.max_weakest4_percent),
        Check("severe_conflicts", len(severe) <= thresholds.max_severe_conflicts,
              detail=(f"{len(severe)} clash(es) long, unresolved and on a strong beat, against "
                      f"{thresholds.max_severe_conflicts} allowed."),
              value=len(severe), limit=thresholds.max_severe_conflicts),
        Check("pitch", (tuning.grid_median_cents <= thresholds.max_grid_median_cents
                        and tuning.notes_drifting_over_50c <= thresholds.max_drift_share_percent
                        and (worst_register is None
                             or worst_register.median_centre_error_cents
                             <= thresholds.max_register_centre_cents)),
              detail=(f"median {tuning.grid_median_cents:.1f} cents, "
                      f"{tuning.notes_drifting_over_50c:.1f}% of held notes drifting past half a "
                      "semitone."),
              value=round(tuning.grid_median_cents, 1), limit=thresholds.max_grid_median_cents),
        Check("vocal_analysis_reliability", True,
              detail=(f"{vocal.usable_vocal_analysis_seconds:.1f}s usable of "
                      f"{vocal.total_vocal_presence_seconds:.1f}s sung "
                      f"({vocal.vocal_analysis_coverage_ratio:.0%})."),
              value=round(vocal.vocal_analysis_coverage_ratio, 3),
              limit=voice_module.MIN_COVERAGE_RATIO),
    ]
    validation = {check.name: check.as_dict() for check in checks}

    reasons: list = []
    rejection: list = []
    if not tempo_check.passed:
        rejection.append(TEMPO_UNMEASURABLE if tempo_check.reason in
                         ("detection_failed", "low_confidence", "unstable_tempo") else TEMPO_MISMATCH)
        reasons.append(tempo_check.detail)
    if not validation["harmonic_compatibility"]["passed"]:
        rejection.append(HARMONIC_MISMATCH)
        reasons.append(validation["harmonic_compatibility"]["detail"])
    if not validation["weakest_four"]["passed"]:
        rejection.append(WEAKEST_FOUR)
        reasons.append(validation["weakest_four"]["detail"])
    if not validation["severe_conflicts"]["passed"]:
        rejection.append(SEVERE_CONFLICT)
        reasons.append(validation["severe_conflicts"]["detail"])
    if not validation["pitch"]["passed"]:
        rejection.append(PITCH_PROBLEM)
        reasons.append(validation["pitch"]["detail"])

    # A tempo that could not be measured is not a tempo that was wrong.
    if TEMPO_UNMEASURABLE in rejection:
        return _unavailable(tempo_check.detail, TEMPO_UNMEASURABLE, request, measurements)

    limitations = list(tuning.limitations) + list(fit.limitations) + [
        "Chord identity comes from the accompaniment's chroma, not from a transcription, so a "
        "tension the band implies but never sounds is counted as absent. Read the z, not the "
        "raw percentages.",
    ]
    worst = [
        {"from_s": c["from_s"], "to_s": c["to_s"], "seconds": c["seconds"],
         "severe": c["severe"], "why": c["why"]}
        for c in sorted(clashes, key=lambda c: (not c["severe"], -c["seconds"]))[:12]
    ]

    if rejection:
        if any(r in rejection for r in (HARMONIC_MISMATCH, WEAKEST_FOUR, SEVERE_CONFLICT)):
            reasons.append(
                "Pitch correction cannot fix this: the notes are on the grid and simply do not "
                "fit the chords under them. The repair is a different melody, not a retuned one.")
        return QualityReport(
            verdict="REGENERATION_REQUIRED", accepted=False, delivery_allowed=False,
            rejection_reasons=rejection, request=request, measurements=measurements,
            validation=validation, worst_moments=worst, reasons=reasons, limitations=limitations)

    return QualityReport(
        verdict="PASS", accepted=True, delivery_allowed=True, rejection_reasons=[],
        request=request, measurements=measurements, validation=validation, worst_moments=[],
        reasons=[f"Melody follows the harmony (z = {fit.z:+.2f}), median tuning error "
                 f"{tuning.grid_median_cents:.1f} cents, no severe clash, "
                 + (tempo_check.detail if requirements.tempo else "no tempo was requested.")],
        limitations=limitations)


def weigh_clashes(clashes, bpm: float | None, thresholds: Thresholds = STRICT) -> list:
    """Which clashes are faults, and which are how jazz is written.

    A non-chord tone is not a mistake. Ninths, elevenths and thirteenths are the
    sound of the genre this project generates, and a passing or approach tone
    lasting a fraction of a beat is a line moving, not a singer being wrong. So a
    clash is weighed rather than counted, and the weighting is by the things
    that make a listener notice one:

      * how long it lasts, in beats rather than seconds, because a beat at 72 BPM
        is nearly twice a beat at 140 and the ear counts beats;
      * whether it is long enough to be a destination rather than a transit.

    Only a clash that survives all of that is severe. Nothing here is loosened to
    let a particular song through: the bar is that a clash has to last more than
    two seconds *and* more than a beat before it counts, and a jazz line that
    parks on a wrong note for that long is not being subtle.
    """
    beat_seconds = 60.0 / bpm if bpm and bpm > 0 else None
    out = []
    for start, stop in clashes:
        seconds = round(float(stop) - float(start), 2)
        beats = (seconds / beat_seconds) if beat_seconds else None
        if seconds < thresholds.max_clash_seconds:
            why = f"{seconds:.1f}s — short enough to be a passing or approach tone."
            severe = False
        elif beats is not None and beats < 1.0:
            why = (f"{seconds:.1f}s but under one beat at {bpm:.0f} BPM — still transit, "
                   "not a destination.")
            severe = False
        else:
            beat_note = f" ({beats:.1f} beats)" if beats is not None else ""
            why = (f"{seconds:.1f}s{beat_note} on the band's weakest pitch classes, unresolved — "
                   "long enough that a listener lands on it.")
            severe = True
        out.append({"from_s": round(float(start), 1), "to_s": round(float(stop), 1),
                    "seconds": seconds, "beats": None if beats is None else round(beats, 2),
                    "severe": severe, "why": why})
    return out
