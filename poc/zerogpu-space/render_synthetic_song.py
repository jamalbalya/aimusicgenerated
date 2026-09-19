"""Runs the whole vocal pipeline on a synthetic song and writes real audio.

    python3 poc/zerogpu-space/render_synthetic_song.py [--out DIR]

**This is not an ACE-Step song.** It is a synthesised mix — a vocal with known,
deliberate pitch errors over a backing track — put through the identical code
path a real song takes: separate, measure, align, correct, remix, write. The
point is that every stage actually executes and produces a file somebody can
listen to, in an environment with no GPU, no torchaudio and no network.

What it therefore does and does not establish:

  * It establishes that the pipeline runs end to end and that the numbers it
    reports are produced by real audio passing through real code.
  * It does **not** establish anything about a real ACE-Step vocal, whose
    timing, timbre and error distribution are not these.
  * It does **not** constitute a listening test. It produces the files a
    listening test needs.

Writes, next to each other so they can be compared by ear:

    mix.wav               the song as "generated", errors and all
    vocal-isolated.wav    what the separator pulled out
    vocal-corrected.wav   the same stem after correction
    corrected-mix.wav     the finished song
    report.json           every measurement, including which separator ran
"""

from __future__ import annotations

import argparse
import json
import math
import os
import sys
import time
import wave

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import vocal_pitch  # noqa: E402
from vocal_pitch import (  # noqa: E402
    ROLE_ANCHOR, ROLE_PASSING, ROLE_REST, TargetNote, cents_between, detect_f0,
    midi_to_hz, segment_notes,
)

SAMPLE_RATE = 44100
BPM = 72.0
BEAT = 60.0 / BPM


