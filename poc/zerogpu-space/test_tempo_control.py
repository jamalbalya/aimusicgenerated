"""Tests for tempo control, tempo verification, and the correction gate.

One test per claim, and the claims are the ones the architecture now rests on:

  PHASE 1  a requested tempo reaches `GenerationParams.bpm`, not the caption
  PHASE 2  the tempo a song actually came out at is measured independently
  PHASE 3  a stable global ratio is established before anything is warped
  PHASE 4  each sung line carries an alignment confidence
  PHASE 5  correction is refused unless the plan describes the performance

Run: python3 poc/zerogpu-space/test_tempo_control.py
"""

from __future__ import annotations

import math
import sys

import numpy as np

sys.path.insert(0, __file__.rsplit("/", 1)[0])

import generation_params as GP  # noqa: E402
import tempo as T  # noqa: E402
import vocal_pitch as V  # noqa: E402

SR = 22050
PASSED = 0
FAILED: list[str] = []


def check(name: str, condition: bool, detail: str = "") -> None:
    global PASSED
    if condition:
        PASSED += 1
        print(f"  ok   {name}" + (f"  ({detail})" if detail else ""))
    else:
        FAILED.append(name)
        print(f"  FAIL {name}" + (f"  ({detail})" if detail else ""))


def click_track(bpm: float, seconds: float, sample_rate: int = SR,
                drift_to: float | None = None) -> np.ndarray:
    """A pulse train at `bpm`, optionally drifting linearly to `drift_to`."""
    total = int(seconds * sample_rate)
    out = np.zeros(total)
    generator = np.random.default_rng(5)
    position, elapsed = 0.0, 0.0
    while position < total:
        length = min(int(0.05 * sample_rate), total - int(position))
        if length <= 0:
            break
        start = int(position)
        envelope = np.exp(-np.linspace(0, 8, length))
        out[start:start + length] += generator.normal(0, 0.6, length) * envelope
        # A pitched body, so this is a note and not only a transient.
        t = np.arange(length) / sample_rate
        out[start:start + length] += 0.4 * np.sin(2 * np.pi * 220 * t) * envelope
        elapsed = position / sample_rate
        current = bpm if drift_to is None else bpm + (drift_to - bpm) * (elapsed / seconds)
        position += 60.0 / current * sample_rate
    return out


# ---------------------------------------------------------------- PHASE 1 ---

print("\n=== PHASE 1: the requested tempo reaches GenerationParams.bpm ===")

params = GP.build_generation_params(
    caption="Romantic melancholic pop ballad, 72 BPM, warm soulful vocal",
    lyrics="[Verse 1]\nbaris pertama", instrumental=False, language="id",
    duration=210.0, bpm=72, keyscale="G Minor", timesignature="4")
check("72 lands in the bpm field", params["bpm"] == 72, f"params['bpm'] = {params['bpm']!r}")
check("as an int, which is what the field takes", isinstance(params["bpm"], int),
      type(params["bpm"]).__name__)
check("the keyscale field carries the key", params["keyscale"] == "G Minor")
check("the time signature is its own field", params["timesignature"] == "4")
check("the caption is passed through unedited",
      params["caption"].startswith("Romantic melancholic pop ballad, 72 BPM"))
check("the lyric sheet is passed through unedited",
      params["lyrics"] == "[Verse 1]\nbaris pertama")
check("the LM may not rewrite the caption or the lyrics",
      params["use_cot_caption"] is False and params["use_cot_lyrics"] is False)

# The tempo must be a real field and not merely words in the caption: a caption
# reaches the text encoder, `bpm` reaches the metadata the precedence rule
# reads, and only the second is protected from the model's own estimate.
caption_only = GP.build_generation_params(
    caption="a ballad at 72 BPM", lyrics="la", instrumental=False, language="en",
    duration=100.0, bpm=None)
check("a tempo mentioned only in the caption leaves bpm unset",
      caption_only["bpm"] is None,
      "so 'it says 72 in the style' is not tempo control")

print("\n--- values that must not be mistaken for a tempo ---")
for given, want, why in ((0, None, "zero is not a tempo, and 0 reads as unset to ACE-Step"),
                         (-1, None, "negative"), (None, None, "nothing requested"),
                         (True, None, "a bool is not a tempo"),
                         ("72", 72, "a numeric string still means 72"),
                         (71.6, 72, "rounded to the int the field takes"),
                         (5, 30, "clamped up to the documented minimum"),
                         (400, 300, "clamped down to the documented maximum")):
    got = GP.normalise_bpm(given)
    check(f"bpm {given!r} -> {want!r}", got == want, why)

# ---------------------------------------------------------------- PHASE 2 ---

print("\n=== PHASE 2: the tempo actually generated is measured independently ===")

