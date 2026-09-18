"""Calibration for the intonation module, against signals of known pitch.

A pitch measurement nobody has calibrated is an opinion. Every test here builds
a tone whose exact frequency is known, measures it the way the analyser measures
real audio, and checks the answer against arithmetic rather than against
whatever the code happened to produce.

Two of them exist because of a specific mistake: reporting a note 70 cents sharp
as 30 cents flat, because distance to the nearest semitone cannot exceed 50 and
the sign flips as it crosses. Those two tests fail if that ever comes back.
"""

from __future__ import annotations

import math
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
import intonation as it  # noqa: E402

SR = 44100
FAILURES: list = []


def check(name: str, condition: bool, detail: str = "") -> None:
    if condition:
        print(f"  ok   {name}")
    else:
        FAILURES.append(f"{name}{': ' + detail if detail else ''}")
        print(f"  FAIL {name}{': ' + detail if detail else ''}")


def tone(frequency_hz: float, seconds: float = 1.0, *, cents_per_second: float = 0.0,
         vibrato_hz: float = 0.0, vibrato_cents: float = 0.0) -> np.ndarray:
    """A sine whose pitch is known exactly, optionally drifting or wobbling."""
    t = np.arange(int(SR * seconds)) / SR
    offset = cents_per_second * t
    if vibrato_hz:
        offset = offset + vibrato_cents * np.sin(2 * np.pi * vibrato_hz * t)
    instantaneous = frequency_hz * np.power(2.0, offset / 1200.0)
    phase = 2 * np.pi * np.cumsum(instantaneous) / SR
    return (0.5 * np.sin(phase)).astype(np.float32)


#: The analyser's own window. Long, for sub-cent precision on a steady note.
LONG_WINDOW = 16384
#: Short enough to see a vibrato cycle, at the cost of frequency precision.
SHORT_WINDOW = 2048


def track(signal: np.ndarray, hop: int = 512, n: int = LONG_WINDOW):
    """Measure a signal the way the analyser does: long-window spectral peak."""
    window = np.hanning(n).astype(np.float32)
    times, freqs = [], []
    for start in range(0, len(signal) - n, hop):
        spectrum = np.abs(np.fft.rfft(signal[start:start + n] * window))
        k = int(np.argmax(spectrum[1:])) + 1
        if k < 1 or k >= len(spectrum) - 1:
            continue
        a, b, c = (math.log(spectrum[k - 1] + 1e-12), math.log(spectrum[k] + 1e-12),
                   math.log(spectrum[k + 1] + 1e-12))
        delta = 0.5 * (a - c) / (a - 2 * b + c + 1e-12)
        freqs.append((k + delta) * SR / n)
        times.append((start + n / 2) / SR)
    return np.array(times), np.array(freqs), np.ones(len(freqs), dtype=bool)


A4 = 440.0
def detuned(reference: float, cents_off: float) -> float:
    return reference * (2.0 ** (cents_off / 1200.0))


print("cents(), the unbounded primitive")
check("a perfectly tuned note is 0 cents", abs(it.cents(A4, A4)) < 1e-9)
check("70 cents sharp reads +70, not -30",
      abs(it.cents(detuned(A4, 70), A4) - 70) < 0.01,
      f"got {it.cents(detuned(A4, 70), A4):+.2f}")
check("70 cents flat reads -70, not +30",
      abs(it.cents(detuned(A4, -70), A4) + 70) < 0.01,
      f"got {it.cents(detuned(A4, -70), A4):+.2f}")
check("150 cents sharp reads +150", abs(it.cents(detuned(A4, 150), A4) - 150) < 0.01)

print("\ngrid_deviation_cents(), and its documented bound")
check("a note on the grid deviates 0", abs(it.grid_deviation_cents(69.0)) < 1e-9)
check("25 cents sharp reads +25", abs(it.grid_deviation_cents(69.25) - 25) < 1e-9)
check("70 cents sharp DOES fold to -30, which is why it is not used alone",
      abs(it.grid_deviation_cents(69.70) + 30) < 1e-9,
      f"got {it.grid_deviation_cents(69.70):+.2f}")
check("the bound is never exceeded, for any input",
      all(abs(it.grid_deviation_cents(69 + k / 97)) <= 50.0000001 for k in range(400)))

print("\nmeasuring real signals of known pitch")
for offset in (0, 12, 25, 40):
    times, freqs, voiced = track(tone(detuned(A4, offset), 2.0))
    report = it.measure(times, freqs, voiced, 2.0,
                        reference_hz=np.full(len(freqs), A4), isolated_vocal=True)
    check(f"a tone {offset:+3d} cents off is measured as {offset:+d}",
          report.reference_median_cents is not None
          and abs(report.reference_median_cents - offset) < 2.0,
          f"got {report.reference_median_cents}")

print("\nthe case the bounded measure gets wrong, and the reference gets right")
times, freqs, voiced = track(tone(detuned(A4, 70), 2.0))
report = it.measure(times, freqs, voiced, 2.0,
                    reference_hz=np.full(len(freqs), A4), isolated_vocal=True)