def write_wav(path: str, audio: np.ndarray, sample_rate: int = SAMPLE_RATE) -> None:
    """16-bit PCM, clipped rather than normalised.

    Normalising on the way out would hide exactly the thing the remix stage is
    supposed to guarantee: that correction does not change the level.
    """
    clipped = np.clip(np.asarray(audio, dtype=np.float64), -1.0, 1.0)
    with wave.open(path, "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(sample_rate)
        handle.writeframes((clipped * 32767.0).astype("<i2").tobytes())


def sung_note(hz: float, seconds: float, vibrato_cents: float = 0.0,
              consonant_seconds: float = 0.0) -> np.ndarray:
    """A vowel with a glottal-ish spectrum and fixed formants, optional onset."""
    total = int(round(seconds * SAMPLE_RATE))
    time_axis = np.arange(total) / SAMPLE_RATE
    contour = np.full(total, hz)
    if vibrato_cents > 0:
        contour = contour * 2.0 ** (
            (vibrato_cents / 2.0) * np.sin(2 * np.pi * 5.4 * time_axis) / 1200.0)
    phase = 2 * np.pi * np.cumsum(contour) / SAMPLE_RATE

    signal = np.zeros(total)
    for harmonic in range(1, 26):
        frequency = hz * harmonic
        if frequency > SAMPLE_RATE / 2.2:
            break
        amplitude = 1.0 / (harmonic ** 1.6)
        for centre, gain in ((700.0, 2.2), (1220.0, 1.6), (2600.0, 0.8)):
            amplitude += 0.35 * gain * math.exp(
                -((frequency - centre) ** 2) / (2 * 260.0 ** 2)) / harmonic
        signal += amplitude * np.sin(harmonic * phase)
    peak = float(np.max(np.abs(signal))) or 1.0
    signal = signal / peak * 0.5

    # An amplitude envelope, so notes start and stop like notes rather than
    # switching on. A hard edge is a click, and a click is a transient the
    # separator and the detector both have to deal with that a real song has
    # fewer of.
    attack = min(total // 4, int(0.02 * SAMPLE_RATE))
    release = min(total // 4, int(0.05 * SAMPLE_RATE))
    if attack > 1:
        signal[:attack] *= np.linspace(0.0, 1.0, attack)
    if release > 1:
        signal[-release:] *= np.linspace(1.0, 0.0, release)

    if consonant_seconds > 0:
        count = int(round(consonant_seconds * SAMPLE_RATE))
        generator = np.random.default_rng(int(hz) % 1000)
        noise = np.convolve(generator.normal(0, 0.3, count), [1.0, -0.95], mode="same")
        noise_peak = float(np.max(np.abs(noise))) or 1.0
        signal = np.concatenate([noise / noise_peak * 0.28, signal])
    return signal


def backing(seconds: float, tonic_hz: float) -> np.ndarray:
    """A chord pad, a bass line and a drum pulse. Deliberately busy.

    A separator handed a vocal over silence has nothing to do. The backing is
    harmonically related to the vocal — same key — because that is the case a
    median-filter separator finds hardest: a sustained pad shares partials with
    the voice.
    """
    total = int(round(seconds * SAMPLE_RATE))
    time_axis = np.arange(total) / SAMPLE_RATE
    out = np.zeros(total)

    for ratio, level in ((1.0, 0.16), (1.2599, 0.13), (1.4983, 0.13)):  # a minor-ish triad
        for harmonic in (1, 2, 3):
            out += (level / harmonic) * np.sin(
                2 * np.pi * tonic_hz * ratio * harmonic * time_axis)
    out += 0.22 * np.sin(2 * np.pi * (tonic_hz / 2) * time_axis)

    generator = np.random.default_rng(99)
    pulse = np.zeros(total)
    step = int(round(BEAT * SAMPLE_RATE))
    for start in range(0, total - 1, step):
        length = min(int(0.09 * SAMPLE_RATE), total - start)
        envelope = np.exp(-np.linspace(0, 9, length))
        pulse[start:start + length] += generator.normal(0, 0.5, length) * envelope
    out += 0.3 * pulse
    peak = float(np.max(np.abs(out))) or 1.0
    return out / peak * 0.42


def build_song() -> tuple[np.ndarray, np.ndarray, list[TargetNote], list[str]]:
    """A short song: two phrases, with the error cases named as they are placed."""
    plan: list[TargetNote] = []
    pieces: list[np.ndarray] = []
    notes_intended: list[str] = []
    cursor = 0.0
    phrase = 0

    # (midi, beats, cents error, role, vibrato, consonant, label)
    script = [
        (57, 1.0, 0.0, ROLE_ANCHOR, 0.0, 0.04, "in tune"),
        (59, 1.0, 12.0, ROLE_PASSING, 0.0, 0.0, "12 cents sharp, passing: leave"),
        (60, 1.0, -48.0, ROLE_ANCHOR, 0.0, 0.05, "48 cents flat, anchor: correct"),
        (62, 1.5, 30.0, ROLE_ANCHOR, 45.0, 0.0, "30 cents sharp with vibrato"),
        (None, 1.0, 0.0, ROLE_REST, 0.0, 0.0, "breath"),
        (64, 1.0, 0.0, ROLE_ANCHOR, 0.0, 0.04, "in tune"),
        (62, 1.0, -250.0, ROLE_ANCHOR, 0.0, 0.0, "250 cents flat: a wrong note"),
        (60, 1.0, 0.0, ROLE_ANCHOR, 0.0, 0.05, "in tune"),
        (57, 2.0, -1200.0, ROLE_ANCHOR, 0.0, 0.0, "an octave low: one note, not the line"),
        (None, 1.0, 0.0, ROLE_REST, 0.0, 0.0, "breath"),
    ]

    for midi, beats, cents, role, vibrato, consonant, label in script:
        seconds = beats * BEAT
        if role == ROLE_REST:
            plan.append(TargetNote(cursor, cursor + seconds, 0, ROLE_REST, phrase))
            pieces.append(np.zeros(int(round(seconds * SAMPLE_RATE))))
            cursor += seconds
            phrase += 1
            continue
        plan.append(TargetNote(cursor, cursor + seconds, midi, role, phrase,
                               consonant if consonant else 0.0))
        sung = midi_to_hz(midi) * 2.0 ** (cents / 1200.0)
        piece = sung_note(sung, seconds - consonant, vibrato, consonant)
        needed = int(round(seconds * SAMPLE_RATE))
        if piece.size < needed:
            piece = np.concatenate([piece, np.zeros(needed - piece.size)])
        pieces.append(piece[:needed])
        notes_intended.append(f"{cursor:5.2f}s  MIDI {midi}  {label}")
        cursor += seconds

    vocal = np.concatenate(pieces)
    band = backing(vocal.size / SAMPLE_RATE, midi_to_hz(45))
    return vocal, band[: vocal.size], plan, notes_intended


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", default="/tmp/vocal-pipeline-render")
    arguments = parser.parse_args()
    os.makedirs(arguments.out, exist_ok=True)

    vocal_true, band, plan, intended = build_song()
    mix = vocal_true + band
    peak = float(np.max(np.abs(mix)))
    if peak > 0.97:
        mix = mix * (0.97 / peak)

    print("the song as built")
    for line in intended:
        print(f"  {line}")

    started = time.perf_counter()
    corrected_mix, report = vocal_pitch.process_song(mix, SAMPLE_RATE, plan, device="cpu")
    total_seconds = time.perf_counter() - started

    # The stems, for listening and for the separator-quality figure below.
    isolated, _ = vocal_pitch.separate_fallback(mix, SAMPLE_RATE)
    corrected_vocal, _ = vocal_pitch.correct_vocal(isolated, SAMPLE_RATE, plan)

    write_wav(os.path.join(arguments.out, "mix.wav"), mix)
    write_wav(os.path.join(arguments.out, "vocal-isolated.wav"), isolated)
    write_wav(os.path.join(arguments.out, "vocal-corrected.wav"), corrected_vocal)
    write_wav(os.path.join(arguments.out, "corrected-mix.wav"), corrected_mix)

    # How good the separation was, against the vocal we actually put in. This
    # number does not exist for a real song — nobody has the true stem — which
    # is precisely why it is worth having here.
    length = min(isolated.size, vocal_true.size)
    error = isolated[:length] - vocal_true[:length]
    signal_power = float(np.sum(vocal_true[:length] ** 2))
    separation_db = (10 * math.log10(signal_power / max(float(np.sum(error ** 2)), 1e-12))
                     if signal_power > 0 else 0.0)

    # Per-note deviation, before and after, measured on the audio rather than
    # predicted from the corrections applied.
    def deviations(stem: np.ndarray) -> dict[float, dict]:
        """Keyed by the planned note's start, so before and after pair up.

        Keyed rather than listed, because listing and zipping pairs by position:
        if the two passes segment the audio into different numbers of notes —
        which correcting one of them can easily cause — row three of one is
        compared with row three of the other and they are different notes. This
        harness printed exactly that and made a correct note look destroyed.
        """
        measured = segment_notes(detect_f0(isolated, SAMPLE_RATE))
        rows: dict[float, dict] = {}
        # Boundaries come from the isolated stem once, so before and after are
        # measured over the same stretches of time. Re-segmenting the corrected
        # stem merges notes that correction brought within a tone of each other
        # and then reports the merged median as both.
        for alignment in vocal_pitch.align(measured, plan):
            if alignment.target is None or alignment.target.is_rest:
                continue
            start = int(round(alignment.measured.start_seconds * SAMPLE_RATE))
            end = int(round(alignment.measured.end_seconds * SAMPLE_RATE))
            hz, _ = vocal_pitch._measure_segment(stem, start, end, SAMPLE_RATE)
            if hz <= 0:
                continue
            raw = cents_between(hz, alignment.target.frequency_hz)
            octaves = int(round(raw / 1200.0))
            rows[round(alignment.target.start_seconds, 3)] = {
                "at": round(alignment.measured.start_seconds, 2),
                "target_midi": alignment.target.midi,
                "cents": round(raw - octaves * 1200.0, 1),
                "octaves": octaves,
            }
        return rows

    before = deviations(isolated)
    after = deviations(corrected_vocal)

    summary = {
        "NOT_AN_ACE_STEP_SONG": (
            "Synthetic mix through the real code path. Establishes that the pipeline runs and "
            "that these numbers came from audio. Establishes nothing about a real ACE-Step vocal."
        ),
        "separator": report.separator,
        "separation_snr_db": round(separation_db, 2),
        "stage_seconds": report.stage_seconds,
        "total_seconds": round(total_seconds, 3),
        "audio_seconds": round(mix.size / SAMPLE_RATE, 2),
        "planned_notes": report.planned_notes,
        "planned_notes_measured": report.planned_notes_measured,
        "measurement_coverage": round(report.measurement_coverage, 3),
        "notes_examined": report.notes_examined,
        "notes_corrected": report.notes_corrected,
        "notes_left_alone": report.notes_left_alone,
        "anchors_examined": report.anchors_examined,
        "anchors_in_tune_before": report.anchors_within_tolerance_before,
        "anchors_in_tune_after": report.anchors_within_tolerance_after,
        "median_deviation_before_cents": round(report.median_deviation_before_cents, 1),
        "median_deviation_after_cents": round(report.median_deviation_after_cents, 1),
        "largest_correction_cents": round(report.largest_correction_cents, 1),
        "octave_errors_before": report.octave_errors,
        "octave_errors_after": report.octave_errors_after,
        "notes_reverted": report.notes_reverted,
        "large_corrections": report.large_corrections,
        "implausible": report.implausible,
        "phrases_measured": report.phrases_measured,
        "phrases_matched": report.phrases_matched,
        "unmatched_sung": report.unmatched_sung,
        "unmatched_planned": report.unmatched_planned,
        "peak_before": round(float(np.max(np.abs(mix))), 4),
        "peak_after": round(float(np.max(np.abs(corrected_mix))), 4),
        "per_note_before": before,
        "per_note_after": after,
        "planned_notes": len([t for t in plan if not t.is_rest]),
        "planned_notes_measured_before": len(before),
        "planned_notes_measured_after": len(after),
        "decisions": report.decisions,
        "LISTENING": "REAL AUDIO LISTENING NOT VERIFIED — files written, nobody has heard them",
    }
    with open(os.path.join(arguments.out, "report.json"), "w") as handle:
        json.dump(summary, handle, indent=2)

    print(f"\nseparator            {report.separator}")
    print(f"separation SNR       {separation_db:.2f} dB against the vocal that went in")
    print(f"stage seconds        {report.stage_seconds}")
    print(f"total                {total_seconds:.2f}s for {mix.size / SAMPLE_RATE:.1f}s of audio")
    print(f"coverage             {report.planned_notes_measured}/{report.planned_notes} "
          f"planned notes were found and measured "
          f"({report.measurement_coverage * 100:.0f}%)")
    print(f"anchors in tune      {report.anchors_within_tolerance_before}"
          f" -> {report.anchors_within_tolerance_after} of {report.anchors_examined}")
    print(f"median deviation     {report.median_deviation_before_cents:.1f}"
          f" -> {report.median_deviation_after_cents:.1f} cents")
    print(f"octave errors        {report.octave_errors} -> {report.octave_errors_after}")
    print(f"corrections reverted {report.notes_reverted}")
    print(f"large corrections    {report.large_corrections}")
    print(f"peak                 {np.max(np.abs(mix)):.3f} -> {np.max(np.abs(corrected_mix)):.3f}")
    print(f"planned notes        {len([t for t in plan if not t.is_rest])}, "
          f"of which {len(before)} were found in the isolated stem")
    print("\nper planned note, measured on the audio:")
    for target in plan:
        if target.is_rest:
            continue
        key = round(target.start_seconds, 3)
        row_before, row_after = before.get(key), after.get(key)
        if row_before is None:
            print(f"  {target.start_seconds:5.2f}s  MIDI {target.midi:3d}  "
                  f"not found in the isolated stem")
            continue
        tail = ("not found after" if row_after is None
                else f"{row_after['cents']:+7.1f} ({row_after['octaves']:+d} oct)")
        print(f"  {target.start_seconds:5.2f}s  MIDI {target.midi:3d}  "
              f"{row_before['cents']:+7.1f} ({row_before['octaves']:+d} oct)  ->  {tail}")
    print(f"\nwrote {arguments.out}/")
    print("REAL AUDIO LISTENING NOT VERIFIED")


if __name__ == "__main__":
    main()