for bpm in (72.0, 96.0, 120.0):
    reading = T.measure_tempo(click_track(bpm, 40.0), SR, requested_bpm=bpm)
    error = abs(reading.comparable_bpm - bpm) / bpm * 100 if reading.comparable_bpm else 999
    check(f"a {bpm:.0f} BPM track measures {bpm:.0f}", error < 3.0,
          f"{reading.comparable_bpm:.2f} BPM, {error:.1f}% out, methods {reading.methods}")
    check(f"  ... and is classified TEMPO_OK", reading.verdict == T.TEMPO_OK,
          f"{reading.verdict}")

print("\n--- a tempo that is not what was asked for ---")
mismatch = T.measure_tempo(click_track(99.0, 40.0), SR, requested_bpm=72)
check("99 against a requested 72 is TEMPO_MISMATCH", mismatch.verdict == T.TEMPO_MISMATCH,
      f"{mismatch.verdict}, measured {mismatch.comparable_bpm:.1f}, ratio {mismatch.ratio}")
check("and the ratio is reported", mismatch.ratio is not None and mismatch.ratio > 1.3,
      f"ratio {mismatch.ratio}")
check("and the drift it implies is computable",
      T.drift_seconds(mismatch, 60) > 10,
      f"a note planned at 60s belongs {T.drift_seconds(mismatch, 60):.1f}s earlier")

print("\n--- three methods, so one opinion is not a measurement ---")
reading = T.measure_tempo(click_track(84.0, 40.0), SR, requested_bpm=84)
check("all three methods answer", len(reading.methods) == 3, str(reading.methods))
values = [v for v in reading.methods.values() if v > 0]
spread = max(values) / min(values) - 1 if len(values) > 1 else 0
check("and they agree", spread <= T.METHOD_AGREEMENT, f"spread {spread * 100:.1f}%")

noise = np.random.default_rng(3).normal(0, 0.2, int(20 * SR))
unmeasurable = T.measure_tempo(noise, SR, requested_bpm=72)
check("noise is not given a tempo",
      unmeasurable.verdict in (T.TEMPO_UNMEASURABLE, T.TEMPO_UNSTABLE),
      f"{unmeasurable.verdict}")

# ---------------------------------------------------------------- PHASE 3 ---

print("\n=== PHASE 3: a stable ratio is established before anything is warped ===")

steady = T.measure_tempo(click_track(90.0, 60.0), SR, requested_bpm=90)
check("a steady tempo reports little drift", steady.local_drift < T.LOCAL_DRIFT_TOLERANCE,
      f"{steady.local_drift * 100:.1f}%")

# A tempo that runs away entirely: the three global methods stop agreeing, so
# it is refused before the local-drift test is even reached. That is the right
# outcome but it does not exercise drift detection, so it is asserted for what
# it is and a gentler case follows.
wild = T.measure_tempo(click_track(80.0, 90.0, drift_to=110.0), SR, requested_bpm=80)
check("a tempo that runs away is refused", wild.verdict == T.TEMPO_UNMEASURABLE,
      f"{wild.verdict}: the methods stop agreeing before drift is even measured")

# A mild drift: slow enough that the global methods still agree on a number, so
# the local-drift test is the only thing standing between it and a warp.
mild = T.measure_tempo(click_track(90.0, 120.0, drift_to=99.0), SR, requested_bpm=90)
check("a mild drift is still measured globally", mild.bpm > 0, f"{mild.bpm:.2f} BPM")
check("but the local drift is seen", mild.local_drift > T.LOCAL_DRIFT_TOLERANCE,
      f"{mild.local_drift * 100:.1f}% across the song, tolerance "
      f"{T.LOCAL_DRIFT_TOLERANCE * 100:.0f}%")
check("and it is classified TEMPO_UNSTABLE", mild.verdict == T.TEMPO_UNSTABLE, mild.verdict)
check("so one ratio is never applied to a tempo that moves",
      V.authorize_correction(mild, good_plan_placeholder := [
          V.TargetNote(0.0, 1.0, 60, V.ROLE_ANCHOR, 0)])[0] == V.CORRECTION_NOT_AUTHORIZED)

print("\n--- warping moves the times and never the notes ---")
plan = [V.TargetNote(0.0, 1.0, 60, V.ROLE_ANCHOR, 0),
        V.TargetNote(1.0, 2.0, 62, V.ROLE_ANCHOR, 0)]
warped = V.warp_targets(plan, 1.25)
check("times are divided by the ratio",
      abs(warped[1].start_seconds - 0.8) < 1e-9, f"{warped[1].start_seconds}")
check("pitches are untouched", [n.midi for n in warped] == [60, 62])
check("a ratio of 1 changes nothing",
      [n.start_seconds for n in V.warp_targets(plan, 1.0)] == [0.0, 1.0])

