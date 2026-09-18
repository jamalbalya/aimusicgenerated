"""What a generation was asked for, stated as data rather than as prose.

A caption saying "72 BPM" is a wish. ACE-Step has no tempo parameter — its
endpoint takes a style string, a lyric sheet, a language, a vocal gender, an
instrumental flag and a duration, and nothing in that list is a tempo — so the
words travel to the model and the model does what it likes with them. The
measured result on one real song was 89.1 BPM against a requested 72.

So the request is recorded here, separately from the caption, and checked
against the audio afterwards. This is not enforcement at generation time,
because no such enforcement is available; it is enforcement at delivery time,
which is the only kind this engine can actually have.
"""

from __future__ import annotations

from dataclasses import dataclass, asdict

#: Tempos a song can plausibly be written at. Below 40 the beat stops being felt
#: as a pulse and above 220 it is usually being counted in half.
BPM_RANGE = (40.0, 220.0)

#: How far the measured tempo may sit from the requested one.
#:
#: Two BPM. At 72 that is 2.8%, which is inside what a human rhythm section
#: drifts by and well outside what a generated track does — the same song
#: measured 0.0 BPM of spread across ten thirty-second windows. A tolerance
#: loose enough to absorb 89.1 against 72 would not be a tolerance.
DEFAULT_BPM_TOLERANCE = 2.0


class InvalidRequirement(ValueError):
    """A requirement that cannot be satisfied or cannot be checked."""


@dataclass(frozen=True)
class TempoRequirement:
    """A requested tempo and how far from it is still acceptable."""

    target_bpm: float
    tolerance_bpm: float = DEFAULT_BPM_TOLERANCE

    def __post_init__(self) -> None:
        if not isinstance(self.target_bpm, (int, float)) or self.target_bpm != self.target_bpm:
            raise InvalidRequirement("target_bpm must be a number.")
        if self.target_bpm <= 0:
            raise InvalidRequirement(f"target_bpm must be positive; got {self.target_bpm}.")
        low, high = BPM_RANGE
        if not (low <= self.target_bpm <= high):
            raise InvalidRequirement(
                f"target_bpm {self.target_bpm} is outside the practical range {low:.0f}-{high:.0f}. "
                "Nothing here rounds it into range: a tempo nobody can play is a request to fix, "
                "not a number to adjust behind someone's back.")
        if self.tolerance_bpm <= 0:
            raise InvalidRequirement(
                f"tolerance_bpm must be positive; got {self.tolerance_bpm}. A tolerance of zero "
                "fails every take, because no estimator returns an exact integer.")

    @property
    def low(self) -> float:
        return self.target_bpm - self.tolerance_bpm

    @property
    def high(self) -> float:
        return self.target_bpm + self.tolerance_bpm

    def as_dict(self) -> dict:
        return asdict(self)


@dataclass(frozen=True)
class QualityRequirements:
    """Everything a take is held to. Tempo is optional; nothing else is."""

    tempo: TempoRequirement | None = None
    #: Seconds the song was asked for, when a length was asked for.
    duration_seconds: float | None = None

    def as_dict(self) -> dict:
        return {
            "tempo": self.tempo.as_dict() if self.tempo else None,
            "duration_seconds": self.duration_seconds,
        }


def tempo_requirement(target_bpm: float | None,
                      tolerance_bpm: float = DEFAULT_BPM_TOLERANCE) -> TempoRequirement | None:
    """A requirement, or None when no tempo was asked for.

    None means "not checked", never "passed". The difference matters: a song
    generated with no tempo in mind cannot fail a tempo check, and must not be
    reported as having cleared one.
    """
    if target_bpm is None:
        return None
    return TempoRequirement(float(target_bpm), float(tolerance_bpm))
