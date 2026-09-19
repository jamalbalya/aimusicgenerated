#!/usr/bin/env python3
"""ONE real ACE-Step generation, end to end, reported in full.

This is the file to run from an environment that has legitimate access to the
Space. It exists because this repository's own environment does not: the gateway
answers `CONNECT tunnel failed, response 403` for `huggingface.co` and every
`*.hf.space` host, so the real validation cannot happen here and must not be
faked here.

    export ACE_STEP_SPACE_URL=https://<owner>-<space>.hf.space
    export HF_TOKEN=...                       # only if the Space is gated
    python3 poc/zerogpu-space/real_run.py --out ./real-run

Nothing is hardcoded: the Space URL and the token come from the environment or
from flags, and neither is written into the report.

## What it guarantees

**One generation.** One request is posted, once. There is no retry loop, no
second candidate, no "generate again if the first is bad". If the request fails,
that failure is the result and it is reported as one. That is not a limitation
of this script, it is the product requirement, and a harness that quietly
generated twice would be validating something the product does not do.

The request payload is built by `scripts/build-melody.mjs`, which loads the
engine's own planner, prompt compiler, melody writer and melody validator
through Vite. The point is that this sends *what the browser sends*: a harness
that assembled its own payload would be validating the harness.

## What it cannot do

It cannot listen. It writes the audio and says so. `analysis != listening`.
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

HERE = Path(__file__).parent
REPO = HERE.parent.parent
API_NAME = "generate_music"

#: ACE-Step's own "you choose the length". Must match `guard.AUTO_DURATION` and
#: `ACE_STEP_AUTO_DURATION` in the browser, or Auto becomes an illegal length.
AUTO_DURATION = -1

sys.path.insert(0, str(HERE))


def build_request(style_file: Path, lyrics_file: Path, duration: float | None,
                  vocal_gender: str, language: str) -> dict:
    """Compiles the request with the engine's own code, through Node."""
    command = [
        "node", str(REPO / "scripts" / "build-melody.mjs"),
        "--style-file", str(style_file),
        "--lyrics-file", str(lyrics_file),
        "--vocal-gender", vocal_gender,
        "--language", language,
    ]
    if duration is not None:
        command += ["--duration", str(duration)]
    finished = subprocess.run(command, cwd=REPO, capture_output=True, text=True, timeout=600)
    if finished.returncode != 0:
        raise RuntimeError(f"building the request failed:\n{finished.stderr[-2000:]}")
    return json.loads(finished.stdout)


def post(url: str, payload: dict, token: str | None, timeout: int = 180):
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    request = urllib.request.Request(
        url, data=json.dumps(payload).encode(), method="POST", headers=headers)
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return response.status, json.loads(response.read().decode())


