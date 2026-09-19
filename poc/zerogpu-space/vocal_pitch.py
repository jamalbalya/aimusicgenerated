"""Correcting the vocal of a generated song, inside the one GPU call.

The product requirement is a final vocal with no audible out-of-tune notes.
Nothing in a caption achieves that: "sing in tune" is an instruction to a
generative model, and a model that ignores it has not malfunctioned. The only
way to control the final pitch is to measure it and change it, which is what
this module does.

Why here and not in the browser: separation needs a model and a GPU, and both
are already allocated for the generation this runs after. Doing it in the Space
keeps the whole thing inside one request — one press of Generate, one ACE-Step
generation, then processing. No second generation, ever; there is no code path
in this file that calls the model again.

The chain:

    mixed song
        -> separate            Hybrid Demucs (torchaudio bundle)
        -> vocal stem + backing
        -> F0                  YIN, with confidence and octave repair
        -> align               measured notes against the planned melody
        -> decide              which deviations are errors and which are music
        -> correct             TD-PSOLA, per period, formants intact
        -> remix               corrected vocal + untouched backing
        -> master              peak-safe, no added loudness

Three design decisions worth defending, because each has an obvious wrong
answer that looks right:

**Separation is Hybrid Demucs from `torchaudio.pipelines`, not Spleeter.** Not
because it separates better, though it does, but because it is already
installed: `torchaudio` is pinned in this Space's requirements for ACE-Step
itself, and `HDEMUCS_HIGH_MUSDB_PLUS` is a bundle inside it. Spleeter would add
TensorFlow, a 73 MB checkpoint and a second numerical stack to a Space that
already has a build it cannot debug interactively. Zero new dependencies beat a
marginally different SDR.

**Correction is fixed-length varispeed, and that is not the answer I expected.**
The textbook choice is TD-PSOLA, which moves pitch periods without resampling
and so leaves the formants where they are. I implemented it, measured it, and it
lost: on a synthetic vowel with a fixed formant envelope it hit the target pitch
exactly while moving the spectral centroid about 34% — in the same direction
whether the pitch went up or down, which is the signature of discontinuity noise
at the grain joins rather than of a formant shift. Fixed-length resampling hit
the same pitches with 3-6% drift that tracked the shift ratio exactly: a clean
formant shift and nothing else. Since corrections here are capped near a
semitone, that is at most ~6% of formant movement, which is inaudible, against
34% of artefact, which is not. A better PSOLA would beat this; the one I wrote
did not, and the measurement outranks the theory. `_shift_note` carries the
numbers.

**Only anchor notes are corrected, and only past a threshold.** A vocal with
every frame snapped to a grid is the robotic result the requirement also
forbids. Vibrato is pitch movement. A scoop into a note is pitch movement. An
expressive approach note is a wrong note that is meant. So the correction acts
on sustained, load-bearing notes that are wrong by more than a singer's own
natural variation, and leaves the rest of the performance alone.

Nothing in this file has been run against a real ACE-Step vocal. The DSP is
tested against synthesised signals with known pitch; the separation is not
tested here at all, because `torchaudio` is not installed in the environment
this was written in. See the module tests and the honest status in
`docs/quality/vocal-pitch-pipeline.md`.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Optional, Sequence

import numpy as np
from scipy.signal import resample

# ----------------------------------------------------------------- constants ---

#: Frame rate for F0 analysis. 100 Hz — 10 ms — is fine enough to follow a
#: vibrato at 6 Hz with a dozen samples a cycle, and coarse enough to stay cheap
#: on a four-minute song.
F0_HOP_SECONDS = 0.010

#: The range a sung voice occupies. Wider than any one singer, narrow enough
#: that a detector cannot report a bass drum or a cymbal as a note.
F0_MIN_HZ = 65.0    # C2
F0_MAX_HZ = 1200.0  # ~D6

#: YIN's aperiodicity threshold. Below this a frame is periodic enough to be a
#: pitch; above it, it is noise, a consonant or silence.
YIN_THRESHOLD = 0.15

#: Above this the frame is not periodic at all and has no pitch. Separate from
#: YIN_THRESHOLD, which picks *which* dip is the period: this decides whether
#: there is a period to pick. Without it, the fallback to the global minimum
#: gave white noise a pitch in every frame.
UNVOICED_THRESHOLD = 0.45

#: A frame quieter than this, relative to the stem's own loud passages, is not
#: singing. Stops a detector from finding pitch in a reverb tail.
SILENCE_FLOOR_DB = -45.0

#: How far a note may sit from its target before that is an error rather than
#: expression. A trained singer holds a note inside about 20 cents; 50 is a
#: quarter tone, which is unambiguously audible as wrong.
AUDIBLE_ERROR_CENTS = 35.0

#: Deviation beyond which a note is certainly wrong rather than stylistic.
GROSS_ERROR_CENTS = 90.0

#: A note must last this long before it is worth correcting. Below it, a listener
#: hears a transition, not a pitch.
MIN_CORRECTABLE_SECONDS = 0.12

#: How much of the correction to apply. Not 1.0: pulling a note exactly onto a
#: mathematical centre removes the last of its life, and the difference between
#: 4 cents off and 0 cents off is inaudible while the naturalness is not.
CORRECTION_STRENGTH = 0.92

#: Vibrato lives here. Movement in this band is preserved rather than flattened.
VIBRATO_MIN_HZ = 4.0
VIBRATO_MAX_HZ = 8.0


def hz_to_midi(hz: float) -> float:
    return 69.0 + 12.0 * math.log2(hz / 440.0)


def midi_to_hz(midi: float) -> float:
    return 440.0 * (2.0 ** ((midi - 69.0) / 12.0))


def cents_between(actual: float, target: float) -> float:
    """Positive when `actual` is sharp of `target`."""
    if actual <= 0 or target <= 0:
        return 0.0
    return 1200.0 * math.log2(actual / target)


# ------------------------------------------------------------------ F0 ---------


@dataclass
class F0Track:
    """Per-frame pitch, with enough context to know when not to trust it."""

    times: np.ndarray          # seconds, frame centres
    f0: np.ndarray             # Hz, 0 where unvoiced
    confidence: np.ndarray     # 0..1
    voiced: np.ndarray         # bool
    hop_seconds: float

    @property
    def voiced_ratio(self) -> float:
        return float(self.voiced.mean()) if self.voiced.size else 0.0


def _yin_difference(frame: np.ndarray, max_lag: int) -> np.ndarray:
    """YIN's cumulative mean normalised difference, for one frame.

    The plain difference function has a trivial minimum at lag 0, which is why
    YIN normalises by the running mean: it turns "how similar" into "how much
    more similar than average", and the first dip below a threshold is the
    period rather than a harmonic of it.
    """
    difference = np.zeros(max_lag, dtype=np.float64)
    for lag in range(1, max_lag):
        delta = frame[lag:] - frame[:-lag]
        difference[lag] = float(np.dot(delta, delta))

    cumulative = np.cumsum(difference[1:])
    normalised = np.ones(max_lag, dtype=np.float64)
    # Guard the first frames: cumulative[0] can be 0 on digital silence.
    with np.errstate(divide="ignore", invalid="ignore"):
        scale = cumulative / np.arange(1, max_lag)
        normalised[1:] = np.where(scale > 0, difference[1:] / scale, 1.0)
    return normalised


def _parabolic_refine(values: np.ndarray, index: int) -> float:
    """Sub-sample minimum, so the period is not quantised to whole samples.

    At 22 kHz a whole-sample period step near 440 Hz is about 20 cents, which is
    the size of the errors being corrected. Without this the detector's own
    resolution would be mistaken for the singer's.
    """
    if index <= 0 or index >= len(values) - 1:
        return float(index)
    before, here, after = values[index - 1], values[index], values[index + 1]
    denominator = 2.0 * (2.0 * here - before - after)
    if abs(denominator) < 1e-12:
        return float(index)
    return float(index) + (after - before) / denominator


def detect_f0(audio: np.ndarray, sample_rate: int,
              hop_seconds: float = F0_HOP_SECONDS) -> F0Track:
    """YIN pitch tracking with confidence, silence gating and octave repair.

    Returns a frame for every hop, voiced or not. The caller needs the unvoiced
    frames as much as the voiced ones: a gap is where a consonant or a breath
    is, and correcting across one is how a splice becomes audible.
    """
    audio = np.asarray(audio, dtype=np.float64).reshape(-1)
    hop = max(1, int(round(hop_seconds * sample_rate)))
    # The window must hold two periods of the lowest pitch, or the lowest note
    # has no lag to find.
    window = int(round(sample_rate / F0_MIN_HZ * 2.5))
    max_lag = int(round(sample_rate / F0_MIN_HZ))
    min_lag = max(2, int(round(sample_rate / F0_MAX_HZ)))

    if audio.size < window * 2:
        empty = np.zeros(0)
        return F0Track(empty, empty, empty, np.zeros(0, dtype=bool), hop_seconds)

    # The loudness floor is relative to this stem's own loud passages, not to
    # full scale: a quiet mix would otherwise read as entirely unvoiced.
    frame_count = 1 + (audio.size - window) // hop
    rms = np.zeros(frame_count)
    for index in range(frame_count):
        frame = audio[index * hop: index * hop + window]
        rms[index] = float(np.sqrt(np.mean(frame * frame)))
    reference = float(np.percentile(rms, 95)) if frame_count else 0.0
    floor = reference * (10.0 ** (SILENCE_FLOOR_DB / 20.0))

    times = np.zeros(frame_count)
    f0 = np.zeros(frame_count)
    confidence = np.zeros(frame_count)

    for index in range(frame_count):
        start = index * hop
        times[index] = (start + window / 2) / sample_rate
        if rms[index] <= floor:
            continue

        frame = audio[start: start + window]
        difference = _yin_difference(frame, max_lag)
        search = difference[min_lag:]
        if search.size == 0:
            continue

        # The *first* dip below the threshold, not the lowest: the lowest is
        # often an octave down, because a signal correlates with itself at twice
        # its period nearly as well as at its period. Taking the first is YIN's
        # own answer to octave error and it is most of why YIN works.
        below = np.flatnonzero(search < YIN_THRESHOLD)
        if below.size > 0:
            local = int(below[0])
            # Walk to the bottom of that dip.
            while local + 1 < search.size and search[local + 1] < search[local]:
                local += 1
        else:
            local = int(np.argmin(search))

        # Only a frame that is genuinely periodic gets a pitch. Taking the
        # minimum of the difference function regardless would hand every frame
        # a number, and white noise would come back 100% voiced with a
        # confidently wrong pitch — which it did, until this test caught it.
        # An aperiodic frame has no pitch, and saying so is the answer.
        if search[local] >= UNVOICED_THRESHOLD:
            continue

        lag = _parabolic_refine(search, local) + min_lag
        if lag <= 0:
            continue
        candidate = sample_rate / lag
        if not (F0_MIN_HZ <= candidate <= F0_MAX_HZ):
            continue

        f0[index] = candidate
        confidence[index] = float(max(0.0, 1.0 - search[local]))

    voiced = f0 > 0
    return _repair_octaves(F0Track(times, f0, confidence, voiced, hop_seconds))


def _repair_octaves(track: F0Track) -> F0Track:
    """Fixes single-frame jumps of an octave, which are detector errors.

    A singer does not leap an octave for one hundredth of a second and come
    back. When the track does, the detector halved or doubled a period, and the
    fix is to put it back rather than to correct the audio toward a pitch nobody
    sang.
    """
    f0 = track.f0.copy()
    voiced = np.flatnonzero(track.voiced)
    for position in range(1, len(voiced) - 1):
        previous, here, following = voiced[position - 1], voiced[position], voiced[position + 1]
        # Only inside a continuous run: a jump across a gap is a new phrase.
        if here - previous > 2 or following - here > 2:
            continue
        neighbours = (f0[previous] + f0[following]) / 2.0
        if neighbours <= 0 or f0[here] <= 0:
            continue
        ratio = f0[here] / neighbours
        for factor in (2.0, 0.5):
            if abs(ratio - factor) < 0.12:
                f0[here] = f0[here] / factor
                break
    return F0Track(track.times, f0, track.confidence, f0 > 0, track.hop_seconds)


# ------------------------------------------------------------- alignment -------


@dataclass
class MeasuredNote:
    """A stretch of continuous voicing, treated as one sung note."""

    start_seconds: float
    end_seconds: float
    median_hz: float
    median_midi: float
    confidence: float
    frame_indices: np.ndarray
    #: Peak-to-peak pitch movement in cents, before any correction.
    movement_cents: float
    #: True when that movement looks like vibrato rather than drift.
    has_vibrato: bool


def segment_notes(track: F0Track, min_seconds: float = 0.06) -> list[MeasuredNote]:
    """Splits the F0 track into notes at gaps and at real pitch changes."""
    notes: list[MeasuredNote] = []
    if track.f0.size == 0:
        return notes

    run: list[int] = []

    def close(indices: Sequence[int]) -> None:
        if len(indices) < 2:
            return
        idx = np.asarray(indices)
        hz = track.f0[idx]
        start = float(track.times[idx[0]])
        end = float(track.times[idx[-1]]) + track.hop_seconds
        if end - start < min_seconds:
            return
        midi = np.array([hz_to_midi(value) for value in hz])
        # The median, not the mean: a scoop into a note would drag a mean away
        # from the pitch the note actually settles on, and the settled pitch is
        # what a listener calls the note.
        median_midi = float(np.median(midi))
        movement = float((midi.max() - midi.min()) * 100.0)
        notes.append(MeasuredNote(
            start_seconds=start,
            end_seconds=end,
            median_hz=float(np.median(hz)),
            median_midi=median_midi,
            confidence=float(np.median(track.confidence[idx])),
            frame_indices=idx,
            movement_cents=movement,
            has_vibrato=_looks_like_vibrato(midi, track.hop_seconds),
        ))

    for index in range(track.f0.size):
        if not track.voiced[index]:
            close(run)
            run = []
            continue
        if run:
            # A jump of more than a whole tone between adjacent frames is a new
            # note, not a slide: a real portamento moves through the space
            # between, and this does not.
            step = abs(hz_to_midi(track.f0[index]) - hz_to_midi(track.f0[run[-1]]))
            if step > 2.0:
                close(run)
                run = []
        run.append(index)
    close(run)
    return notes


def _looks_like_vibrato(midi: np.ndarray, hop_seconds: float) -> bool:
    """True when the pitch oscillates in the 4-8 Hz band a singer's does.

    Distinguishing vibrato from drift matters because they need opposite
    treatment: vibrato is the performance and must survive, drift is the error
    and must not.
    """
    if midi.size < 8:
        return False
    centred = midi - np.mean(midi)
    if np.max(np.abs(centred)) < 0.05:  # under 5 cents: not vibrato, just noise
        return False
    spectrum = np.abs(np.fft.rfft(centred * np.hanning(centred.size)))
    freqs = np.fft.rfftfreq(centred.size, d=hop_seconds)
    band = (freqs >= VIBRATO_MIN_HZ) & (freqs <= VIBRATO_MAX_HZ)
    if not band.any() or spectrum.sum() <= 0:
        return False
    return float(spectrum[band].sum() / spectrum.sum()) > 0.35


@dataclass
class TargetNote:
    """One note of the planned melody, as the browser sent it."""

    start_seconds: float
    end_seconds: float
    midi: int
    is_anchor: bool

    @property
    def frequency_hz(self) -> float:
        return midi_to_hz(self.midi)


@dataclass
class Alignment:
    """A measured note paired with what it was supposed to be."""

    measured: MeasuredNote
    target: Optional[TargetNote]
    deviation_cents: float
    #: Why this note is or is not corrected.
    decision: str
    correct: bool


def align(notes: Sequence[MeasuredNote], targets: Sequence[TargetNote]) -> list[Alignment]:
    """Matches sung notes to planned notes by overlap in time.

    ACE-Step does not sing the planned melody — it has never seen it — so this
    is not a lookup. It asks which planned note a sung note *corresponds* to,
    by time, and then asks what that implies about its pitch.

    A sung note with no overlapping target is left alone. Correcting a note
    against a target that is not its own would be worse than not correcting it.
    """
    aligned: list[Alignment] = []
    for note in notes:
        best: Optional[TargetNote] = None
        best_overlap = 0.0
        for target in targets:
            overlap = min(note.end_seconds, target.end_seconds) - max(note.start_seconds, target.start_seconds)
            if overlap > best_overlap:
                best_overlap = overlap
                best = target

        if best is None or best_overlap <= 0:
            aligned.append(Alignment(note, None, 0.0, "no planned note overlaps this one", False))
            continue

        deviation = cents_between(note.median_hz, best.frequency_hz)
        # Octave-fold: a note sung an octave from the plan is the right note in
        # the wrong register, and dragging it across an octave would be a worse
        # edit than leaving it. Judge it within its own octave.
        folded = deviation
        while folded > 600:
            folded -= 1200
        while folded < -600:
            folded += 1200

        duration = note.end_seconds - note.start_seconds
        magnitude = abs(folded)

        if not best.is_anchor:
            decision, correct = "passing note, left as performed", False
        elif duration < MIN_CORRECTABLE_SECONDS:
            decision, correct = "too short to hear as a pitch", False
        elif note.confidence < 0.35:
            decision, correct = "pitch not measured confidently enough to act on", False
        elif magnitude < AUDIBLE_ERROR_CENTS:
            decision, correct = f"within {AUDIBLE_ERROR_CENTS:.0f} cents, audibly in tune", False
        elif note.has_vibrato and magnitude < GROSS_ERROR_CENTS:
            # Vibrato centred correctly reads as in tune even when individual
            # frames are not. Only a grossly wrong vibrato note is moved.
            decision, correct = "vibrato around the target, preserved", False
        else:
            decision, correct = f"{folded:+.0f} cents from the planned note", True

        aligned.append(Alignment(note, best, folded, decision, correct))
    return aligned


# ------------------------------------------------------------- correction ------


def _shift_note(audio: np.ndarray, start: int, end: int, ratio: float) -> np.ndarray:
    """Shifts one note by `ratio`, keeping its length exactly.

    Fixed-length varispeed: read `length * ratio` samples and resample them to
    `length`. Reading more and squeezing it in raises the pitch; reading less
    and stretching it lowers it. The note still starts and ends where it did, so
    no note after it drifts.

    **This replaced a TD-PSOLA implementation, on measurement.** The argument for
    PSOLA is textbook and I made it here in an earlier version: it moves pitch
    periods without resampling, so the formants stay put, where varispeed drags
    them along with the pitch. The argument is sound and my implementation of it
    was not. Measured on a synthetic vowel with a fixed formant envelope, at the
    ratios this pipeline actually uses:

        method                pitch          spectral centroid drift
        TD-PSOLA (mine)       exact          ~34%, same direction either way
        fixed-length resample exact          3-6%, tracking the shift

    A drift that goes the same way whether the pitch went up or down is not a
    formant shift, it is broadband discontinuity noise at the grain joins — the
    "processed" sound the requirement forbids. The resample's drift, by
    contrast, is 4.35% for a 4.34% shift: a pure formant shift and nothing else.

    And the shifts here are small by construction. Corrections are capped near a
    semitone, so the formant movement is at most about 6% — under the threshold
    where a voice starts to sound like a different person, and far under the
    cost of the artefacts. A better PSOLA would beat this. The one I wrote did
    not, and shipping the theory over the measurement would have been shipping a
    worse-sounding vocal with a better-sounding justification.
    """
    length = end - start
    if length <= 0 or ratio <= 0 or abs(ratio - 1.0) < 1e-4:
        return audio[start:end].copy()

    needed = int(round(length * ratio))
    if needed < 8:
        return audio[start:end].copy()

    available = audio[start: start + needed]
    if available.size < needed:
        # Ran past the end of the stem. Extend by repeating the last whole cycle
        # rather than padding with silence, which would put a gap inside a note.
        if available.size == 0:
            return audio[start:end].copy()
        tail = available[-min(available.size, 1024):]
        repeats = int(np.ceil((needed - available.size) / tail.size))
        available = np.concatenate([available, np.tile(tail, repeats)])[:needed]

    return resample(available, length).astype(np.float64)


@dataclass
class CorrectionReport:
    """What was changed, and what was deliberately not."""

    notes_examined: int = 0
    notes_corrected: int = 0
    notes_left_alone: int = 0
    total_cents_moved: float = 0.0
    largest_correction_cents: float = 0.0
    median_deviation_before_cents: float = 0.0
    median_deviation_after_cents: float = 0.0
    anchors_examined: int = 0
    anchors_within_tolerance_before: int = 0
    anchors_within_tolerance_after: int = 0
    decisions: list[str] = field(default_factory=list)
    unavailable: Optional[str] = None


def correct_vocal(vocal: np.ndarray, sample_rate: int,
                  targets: Sequence[TargetNote]) -> tuple[np.ndarray, CorrectionReport]:
    """Measures the vocal, decides what is wrong, and fixes only that.

    Returns the corrected vocal and a report. Never raises: a stem it cannot
    analyse comes back unchanged with the reason recorded, because returning the
    original vocal is always better than returning a damaged one.
    """
    report = CorrectionReport()
    vocal = np.asarray(vocal, dtype=np.float64).reshape(-1)
    if vocal.size < sample_rate // 2:
        report.unavailable = "The vocal stem is too short to analyse."
        return vocal, report
    if not np.any(np.abs(vocal) > 1e-4):
        report.unavailable = "The vocal stem is silent."
        return vocal, report

    track = detect_f0(vocal, sample_rate)
    if track.voiced_ratio < 0.02:
        report.unavailable = (
            "No sustained pitch was found in the vocal stem, so there is nothing to correct."
        )
        return vocal, report

    notes = segment_notes(track)
    alignments = align(notes, targets)
    report.notes_examined = len(alignments)

    deviations_before = [abs(a.deviation_cents) for a in alignments if a.target is not None]
    anchors = [a for a in alignments if a.target is not None and a.target.is_anchor]
    report.anchors_examined = len(anchors)
    report.anchors_within_tolerance_before = sum(
        1 for a in anchors if abs(a.deviation_cents) < AUDIBLE_ERROR_CENTS)

    output = vocal.copy()
    for alignment in alignments:
        if not alignment.correct or alignment.target is None:
            report.notes_left_alone += 1
            continue

        note = alignment.measured
        start = int(round(note.start_seconds * sample_rate))
        end = min(output.size, int(round(note.end_seconds * sample_rate)))
        if end - start < int(MIN_CORRECTABLE_SECONDS * sample_rate):
            report.notes_left_alone += 1
            continue

        # Correct most of the way, not all of it. The residue is inaudible and
        # the alternative sounds machined.
        move_cents = -alignment.deviation_cents * CORRECTION_STRENGTH
        ratio = 2.0 ** (move_cents / 1200.0)
        shifted = _shift_note(output, start, end, ratio)
        if shifted.size == end - start:
            # Cross-fade the joins. A hard splice between a corrected note and
            # the untouched breath before it is a click, and a click is more
            # audible than the error being fixed.
            fade = min(int(0.005 * sample_rate), (end - start) // 4)
            if fade > 1:
                ramp = np.linspace(0.0, 1.0, fade)
                shifted[:fade] = shifted[:fade] * ramp + output[start:start + fade] * (1 - ramp)
                shifted[-fade:] = shifted[-fade:] * ramp[::-1] + output[end - fade:end] * ramp
            output[start:end] = shifted
            report.notes_corrected += 1
            report.total_cents_moved += abs(move_cents)
            report.largest_correction_cents = max(report.largest_correction_cents, abs(move_cents))
        else:
            report.notes_left_alone += 1
        report.decisions.append(
            f"{note.start_seconds:6.2f}s  {alignment.decision}"
        )

    # Measure again, on the output, rather than predicting what the correction
    # achieved. A correction that did not land must not be reported as one that
    # did.
    after_track = detect_f0(output, sample_rate)
    after_notes = segment_notes(after_track)
    after = align(after_notes, targets)
    deviations_after = [abs(a.deviation_cents) for a in after if a.target is not None]
    after_anchors = [a for a in after if a.target is not None and a.target.is_anchor]
    report.anchors_within_tolerance_after = sum(
        1 for a in after_anchors if abs(a.deviation_cents) < AUDIBLE_ERROR_CENTS)
    report.median_deviation_before_cents = float(np.median(deviations_before)) if deviations_before else 0.0
    report.median_deviation_after_cents = float(np.median(deviations_after)) if deviations_after else 0.0
    return output, report


# ------------------------------------------------------------------ mix --------


def remix(vocal: np.ndarray, backing: np.ndarray, peak_ceiling: float = 0.97) -> np.ndarray:
    """Puts the corrected vocal back with its own backing track.

    The backing is the separator's other output, untouched. Summing the two
    reconstructs the original mix exactly when the vocal was not corrected,
    which is the property that makes this safe: a song with nothing to fix comes
    back bit-for-bit as ACE-Step made it, give or take the separator's own
    residual.

    Peak-limited rather than normalised. The correction cannot make a song
    louder — it moves pitch, not level — so any new peak is an artefact of
    summing, and scaling down is the honest fix. Raising the level to a target
    would be mastering the song differently than ACE-Step mastered it.
    """
    length = min(vocal.size, backing.size)
    mixed = vocal[:length] + backing[:length]
    peak = float(np.max(np.abs(mixed))) if length else 0.0
    if peak > peak_ceiling:
        mixed = mixed * (peak_ceiling / peak)
    return mixed


# ------------------------------------------------------------ separation ------


#: The bundle is downloaded once, on first use, and kept for the process.
_SEPARATOR: dict[str, object] = {}


def separate(mix: np.ndarray, sample_rate: int, device: str = "cuda") -> tuple[np.ndarray, np.ndarray, Optional[str]]:
    """Splits a mixed song into (vocal, everything else).

    Hybrid Demucs, from `torchaudio.pipelines.HDEMUCS_HIGH_MUSDB_PLUS`. Chosen
    because it is already installed: this Space pins torchaudio for ACE-Step
    itself, and the separator is a bundle inside it. Spleeter would have added
    TensorFlow, a second numerical stack and a 73 MB checkpoint to a build that
    cannot be debugged interactively; a marginally different SDR is not worth
    that. Licensing is the same MIT as torchaudio.

    Returns `(vocal, backing, reason_unavailable)`. On any failure the mix comes
    back as the backing with an empty vocal and a stated reason, because a song
    delivered unprocessed is a good outcome and a song destroyed by a
    half-working separator is not.

    Never been run: torchaudio is not installed in the environment this was
    written in, so this function is unverified. Everything downstream of it is
    tested against synthesised stems.
    """
    try:
        import torch
        import torchaudio
    except Exception as error:  # pragma: no cover - torchaudio absent here
        return np.zeros(0), mix, f"Separation unavailable: {error}"

    try:
        bundle = _SEPARATOR.get("bundle")
        if bundle is None:
            bundle = torchaudio.pipelines.HDEMUCS_HIGH_MUSDB_PLUS
            _SEPARATOR["bundle"] = bundle
        model = _SEPARATOR.get("model")
        if model is None:
            model = bundle.get_model()
            model.to(device)
            model.eval()
            _SEPARATOR["model"] = model

        model_rate = int(bundle.sample_rate)
        wave = np.asarray(mix, dtype=np.float32)
        if wave.ndim == 1:
            wave = np.stack([wave, wave])
        tensor = torch.from_numpy(wave)
        if sample_rate != model_rate:
            tensor = torchaudio.functional.resample(tensor, sample_rate, model_rate)

        # Demucs was trained on loudness-normalised input and its output is
        # scaled back by the same figures, so the stems sum to the input.
        reference = tensor.mean(0)
        mean, std = float(reference.mean()), float(reference.std()) or 1.0
        tensor = (tensor - mean) / std

        with torch.no_grad():
            sources = model(tensor.to(device).unsqueeze(0))[0]
        sources = sources * std + mean

        names = list(bundle.sources)          # ("drums", "bass", "other", "vocals")
        index = names.index("vocals")
        vocal_t = sources[index]
        backing_t = sum(sources[i] for i in range(len(names)) if i != index)

        if sample_rate != model_rate:
            vocal_t = torchaudio.functional.resample(vocal_t, model_rate, sample_rate)
            backing_t = torchaudio.functional.resample(backing_t, model_rate, sample_rate)

        vocal = vocal_t.mean(0).cpu().numpy().astype(np.float64)
        backing = backing_t.mean(0).cpu().numpy().astype(np.float64)
        return vocal, backing, None
    except Exception as error:  # pragma: no cover - needs a GPU and the model
        return np.zeros(0), mix, f"Separation failed: {error}"


def process_song(mix: np.ndarray, sample_rate: int, targets: Sequence[TargetNote],
                 device: str = "cuda") -> tuple[np.ndarray, CorrectionReport]:
    """The whole vocal pipeline, on one song, once.

    separate -> analyse -> correct -> remix. Returns the finished audio and the
    report. No branch of this calls ACE-Step: the generation already happened
    and this is what runs afterwards, inside the same request.

    A song it cannot process is returned exactly as it arrived. That is the
    property that makes adding this stage safe — the worst case is the song
    ACE-Step made, which is what the previous version of this Space returned
    every time.
    """
    report = CorrectionReport()
    if not targets:
        report.unavailable = "No target melody was supplied, so there is nothing to correct against."
        return mix, report

    vocal, backing, problem = separate(mix, sample_rate, device)
    if problem is not None or vocal.size == 0:
        report.unavailable = problem or "The separator returned no vocal."
        return mix, report

    corrected, report = correct_vocal(vocal, sample_rate, targets)
    if report.unavailable is not None:
        return mix, report
    if report.notes_corrected == 0:
        # Nothing was wrong. Return the original mix rather than a reconstruction
        # of it: summing the separator's stems is never bit-exact, and there is
        # no reason to pay that when no correction was made.
        return mix, report

    return remix(corrected, backing), report