# ---------------------------------------------------------------- PHASE 4 ---

print("\n=== PHASE 4: every sung line carries an alignment confidence ===")


def voice(hz: float, seconds: float, sample_rate: int = SR) -> np.ndarray:
    t = np.arange(int(seconds * sample_rate)) / sample_rate
    out = np.zeros_like(t)
    for harmonic in range(1, 16):
        if hz * harmonic > sample_rate / 2.2:
            break
        out += np.sin(2 * np.pi * hz * harmonic * t) / harmonic ** 1.6
    return out / np.max(np.abs(out)) * 0.5


def silence(seconds: float) -> np.ndarray:
    return np.zeros(int(seconds * SR))


good_plan = [V.TargetNote(i * 0.5, i * 0.5 + 0.45, 57 + (i % 4), V.ROLE_ANCHOR, 0)
             for i in range(6)]
good_audio = np.concatenate([
    np.concatenate([voice(V.midi_to_hz(t.midi), 0.45), silence(0.05)]) for t in good_plan])
V.align(V.segment_notes(V.detect_f0(good_audio, SR)), good_plan)
scores = list(V._LAST_PHRASE_SCORES)
check("a line that matches gets a confidence", len(scores) >= 1 and scores[0].confidence > 0.5,
      f"{scores[0].confidence if scores else 'none'}")
check("and is trusted", bool(scores) and scores[0].trusted)
check("and reports how much of the plan it matched",
      bool(scores) and scores[0].matched_notes > 0,
      f"{scores[0].matched_notes}/{scores[0].planned_notes}" if scores else "")

# A line whose plan sits somewhere else entirely.
far_plan = [V.TargetNote(60 + i * 0.5, 60 + i * 0.5 + 0.45, 57, V.ROLE_ANCHOR, 0)
            for i in range(6)]
V.align(V.segment_notes(V.detect_f0(good_audio, SR)), far_plan)
far_scores = list(V._LAST_PHRASE_SCORES)
check("a line matched to the wrong place is not trusted",
      all(not s.trusted for s in far_scores) or not far_scores,
      f"{[round(s.confidence, 2) for s in far_scores]}")

# ---------------------------------------------------------------- PHASE 5 ---

print("\n=== PHASE 5: correction is refused unless the plan fits the performance ===")

ok_reading = T.measure_tempo(click_track(72.0, 40.0), SR, requested_bpm=72)
verdict, why = V.authorize_correction(ok_reading, good_plan)
check("a matching tempo authorises correction", verdict == V.CORRECTION_AUTHORIZED,
      f"{verdict}: {why[:1]}")

verdict, why = V.authorize_correction(mismatch, good_plan)
check("a 37% tempo error does NOT authorise correction",
      verdict == V.CORRECTION_NOT_AUTHORIZED, f"{verdict}")
check("and the reason names the structural problem",
      any("different part of the song" in r or "arrangement" in r for r in why),
      why[-1] if why else "")

verdict, why = V.authorize_correction(None, good_plan)
check("no tempo measurement means no authorisation",
      verdict == V.CORRECTION_NOT_AUTHORIZED, verdict)

verdict, why = V.authorize_correction(ok_reading, [])
check("no target melody means no authorisation",
      verdict == V.CORRECTION_NOT_AUTHORIZED, verdict)

small = T.measure_tempo(click_track(76.0, 40.0), SR, requested_bpm=72)
verdict, why = V.authorize_correction(small, good_plan)
check("a small, stable difference is warped rather than refused",
      verdict == V.CORRECTION_AUTHORIZED,
      f"{verdict}, ratio {small.ratio:.3f} (limit {V.TEMPO_WARP_LIMIT:.0%})")

print("\n--- and the gate is enforced by process_song, not merely offered ---")
mixed = np.concatenate([click_track(99.0, 20.0)[:int(20 * SR)]])
out, report = V.process_song(mixed, SR, good_plan, device="cpu", requested_bpm=72)
check("a mismatched song is returned untouched", np.array_equal(out, mixed))
check("with PITCH_CORRECTION_NOT_AUTHORIZED",
      report.authorization == V.CORRECTION_NOT_AUTHORIZED, report.authorization)
check("and TEMPO_MISMATCH recorded", report.tempo_verdict == T.TEMPO_MISMATCH,
      report.tempo_verdict)
check("and trust UNVERIFIED, never a pass", report.trust == "UNVERIFIED", report.trust)
check("and nothing corrected", report.notes_corrected == 0, str(report.notes_corrected))

print(f"\n{PASSED} passed, {len(FAILED)} failed")
if FAILED:
    for name in FAILED:
        print(f"  - {name}")
    sys.exit(1)
