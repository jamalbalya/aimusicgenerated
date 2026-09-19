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


#: Length of the forensic run, in seconds.
#:
#: 267, because the existing real fixture — the Tetap Memilihmu render already
#: in `fixtures/real/` — is 267.024 seconds long. A new song of a different
#: length is comparable with it only loosely: bar counts, phrase budgets and
#: the drift a tempo mismatch accumulates all scale with duration, and the
#: whole point of this run is to sit beside that fixture and be read against
#: it. ACE-Step accepts 10–600, so this is well inside range.
#:
#: The fractional 0.024 is dropped because the field is a whole number of
#: seconds. That is a 24-millisecond difference across four and a half minutes
#: and it changes no measurement this harness makes.
FORENSIC_DURATION_SECONDS = 267

#: What ACE-Step's generation actually reads, of the eleven fields sent.
#:
#: `melody` is not among them, and that is not an oversight. ACE-Step has no
#: melody or reference-audio input — `constraints.ts` files it under
#: NOT_CONTROLLED_BY_ACE_STEP — so field 11 travels to the Space and is
#: consumed *after* generation, by the pitch stage, as the reference to correct
#: against. Calling it "melody conditioning" would describe a mechanism that
#: does not exist and would make the run's result unreadable: if the vocal does
#: not follow the planned melody, that is the expected behaviour of a model
#: that was never given it, not a finding.
ACE_STEP_CONDITIONS_ON = frozenset({
    "style", "lyrics", "language", "vocal_gender", "instrumental",
    "duration", "bpm", "keyscale", "timesignature", "seed",
})


def build_request(style_file: Path, lyrics_file: Path, duration: float | None,
                  vocal_gender: str, language: str,
                  caption_mode: str = "bare") -> dict:
    """Compiles the request with the engine's own code, through Node.

    `caption_mode` decides what reaches ACE-Step's text field, and nothing
    else. `bare` sends the person's Style exactly as authored; `compiled`
    appends the planner's derived directions, which is what the Studio does.

    Bare is the default here because this harness exists to find out what the
    *model* does. With the derived tags appended, a song that comes back "Pop"
    has told us nothing — the caption said Pop. The planner still derives every
    one of them, `MusicControlSpec` is untouched, and the withheld directions
    are listed in the report; they simply are not sent.
    """
    if caption_mode not in ("bare", "compiled"):
        raise ValueError(f"caption_mode must be 'bare' or 'compiled', got {caption_mode!r}")
    command = [
        "node", str(REPO / "scripts" / "build-melody.mjs"),
        "--style-file", str(style_file),
        "--lyrics-file", str(lyrics_file),
        "--vocal-gender", vocal_gender,
        "--language", language,
        "--caption-mode", caption_mode,
    ]
    if duration is not None:
        command += ["--duration", str(duration)]
    finished = subprocess.run(command, cwd=REPO, capture_output=True, text=True, timeout=600)
    if finished.returncode != 0:
        raise RuntimeError(f"building the request failed:\n{finished.stderr[-2000:]}")
    return json.loads(finished.stdout)


USER = "USER-SPECIFIED"
ENGINE = "ENGINE-SELECTED"


