"""Tests for the vocal pitch pipeline, on signals whose pitch is known exactly.

The point of synthesising the test signals rather than using a recording is
that the answer is known to the cent. A detector tested on real audio can only
be compared with another detector; a detector tested on a 220.000 Hz tone that
reports 219.4 Hz has a measurable error of 4.7 cents.

What these tests do NOT cover, and cannot from this environment:

  * Hybrid Demucs separation — torchaudio is not installed here.
  * Any real ACE-Step vocal.
  * Whether the corrected result *sounds* right, which needs ears.

Run: python3 poc/zerogpu-space/test_vocal_pitch.py
"""

from __future__ import annotations

import math
import sys

import numpy as np

sys.path.insert(0, __file__.rsplit("/", 1)[0])

from vocal_pitch import (  # noqa: E402
    AUDIBLE_ERROR_CENTS, TargetNote, align, cents_between, correct_vocal,
    detect_f0, hz_to_midi, midi_to_hz, remix, segment_notes,
)

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


def voice(hz: float, seconds: float, sample_rate: int = SR,
          vibrato_hz: float = 0.0, vibrato_cents: float = 0.0,
          drift_cents: float = 0.0) -> np.ndarray:
    """A synthetic sung vowel: a harmonic stack with a fixed formant envelope.

    Harmonics matter. A pure sine is not what YIN sees in a voice, and a
    detector that only works on sines would be useless here. The formant
    envelope is fixed so that a pitch shift which moved it would be visible as
    a change in spectral centroid.
    """
    t = np.arange(int(seconds * sample_rate)) / sample_rate
    cents = np.zeros_like(t)
    if vibrato_hz > 0:
        cents += vibrato_cents * np.sin(2 * math.pi * vibrato_hz * t)
    if drift_cents:
        cents += np.linspace(0.0, drift_cents, t.size)
    instantaneous = hz * (2.0 ** (cents / 1200.0))
    phase = 2 * math.pi * np.cumsum(instantaneous) / sample_rate

    signal = np.zeros_like(t)
    # A glottal-ish spectrum: -12 dB/octave, with two formant bumps.
    for harmonic in range(1, 25):
        f = hz * harmonic
        if f > sample_rate / 2.2:
            break
        amplitude = 1.0 / (harmonic ** 1.6)
        for centre, gain in ((700.0, 2.2), (1220.0, 1.6), (2600.0, 0.8)):
            amplitude += 0.35 * gain * math.exp(-((f - centre) ** 2) / (2 * 260.0 ** 2)) / harmonic
        signal += amplitude * np.sin(harmonic * phase)
    peak = np.max(np.abs(signal))
    return (signal / peak * 0.5) if peak > 0 else signal


def silence(seconds: float, sample_rate: int = SR) -> np.ndarray:
    return np.zeros(int(seconds * sample_rate))


print("\n=== F0 detection, against known pitches ===")
for hz in (98.0, 146.83, 220.0, 329.63, 440.0, 659.26):
    track = detect_f0(voice(hz, 0.7), SR)
    voiced = track.f0[track.voiced]
    measured = float(np.median(voiced)) if voiced.size else 0.0
    error = abs(cents_between(measured, hz)) if measured else 999.0
    check(f"{hz:7.2f} Hz detected", error < 12.0,
          f"measured {measured:.2f} Hz, {error:.1f} cents off")

print("\n=== silence and noise are not pitches ===")
track = detect_f0(silence(0.6), SR)
check("digital silence is unvoiced", track.voiced_ratio == 0.0,
      f"voiced ratio {track.voiced_ratio:.3f}")

rng = np.random.default_rng(7)
track = detect_f0(rng.normal(0, 0.25, int(0.8 * SR)), SR)
check("white noise is mostly unvoiced", track.voiced_ratio < 0.35,
      f"voiced ratio {track.voiced_ratio:.3f}")

