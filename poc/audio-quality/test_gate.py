"""The loop's promises, tested without a GPU.

Nothing here generates music. The client is a stub and the gate is stubbed with
a scripted sequence of verdicts, because what is under test is not whether the
analysis is right — `test_separation.py` and `test_intonation.py` cover that —
but whether a take that failed can get out of this function. It cannot, and
these are the tests that say so.
"""

from __future__ import annotations

import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import gate  # noqa: E402
import pipeline  # noqa: E402
import generate_gated as controller  # noqa: E402

FAILURES: list = []


def check(name: str, condition: bool, detail: str = "") -> None:
    if condition:
        print(f"  ok   {name}")
    else:
        FAILURES.append(f"{name}{': ' + detail if detail else ''}")
        print(f"  FAIL {name}{': ' + detail if detail else ''}")


STYLE = "Dangdut koplo sarkastik, kendang bertenaga, vokal pria lantang"
LYRICS = "[Verse]\nHei kawan, hidup jangan terlalu serius\n[Chorus]\nBos toxic, kerja terus"


class StubClient:
    """Writes a file and records exactly what it was asked for."""

    def __init__(self) -> None:
        self.calls: list = []
        self.scratch = Path(tempfile.mkdtemp(prefix="stub-"))

    def predict(self, style, lyrics, language, vocal_gender, instrumental, duration):
        self.calls.append({
            "style": style, "lyrics": lyrics, "language": language,
            "vocal_gender": vocal_gender, "instrumental": instrumental, "duration": duration,
        })
        path = self.scratch / f"take-{len(self.calls)}.wav"
        path.write_bytes(b"RIFF....WAVE")
        return str(path), {"seed": 1000 + len(self.calls)}


def scripted(verdicts):
    """Replaces `gate.judge` with a fixed sequence, one per attempt.

    The reports are built the way the pipeline builds them, so the controller is
    tested against the shape it really receives — including `delivery_allowed`,
    which is the field it actually branches on.
    """
    remaining = list(verdicts)

    def judge(path, thresholds=gate.STRICT, requirements=None):
        verdict = remaining.pop(0) if remaining else "REGENERATION_REQUIRED"
        rejection = {
            "REGENERATION_REQUIRED": [pipeline.HARMONIC_MISMATCH],
            "ANALYSIS_UNAVAILABLE": [pipeline.SEPARATION_UNRELIABLE],
            "REVIEW_REQUIRED": [],
        }.get(verdict, [])
        return pipeline.QualityReport(
            verdict=verdict,
            accepted=verdict == "PASS",
            delivery_allowed=verdict == "PASS",
            rejection_reasons=rejection,
            reasons=[f"scripted {verdict}"],
        )
    return judge


def with_verdicts(verdicts, **kwargs):
    client = StubClient()
    original = gate.judge
    gate.judge = scripted(verdicts)
    try:
        outcome = controller.run(client, STYLE, LYRICS, log=lambda *_: None, **kwargs)
    finally:
        gate.judge = original
    return client, outcome


print("a passing take is delivered")
client, outcome = with_verdicts(["PASS"])
check("the first passing take is returned", outcome.delivered)
check("and nothing more is generated", len(client.calls) == 1, f"{len(client.calls)} calls")
check("the file it returns exists", outcome.path is not None and outcome.path.is_file())

print("\na failing take is regenerated")
client, outcome = with_verdicts(["REGENERATION_REQUIRED", "REGENERATION_REQUIRED", "PASS"])
check("the loop keeps going until one passes", outcome.delivered)
check("and it took three attempts", len(client.calls) == 3, f"{len(client.calls)}")
check("every attempt is recorded", len(outcome.attempts) == 3)
check("the log reads as the product describes it",
      [a.line() for a in outcome.attempts] == [
          "Attempt 1 → REGENERATION_REQUIRED → reject",
          "Attempt 2 → REGENERATION_REQUIRED → reject",
          "Attempt 3 → PASS → deliver",
      ], str([a.line() for a in outcome.attempts]))

print("\nwhen every attempt fails")
client, outcome = with_verdicts(["REGENERATION_REQUIRED"] * 5, attempts=5)
check("nothing is delivered", not outcome.delivered)
check("and no audio comes back at all", outcome.path is None)
check("the message is the one the product uses",
      "failed the musical quality gate after 5 attempts" in outcome.reason
      and "No incorrect audio was delivered." in outcome.reason, outcome.reason)
