"""The quality gate for a generated take.

This file used to contain its own copy of the analysis, and the copy drifted.
On a real 309-second ballad it reported z = +2.30 where `analyze.py` reported
+0.72 on the same audio, because one filtered the vocal stem for frames that
looked like a voice and the other counted every frame a pitch tracker called
voiced — and the permissive one was this file, the one that decides whether a
song reaches a listener.

So the analysis lives in `pipeline.evaluate_audio` and this is the thin layer
that calls it. There is nothing left here to disagree with, which is the point:
two implementations of one measurement drift, and the drift is always found
late.
"""

from __future__ import annotations

from pathlib import Path

import pipeline
from pipeline import QualityReport, Thresholds, STRICT  # noqa: F401 - re-exported
from requirements import QualityRequirements, TempoRequirement, tempo_requirement  # noqa: F401


def judge(path: Path, thresholds: Thresholds = STRICT,
          requirements: QualityRequirements | None = None) -> QualityReport:
    """Separate, measure, and decide. Never guesses, never passes on a mix."""
    return pipeline.evaluate_audio(path, requirements, thresholds)


def judge_with_tempo(path: Path, target_bpm: float | None,
                     tolerance_bpm: float | None = None,
                     thresholds: Thresholds = STRICT) -> QualityReport:
    """The same, for a caller that only has a requested tempo to hand."""
    requirement = (tempo_requirement(target_bpm, tolerance_bpm)
                   if tolerance_bpm is not None else tempo_requirement(target_bpm))
    return judge(path, thresholds, QualityRequirements(tempo=requirement))
