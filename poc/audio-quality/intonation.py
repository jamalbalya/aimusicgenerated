"""Measuring whether sung notes are in tune — and saying what that cannot tell you.

There are two completely different questions hiding behind "is this in tune",
and conflating them produces a number that looks authoritative and means
nothing.

The first is **tuning to the grid**: given that the singer aimed at some note,
did they land on a semitone of the twelve-tone scale, or between two of them?
This is what `grid_deviation_cents` measures, and its answer is bounded to ±50
cents *by construction* — the distance to the nearest semitone can never be
more than half a semitone. A singer who is 70 cents sharp of the note they
meant is 30 cents flat of the note above, and this measure reports 30. That is
not a bug to be fixed; it is what "distance to the nearest grid point" means.
It is recorded here because the alternative — quietly reporting 30 and letting
a reader believe the note was nearly perfect — is how a measurement lies.

The second question is **note choice**: was that the right note for the chord
and the key? A wrong note sung with perfect technique scores zero on the first
measure. Only `scale_membership` and chord support can see it.

So when the intended pitch is known — a synthetic test, or a melody someone
wrote down — pass it as `reference_midi` and you get the true signed error,
unbounded. When it is not known, which is every real generated song, you get
the grid figure with its limitation attached, and you must read the note-choice
figures beside it.

Nothing here isolates a voice. On a mix containing piano, upright bass and
tenor saxophone, a pitch tracker follows whichever harmonic source is loudest,
and a saxophone occupies the same register as a male singer. Every report
carries `contaminated` for that reason, and a report with it set must never be
described as a measurement of the vocal.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field, asdict

#: Frames closer together than this are the same note, not two notes.
NOTE_GAP_FRAMES = 3

#: A note must last at least this long to be worth measuring. Shorter than this
#: and vibrato, consonants and tracker noise dominate whatever is reported.
MIN_NOTE_SECONDS = 0.12

#: How far a frame may sit from a note's running centre and still belong to it.
#: One semitone: wide enough for any vibrato a singer would use, narrow enough
#: that a real change of note starts a new one.
NOTE_TOLERANCE_SEMITONES = 1.0

#: Tolerances, and where they come from.
#:
#: A trained singer holds a sustained note within roughly 10-20 cents of its
#: centre; 25 cents (a quarter of a semitone) is where a listener reliably hears
#: "flat" or "sharp" rather than "expressive". These are the thresholds this
#: module reports at. They are conventions, not laws, and they are stated so a
#: reader can disagree with them rather than have to guess what was applied.
GOOD_CENTS = 15
AUDIBLE_CENTS = 25
BAD_CENTS = 35

#: Below this many analysed frames, no summary is produced at all. A median over
#: a handful of frames is a number with no standing.
MIN_FRAMES_FOR_SUMMARY = 100

#: Human singing vibrato lives here. Modulation faster or slower than this is
#: not vibrato, and is not excused as it.
VIBRATO_RATE_HZ = (4.0, 8.0)


def cents(frequency_hz: float, reference_hz: float) -> float:
    """Signed cents from a reference. **Unbounded** — 70 sharp reports +70.

    The primitive the grid measure is not. Use it whenever the intended pitch is
    known, which is the only way an error larger than a quarter tone can be seen
    for what it is.
    """
    if frequency_hz <= 0 or reference_hz <= 0:
        return float("nan")
    return 1200.0 * math.log2(frequency_hz / reference_hz)


def grid_deviation_cents(midi: float) -> float:
    """Distance to the nearest semitone, in cents. **Bounded to ±50.**

    Read the module docstring before using this. It answers "did the note land
    on the grid", never "was it the right note".
    """
    return (midi - round(midi)) * 100.0


@dataclass
class Note:
    """One sustained note, and what it did while it was held."""

    start_s: float
    end_s: float
    frames: int
    median_midi: float
    #: How far the note's own centre sits from the grid. Bounded ±50.
    centre_error_cents: float
    #: First frame to last. Positive is sharpening.
    drift_cents: float
    #: Standard deviation across the note: vibrato and wobble together.
    spread_cents: float
    #: Cycles per second of the pitch modulation, when there is one.
    vibrato_rate_hz: float | None
    #: Peak-to-centre extent of that modulation.
    vibrato_extent_cents: float | None

    @property
    def duration_s(self) -> float:
        return self.end_s - self.start_s

    @property
    def vibrato_is_human(self) -> bool:
        """Whether the modulation sits in the range a singer produces."""
        if self.vibrato_rate_hz is None:
            return False
        return VIBRATO_RATE_HZ[0] <= self.vibrato_rate_hz <= VIBRATO_RATE_HZ[1]


@dataclass
class IntonationReport:
    """What was measured, over how much, and what it cannot support."""

    frames: int
    analysed_seconds: float
    #: Analysed seconds over the track's length. A figure from 5% of a song is
    #: not a statement about the song.
    coverage_percent: float
    track_seconds: float

    grid_median_cents: float | None = None
    grid_bias_cents: float | None = None
    grid_worse_than: dict = field(default_factory=dict)

    #: Populated only when the intended pitches were supplied.
    reference_median_cents: float | None = None
    reference_max_abs_cents: float | None = None

    notes: list = field(default_factory=list)
    note_centre_median_cents: float | None = None
    note_drift_median_cents: float | None = None
    note_spread_median_cents: float | None = None
    notes_drifting_over_50c: float | None = None

    scale_membership_percent: float | None = None
    chord_tone_percent: float | None = None
    weakly_supported_percent: float | None = None

    #: True whenever the measured signal is not an isolated vocal.
    contaminated: bool = True
    contamination_note: str = ""
    limitations: list = field(default_factory=list)

    @property
    def sufficient(self) -> bool:
        return self.frames >= MIN_FRAMES_FOR_SUMMARY

    @property
    def confidence(self) -> str:
        """How much weight the numbers will bear. Deliberately pessimistic."""
        if not self.sufficient:
            return "insufficient"
        if self.contaminated:
            return "low — not an isolated vocal"
        if self.coverage_percent < 20:
            return "low — small share of the track"
        return "moderate"

    def as_dict(self) -> dict:
        out = asdict(self)
        out["notes"] = [asdict(n) for n in self.notes]
        out["confidence"] = self.confidence
        out["sufficient"] = self.sufficient
        return out


def segment_notes(times, midi, voiced, window_seconds: float = 0.0) -> list:
    """Group voiced frames into held notes.

    A note runs while consecutive frames stay within a semitone of its running
    centre. That is wide on purpose: vibrato of ±50 cents is still one note, and
    splitting it into many would turn expression into a fault.
    """
    import numpy as np

    notes: list = []
    indices = [i for i, v in enumerate(voiced) if v and math.isfinite(midi[i])]
    if not indices:
        return notes

    frame_seconds = float(times[1] - times[0]) if len(times) > 1 else 0.0
    minimum = max(3, int(MIN_NOTE_SECONDS / frame_seconds)) if frame_seconds > 0 else 3

    run = [indices[0]]
    for i in indices[1:]:
        centre = float(np.median([midi[k] for k in run]))
        if i - run[-1] <= NOTE_GAP_FRAMES and abs(midi[i] - centre) <= NOTE_TOLERANCE_SEMITONES:
            run.append(i)
            continue
        if len(run) >= minimum:
            notes.append(_describe_note(times, midi, run, frame_seconds, window_seconds))
        run = [i]
    if len(run) >= minimum:
        notes.append(_describe_note(times, midi, run, frame_seconds, window_seconds))
    return notes


def _describe_note(times, midi, run, frame_seconds: float, window_seconds: float = 0.0) -> Note:
    import numpy as np

    values = np.array([midi[k] for k in run], dtype=float)
    centre = float(np.median(values))
    deviation = (values - centre) * 100.0

    rate, extent = _vibrato(deviation, frame_seconds, window_seconds)
    # Drift is measured on the vibrato-free trend, so a note that wobbles evenly
    # around one pitch is not accused of sliding. Least squares over the note.
    if len(values) >= 4:
        x = np.arange(len(values), dtype=float)
        slope = float(np.polyfit(x, values * 100.0, 1)[0])
        drift = slope * (len(values) - 1)
    else:
        drift = float((values[-1] - values[0]) * 100.0)

    return Note(
        start_s=float(times[run[0]]),
        end_s=float(times[run[-1]]),
        frames=len(run),
        median_midi=centre,
        centre_error_cents=grid_deviation_cents(centre),
        drift_cents=drift,
        spread_cents=float(np.std(deviation)),
        vibrato_rate_hz=rate,
        vibrato_extent_cents=extent,
    )


def _vibrato(deviation_cents, frame_seconds: float, window_seconds: float = 0.0):
    """Rate and extent of a periodic wobble, or (None, None) when there is none.

    `window_seconds` is how long the pitch tracker's own analysis window is, and
    it decides whether the extent can be measured at all. A window that spans
    more than half a vibrato cycle averages the wobble away: the rate still
    shows, because the residual modulation keeps its period, but the depth comes
    back far smaller than it is. A 16384-sample window at 44.1 kHz is 0.37 s,
    which is more than two cycles of a 6 Hz vibrato and reports roughly a sixth
    of the true extent.

    Rather than return that number, the extent is withheld. A wrong depth would
    be read as "controlled vibrato" when the singer is swinging a quarter tone.
    """
    import numpy as np

    n = len(deviation_cents)
    if n < 8 or frame_seconds <= 0:
        return None, None
    centred = deviation_cents - deviation_cents.mean()
    if np.allclose(centred, 0):
        return None, None
    spectrum = np.abs(np.fft.rfft(centred * np.hanning(n)))
    freqs = np.fft.rfftfreq(n, frame_seconds)
    usable = (freqs >= 1.0) & (freqs <= 12.0)
    if not usable.any() or spectrum[usable].max() <= 0:
        return None, None
    peak = int(np.argmax(spectrum[usable]))
    rate = float(freqs[usable][peak])
    if window_seconds > 0 and rate > 0 and window_seconds > 0.5 / rate:
        # The tracker cannot see this fast a wobble; see the docstring.
        return rate, None
    # Extent as the amplitude of a sine with this RMS: a pure sine's RMS is
    # amplitude / sqrt(2), and quoting the RMS as "extent" would understate the
    # swing a listener hears by 40%.
    extent = float(np.std(centred) * math.sqrt(2.0))
    return rate, extent


def measure(
    times,
    frequencies_hz,
    voiced,
    track_seconds: float,
    *,
    reference_hz=None,
    isolated_vocal: bool = False,
    contamination_note: str = "",
    analysis_window_seconds: float = 0.0,
) -> IntonationReport:
    """Everything above, gathered into one report that states its own standing.

    `reference_hz` is the intended pitch per frame when it is known. Supply it
    and the report carries the true signed error, unbounded, which is the only
    way a note 70 cents sharp is reported as 70 rather than as 30 the other way.
    """
    import numpy as np

    frequencies_hz = np.asarray(frequencies_hz, dtype=float)
    times = np.asarray(times, dtype=float)
    voiced = np.asarray(voiced, dtype=bool)

    usable = voiced & np.isfinite(frequencies_hz) & (frequencies_hz > 0)
    frame_seconds = float(times[1] - times[0]) if len(times) > 1 else 0.0
    analysed = float(usable.sum()) * frame_seconds

    report = IntonationReport(
        frames=int(usable.sum()),
        analysed_seconds=analysed,
        coverage_percent=(100.0 * analysed / track_seconds) if track_seconds > 0 else 0.0,
        track_seconds=track_seconds,
        contaminated=not isolated_vocal,
        contamination_note=contamination_note or (
            "" if isolated_vocal else
            "Measured on a mix, not an isolated vocal. A pitch tracker follows the "
            "loudest harmonic source, and piano, upright bass and saxophone share a "
            "male singer's register, so these figures cannot be attributed to the voice."
        ),
    )
    report.limitations.append(
        "grid_median_cents is bounded to +/-50 by construction: it measures landing on "
        "the twelve-tone grid, never whether the note was the right one for the chord."
    )
    if analysis_window_seconds > 0.0625:
        report.limitations.append(
            f"The pitch tracker's window is {analysis_window_seconds*1000:.0f} ms, so vibrato "
            "faster than "
            f"{0.5/analysis_window_seconds:.1f} Hz is averaged away and its extent is withheld "
            "rather than under-reported."
        )
    if not isolated_vocal:
        report.limitations.append(
            "No vocal isolation was applied, so no figure here is a vocal measurement."
        )
    if not report.sufficient:
        report.limitations.append(
            f"Only {report.frames} usable frames; {MIN_FRAMES_FOR_SUMMARY} are required "
            "before a summary is reported at all."
        )
        return report

    midi = 69.0 + 12.0 * np.log2(np.where(usable, frequencies_hz, 440.0) / 440.0)
    grid = np.array([grid_deviation_cents(m) for m in midi[usable]])
    report.grid_median_cents = float(np.median(np.abs(grid)))
    report.grid_bias_cents = float(grid.mean())
    report.grid_worse_than = {
        f"{limit}c": float(100.0 * (np.abs(grid) > limit).mean())
        for limit in (GOOD_CENTS, AUDIBLE_CENTS, BAD_CENTS)
    }

    if reference_hz is not None:
        reference_hz = np.asarray(reference_hz, dtype=float)
        pairs = usable & np.isfinite(reference_hz) & (reference_hz > 0)
        if pairs.any():
            true_error = np.array([
                cents(f, r) for f, r in zip(frequencies_hz[pairs], reference_hz[pairs])
            ])
            report.reference_median_cents = float(np.median(true_error))
            report.reference_max_abs_cents = float(np.max(np.abs(true_error)))

    notes = segment_notes(times, midi, usable, analysis_window_seconds)
    report.notes = notes
    if notes:
        report.note_centre_median_cents = float(np.median([abs(n.centre_error_cents) for n in notes]))
        report.note_drift_median_cents = float(np.median([n.drift_cents for n in notes]))
        report.note_spread_median_cents = float(np.median([n.spread_cents for n in notes]))
        report.notes_drifting_over_50c = float(
            100.0 * np.mean([abs(n.drift_cents) > 50 for n in notes])
        )
    return report


def scale_membership(midi_values, scale_pitch_classes) -> float:
    """Per cent of frames whose pitch class is in the given scale.

    The measure `grid_deviation_cents` cannot make: a note perfectly on the grid
    and outside the key is exactly the failure a listener calls "off-key".
    """
    import numpy as np

    if len(midi_values) == 0:
        return float("nan")
    classes = np.mod(np.round(np.asarray(midi_values, dtype=float)), 12).astype(int)
    return float(100.0 * np.isin(classes, list(scale_pitch_classes)).mean())