def provenance(request: dict, built: dict, explicit: set[str]) -> list[dict]:
    """Where each field's value came from: the person, or the engine.

    Written because a report that lists eleven values in one column reads as
    eleven decisions the person made. Four of them are. The key this run turns
    on — A Major — was picked by the planner from a Style that names no key,
    and presenting it beside the Style as though it were asked for would be a
    quiet lie about what the experiment controls.

    `explicit` is the set of flags actually passed on the command line, so a
    value is only called USER-SPECIFIED when a person really supplied it; a
    default that happens to be sensible is still the engine's choice.
    """
    plan = built.get("plan", {})
    bpm_stated = plan.get("bpmStated") is True

    def origin(condition: bool) -> str:
        return USER if condition else ENGINE

    return [
        {"field": "style", "origin": USER,
         "why": "the Style file, byte for byte. Caption mode is bare, so nothing "
                "the planner derived was appended."},
        {"field": "lyrics", "origin": USER,
         "why": "the Lyrics file, verbatim. [End] was consumed as a terminator "
                "and nothing after it is sent."},
        {"field": "language", "origin": origin("language" in explicit),
         "why": ("passed on the command line"
                 if "language" in explicit else
                 "detected from the lyrics; the harness was asked for 'auto'. "
                 "Nobody typed 'id'.")},
        {"field": "vocal_gender", "origin": origin("vocal_gender" in explicit),
         "why": ("passed on the command line"
                 if "vocal_gender" in explicit else
                 "this run's configured vocal intent, from the harness default "
                 "rather than from the Style text")},
        {"field": "instrumental", "origin": ENGINE,
         "why": "false because the sheet has lyrics. Never asked for either way."},
        {"field": "duration", "origin": origin("duration" in explicit),
         "why": ("passed on the command line"
                 if "duration" in explicit else
                 f"the harness default of {FORENSIC_DURATION_SECONDS}s, chosen to "
                 f"match the 267.024s Tetap Memilihmu fixture")},
        {"field": "bpm", "origin": origin(bpm_stated),
         "why": ("read out of the Style text, which states a tempo. It reaches "
                 "GenerationParams.bpm as a dedicated integer, not as prose."
                 if bpm_stated else
                 "the Style states no tempo, so the planner chose one")},
        {"field": "keyscale", "origin": ENGINE,
         "why": "the planner picked it. The Style names no key, and nobody asked "
                "for this one."},
        {"field": "timesignature", "origin": ENGINE,
         "why": "the harness sends 4 for every run. Not derived from the song."},
        {"field": "seed", "origin": ENGINE,
         "why": "-1 means the model picks its own. This run is therefore not "
                "reproducible: a second generation would differ."},
        {"field": "melody", "origin": ENGINE,
         "why": "generated by the planner from the lyrics and the chosen key. "
                "ACE-Step never sees it — the Space consumes it after generation, "
                "as the pitch stage's reference."},
    ]


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