def stream(url: str, token: str | None, timeout: int):
    """Consumes the Gradio SSE stream. Returns (events, last lines)."""
    headers = {"Accept": "text/event-stream"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    request = urllib.request.Request(url, headers=headers)
    events, event, tail = [], {}, []
    with urllib.request.urlopen(request, timeout=timeout) as response:
        for raw in response:
            line = raw.decode("utf8", "replace").rstrip("\n")
            tail.append(line)
            if line.startswith("event:"):
                event["event"] = line[6:].strip()
            elif line.startswith("data:"):
                event["data"] = line[5:].strip()
            elif line == "":
                if event:
                    events.append(event)
                    event = {}
    if event:
        events.append(event)
    return events, tail[-60:]


def fetch_audio(base: str, reference: object, token: str | None, out: Path) -> Path | None:
    """Downloads whatever the Space pointed at, if it pointed at anything."""
    url = None
    if isinstance(reference, dict):
        url = reference.get("url") or reference.get("path")
    elif isinstance(reference, str):
        url = reference
    if not url:
        return None
    if not url.startswith("http"):
        url = f"{base}/gradio_api/file={url.lstrip('/')}"
    headers = {}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    request = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(request, timeout=900) as response:
        data = response.read()
    path = out / "generated.wav"
    path.write_bytes(data)
    return path


def analyse_locally(audio_path: Path, melody_json: str, out: Path) -> dict:
    """Runs the vocal pipeline here, on the audio that came back.

    The Space runs this too, inside the same GPU call, and its report is the one
    that matters for the deployed product. This second pass exists because it
    gives per-note detail the metadata does not carry, and because it confirms
    the two agree. A disagreement between them is itself a finding.
    """
    try:
        import numpy as np
        import wave

        import vocal_pitch
    except Exception as error:
        return {"ran": False, "reason": f"local analysis unavailable: {error}"}

    with wave.open(str(audio_path), "rb") as handle:
        channels = handle.getnchannels()
        sample_rate = handle.getframerate()
        frames = handle.readframes(handle.getnframes())
    samples = np.frombuffer(frames, dtype="<i2").astype(np.float64) / 32768.0
    if channels > 1:
        samples = samples.reshape(-1, channels).mean(axis=1)

    plan = json.loads(melody_json) if melody_json else {"notes": []}
    targets = [vocal_pitch.TargetNote.from_row(row) for row in plan.get("notes", [])
               if isinstance(row, (list, tuple)) and len(row) >= 3]
    if not targets:
        return {"ran": False, "reason": "no target melody was sent, so nothing to measure against"}

    # The same three stages `process_song` runs, run here so the corrected vocal
    # *stem* is in hand and not only the remixed song.
    #
    # Per-note comparison has to be stem against stem. Measuring "before" on the
    # isolated vocal and "after" on the finished mix compares two different
    # signals — the second has the whole band in it — and reports regressions
    # that are the backing track, not the correction. This harness did exactly
    # that and claimed four.
    started = time.perf_counter()
    separation_started = time.perf_counter()
    isolated, backing, problem = vocal_pitch.separate(samples, sample_rate, "cpu")
    separator = "hybrid-demucs"
    if problem is not None or isolated.size == 0:
        isolated, backing = vocal_pitch.separate_fallback(samples, sample_rate)
        separator = "median-filter fallback"
    separation_seconds = time.perf_counter() - separation_started

    corrected_stem, report = vocal_pitch.correct_vocal(isolated, sample_rate, targets)
    report.separator = separator
    report.stage_seconds = {
        "separate": round(separation_seconds, 3),
        "measure_align_correct": round(
            time.perf_counter() - separation_started - separation_seconds, 3),
    }
    corrected = (vocal_pitch.remix(corrected_stem, backing)
                 if report.notes_corrected > 0 else samples)
    report.stage_seconds["total"] = round(time.perf_counter() - started, 3)
    seconds = time.perf_counter() - started

    per_note = []
    if isolated.size:
        measured = vocal_pitch.segment_notes(vocal_pitch.detect_f0(isolated, sample_rate))
        for alignment in vocal_pitch.align(measured, targets):
            if alignment.target is None or alignment.target.is_rest:
                continue
            start = int(round(alignment.measured.start_seconds * sample_rate))
            end = int(round(alignment.measured.end_seconds * sample_rate))
            # Both sides measured the same way over the same samples. Taking
            # "before" from the segmenter's own median and "after" from a fresh
            # measurement compares two methods, not two states: a note nobody
            # touched then differs by a few cents, and the harness reports a
            # regression that never happened. It reported two.
            before_hz, _ = vocal_pitch._measure_segment(
                isolated, start, end, sample_rate)
            after_hz, _ = vocal_pitch._measure_segment(
                corrected_stem, start, end, sample_rate)
            target_hz = alignment.target.frequency_hz
            raw_before = (vocal_pitch.cents_between(before_hz, target_hz)
                          if before_hz > 0 else None)
            raw_after = (vocal_pitch.cents_between(after_hz, target_hz)
                         if after_hz > 0 else None)
            per_note.append({
                "at": round(alignment.measured.start_seconds, 2),
                "target_midi": alignment.target.midi,
                "role": vocal_pitch._role_name(alignment.target.role),
                "before_cents": None if raw_before is None else round(raw_before, 1),
                "after_cents": None if raw_after is None else round(raw_after, 1),
                "untouched": bool(np.array_equal(
                    isolated[start:end], corrected_stem[start:end])),
                "decision": alignment.decision,
            })

    # A regression is a note the correction moved further from its target. A
    # note whose samples are unchanged cannot be one, whatever two measurements
    # of it happen to say.
    regressions = [
        row for row in per_note
        if not row["untouched"]
        and row["after_cents"] is not None and row["before_cents"] is not None
        and abs(row["after_cents"]) > abs(row["before_cents"]) + 5.0
    ]

    with wave.open(str(out / "corrected.wav"), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(sample_rate)
        clipped = np.clip(corrected, -1.0, 1.0)
        handle.writeframes((clipped * 32767.0).astype("<i2").tobytes())

    return {
        "ran": True,
        "seconds": round(seconds, 3),
        "separator": report.separator,
        "trust": report.trust,
        "trust_reasons": report.trust_reasons,
        "stage_seconds": report.stage_seconds,
        "time_offset_seconds": report.time_offset_seconds,
        "planned_notes": report.planned_notes,
        "planned_notes_measured": report.planned_notes_measured,
        "measurement_coverage": round(report.measurement_coverage, 3),
        "notes_examined": report.notes_examined,
        "notes_corrected": report.notes_corrected,
        "notes_reverted": report.notes_reverted,
        "notes_left_alone": report.notes_left_alone,
        "anchors_examined": report.anchors_examined,
        "anchors_in_tune_before": report.anchors_within_tolerance_before,
        "anchors_in_tune_after": report.anchors_within_tolerance_after,
        "median_deviation_before_cents": round(report.median_deviation_before_cents, 1),
        "median_deviation_after_cents": round(report.median_deviation_after_cents, 1),
        "octave_errors_before": report.octave_errors,
        "octave_errors_after": report.octave_errors_after,
        "large_corrections": report.large_corrections,
        "implausible": report.implausible,
        "unmatched_sung": report.unmatched_sung,
        "unmatched_planned": report.unmatched_planned,
        "phrases_measured": report.phrases_measured,
        "phrases_matched": report.phrases_matched,
        "per_note": per_note,
        "per_note_regressions": regressions,
        "decisions": report.decisions,
    }


def render(record: dict) -> str:
    """The report, in the shape it was asked for."""
    request = record.get("request_summary", {})
    ace = record.get("ace_step", {})
    local = record.get("local_analysis", {})
    melody = record.get("melody", {})
    stages = local.get("stage_seconds", {}) or {}

    def value(source: dict, key: str, unit: str = "") -> str:
        got = source.get(key)
        return "not measured" if got is None else f"{got}{unit}"

    def stage(key: str) -> str:
        got = stages.get(key)
        return "not measured" if got is None else f"{got}s"

    lines = [
        "Generation:",
        f"  one request / one ticket / no regeneration: {record.get('one_request', 'unknown')}",
        f"  requests posted: {record.get('requests_posted', 0)}",
        "",
        "ACE-Step:",
        f"  generation duration: {value(ace, 'generation_seconds', 's')}",
        f"  audio duration:      {value(ace, 'audio_seconds', 's')}",
        "",
        "Vocal processing:",
        f"  separator:           {local.get('separator', 'not run')}",
        f"  separation duration: {stage('separate')}",
        f"  F0 + alignment + correction: {stage('measure_align_correct')}",
        f"  remix duration:      {stage('remix')}",
        f"  total vocal pipeline: {stage('total')}",
        "",
        "Pitch:",
        f"  planned notes:            {local.get('planned_notes', 'not measured')}",
        f"  measured / coverage:      {local.get('planned_notes_measured', '-')} "
        f"({local.get('measurement_coverage', '-')})",
        f"  matched notes:            {local.get('notes_examined', '-')}",
        f"  unmatched sung notes:     {local.get('unmatched_sung', '-')}",
        f"  unmatched planned notes:  {local.get('unmatched_planned', '-')}",
        f"  deviation before (median):{local.get('median_deviation_before_cents', '-')} cents",
        f"  deviation after  (median):{local.get('median_deviation_after_cents', '-')} cents",
        f"  octave errors before:     {local.get('octave_errors_before', '-')}",
        f"  octave errors after:      {local.get('octave_errors_after', '-')}",
        f"  large deviations:         {local.get('large_corrections', '-')}",
        f"  corrections applied:      {local.get('notes_corrected', '-')}",
        f"  corrections reverted:     {local.get('notes_reverted', '-')}",
        f"  per-note regressions:     {len(local.get('per_note_regressions', []))}",
        "",
        "Melody:",
        f"  validator result:  {'passed' if melody.get('usable') else 'REJECTED'}",
        f"  checks passed:     {len(melody.get('checksPassed', []))}",
        f"  problems:          {melody.get('problems', [])}",
        f"  target melody sent:{bool(request.get('melody_chars'))}",
        "",
        "Final audio:",
        f"  written: {record.get('audio_path', 'none')}",
        f"  corrected written: {record.get('corrected_path', 'none')}",
        "",
        "Listening:",
        "  NOT VERIFIED — this script writes audio, it does not listen",
        "",
        "Classification:",
        "  IMPLEMENTED:            yes",
        "  TESTED ON SYNTHETIC:    yes (see test_vocal_pitch.py)",
        f"  TESTED ON REAL ACE-STEP:{' yes' if record.get('real_audio') else ' NO'}",
        "  LISTENING VERIFIED:     NO",
    ]
    if local.get("trust"):
        lines.insert(0, f"Trust: {local['trust']} — {'; '.join(local.get('trust_reasons', []))}\n")
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--space-url", default=os.environ.get("ACE_STEP_SPACE_URL", ""))
    parser.add_argument("--token", default=os.environ.get("HF_TOKEN", ""))
    parser.add_argument("--style-file", default=str(HERE / "fixtures" / "real-run-style.txt"))
    parser.add_argument("--lyrics-file", default=str(HERE / "fixtures" / "real-run-lyrics.txt"))
    parser.add_argument("--duration", type=float, default=210.0)
    parser.add_argument("--vocal-gender", default="male")
    parser.add_argument("--language", default="auto")
    parser.add_argument("--timeout", type=int, default=1800)
    parser.add_argument("--out", default="./real-run")
    parser.add_argument(
        "--audio-file", default="",
        help="Analyse an existing song instead of generating one. For a real "
             "ACE-Step render obtained some other way: the analysis half of this "
             "script runs unchanged, and the report says the audio was supplied "
             "rather than generated here.")
    arguments = parser.parse_args()

    out = Path(arguments.out)
    out.mkdir(parents=True, exist_ok=True)
    record: dict = {
        "started_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "requests_posted": 0,
        "one_request": "yes — this script posts once and never retries",
        "real_audio": False,
    }

    import vocal_pitch
    record["readiness"] = vocal_pitch.readiness(device="cpu")

    built = build_request(Path(arguments.style_file), Path(arguments.lyrics_file),
                          arguments.duration, arguments.vocal_gender, arguments.language)
    record["melody"] = built["melody"]
    record["plan"] = built["plan"]
    if not built["valid"]:
        record["error"] = "the planner refused the request"
        record["problems"] = built["problems"]
        (out / "report.json").write_text(json.dumps(record, indent=2))
        print(render(record))
        return 2

    request = built["request"]
    record["request_summary"] = {
        "caption_chars": len(request["style"]),
        "lyric_chars": len(request["lyrics"]),
        "melody_chars": len(request["melody"]),
        "bpm": request["bpm"],
        "keyscale": request["keyscale"],
        "duration": request.get("duration"),
    }

    if arguments.audio_file:
        # Someone already has the song. Analyse it with exactly the code a
        # generated song goes through — the report then describes a real vocal,
        # while still saying that this script did not generate it.
        audio_path = Path(arguments.audio_file)
        if not audio_path.exists():
            record["error"] = f"no such audio file: {audio_path}"
            (out / "report.json").write_text(json.dumps(record, indent=2))
            print(render(record))
            return 6
        record["audio_path"] = str(audio_path)
        record["audio_supplied"] = True
        record["one_request"] = "no request — the audio was supplied, not generated here"
        import wave
        try:
            with wave.open(str(audio_path), "rb") as handle:
                record["ace_step"] = {
                    "generation_seconds": None,
                    "audio_seconds": round(handle.getnframes() / handle.getframerate(), 2),
                }
        except Exception as error:  # noqa: BLE001
            record["error"] = (f"could not read {audio_path} as WAV ({error}). "
                               f"Convert it first: ffmpeg -i in.mp3 out.wav")
            (out / "report.json").write_text(json.dumps(record, indent=2))
            print(render(record))
            return 6
        record["local_analysis"] = analyse_locally(audio_path, request["melody"], out)
        if (out / "corrected.wav").exists():
            record["corrected_path"] = str(out / "corrected.wav")
        # `real_audio` stays false unless the caller says this came from
        # ACE-Step. This script cannot tell, and guessing would be the one thing
        # it must never do.
        record["real_audio"] = False
        record["note"] = (
            "Audio was supplied, not generated by this script. Whether it is a real "
            "ACE-Step render is not something this script can determine; classify "
            "TESTED ON REAL ACE-STEP by hand, from where the file came from."
        )
        record["finished_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        (out / "report.json").write_text(json.dumps(record, indent=2))
        print(render(record))
        print(f"\nwrote {out}/report.json")
        print("REAL AUDIO LISTENING NOT VERIFIED")
        return 0

    base = arguments.space_url.rstrip("/")
    if not base:
        record["error"] = (
            "No Space URL. Set ACE_STEP_SPACE_URL or pass --space-url. "
            "REAL ACE-STEP VALIDATION NOT PERFORMED."
        )
        (out / "report.json").write_text(json.dumps(record, indent=2))
        print(render(record))
        return 3

    # Eleven fields, in the order `app.py` binds them and `space-info.json`
    # declares them: style, lyrics, language, vocal_gender, instrumental,
    # duration, bpm, keyscale, timesignature, seed, melody.
    #
    # `duration` is -1 for Auto, which is ACE-Step choosing the length, and a
    # whole number of seconds otherwise. Sending 0 — which this did first, as
    # the default of a `.get()` — is not Auto: the guard reads it as a length,
    # finds it below the ten-second minimum, and refuses the request. That would
    # have spent the one real generation on a 400.
    duration = request.get("duration")
    duration_field = AUTO_DURATION if not duration else int(round(float(duration)))
    payload = {"data": [
        request["style"], request["lyrics"], request["language"], request["vocalGender"],
        request["instrumental"], duration_field,
        int(request["bpm"]), request["keyscale"], "4", -1, request["melody"],
    ]}
    record["request_summary"]["duration_sent"] = duration_field

    wall = time.perf_counter()
    try:
        # One POST. If this fails, that failure is the result.
        record["requests_posted"] = 1
        status, body = post(f"{base}/gradio_api/call/{API_NAME}", payload,
                            arguments.token or None)
        record["post_status"] = status
        event_id = body.get("event_id")
        if not event_id:
            raise RuntimeError(f"no event_id in the response: {body}")
        events, tail = stream(f"{base}/gradio_api/call/{API_NAME}/{event_id}",
                              arguments.token or None, arguments.timeout)
        record["ace_step"] = {"generation_seconds": round(time.perf_counter() - wall, 3)}
        record["sse_tail"] = tail

        completed = [event for event in events if event.get("event") == "complete"]
        if not completed:
            errors = [event for event in events if event.get("event") == "error"]
            record["error"] = f"no completion event. errors: {errors or 'none'}"
            (out / "report.json").write_text(json.dumps(record, indent=2))
            print(render(record))
            return 4

        data = json.loads(completed[-1]["data"])
        record["space_result"] = data if len(json.dumps(data)) < 20000 else "(truncated)"
        audio_path = fetch_audio(base, data[0] if isinstance(data, list) and data else None,
                                 arguments.token or None, out)
        if audio_path is None:
            record["error"] = "the Space returned no audio file"
            (out / "report.json").write_text(json.dumps(record, indent=2))
            print(render(record))
            return 5

        record["audio_path"] = str(audio_path)
        record["real_audio"] = True
        import wave
        with wave.open(str(audio_path), "rb") as handle:
            record["ace_step"]["audio_seconds"] = round(
                handle.getnframes() / handle.getframerate(), 2)

        record["local_analysis"] = analyse_locally(audio_path, request["melody"], out)
        if (out / "corrected.wav").exists():
            record["corrected_path"] = str(out / "corrected.wav")
    except Exception as error:  # noqa: BLE001 - every failure is a result
        record["error"] = f"{type(error).__name__}: {error}"

    record["finished_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    (out / "report.json").write_text(json.dumps(record, indent=2))
    print(render(record))
    print(f"\nwrote {out}/report.json")
    print("REAL AUDIO LISTENING NOT VERIFIED")
    return 0 if record.get("real_audio") else 1


if __name__ == "__main__":
    sys.exit(main())
