#!/usr/bin/env python3
"""Generate, judge, reject, generate again — against a real ACE-Step backend.

The enforcement the browser cannot do. Each attempt asks the backend for a
complete song, separates the vocal, measures it against the accompaniment, and
keeps the file only if it passes. A rejected take's audio is deleted, not
shelved: there is no path through this program that hands back a song the gate
refused.

Usage:
    python generate_gated.py --style-file style.txt --lyrics-file lyrics.txt \\
        --space-url https://<owner>-<space>.hf.space --out song.wav [--attempts 5]

The Space URL and any token come from arguments or the environment. Nothing is
hardcoded here and nothing is written to disk but the passing song and its
report.

A fresh seed per attempt costs nothing to arrange: the ZeroGPU Space draws its
own random seed on every request and reports the one it used, so every attempt
is genuinely a new take. The style and the lyrics are read once, sent byte for
byte on every attempt, and checked against what was read before each send — a
regeneration loop must never become a rewriting loop.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile
import time
from dataclasses import dataclass, field
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import gate  # noqa: E402

DEFAULT_ATTEMPTS = 5


class LyricsChanged(RuntimeError):
    """Raised if the text about to be sent is not the text that was read."""


@dataclass
class Attempt:
    attempt: int
    verdict: str
    seed: object = None
    reasons: list = field(default_factory=list)
    measurements: dict = field(default_factory=dict)
    seconds: float = 0.0

    def line(self) -> str:
        action = {"PASS": "deliver", "REGENERATION_REQUIRED": "reject"}.get(self.verdict, "held back")
        return f"Attempt {self.attempt} → {self.verdict} → {action}"


@dataclass
class Outcome:
    delivered: bool
    attempts: list = field(default_factory=list)
    path: Path | None = None
    report: object = None
    reason: str = ""


def generate_once(client, style: str, lyrics: str, language: str, vocal_gender: str,
                  instrumental: bool, duration: int, into: Path):
    """One request to the Space. Returns (audio path, metadata).

    Kept behind a `client` argument rather than importing a Gradio client at
    module scope: the loop, the gate and the refusal are all testable without a
    network, and a test can hand in anything with a `predict`.
    """
    file_path, metadata = client.predict(
        style, lyrics, language, vocal_gender, instrumental, duration)
    destination = into / f"attempt-{int(time.time() * 1000)}.wav"
    Path(file_path).replace(destination)
    return destination, metadata


def run(client, style: str, lyrics: str, *, language: str = "id",
        vocal_gender: str = "male", instrumental: bool = False, duration: int = -1,
        attempts: int = DEFAULT_ATTEMPTS, thresholds: gate.Thresholds = gate.STRICT,
        workspace: Path | None = None, log=print) -> Outcome:
    """The loop. Returns a passing take or nothing — never a rejected one."""
    original_style, original_lyrics = style, lyrics
    scratch = workspace or Path(tempfile.mkdtemp(prefix="gated-"))
    scratch.mkdir(parents=True, exist_ok=True)
    record: list = []
    held = None

    for attempt in range(1, max(1, attempts) + 1):
        # Checked before every send, not trusted. Nothing in this loop is
        # allowed to edit what the user wrote.
        if style != original_style:
            raise LyricsChanged("The style changed during the run.")
        if lyrics != original_lyrics:
            raise LyricsChanged("The lyrics changed during the run.")

        started = time.perf_counter()
        path, metadata = generate_once(
            client, style, lyrics, language, vocal_gender, instrumental, duration, scratch)
        report = gate.judge(path, thresholds)
        seed = (metadata or {}).get("seed") if isinstance(metadata, dict) else None
        entry = Attempt(attempt, report.verdict, seed, report.reasons, report.measurements,
                        round(time.perf_counter() - started, 1))
        record.append(entry)
        log(entry.line())
        for reason in report.reasons:
            log(f"    {reason}")

        if report.verdict == "PASS":
            return Outcome(True, record, path, report)

        if report.verdict == "REGENERATION_REQUIRED":
            # Deleted, not shelved. A rejected take that stays on disk is a
            # rejected take somebody eventually plays.
            path.unlink(missing_ok=True)
            continue

        # ANALYSIS_UNAVAILABLE or REVIEW_REQUIRED. Generating again does not make
        # a take analysable — the reason is a property of this machine, not of
        # that song — so the loop stops rather than spending the rest of the
        # attempts arriving at the same sentence.
        held = (path, report)
        break

    if held is not None:
        path, report = held
        return Outcome(False, record, path, report,
                       f"The quality gate could not verify this song: {report.reasons[0]}")

    return Outcome(
        False, record, None, None,
        f"Generation failed the musical quality gate after {len(record)} attempts. "
        "No incorrect audio was delivered.")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--style-file", required=True, type=Path)
    parser.add_argument("--lyrics-file", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--space-url", default=os.environ.get("ACE_STEP_SPACE_URL"),
                        help="The Space to call. Also read from ACE_STEP_SPACE_URL.")
    parser.add_argument("--language", default="id")
    parser.add_argument("--vocal-gender", default="male", choices=["male", "female", "mixed"])
    parser.add_argument("--instrumental", action="store_true")
    parser.add_argument("--duration", type=int, default=-1,
                        help="Seconds, or -1 to let the model choose.")
    parser.add_argument("--attempts", type=int, default=DEFAULT_ATTEMPTS)
    args = parser.parse_args()

    if not args.space_url:
        parser.error("No Space URL. Pass --space-url or set ACE_STEP_SPACE_URL.")

    try:
        from gradio_client import Client
    except ImportError:
        print("gradio_client is not installed: python3 -m pip install gradio_client",
              file=sys.stderr)
        return 2

    # The token, if there is one, comes from the environment and is never logged.
    token = os.environ.get("HF_TOKEN")
    client = Client(args.space_url, **({"hf_token": token} if token else {}))

    style = args.style_file.read_text(encoding="utf-8")
    lyrics = args.lyrics_file.read_text(encoding="utf-8")

    outcome = run(client, style, lyrics, language=args.language,
                  vocal_gender=args.vocal_gender, instrumental=args.instrumental,
                  duration=args.duration, attempts=args.attempts)

    report_path = args.out.with_suffix(".quality.json")
    report_path.write_text(json.dumps({
        "delivered": outcome.delivered,
        "reason": outcome.reason,
        "attempts": [a.__dict__ for a in outcome.attempts],
        "report": outcome.report.as_dict() if outcome.report else None,
    }, indent=2), encoding="utf-8")

    if outcome.delivered and outcome.path:
        outcome.path.replace(args.out)
        print(f"\nDelivered: {args.out}")
        print(f"Report:    {report_path}")
        return 0

    print(f"\n{outcome.reason}")
    print(f"Report:    {report_path}")
    if outcome.path:
        print(f"The unverified take was left at {outcome.path}; it has NOT passed the gate.")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