def analyse_locally(audio_path: Path, melody_json: str, out: Path,
                    requested_bpm: float | None = None) -> dict:
    """Runs the vocal pipeline here, on the audio that came back.

    The Space runs this too, inside the same GPU call, and its report is the one
    that matters for the deployed product. This second pass exists because it
    gives per-note detail the metadata does not carry, and because it confirms
    the two agree. A disagreement between them is itself a finding.

    The tempo gate runs here first, exactly as `process_song` runs it, and for
    the same reason: this harness used to call `correct_vocal` directly, which
    skipped the gate entirely. A song whose tempo does not match the plan would
    have been pitch-corrected here and reported as corrected, while the deployed
    Space refused the same song. The harness must not be the lenient path.
    """
    try:
        import numpy as np
        import wave

        import tempo as tempo_module
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

    # ---- the tempo, all four numbers, before anything is corrected ----------
    #
    # Requested, raw, canonical and ratio, always together. Raw and canonical
    # are the same pulse counted at different octaves: a ballad the detectors
    # read at 49.3 and one they read at 98.7 can be the same recording, and a
    # report that prints one of them without the other has already been
    # misread once.
    duration_seconds = samples.size / sample_rate
    try:
        reading = tempo_module.measure_tempo(samples, sample_rate,
                                             requested_bpm=requested_bpm)
    except Exception as error:  # noqa: BLE001 - a missing measurement is a refusal
        reading = None
        tempo_error = str(error)
    else:
        tempo_error = ""

    tempo_block: dict = {
        "requested_bpm": round(float(requested_bpm), 2) if requested_bpm else None,
        "raw_bpm": round(reading.raw_bpm, 2) if reading and reading.raw_bpm else None,
        "canonical_bpm": (round(reading.canonical_bpm, 2)
                          if reading and reading.canonical_bpm else None),
        "tempo_ratio": round(reading.ratio, 4) if (reading and reading.ratio) else None,
        "folded": bool(reading.folded) if reading else False,
        "verdict": reading.verdict if reading else "TEMPO_UNMEASURABLE",
        "methods": reading.methods if reading else {},
        "local_drift": round(reading.local_drift, 4) if reading else None,
        "line": (reading.describe() if reading
                 else f"tempo could not be measured: {tempo_error}"),
        "reasons": reading.reasons if reading else [tempo_error],
    }

    authorization, why = vocal_pitch.authorize_correction(reading, targets)

    # Bars, both ways, because a plan and a performance that disagree about the
    # bar count are not describing the same arrangement.
    planned_bars = (duration_seconds / (4 * 60 / float(requested_bpm))
                    if requested_bpm else None)
    actual_bars = (duration_seconds / (4 * 60 / reading.canonical_bpm)
                   if reading and reading.canonical_bpm else None)
    structure = {
        "duration_seconds": round(duration_seconds, 3),
        "bars_planned_at_requested_bpm": (round(planned_bars, 1)
                                          if planned_bars else None),
        "bars_in_the_performance": round(actual_bars, 1) if actual_bars else None,
        "phrases_planned": len({t.phrase for t in targets
                                if getattr(t, "phrase", None) is not None}) or None,
    }

    if authorization != vocal_pitch.CORRECTION_AUTHORIZED:
        # The safe outcome, and the one this fixture produces. The song is
        # returned exactly as ACE-Step made it. Nothing measured afterwards can
        # upgrade this to a pass, and no field below is filled in with a zero
        # that would read as "no errors found".
        return {
            "ran": True,
            "corrected": False,
            "tempo": tempo_block,
            "structure": structure,
            "authorization": authorization,
            "authorization_reasons": why,
            "alignment_trust": vocal_pitch.ALIGNMENT_UNTRUSTWORTHY,
            "trust": "UNVERIFIED",
            "trust_reasons": why,
            "planned_notes": len([t for t in targets if not t.is_rest]),
            "alignment_coverage": None,
            "notes_corrected": None,
            "octave_corrections": None,
            "max_residual_cents": None,
            "median_residual_cents": None,
            "unverified_notes": None,
            "notes_reverted": None,
            "final_verification": "PITCH_CORRECTION_NOT_AUTHORIZED / NO AUDIBLE FALS: UNVERIFIED",
            "decisions": [
                "The target melody is laid out on the requested tempo's timeline. "
                "Correcting against a plan that does not describe this performance "
                "would move the vocal toward notes belonging to a different part of "
                "the song, so the audio was returned unchanged.",
            ],
        }

    # Authorised: the ratio is small and stable enough that re-timing the plan
    # is a re-timing and not a reinterpretation. Times move; pitches never do.
    if reading and reading.ratio and abs(reading.ratio - 1.0) > 1e-6:
        targets = vocal_pitch.warp_targets(targets, reading.ratio)

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

    # The residuals: how far each note still sits from its target *after*
    # correction. Measured only on notes whose pitch could be read at all; a
    # note nobody could measure is counted as unverified, never as zero.
    residuals = [abs(row["after_cents"]) for row in per_note
                 if row["after_cents"] is not None]
    unverified_notes = len([row for row in per_note if row["after_cents"] is None])

    return {
        "ran": True,
        "corrected": True,
        "seconds": round(seconds, 3),
        "tempo": tempo_block,
        "structure": structure,
        "authorization": authorization,
        "authorization_reasons": why,
        "alignment_coverage": round(report.measurement_coverage, 3),
        # Read off the phrase scores, never asserted. A run in which no phrase
        # could be scored is untrustworthy, not trustworthy by default.
        "alignment_trust": (
            vocal_pitch.ALIGNMENT_TRUSTWORTHY
            if (report.phrase_alignments
                and all(row.get("trusted") for row in report.phrase_alignments))
            else vocal_pitch.ALIGNMENT_UNTRUSTWORTHY),
        # Per phrase, because that is the grain the decision is taken at: an
        # untrusted line has its notes left exactly as performed while the rest
        # of the song is corrected. The aggregate above is the strict reading —
        # trustworthy only if every scored line was — and the counts say how
        # far from it a run sits, so one weak line does not read as a whole
        # song nobody could align.
        "phrases_scored": len(report.phrase_alignments),
        "phrases_trusted": len([row for row in report.phrase_alignments
                                if row.get("trusted")]),
        "phrase_alignments": report.phrase_alignments,
        "octave_corrections": report.octave_errors - report.octave_errors_after,
        "max_residual_cents": round(max(residuals), 1) if residuals else None,
        "median_residual_cents": (round(float(sorted(residuals)[len(residuals) // 2]), 1)
                                  if residuals else None),
        "unverified_notes": unverified_notes,
        "final_verification": (
            "NO AUDIBLE FALS: UNVERIFIED — this script writes audio, it does not listen"),
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

    tempo = local.get("tempo", {}) or {}
    structure = local.get("structure", {}) or {}

    def four(key: str, unit: str = " BPM") -> str:
        got = tempo.get(key)
        return "not measured" if got is None else f"{got}{unit}"

    def shown(source: dict, key: str, unit: str = "") -> str:
        """A missing measurement says so. It never prints as a bare None.

        A `None` in a column of numbers reads as a value, and the one thing
        this report must not do is let an unavailable measurement pass for a
        measured zero.
        """
        got = source.get(key)
        return "not measured" if got is None else f"{got}{unit}"

    fold = ""
    if tempo.get("folded"):
        fold = ("      NOTE: raw and canonical are the same pulse counted at different\n"
                "            octaves — one recording, two readings, not two tempi.\n")

    rows = record.get("provenance") or []
    conditions_on = set(record.get("ace_step_conditions_on") or [])
    user_rows = [row for row in rows if row["origin"] == USER]
    engine_rows = [row for row in rows if row["origin"] == ENGINE]

    def block(title: str, source: list[dict]) -> list[str]:
        out = [title]
        if not source:
            out.append("  (none recorded)")
        for row in source:
            seen = "" if row["field"] in conditions_on else "   [ACE-Step never sees this]"
            out.append(f"  {row['field']:<14} {seen}")
            out.append(f"      {row['why']}")
        return out

    lines = [
        *block("USER-SPECIFIED — the person supplied these:", user_rows),
        "",
        *block("ENGINE-SELECTED / DEFAULT — the person did not ask for these:",
               engine_rows),
        "",
        "  The two lists are not interchangeable. A value in the second list is",
        "  a decision this pipeline made, and a result that follows it is the",
        "  pipeline agreeing with itself, not the model following the request.",
        "",
        "Caption (what reached ACE-Step's text field):",
        f"  mode:                    {request.get('caption_mode', 'not recorded')}",
        f"  caption === user Style:  {request.get('caption_is_exactly_the_user_style')}",
        f"  characters sent:         {request.get('caption_chars', '-')}",
        f"  derived directions withheld: "
        f"{len(request.get('caption_withheld', []) or [])}",
        *[f"    - {item['text']}" for item in (request.get("caption_withheld") or [])],
        "",
        "Tempo (all four values, always):",
        f"  1. requested BPM:        {four('requested_bpm')}",
        f"  2. raw detected BPM:     {four('raw_bpm')}",
        f"  3. canonical/folded BPM: {four('canonical_bpm')}",
        f"  4. tempo ratio:          {four('tempo_ratio', '')}"
        f"  (canonical / requested)",
        fold + f"  verdict:                 {tempo.get('verdict', 'not measured')}",
        f"  per-method readings:     {tempo.get('methods', {})}",
        f"  local drift:             {four('local_drift', '')}",
        "",
        "Structure:",
        f"  duration:                {structure.get('duration_seconds', '-')}s",
        f"  bars planned at the requested BPM: "
        f"{structure.get('bars_planned_at_requested_bpm', '-')}",
        f"  bars in the performance:           "
        f"{structure.get('bars_in_the_performance', '-')}",
        f"  phrases planned:         {structure.get('phrases_planned', '-')}",
        "",
        "Alignment:",
        f"  coverage:                {shown(local, 'alignment_coverage')}",
        f"  trust:                   {local.get('alignment_trust', 'not measured')}"
        + (f"  ({local['phrases_trusted']} of {local['phrases_scored']} phrases trusted)"
           if local.get("phrases_scored") else ""),
        f"  authorization:           {local.get('authorization', 'not measured')}",
        *[f"    - {reason}" for reason in local.get("authorization_reasons", [])],
        "",
        "Correction:",
        f"  notes pitch-corrected:   {shown(local, 'notes_corrected')}",
        f"  octave corrections:      {shown(local, 'octave_corrections')}",
        f"  max residual deviation:  {shown(local, 'max_residual_cents', ' cents')}",
        f"  median residual:         {shown(local, 'median_residual_cents', ' cents')}",
        f"  unverified notes:        {shown(local, 'unverified_notes')}",
        f"  correction reversions:   {shown(local, 'notes_reverted')}",
        f"  final verification:      {local.get('final_verification', 'not measured')}",
        "",
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
        f"  corrections applied:      {shown(local, 'notes_corrected')}",
        f"  corrections reverted:     {shown(local, 'notes_reverted')}",
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
    parser.add_argument(
        "--duration", default=str(FORENSIC_DURATION_SECONDS),
        help="Seconds, or 'auto' for ACE-Step's own choice. 'auto' is not 0: "
             "zero is a length, it is below the ten-second minimum, and the "
             "Space refuses it.")
    parser.add_argument("--vocal-gender", default="male")
    parser.add_argument(
        "--caption-mode", default="bare", choices=("bare", "compiled"),
        help="What reaches ACE-Step's text field. 'bare' is the Style exactly "
             "as authored, which is what a forensic run needs: it is the only "
             "way to tell whether the model followed the person's words or the "
             "planner's paraphrase of them. 'compiled' appends the planner's "
             "derived directions, as the Studio does. Neither setting changes "
             "what the planner derives.")
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

    # Which flags a person actually typed, as opposed to which ones have a
    # default. Provenance is only honest if it is read off the command line
    # rather than assumed from the value that came out.
    explicit = {
        name.lstrip("-").replace("-", "_")
        for name in sys.argv[1:] if name.startswith("--")
    }

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

    raw_duration = str(arguments.duration).strip().lower()
    duration = None if raw_duration in ("auto", "", "0", "-1") else float(raw_duration)
    built = build_request(Path(arguments.style_file), Path(arguments.lyrics_file),
                          duration, arguments.vocal_gender, arguments.language,
                          caption_mode=arguments.caption_mode)
    record["melody"] = built["melody"]
    record["plan"] = built["plan"]
    if not built["valid"]:
        record["error"] = "the planner refused the request"
        record["problems"] = built["problems"]
        (out / "report.json").write_text(json.dumps(record, indent=2))
        print(render(record))
        return 2

    request = built["request"]
    record["provenance"] = provenance(request, built, explicit)
    record["ace_step_conditions_on"] = sorted(ACE_STEP_CONDITIONS_ON)
    record["request_summary"] = {
        "caption_mode": arguments.caption_mode,
        "caption_is_exactly_the_user_style": (
            request["style"] == Path(arguments.style_file).read_text(
                encoding="utf-8").strip()),
        "caption_withheld": built["plan"].get("captionWithheld", []),
        "caption_chars": len(request["style"]),
        "lyric_chars": len(request["lyrics"]),
        "melody_chars": len(request["melody"]),
        "bpm": request["bpm"],
        "keyscale": request["keyscale"],
        "duration": request.get("duration"),
    }

    # The one tempo every later number is compared against. It comes from the
    # planner, which read it out of the style text, so the figure in the report
    # is the figure the melody was actually laid out on — not a flag that could
    # disagree with it.
    requested_bpm = float(request["bpm"]) if request.get("bpm") else None

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
        record["local_analysis"] = analyse_locally(audio_path, request["melody"], out,
                                                 requested_bpm=requested_bpm)
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

        record["local_analysis"] = analyse_locally(audio_path, request["melody"], out,
                                                 requested_bpm=requested_bpm)
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
