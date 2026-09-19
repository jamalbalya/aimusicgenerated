#!/usr/bin/env python3
"""The real-song regression: a 72 BPM plan must not be forced onto a 98 BPM song.

    python3 poc/zerogpu-space/regression_real_song.py

Runs against `fixtures/real/tetap-memilihmu.mp3`, a real ACE-Step generation
asked for at 72 BPM that came back at 98.4. Everything here is measured from
those bytes; nothing is asserted from the earlier analysis by hand.

What it demonstrates, in the order the architecture needs it:

    1. the tempo actually generated
    2. the tempo that was requested
    3. TEMPO_MISMATCH detected, not assumed
    4. the drift that mismatch puts between plan and performance
    5. PITCH_CORRECTION_NOT_AUTHORIZED, and the audio returned untouched

The last one is the point. Forcing a correction here would move the vocal toward
notes belonging to a different part of the song, and nothing downstream could
tell — every planned note would still find a partner, just the wrong one.

Needs numpy, scipy and a decoder for MP3 (soundfile, or ffmpeg on the path).
"""

from __future__ import annotations

import os
import subprocess
import sys
import tempfile
import wave

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import tempo as T  # noqa: E402
import vocal_pitch as V  # noqa: E402

FIXTURE = os.path.join(HERE, "fixtures", "real", "tetap-memilihmu.mp3")
REQUESTED_BPM = 72.0

#: Measured once, from these exact bytes, and pinned so a change is visible.
EXPECTED_DURATION_S = 267.02
EXPECTED_BPM = 98.44
BPM_TOLERANCE = 2.0

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


def load(path: str) -> tuple[np.ndarray, int]:
    """Decodes the fixture to mono float, without modifying it."""
    try:
        import soundfile as sf

        data, rate = sf.read(path, always_2d=True)
        return data.mean(axis=1), int(rate)
    except Exception:
        pass
    with tempfile.TemporaryDirectory() as folder:
        out = os.path.join(folder, "decoded.wav")
        subprocess.run(["ffmpeg", "-v", "error", "-i", path, "-ac", "1", out],
                       check=True, timeout=600)
        with wave.open(out, "rb") as handle:
            rate = handle.getframerate()
            frames = handle.readframes(handle.getnframes())
    return np.frombuffer(frames, dtype="<i2").astype(np.float64) / 32768.0, rate