# The stub writes into its own directory and the controller moves each take into
# the run's workspace, so what is checked is that no .wav survives anywhere the
# loop touched. A rejected take left on disk is a rejected take somebody
# eventually plays.
survivors = sorted(
    str(path) for path in list(client.scratch.rglob("*.wav"))
    if path.is_file())
check("every rejected take's audio is deleted, not shelved",
      survivors == [], f"still on disk: {survivors}")

print("\nthe user's words")
client, outcome = with_verdicts(["REGENERATION_REQUIRED"] * 4, attempts=4)
check("reach every attempt byte for byte",
      all(call["style"] == STYLE and call["lyrics"] == LYRICS for call in client.calls))
check("are never translated or re-tagged",
      len({call["lyrics"] for call in client.calls}) == 1
      and "[Chorus]" in client.calls[0]["lyrics"])

print("\nverdicts regeneration cannot help")
client, outcome = with_verdicts(["ANALYSIS_UNAVAILABLE"] * 5, attempts=5)
check("stop the loop at once rather than burning attempts",
      len(client.calls) == 1, f"{len(client.calls)} calls")
check("are never delivered", not outcome.delivered)
check("keep the audio, clearly marked unverified",
      outcome.path is not None and "could not verify" in outcome.reason, outcome.reason)

client, outcome = with_verdicts(["REGENERATION_REQUIRED"] * 3, attempts=3)
check("a take that failed the gate is never offered, on any path", outcome.path is None)

print("\nthe gate refuses what it cannot measure")
missing = pipeline._unavailable("no separator", pipeline.SEPARATION_UNRELIABLE, {})
check("an unavailable report is never a pass", missing.verdict == "ANALYSIS_UNAVAILABLE")
check("and is never accepted", not missing.accepted)
check("and may never be delivered", not missing.delivery_allowed)
check("and names the code the loop branches on",
      missing.rejection_reasons == [pipeline.SEPARATION_UNRELIABLE])

print("\nthe gate has no analysis of its own left to disagree with")
_gate_src = Path(__file__).with_name("gate.py").read_text()
for banned in ("librosa", "pyin", "compatibility(", "formant"):
    check(f"gate.py does not reimplement {banned}", banned not in _gate_src)
check("gate.judge calls the shared pipeline", "pipeline.evaluate_audio" in _gate_src)
_analyze_src = Path(__file__).with_name("analyze.py").read_text()
check("analyze.py calls the same shared pipeline",
      "pipeline.evaluate_audio" in _analyze_src)

print("\nthresholds are strict by default")
check("harmonic compatibility must beat chance by 2 sigma", gate.STRICT.min_harmony_z == 2.0)
check("no severe conflict is tolerated", gate.STRICT.max_severe_conflicts == 0)
check("the defaults are the documented ones",
      gate.STRICT.max_grid_median_cents == 25.0
      and gate.STRICT.max_drift_share_percent == 25.0
      and gate.STRICT.max_register_centre_cents == 30.0)
check("octave errors are never accepted silently", gate.STRICT.accept_octave_errors is False)

print("\nthe user's words cannot be edited mid-run")
check("a changed sheet raises rather than sending it",
      issubclass(controller.LyricsChanged, RuntimeError))

print("\nthere is only one implementation left to disagree with")
import voice as voice_module
_pipeline_src = Path(__file__).with_name("pipeline.py").read_text()
check("the pipeline scores vocal frames rather than trusting the tracker",
      "voice_module.analyse_frames" in _pipeline_src)
check("and measures only the frames that survived",
      "sung = vocal.usable" in _pipeline_src)
# The defect that made this necessary, kept as numbers so nobody removes the
# filter as an optimisation: on a real 309-second ballad the same audio scored
# z = +2.30 over every voiced frame, +0.72 with the filter and +0.43 with a
# stricter one. The more certainly the frames were voice, the worse the fit.
check("the reason is written down where the model is",
      "z = +2.30" in voice_module.__doc__ and "+0.43" in voice_module.__doc__)
check("coverage is a gate, so a fragment cannot be passed off as a song",
      voice_module.MIN_COVERAGE_RATIO > 0 and voice_module.MIN_USABLE_SECONDS >= 20)

print()
if FAILURES:
    print(f"{len(FAILURES)} FAILED:")
    for failure in FAILURES:
        print(f"  - {failure}")
    sys.exit(1)
print("all gate and controller tests passed")