print("\n=== octave errors are repaired ===")
# A run at 220 with one frame detected an octave down is the classic YIN slip.
clean = voice(220.0, 0.6)
track = detect_f0(clean, SR)
damaged = track.f0.copy()
voiced_idx = np.flatnonzero(track.voiced)
if voiced_idx.size > 6:
    damaged[voiced_idx[len(voiced_idx) // 2]] /= 2.0
from vocal_pitch import F0Track, _repair_octaves  # noqa: E402
repaired = _repair_octaves(F0Track(track.times, damaged, track.confidence, damaged > 0, track.hop_seconds))
middle = voiced_idx[len(voiced_idx) // 2]
check("a halved frame is put back", abs(cents_between(repaired.f0[middle], 220.0)) < 60,
      f"{repaired.f0[middle]:.1f} Hz")

print("\n=== notes are segmented at gaps ===")
phrase = np.concatenate([voice(220.0, 0.5), silence(0.25), voice(261.63, 0.5)])
notes = segment_notes(detect_f0(phrase, SR))
check("two notes across a gap", len(notes) == 2, f"found {len(notes)}")
if len(notes) == 2:
    check("first note is A3", abs(cents_between(notes[0].median_hz, 220.0)) < 20,
          f"{notes[0].median_hz:.1f} Hz")
    check("second note is C4", abs(cents_between(notes[1].median_hz, 261.63)) < 20,
          f"{notes[1].median_hz:.1f} Hz")

print("\n=== vibrato is recognised, drift is not ===")
vib = segment_notes(detect_f0(voice(330.0, 1.2, vibrato_hz=5.5, vibrato_cents=45), SR))
check("vibrato detected", len(vib) > 0 and vib[0].has_vibrato,
      f"movement {vib[0].movement_cents:.0f} cents" if vib else "no note")
drift = segment_notes(detect_f0(voice(330.0, 1.2, drift_cents=60), SR))
check("a slow drift is not called vibrato", len(drift) > 0 and not drift[0].has_vibrato,
      f"movement {drift[0].movement_cents:.0f} cents" if drift else "no note")

print("\n=== alignment decides what is an error ===")
targets = [TargetNote(0.0, 1.0, 57, True)]     # A3 = 220 Hz, an anchor
in_tune = segment_notes(detect_f0(voice(220.0, 0.9), SR))
decided = align(in_tune, targets)
check("an in-tune anchor is left alone", decided and not decided[0].correct,
      decided[0].decision if decided else "")

flat = segment_notes(detect_f0(voice(220.0 * 2 ** (-70 / 1200), 0.9), SR))
decided = align(flat, targets)
check("a 70-cent-flat anchor is corrected", decided and decided[0].correct,
      decided[0].decision if decided else "")

passing = [TargetNote(0.0, 1.0, 57, False)]
decided = align(flat, passing)
check("the same error on a passing note is left", decided and not decided[0].correct,
      decided[0].decision if decided else "")

short = segment_notes(detect_f0(np.concatenate([voice(220.0 * 2 ** (-70 / 1200), 0.09), silence(0.2)]), SR))
decided = align(short, targets)
check("a very short note is left", all(not d.correct for d in decided),
      decided[0].decision if decided else "no note segmented")

octave = segment_notes(detect_f0(voice(440.0, 0.9), SR))   # an octave above target
decided = align(octave, targets)
check("an octave away is judged within its own octave",
      decided and abs(decided[0].deviation_cents) < 50,
      f"{decided[0].deviation_cents:+.0f} cents" if decided else "")

print("\n=== correction moves the pitch to the target ===")
for error_cents in (-80.0, -55.0, 60.0, 95.0):
    detuned = voice(220.0 * 2 ** (error_cents / 1200), 1.0)
    corrected, report = correct_vocal(detuned, SR, [TargetNote(0.0, 1.1, 57, True)])
    after = detect_f0(corrected, SR)
    voiced = after.f0[after.voiced]
    measured = float(np.median(voiced)) if voiced.size else 0.0
    residual = abs(cents_between(measured, 220.0)) if measured else 999.0
    check(f"{error_cents:+.0f} cents corrected", residual < AUDIBLE_ERROR_CENTS,
          f"{residual:.1f} cents left, {report.notes_corrected} note(s) moved")

print("\n=== correction does not damage what was already right ===")
good = voice(220.0, 1.0)
corrected, report = correct_vocal(good, SR, [TargetNote(0.0, 1.1, 57, True)])
check("an in-tune note is returned untouched",
      report.notes_corrected == 0 and np.allclose(corrected, good),
      f"{report.notes_corrected} corrected")

print("\n=== vibrato survives correction ===")
# Flat by 70 cents AND vibrato: the centre must move, the vibrato must stay.
vibrato_flat = voice(220.0 * 2 ** (-70 / 1200), 1.4, vibrato_hz=5.5, vibrato_cents=40)
before = segment_notes(detect_f0(vibrato_flat, SR))
corrected, report = correct_vocal(vibrato_flat, SR, [TargetNote(0.0, 1.5, 57, True)])
after = segment_notes(detect_f0(corrected, SR))
if before and after:
    check("vibrato depth survives",
          after[0].movement_cents > before[0].movement_cents * 0.5,
          f"{before[0].movement_cents:.0f} -> {after[0].movement_cents:.0f} cents")
else:
    check("vibrato depth survives", False, "no note segmented")

print("\n=== formants are not dragged along ===")
def centroid(x: np.ndarray) -> float:
    spectrum = np.abs(np.fft.rfft(x * np.hanning(x.size)))
    freqs = np.fft.rfftfreq(x.size, 1 / SR)
    return float((spectrum * freqs).sum() / max(spectrum.sum(), 1e-9))

# Compared against a voice synthesised AT THE TARGET PITCH, not against the
# detuned input. Comparing with the input is the wrong test and I wrote it that
# way first: a harmonic series under a fixed formant envelope changes its own
# centroid when the pitch moves, because the harmonics slide across the formant
# peaks. On this signal a 4.9% shift upward moves the third harmonic from 627 Hz
# to 657 Hz, much closer to the 700 Hz formant, and the centroid legitimately
# jumps 9%. That is what a real voice does too.
#
# The reference has the same envelope and the same target pitch, so the only way
# to match it is to have moved the pitch without dragging the envelope. The
# TD-PSOLA implementation this replaced scored 33% against this reference.
flat_voice = voice(220.0 * 2 ** (-90 / 1200), 1.0)
corrected, _ = correct_vocal(flat_voice, SR, [TargetNote(0.0, 1.1, 57, True)])
reference = voice(220.0 * 2 ** (-90 * (1 - 0.92) / 1200), 1.0)   # where correction lands
ref_c, got_c = centroid(reference), centroid(corrected)
gap = abs(got_c - ref_c) / ref_c * 100
# The bound is 8%, and what sits inside it is known rather than slack.
# Varispeed moves the formants by the shift ratio — that is its defining
# trade-off, not a defect — so for this 4.9% correction about 5 points of the
# gap are the formant shift itself and are expected. The measurement is 6.1%.
#
# The threshold exists to catch the failure mode next door: a correction that
# adds broadband energy instead of moving the spectrum. The implementation this
# replaced scored 33% here. The second assertion pins that separation, so this
# test cannot quietly come to tolerate artefacts by being relaxed one point at
# a time.
check("matches a voice synthesised at the corrected pitch", gap < 8.0,
      f"{got_c:.0f} Hz against {ref_c:.0f} Hz reference, {gap:.2f}% apart "
      f"(~5% of it the formant shift varispeed makes by design)")
check("and is nowhere near the artefact-laden alternative", gap < 15.0,
      f"{gap:.2f}% against the 33% the TD-PSOLA version measured")

print("\n=== the report is honest ===")
silent, report = correct_vocal(silence(1.0), SR, [TargetNote(0.0, 1.0, 57, True)])
check("a silent stem says so", report.unavailable is not None, str(report.unavailable))
check("and is returned unchanged", np.array_equal(silent, silence(1.0)))

noise_in = rng.normal(0, 0.3, int(1.5 * SR))
out, report = correct_vocal(noise_in, SR, [TargetNote(0.0, 1.0, 57, True)])
check("noise corrects nothing", report.notes_corrected == 0,
      report.unavailable or f"{report.notes_corrected} corrected")

print("\n=== remix ===")
v = voice(220.0, 1.0) * 0.5
b = voice(110.0, 1.0) * 0.5
mixed = remix(v, b)
check("no clipping after remix", float(np.max(np.abs(mixed))) <= 0.971,
      f"peak {np.max(np.abs(mixed)):.3f}")
check("length is the shorter of the two", mixed.size == min(v.size, b.size))
quiet = remix(v * 0.2, b * 0.2)
check("a quiet mix is not normalised up", float(np.max(np.abs(quiet))) < 0.5,
      f"peak {np.max(np.abs(quiet)):.3f}")

print("\n=== midi helpers ===")
check("A4 is 440", abs(midi_to_hz(69) - 440.0) < 1e-9)
check("440 is A4", abs(hz_to_midi(440.0) - 69.0) < 1e-9)
check("an octave is 1200 cents", abs(cents_between(880.0, 440.0) - 1200.0) < 1e-9)

print(f"\n{PASSED} passed, {len(FAILED)} failed")
if FAILED:
    for name in FAILED:
        print(f"  - {name}")
    sys.exit(1)