def main() -> int:
    if not os.path.exists(FIXTURE):
        print(f"missing fixture: {FIXTURE}")
        return 2
    audio, rate = load(FIXTURE)
    duration = audio.size / rate

    print("\n=== 1 & 2: what was asked for, and what came back ===")
    check("the fixture decodes", audio.size > 0, f"{duration:.2f}s at {rate} Hz")
    check(f"duration is {EXPECTED_DURATION_S}s", abs(duration - EXPECTED_DURATION_S) < 0.5,
          f"{duration:.3f}s")
    reading = T.measure_tempo(audio, rate, requested_bpm=REQUESTED_BPM)
    print(f"       requested {REQUESTED_BPM:.0f} BPM")
    print(f"       measured  {reading.comparable_bpm:.2f} BPM   (detected {reading.bpm:.2f}; "
          f"the same performance at the octave nearest the request)")
    print(f"       methods   {reading.methods}")
    print(f"       harmonics {reading.harmonics[:4]}")
    check("the tempo is measurable", reading.comparable_bpm > 0, f"{reading.comparable_bpm:.2f}")
    check(f"and measures {EXPECTED_BPM} BPM",
          abs(reading.comparable_bpm - EXPECTED_BPM) < BPM_TOLERANCE,
          f"{reading.comparable_bpm:.2f}")
    check("the three methods agree", len(reading.methods) == 3 and
          max(reading.methods.values()) / min(reading.methods.values()) - 1 <= T.METHOD_AGREEMENT,
          str(reading.methods))
    check("72 BPM is not among the candidates",
          all(abs(h - 72.0) > 3.0 for h in reading.harmonics),
          f"candidates {reading.harmonics[:5]} — so this is not a subdivision artefact")

    print("\n=== 3: the mismatch is detected, not assumed ===")
    check("verdict is TEMPO_MISMATCH", reading.verdict == T.TEMPO_MISMATCH, reading.verdict)
    check("the ratio is reported", reading.ratio is not None and reading.ratio > 1.3,
          f"{reading.ratio:.4f}")
    check("the tempo itself is steady, so this is a wrong tempo and not an unstable one",
          reading.local_drift <= T.LOCAL_DRIFT_TOLERANCE,
          f"local drift {reading.local_drift * 100:.1f}%")

    print("\n=== 4: the drift that mismatch puts between plan and performance ===")
    for at in (30.0, 60.0, 120.0, 267.0):
        print(f"       a note planned at {at:5.0f}s belongs "
              f"{T.drift_seconds(reading, at):+6.1f}s from where the plan puts it")
    check("drift exceeds the alignment's offset search well before the song ends",
          T.drift_seconds(reading, 60.0) > T.OFFSET_SEARCH_SECONDS
          if hasattr(T, "OFFSET_SEARCH_SECONDS") else
          T.drift_seconds(reading, 60.0) > V.OFFSET_SEARCH_SECONDS,
          f"{T.drift_seconds(reading, 60.0):.1f}s at plan t=60s against a "
          f"{V.OFFSET_SEARCH_SECONDS:.0f}s search window")
    planned_bars = duration / (4 * 60 / REQUESTED_BPM)
    actual_bars = duration / (4 * 60 / reading.comparable_bpm)
    print(f"       the plan budgets {planned_bars:.0f} bars; the song has {actual_bars:.0f}")
    check("the plan and the song do not even have the same number of bars",
          abs(planned_bars - actual_bars) > 20, f"{planned_bars:.0f} against {actual_bars:.0f}")

    print("\n=== 5: correction is refused, and the audio is returned untouched ===")
    # A plan laid out on the requested tempo's grid over the song's own length.
    # Its pitches do not matter here: what is on trial is its timeline.
    beat = 60.0 / REQUESTED_BPM
    plan = []
    at, index = 0.0, 0
    while at < duration:
        plan.append(V.TargetNote(at, at + beat * 0.9, 57 + (index % 5),
                                 V.ROLE_ANCHOR, index // 8))
        at += beat
        index += 1
    print(f"       plan: {len(plan)} notes laid out at {REQUESTED_BPM:.0f} BPM")

    verdict, why = V.authorize_correction(reading, plan)
    check("authorization is PITCH_CORRECTION_NOT_AUTHORIZED",
          verdict == V.CORRECTION_NOT_AUTHORIZED, verdict)
    for reason in why:
        print(f"       - {reason}")

    out, report = V.process_song(audio, rate, plan, device="cpu",
                                 requested_bpm=REQUESTED_BPM)
    check("process_song returns the song exactly as it arrived", np.array_equal(out, audio))
    check("no note was corrected", report.notes_corrected == 0, str(report.notes_corrected))
    check("the report says TEMPO_MISMATCH", report.tempo_verdict == T.TEMPO_MISMATCH,
          report.tempo_verdict)
    check("the report says PITCH_CORRECTION_NOT_AUTHORIZED",
          report.authorization == V.CORRECTION_NOT_AUTHORIZED, report.authorization)
    check("trust is UNVERIFIED and is never upgraded", report.trust == "UNVERIFIED",
          report.trust)
    check("the requested and measured tempi are both in the report",
          report.requested_bpm == REQUESTED_BPM and report.measured_bpm > 90,
          f"requested {report.requested_bpm}, measured {report.measured_bpm}")

    print(f"\n{PASSED} passed, {len(FAILED)} failed")
    if FAILED:
        for name in FAILED:
            print(f"  - {name}")
        return 1
    print("\nTEMPO_MISMATCH / ALIGNMENT_UNTRUSTWORTHY / PITCH_CORRECTION_NOT_AUTHORIZED")
    print("This is the expected outcome for this fixture, and it is a safety result,")
    print("not a failure: the song is returned exactly as ACE-Step made it.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