check("70 sharp against a known reference reports ~+70",
      abs(report.reference_median_cents - 70) < 2.0, f"got {report.reference_median_cents}")
check("the same signal's grid figure reports ~-30, as the bound requires",
      abs(report.grid_median_cents - 30) < 2.0, f"got {report.grid_median_cents}")
check("the report says the grid figure is bounded",
      any("bounded" in line for line in report.limitations))

times, freqs, voiced = track(tone(detuned(A4, -70), 2.0))
report = it.measure(times, freqs, voiced, 2.0,
                    reference_hz=np.full(len(freqs), A4), isolated_vocal=True)
check("70 flat against a known reference reports ~-70",
      abs(report.reference_median_cents + 70) < 2.0, f"got {report.reference_median_cents}")

print("\ndrift, and not mistaking vibrato for it")
times, freqs, voiced = track(tone(A4, 2.0, cents_per_second=20.0))
report = it.measure(times, freqs, voiced, 2.0, isolated_vocal=True)
check("a note sharpening 20 cents per second over 2 s drifts about +40",
      report.notes and abs(report.note_drift_median_cents - 40) < 10,
      f"got {report.note_drift_median_cents}")

wobble = tone(A4, 2.0, vibrato_hz=6.0, vibrato_cents=30.0)

# With the analyser's own long window the wobble is real but its depth is not
# measurable: 16384 samples span more than two cycles of a 6 Hz vibrato.
times, freqs, voiced = track(wobble, n=LONG_WINDOW)
report = it.measure(times, freqs, voiced, 2.0, isolated_vocal=True,
                    analysis_window_seconds=LONG_WINDOW / SR)
note = report.notes[0] if report.notes else None
check("6 Hz vibrato is detected at about 6 Hz",
      note is not None and note.vibrato_rate_hz is not None
      and abs(note.vibrato_rate_hz - 6.0) < 1.5,
      f"got {note.vibrato_rate_hz if note else None}")
check("with a window too long to see it, the extent is withheld, not guessed",
      note is not None and note.vibrato_extent_cents is None,
      f"got {note.vibrato_extent_cents if note else None}")
check("and the report says why",
      any("averaged away" in line for line in report.limitations))
check("vibrato is recognised as human, not flagged as a fault",
      note is not None and note.vibrato_is_human)
check("a steady note that only wobbles is not accused of drifting",
      note is not None and abs(note.drift_cents) < 15, f"got {note.drift_cents if note else None}")

# With a window short enough to resolve a cycle, the depth comes back right.
times, freqs, voiced = track(wobble, hop=256, n=SHORT_WINDOW)
report = it.measure(times, freqs, voiced, 2.0, isolated_vocal=True,
                    analysis_window_seconds=SHORT_WINDOW / SR)
note = report.notes[0] if report.notes else None
check("with a short enough window the extent measures about 30 cents",
      note is not None and note.vibrato_extent_cents is not None
      and abs(note.vibrato_extent_cents - 30) < 10,
      f"got {note.vibrato_extent_cents if note else None}")

print("\nnot enough to say anything")
report = it.measure(np.array([0.0, 0.01]), np.array([440.0, 440.0]),
                    np.array([True, True]), 290.0, isolated_vocal=True)
check("two frames produce no summary", report.grid_median_cents is None)
check("and the confidence says so", report.confidence == "insufficient")
check("and the reason is stated", any("required" in line for line in report.limitations))

report = it.measure(np.array([]), np.array([]), np.array([], dtype=bool), 290.0)
check("an empty region does not raise", report.frames == 0 and not report.sufficient)

print("\ncoverage and contamination are always reported")
times, freqs, voiced = track(tone(A4, 2.0))
report = it.measure(times, freqs, voiced, 290.0)
check("coverage is the analysed share of the whole track",
      report.coverage_percent < 1.0 and report.analysed_seconds > 0,
      f"{report.coverage_percent:.2f}% of {report.track_seconds}s")
check("a mix measurement is marked contaminated by default", report.contaminated)
check("and says why", "isolated vocal" in report.contamination_note)
check("and its confidence is downgraded for it", report.confidence.startswith("low"))
check("an isolated vocal is not marked contaminated",
      not it.measure(times, freqs, voiced, 290.0, isolated_vocal=True).contaminated)

print("\nnote choice, which the grid measure cannot see")
g_major = {7, 9, 11, 0, 2, 4, 6}
check("a note on the grid but outside the key is counted as outside",
      abs(it.scale_membership([70.0], g_major) - 0.0) < 1e-9)   # A# / Bb
check("a note in the key is counted as inside",
      abs(it.scale_membership([69.0], g_major) - 100.0) < 1e-9)  # A
check("a perfectly tuned wrong note scores 0 on the grid and 0 on membership",
      abs(it.grid_deviation_cents(70.0)) < 1e-9
      and abs(it.scale_membership([70.0], g_major)) < 1e-9)

print()
if FAILURES:
    print(f"{len(FAILURES)} FAILED:")
    for failure in FAILURES:
        print(f"  - {failure}")
    sys.exit(1)
print("all intonation tests passed")
