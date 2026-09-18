"""The tempo gate, on audio whose tempo is known because it was constructed.

Every fixture here is a click track at an exact BPM, so a disagreement is the
estimator's and not the material's. That matters more than it sounds: the first
implementation used librosa's beat tracker, which reports from a fixed grid of
candidate tempos and answered 117.45 for a 120 BPM track and 143.55 for a 140
one. Against a 2 BPM tolerance the estimator alone would have failed songs that
were exactly right, and every one of those failures would have been blamed on
the model.
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
import pipeline  # noqa: E402
import requirements as req  # noqa: E402
import tempo as tempo_module  # noqa: E402

SR = 22050
FAILURES: list = []

#: The tempos this gate is calibrated against: a slow ballad through to drum and
#: bass, including the 72 the failing song asked for and the 89-90 it produced.
CALIBRATION_BPMS = [60, 66, 72, 80, 90, 100, 110, 120, 128, 140, 160]


def check(name: str, condition: bool, detail: str = "") -> None:
    if condition:
        print(f"  ok   {name}")
    else:
        FAILURES.append(f"{name}{': ' + detail if detail else ''}")
        print(f"  FAIL {name}{': ' + detail if detail else ''}")


def clicks(bpm: float, seconds: float = 40.0, jitter: float = 0.0, seed: int = 0):
    """A click track. `jitter` moves each beat, for the unstable-tempo case."""
    rng = np.random.default_rng(seed)
    total = int(seconds * SR)
    out = np.zeros(total, dtype="float32")
    step = 60.0 / bpm
    envelope = np.exp(-np.arange(400) / 60.0)
    tone = (envelope * np.sin(2 * np.pi * 180 * np.arange(400) / SR)).astype("float32")
    position = 0.0
    while position < seconds:
        at = int((position + (rng.normal(0, jitter) if jitter else 0.0)) * SR)
        if 0 <= at and at + len(tone) < total:
            out[at:at + len(tone)] += tone
        position += step
    return out


def accelerating(start_bpm: float, end_bpm: float, seconds: float = 60.0):
    """A track that speeds up across its length. No single tempo describes it."""
    total = int(seconds * SR)
    out = np.zeros(total, dtype="float32")
    envelope = np.exp(-np.arange(400) / 60.0)
    tone = (envelope * np.sin(2 * np.pi * 180 * np.arange(400) / SR)).astype("float32")
    position = 0.0
    while position < seconds:
        share = position / seconds
        bpm = start_bpm + (end_bpm - start_bpm) * share
        at = int(position * SR)
        if at + len(tone) < total:
            out[at:at + len(tone)] += tone
        position += 60.0 / bpm
    return out


print("every calibration tempo is measured accurately enough to gate on")
for wanted in CALIBRATION_BPMS:
    measured = tempo_module.detect_tempo(clicks(wanted), SR)
    error = abs(measured.bpm - wanted) if measured.bpm else float("inf")
    check(f"{wanted} BPM is measured within tolerance", error <= 2.0,
          f"measured {measured.bpm} ({error:.2f} out)")

print("\nan exact match passes at every calibration tempo")
for wanted in CALIBRATION_BPMS:
    result = tempo_module.check_tempo(
        tempo_module.detect_tempo(clicks(wanted), SR), req.TempoRequirement(wanted))
    check(f"{wanted} BPM requested and delivered", result.passed and result.reason == "ok",
          f"{result.reason}: {result.detail}")

print("\ninside the tolerance passes, outside it does not")
measured = tempo_module.detect_tempo(clicks(120), SR)
check("a request 1 BPM away still passes",
      tempo_module.check_tempo(measured, req.TempoRequirement(121)).passed)
outside = tempo_module.check_tempo(measured, req.TempoRequirement(112))
check("a request 8 BPM away does not", not outside.passed)
check("and it is named a tempo mismatch", outside.reason == "tempo_mismatch", outside.reason)
check("and says by how much", "8" in outside.detail or "7" in outside.detail, outside.detail)

print("\noctave errors are reported, never silently accepted")
half = tempo_module.check_tempo(
    tempo_module.detect_tempo(clicks(70), SR), req.TempoRequirement(140))
check("a track at half the requested tempo is refused", not half.passed)
check("and is named half_time rather than a generic mismatch",
      half.reason == "half_time", half.reason)
double = tempo_module.check_tempo(
    tempo_module.detect_tempo(clicks(160), SR), req.TempoRequirement(80))
check("a track at twice the requested tempo is refused", not double.passed)
check("and is named double_time", double.reason == "double_time", double.reason)
check("the refusal explains why it is not resolved for you",
      "tell the two apart" in half.detail or "identical from here" in half.detail, half.detail)
allowed = tempo_module.check_tempo(
    tempo_module.detect_tempo(clicks(70), SR), req.TempoRequirement(140),
    accept_octave_errors=True)
check("a policy may accept them, and then says it did",
      allowed.passed and "policy" in allowed.detail, allowed.detail)

print("\ntempo that cannot be measured is not tempo that failed")
silence = np.zeros(SR * 30, dtype="float32")
quiet = tempo_module.detect_tempo(silence, SR)
check("silence yields no tempo", not quiet.available)
failed = tempo_module.check_tempo(quiet, req.TempoRequirement(120))
check("and the check fails as detection_failed", failed.reason == "detection_failed", failed.reason)
short = tempo_module.detect_tempo(np.zeros(SR * 2, dtype="float32"), SR)
check("audio too short yields no tempo", not short.available)

print("\nan unstable tempo is refused rather than averaged")
drifting = tempo_module.detect_tempo(accelerating(90, 130), SR)
check("a track that speeds up is not called stable", not drifting.stable,
      f"spread {drifting.spread_bpm}")
unstable = tempo_module.check_tempo(drifting, req.TempoRequirement(110))
check("and the check names it", unstable.reason == "unstable_tempo" and not unstable.passed,
      unstable.reason)

print("\nno tempo requested is not a tempo that passed")
none_asked = tempo_module.check_tempo(
    tempo_module.detect_tempo(clicks(100), SR), None)
check("the check passes", none_asked.passed)
check("but says it checked nothing", none_asked.reason == "not_requested")
check("and says so in words", "nobody asked" in none_asked.detail, none_asked.detail)

print("\ninvalid requests are refused before anything is generated")
for bad, why in ((0, "zero"), (-10, "negative"), (20, "below the practical range"),
                 (400, "above it"), (float("nan"), "not a number")):
    try:
        req.TempoRequirement(bad)
        check(f"{why} BPM is refused", False, "it was accepted")
    except req.InvalidRequirement:
        check(f"{why} BPM is refused", True)
try:
    req.TempoRequirement(120, 0)
    check("a zero tolerance is refused", False, "it was accepted")
except req.InvalidRequirement:
    check("a zero tolerance is refused", True)
check("the default tolerance is 2 BPM", req.DEFAULT_BPM_TOLERANCE == 2.0)

print("\nthe song that prompted all of this")
# Requested 72, measured 89.1 by the old analyser and 89.8 by this one. Either
# way it is roughly eighteen BPM out, and no tolerance worth the name absorbs it.
reported = tempo_module.TempoMeasurement(bpm=89.1, confidence=1.0, per_window=[89.1] * 10,
                                         spread_bpm=0.0, candidates=[89.1], stable=True)
actual = tempo_module.check_tempo(reported, req.TempoRequirement(72))
check("72 requested against 89.1 measured fails", not actual.passed)
check("as a tempo mismatch", actual.reason == "tempo_mismatch", actual.reason)
check("with the difference stated", actual.difference_bpm is not None
      and abs(actual.difference_bpm - 17.1) < 0.05, str(actual.difference_bpm))
check("and it is not an octave error, so it is not excused",
      tempo_module._octave_relation(89.1, 72) is None)

print("\nthe failure code the regeneration loop branches on")
check("TEMPO_MISMATCH exists and is retryable",
      pipeline.TEMPO_MISMATCH == "TEMPO_MISMATCH")
check("an unmeasurable tempo is a different code",
      pipeline.TEMPO_UNMEASURABLE != pipeline.TEMPO_MISMATCH)

print()
if FAILURES:
    print(f"{len(FAILURES)} FAILED:")
    for failure in FAILURES:
        print(f"  - {failure}")
    sys.exit(1)
print("all tempo tests passed")
