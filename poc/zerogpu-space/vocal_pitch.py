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
import time
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

#: Role codes, as the browser's `ROLE_CODES` writes them into the payload.
#: Kept as a plain mapping rather than an enum so a payload from an older build
#: — one that sends four fields instead of six — still parses.
ROLE_PASSING = 0
ROLE_ANCHOR = 1
ROLE_APPROACH = 2
ROLE_SUSPENSION = 3
ROLE_RESOLUTION = 4
ROLE_NEIGHBOUR = 5
ROLE_MELISMA = 6
ROLE_REST = 7

#: The roles the song has to get right for the song to be in tune.
STRUCTURAL_ROLES = frozenset({ROLE_ANCHOR, ROLE_RESOLUTION})

#: How far a note of each role may sit from its target before it is worth
#: moving, in cents.
#:
#: Not one number, because the roles are not equivalent and the requirement
#: names two things at once: no audible wrong notes, and a vocal that does not
#: sound processed. Holding a passing note to the same 35 cents as a cadence
#: anchor buys nothing a listener can hear and costs the performance its
#: phrasing. The browser sends the same table in `ROLE_TOLERANCE_CENTS`; this
#: copy is authoritative here because the Space must work if an older build
#: sends a payload without roles at all.
ROLE_TOLERANCE_CENTS = {
    ROLE_ANCHOR: 35.0,
    ROLE_RESOLUTION: 40.0,
    ROLE_SUSPENSION: 45.0,
    ROLE_APPROACH: 60.0,
    ROLE_NEIGHBOUR: 60.0,
    ROLE_PASSING: 70.0,
    ROLE_MELISMA: 70.0,
    ROLE_REST: 1200.0,
}

#: Silence longer than this between two sung notes ends a phrase.
#:
#: A singer breathes between lines and not inside them. Grouping notes into
#: phrases at the breaths is what lets alignment match a *line* of the plan to
#: a *line* of the performance, instead of matching every note independently
#: and letting two of them cross.
PHRASE_GAP_SECONDS = 0.35

#: What it costs, in seconds of notional time error, to leave a note unmatched.
#:
#: The alignment is a shortest-path over (measured, planned) pairs, and this is
#: the weight on the two edges that skip. Too low and everything goes unmatched;
#: too high and the path matches notes half a bar apart rather than admit that
#: ACE-Step sang a syllable the plan did not have.
SKIP_COST_SECONDS = 0.30

#: A shift larger than this is not a correction.
#:
#: Beyond about a semitone the note was *wrong*, not out of tune, and dragging
#: it there is a bigger edit than the error. Those are reported instead — which
#: is the honest outcome, because this pipeline cannot make ACE-Step sing a
#: different note.
MAX_CORRECTION_CENTS = 120.0

#: Below this, a lifter of this many cepstral bins keeps the spectral envelope
#: smooth enough to be formants rather than harmonics.
FORMANT_LIFTER_BINS = 60


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

    ## Computed by FFT, because the obvious way is too slow to ship

    Expanding the square separates the difference function into two running
    power sums and an autocorrelation:

        d(t) = S x[j]^2 + S x[j+t]^2 - 2 S x[j]x[j+t]

    The first two are slices of one cumulative sum. The third is the
    autocorrelation, which is one forward and one inverse real FFT. So the whole
    curve costs O(W log W) instead of one pass over the frame per lag.

    That is not an optimisation, it is the difference between this stage running
    and not running. Written as a loop over 678 lags it took **53.9 seconds** to
    track a 209-second stem, and `correct_vocal` measures the vocal twice — once
    to decide and once to check the decision landed — so the stage cost 107
    seconds. ZeroGPU hands a Space a bounded slice and takes the GPU back at the
    end of it, and this runs *after* a generation that has already spent most of
    that slice. A hundred seconds of post-processing does not make the song
    late; it means the song never arrives.
    """
    width = frame.size
    size = 1 << int(np.ceil(np.log2(max(2 * width, 2))))
    spectrum = np.fft.rfft(frame, size)
    autocorrelation = np.fft.irfft(spectrum * np.conj(spectrum), size)[:max_lag]

    power = np.concatenate([[0.0], np.cumsum(frame * frame)])
    lags = np.arange(max_lag)
    difference = (power[width - lags] + (power[width] - power[lags])
                  - 2.0 * autocorrelation)
    # Floating-point subtraction of two nearly equal sums can go slightly
    # negative on a near-periodic frame. A negative difference is not meaningful
    # and would make the normalisation below produce a spurious deep dip.
    np.maximum(difference, 0.0, out=difference)
    difference[0] = 0.0

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


#: How much worse a lag half or a third the length may be and still be preferred.
#:
#: Restricted to integer divisors of the chosen lag, which is the only place a
#: period multiple can hide, so the margin can be generous without letting an
#: unrelated early dip win. Measured on the case that motivated it: a 220 Hz
#: note at 6 dB SNR gives d'(T) = 0.194, d'(2T) = 0.179, d'(3T) = 0.159 — the
#: true period is the *worst* of the three, and only by 22%.
SUBHARMONIC_MARGIN = 1.25


def _prefer_fundamental(search: np.ndarray, lag: int, min_lag: int) -> int:
    """Walks a chosen lag back to the fundamental, if it is a period multiple.

    A signal correlates with itself at 2T and 3T nearly as well as at T, and
    under noise it can correlate *better*: the cumulative mean normalisation
    divides by a running average that grows with the lag, so a noisy frame's
    difference function drifts downward and the deepest dip ends up at the
    longest period that fits. A 220 Hz note at 6 dB SNR came back as 73.3 Hz —
    exactly 220/3 — and no amount of octave repair afterwards would have found
    it, because `_repair_octaves` looks for factors of two and this was three.

    So: having chosen a lag, check whether half or a third or a quarter of it is
    nearly as periodic, and prefer the shortest that is. The candidates are
    integer divisors of the chosen lag and nothing else, which is why the margin
    can be as loose as it needs to be without admitting unrelated dips.
    """
    best = lag
    for divisor in (4, 3, 2):
        candidate = int(round((lag + min_lag) / divisor)) - min_lag
        if candidate < 0 or candidate >= search.size:
            continue
        # The dip may sit a sample or two either side of the exact divisor.
        low = max(0, candidate - 2)
        high = min(search.size, candidate + 3)
        local = low + int(np.argmin(search[low:high]))
        if search[local] <= search[lag] * SUBHARMONIC_MARGIN:
            best = local
            break
    return best


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
            # No dip cleared the threshold: the frame is noisy. Taking the
            # global minimum here is what YIN's own octave defence exists to
            # avoid, and taking it anyway cost this detector a sub-harmonic —
            # a 220 Hz note at 6 dB SNR came back as 73.3 Hz, which is 220/3,
            # the difference function's dip at three periods.
            #
            # So: the *earliest* lag that is within a small margin of the
            # global minimum. A signal correlates with itself at 2T and 3T
            # nearly as well as at T, and "nearly as well" is the whole of the
            # error — preferring the shortest lag that is nearly as good is the
            # same principle as the threshold rule above, applied where the
            # threshold found nothing.
            local = int(np.argmin(search))

        # Only a frame that is genuinely periodic gets a pitch. Taking the
        # minimum of the difference function regardless would hand every frame
        # a number, and white noise would come back 100% voiced with a
        # confidently wrong pitch — which it did, until this test caught it.
        # An aperiodic frame has no pitch, and saying so is the answer.
        if search[local] >= UNVOICED_THRESHOLD:
            continue

        # Whichever branch chose the lag, it may have chosen a multiple of the
        # true period. The threshold branch can too: if the fundamental's dip
        # sits just above the threshold and the second period's just below, the
        # "first dip below" is already an octave down.
        local = _prefer_fundamental(search, local, min_lag)

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
    """One note of the planned melody, as the browser sent it.

    Six fields where there were four. The two additions are not decoration:

    - `phrase` groups notes into sung lines, which is what makes phrase-level
      alignment possible. Matching every note independently lets two of them
      cross — the plan's note 7 matched to the performance's note 8 and vice
      versa — and a crossed pair produces two corrections in the wrong
      direction.
    - `onset_seconds` is how much of the note is consonant rather than pitch.
      The first 40 ms of "so" is turbulence; measuring it returns whatever the
      detector makes of noise and shifting it smears a fricative.

    `role` replaces the old `is_anchor` boolean and carries the whole
    classification, which is what lets the tolerance vary by what the note is
    for. A payload from an older build has neither, and parses: see `from_row`.
    """

    start_seconds: float
    end_seconds: float
    midi: int
    role: int = ROLE_ANCHOR
    phrase: int = 0
    onset_seconds: float = 0.0

    @property
    def frequency_hz(self) -> float:
        return midi_to_hz(self.midi)

    @property
    def is_anchor(self) -> bool:
        """True when this note has to be right for the song to be in tune."""
        return self.role in STRUCTURAL_ROLES

    @property
    def is_rest(self) -> bool:
        """True when nothing should be sung here at all."""
        return self.role == ROLE_REST or self.midi <= 0

    @property
    def tolerance_cents(self) -> float:
        return ROLE_TOLERANCE_CENTS.get(self.role, AUDIBLE_ERROR_CENTS)

    @classmethod
    def from_row(cls, row: Sequence[object]) -> "TargetNote":
        """Reads one note from the payload, whatever length the row is.

        Four fields is the old shape, where the fourth was an anchor flag. Six
        is the current one. Anything else is refused by the guard before it
        reaches here; this only has to survive the two shapes that were ever
        sent, so a Space deployed ahead of a browser — or behind one — still
        runs rather than failing the whole request over a melody it could
        simply have read less of.
        """
        start = float(row[0])  # type: ignore[arg-type]
        end = float(row[1])    # type: ignore[arg-type]
        midi = int(row[2])     # type: ignore[arg-type]
        if len(row) >= 6:
            return cls(start, end, midi, int(row[3]), int(row[4]),  # type: ignore[arg-type]
                       float(row[5]) / 1000.0)                      # type: ignore[arg-type]
        role = ROLE_ANCHOR if len(row) >= 4 and bool(row[3]) else ROLE_PASSING
        return cls(start, end, midi, role, 0, 0.0)


@dataclass
class Alignment:
    """A measured note paired with what it was supposed to be."""

    measured: MeasuredNote
    target: Optional[TargetNote]
    #: Deviation from the target, folded into the nearest octave.
    deviation_cents: float
    #: Why this note is or is not corrected.
    decision: str
    correct: bool
    #: Octaves between what was sung and what was planned, usually 0.
    #:
    #: Kept separate from `deviation_cents` on purpose. The deviation is folded
    #: so that a note in the wrong register is judged on whether it is in tune
    #: *with itself*, but folding silently would report a note sung an octave
    #: low as perfect. It is not perfect; it is a different note, this pipeline
    #: cannot fix it, and the report has to say so rather than hide it in a
    #: modulo.
    octaves_out: int = 0


def _phrase_of(note: MeasuredNote) -> float:
    return (note.start_seconds + note.end_seconds) / 2.0


def group_measured_phrases(notes: Sequence[MeasuredNote]) -> list[list[MeasuredNote]]:
    """Splits sung notes into phrases at the breaths.

    A singer breathes between lines, not inside them, so a silence longer than
    `PHRASE_GAP_SECONDS` is a line ending. This is the performance's own
    phrasing, read off the audio rather than assumed from the plan — the plan
    says where the lines *should* be and the two are then matched.
    """
    phrases: list[list[MeasuredNote]] = []
    current: list[MeasuredNote] = []
    for note in notes:
        if current and note.start_seconds - current[-1].end_seconds > PHRASE_GAP_SECONDS:
            phrases.append(current)
            current = []
        current.append(note)
    if current:
        phrases.append(current)
    return phrases


def group_target_phrases(targets: Sequence[TargetNote]) -> list[list[TargetNote]]:
    """Groups planned notes by the phrase number the browser assigned.

    Rests are dropped: they are not notes to be matched, they are the statement
    that nothing should be sung there. A sung note landing in a rest ends up
    unmatched, which is exactly right — the pipeline has no target for it and
    must leave it alone.
    """
    phrases: list[list[TargetNote]] = []
    for target in targets:
        if target.is_rest:
            continue
        if phrases and phrases[-1][0].phrase == target.phrase:
            phrases[-1].append(target)
        else:
            phrases.append([target])
    return phrases


def _monotonic_match(left_times: Sequence[float], right_times: Sequence[float],
                     skip_cost: float) -> list[tuple[int, int]]:
    """Pairs two time-ordered sequences without letting the pairs cross.

    A shortest path over the (i, j) grid with three moves: match, skip a left,
    skip a right. That is the whole of it, and it is the fix for the greedy
    maximum-overlap matcher this replaces.

    Greedy matching asked each sung note independently which planned note it
    overlapped most. Two problems, both real. Two sung notes could claim the
    same planned note, so one of them was corrected toward a pitch belonging to
    the other. And when the performance ran a little late — which it does,
    because ACE-Step has never seen the plan — the pairs crossed: sung note 7
    took planned note 8 while sung note 8 took planned note 7, and the
    correction then moved both of them the wrong way. Monotonicity makes both
    impossible by construction, which is worth more than any tuning.
    """
    rows, columns = len(left_times), len(right_times)
    if rows == 0 or columns == 0:
        return []

    infinity = float("inf")
    cost = [[infinity] * (columns + 1) for _ in range(rows + 1)]
    move = [[0] * (columns + 1) for _ in range(rows + 1)]
    cost[0][0] = 0.0
    for i in range(1, rows + 1):
        cost[i][0] = i * skip_cost
        move[i][0] = 1
    for j in range(1, columns + 1):
        cost[0][j] = j * skip_cost
        move[0][j] = 2

    for i in range(1, rows + 1):
        for j in range(1, columns + 1):
            pair = cost[i - 1][j - 1] + abs(left_times[i - 1] - right_times[j - 1])
            skip_left = cost[i - 1][j] + skip_cost
            skip_right = cost[i][j - 1] + skip_cost
            best = min(pair, skip_left, skip_right)
            cost[i][j] = best
            move[i][j] = 0 if best == pair else (1 if best == skip_left else 2)

    pairs: list[tuple[int, int]] = []
    i, j = rows, columns
    while i > 0 and j > 0:
        if move[i][j] == 0:
            pairs.append((i - 1, j - 1))
            i, j = i - 1, j - 1
        elif move[i][j] == 1:
            i -= 1
        else:
            j -= 1
    pairs.reverse()
    return pairs


def _judge(note: MeasuredNote, target: TargetNote) -> Alignment:
    """Decides what one measured note's deviation from its target means."""
    raw = cents_between(note.median_hz, target.frequency_hz)
    # Fold into the nearest octave, and record how many octaves that took. A
    # note sung in the wrong register is the right note in the wrong place;
    # judging it inside its own octave is correct, and losing the fact that it
    # happened is not.
    octaves = int(round(raw / 1200.0))
    folded = raw - octaves * 1200.0

    duration = note.end_seconds - note.start_seconds
    magnitude = abs(folded)
    tolerance = target.tolerance_cents

    if octaves != 0:
        # Nothing here can fix this. A 1200-cent varispeed shift halves or
        # doubles the length read from the stem and comes back sounding like a
        # different instrument, and the note was not mistuned in the first
        # place — it was the wrong note. Reported, never corrected.
        decision = f"sung {abs(octaves)} octave{'s' if abs(octaves) > 1 else ''} "\
                   f"{'above' if octaves > 0 else 'below'} the planned note"
        return Alignment(note, target, folded, decision, False, octaves)
    if target.is_rest:
        return Alignment(note, target, 0.0, "nothing was planned to be sung here", False)
    if not target.is_anchor:
        return Alignment(note, target, folded,
                         f"{_role_name(target.role)} note, left as performed", False)
    if duration < MIN_CORRECTABLE_SECONDS:
        return Alignment(note, target, folded, "too short to hear as a pitch", False)
    if note.confidence < 0.35:
        return Alignment(note, target, folded,
                         "pitch not measured confidently enough to act on", False)
    if magnitude < tolerance:
        return Alignment(note, target, folded,
                         f"within {tolerance:.0f} cents, audibly in tune", False)
    if note.has_vibrato and magnitude < GROSS_ERROR_CENTS:
        # Vibrato centred correctly reads as in tune even when individual
        # frames are not. Only a grossly wrong vibrato note is moved.
        return Alignment(note, target, folded, "vibrato around the target, preserved", False)
    if magnitude > MAX_CORRECTION_CENTS:
        return Alignment(note, target, folded,
                         f"{folded:+.0f} cents out — too far to be a tuning error", False)
    return Alignment(note, target, folded, f"{folded:+.0f} cents from the planned note", True)


def _role_name(role: int) -> str:
    return {
        ROLE_PASSING: "passing", ROLE_ANCHOR: "anchor", ROLE_APPROACH: "approach",
        ROLE_SUSPENSION: "suspension", ROLE_RESOLUTION: "resolution",
        ROLE_NEIGHBOUR: "neighbour", ROLE_MELISMA: "melisma", ROLE_REST: "rest",
    }.get(role, "unknown")


def align(notes: Sequence[MeasuredNote], targets: Sequence[TargetNote]) -> list[Alignment]:
    """Matches sung notes to planned notes, phrase by phrase.

    ACE-Step does not sing the planned melody — it has never seen it — so this
    is not a lookup. It asks which planned note a sung note *corresponds* to,
    and then asks what that implies about its pitch.

    Two levels, both monotonic:

      1. The performance's phrases, found at its own breaths, are matched to the
         plan's phrases, which the browser numbered. A performance that drops a
         line, or sings one the plan did not have, leaves a phrase unmatched
         rather than dragging every later line one out of step.
      2. Inside a matched pair, notes are matched the same way. A sung note with
         no partner is left exactly as performed.

    A sung note with no overlapping target is left alone. Correcting a note
    against a target that is not its own would be worse than not correcting it,
    and under the greedy matcher this replaced, that is what happened whenever
    the timing drifted.
    """
    if not notes:
        return []
    target_phrases = group_target_phrases(targets)
    if not target_phrases:
        return [Alignment(note, None, 0.0, "no planned note overlaps this one", False)
                for note in notes]

    measured_phrases = group_measured_phrases(notes)
    phrase_pairs = dict(_monotonic_match(
        [float(np.mean([_phrase_of(n) for n in phrase])) for phrase in measured_phrases],
        [float(np.mean([(t.start_seconds + t.end_seconds) / 2 for t in phrase]))
         for phrase in target_phrases],
        # A phrase may legitimately sit a bar out; the skip cost is scaled up to
        # match, or every drifting line would go unmatched.
        SKIP_COST_SECONDS * 8,
    ))

    aligned: list[Alignment] = []
    for index, phrase in enumerate(measured_phrases):
        planned = target_phrases[phrase_pairs[index]] if index in phrase_pairs else None
        if planned is None:
            aligned.extend(
                Alignment(note, None, 0.0, "no planned phrase matches this one", False)
                for note in phrase)
            continue

        pairs = dict(_monotonic_match(
            [_phrase_of(note) for note in phrase],
            [(target.start_seconds + target.end_seconds) / 2 for target in planned],
            SKIP_COST_SECONDS,
        ))
        for position, note in enumerate(phrase):
            if position not in pairs:
                aligned.append(
                    Alignment(note, None, 0.0, "no planned note matches this one", False))
                continue
            aligned.append(_judge(note, planned[pairs[position]]))
    return aligned


# ------------------------------------------------------------- correction ------


def _spectral_envelope(spectrum: np.ndarray, lifter: int = FORMANT_LIFTER_BINS) -> np.ndarray:
    """The smooth part of a spectrum: formants without the harmonics.

    Cepstral liftering. The log spectrum of a voiced sound is a slow envelope —
    the resonances of the throat and mouth — plus a fast ripple at the pitch.
    They separate cleanly in the cepstrum, and keeping only the low quefrencies
    keeps only the envelope.
    """
    magnitude = np.log(np.maximum(np.abs(spectrum), 1e-10))
    length = (magnitude.size - 1) * 2
    cepstrum = np.fft.irfft(magnitude, n=length)
    if lifter * 2 < cepstrum.size:
        cepstrum[lifter:-lifter] = 0.0
    return np.exp(np.fft.rfft(cepstrum, n=length).real)


def _shift_note(audio: np.ndarray, start: int, end: int, ratio: float) -> np.ndarray:
    """Shifts one note by `ratio`, keeping its length exactly.

    Fixed-length varispeed followed by one static formant-restoration filter.

    Varispeed: read `length * ratio` samples and resample them to `length`.
    Reading more and squeezing it in raises the pitch; reading less and
    stretching it lowers it. The note still starts and ends where it did, so no
    note after it drifts.

    Its one weakness is that it scales the whole spectrum, so the formants move
    with the pitch and the singer sounds fractionally like a different person.
    But the displacement is known — a resonance that was at f is now at
    f x ratio — so it is undone by one filter, computed once per note from the
    note's own averaged spectral envelope:

        H(f) = Env(f) / Env(f / ratio)

    applied zero-phase. The harmonics stay where varispeed put them, so the
    pitch is still right; the resonances go back where the voice had them.

    ## Why this method, measured rather than argued

    `bench_shifters.py` scores five methods on ten properties, against a
    reference that is the same synthetic voice genuinely produced at the target
    pitch — because comparing a shifted signal with its own *input* is invalid:
    the harmonics have moved across fixed formant peaks, so the spectrum is
    supposed to change. It also scores a control that applies no shift at all,
    which is what makes the other rows readable.

        method           cents  oct  centroid%  formant%   flux  HNRloss  onset%
        none (control)    67.5    0        1.4      14.1    277     n/a      100
        varispeed          2.1    0        7.7      11.3   1113    21.0       99
        varispeed-poly     2.1    0        7.5      11.7   1110    25.0       93
        td-psola           2.1    0        9.3      13.5    274    54.9       83
        phase-vocoder      2.1    0       31.6      47.4   2709    36.6      959
        hybrid (this)      2.1    0        5.1      13.7   1150    21.0      105

    Read with the control in hand:

    - **formant% cannot separate them.** A signal whose formants provably did
      not move scores 14.1 on that column, so 11.3, 13.5 and 13.7 are all at the
      estimator's noise floor. Only the phase vocoder's 47.4 is a real result.
      Citing 11.3 against 13.7 as evidence would have been reading noise.
    - **centroid% can.** Its floor is 1.4. The hybrid sits at 5.1 against
      varispeed's 7.7 — the excess over the control falls from 6.3 to 3.7, so
      about two fifths of the formant drift is genuinely removed.
    - **Everything else is a tie or a loss elsewhere.** The hybrid matches
      varispeed exactly on pitch error, octave errors, harmonic structure
      (21.0 dB), vibrato and duration. TD-PSOLA is the steadiest spectrum on the
      bench — flux 274 against the control's 277 — and pays 54.9 dB of
      harmonic-to-noise for it, which is what "processed" sounds like. The phase
      vocoder is worst on almost everything and smears a consonant onset across
      the note.

    So: the hybrid, because it is varispeed plus a measurable improvement at no
    measured cost, and it adds one FFT per note and no dependency. WORLD is not
    on the bench and its absence is a decision — it is a new binary dependency
    on a Space whose premise is that it installs nothing beyond ACE-Step's own
    requirements. If a method here were failing, that trade would be worth
    reopening. None is.

    Two earlier conclusions in this file were wrong and both were wrong the same
    way — I argued from theory and measured afterwards. TD-PSOLA "preserves
    formants" and measured 34% centroid drift in the same direction whichever
    way the pitch went, which is grain-join noise and not a formant shift. And
    the flux column here was supposed to show FFT-resample edge ringing; a
    polyphase variant with no periodicity assumption scores 1110 against 1113,
    so it shows nothing of the kind.
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

    shifted = resample(available, length).astype(np.float64)
    return _restore_formants(audio[start:end], shifted, ratio)


def _restore_formants(original: np.ndarray, shifted: np.ndarray, ratio: float) -> np.ndarray:
    """Puts the original spectral envelope back onto a varispeed-shifted note.

    Degrades to the unmodified shift rather than raising: a note too short for a
    meaningful envelope is a note whose formants nobody can hear anyway, and
    returning the varispeed result is the previous, measured-acceptable answer.
    """
    if shifted.size < 256 or abs(ratio - 1.0) < 1e-4:
        return shifted
    spectrum = np.fft.rfft(original * np.hanning(original.size))
    envelope = _spectral_envelope(spectrum)
    if envelope.size < 8:
        return shifted

    bins = np.arange(envelope.size, dtype=np.float64)
    moved = np.interp(bins / ratio, bins, envelope, left=envelope[0], right=envelope[-1])
    # Clipped: an envelope ratio of 30 dB is the estimator failing on a quiet
    # band, not a formant, and applying it would be audible where the error is
    # not.
    correction = np.clip(envelope / np.maximum(moved, 1e-12), 0.25, 4.0)

    length = (envelope.size - 1) * 2
    transformed = np.fft.rfft(shifted, n=length)
    fitted = np.interp(np.linspace(0.0, 1.0, transformed.size),
                       np.linspace(0.0, 1.0, correction.size), correction)
    out = np.fft.irfft(transformed * fitted, n=length)[: shifted.size]
    # The filter has gain. Put the note back at the level it was at, because a
    # correction must change pitch and nothing else.
    peak_before = float(np.max(np.abs(shifted))) if shifted.size else 0.0
    peak_after = float(np.max(np.abs(out))) if out.size else 0.0
    if peak_after > 1e-9 and peak_before > 1e-9:
        out = out * (peak_before / peak_after)
    return out.astype(np.float64)


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
    #: Notes sung in the wrong octave. Reported, never corrected.
    #:
    #: These are the honest limit of this stage. A note an octave from the plan
    #: is not mistuned, it is a different note, and no amount of shifting makes
    #: ACE-Step have sung the right one. Counting them separately is what stops
    #: the octave fold in `_judge` from reporting them as perfectly in tune.
    octave_errors: int = 0
    #: Notes more than `MAX_CORRECTION_CENTS` out: wrong rather than untuned.
    beyond_correction: int = 0
    #: Sung notes the plan had no note for, and planned notes nothing was sung
    #: for. Both are normal — ACE-Step has never seen the plan — and both are
    #: reported, because a high count means the alignment is guessing.
    unmatched_sung: int = 0
    unmatched_planned: int = 0
    phrases_measured: int = 0
    phrases_matched: int = 0
    #: Seconds each stage took, for the ZeroGPU budget.
    #:
    #: ZeroGPU gives a Space a bounded slice per request and takes the GPU away
    #: at the end of it. This stage runs *after* a generation that has already
    #: spent most of that slice, so how long it takes is not a performance
    #: question, it is whether the song comes back at all. Measured rather than
    #: estimated, and reported with the song.
    stage_seconds: dict[str, float] = field(default_factory=dict)
    decisions: list[str] = field(default_factory=list)
    unavailable: Optional[str] = None

    @property
    def anchors_in_tune_after(self) -> float:
        """Share of the notes that had to be right which are, 0..1.

        The number the product requirement turns on, and it is measured on the
        output rather than predicted from the corrections applied.
        """
        if self.anchors_examined == 0:
            return 0.0
        return self.anchors_within_tolerance_after / self.anchors_examined


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

    matched = [a for a in alignments if a.target is not None]
    deviations_before = [abs(a.deviation_cents) for a in matched if a.octaves_out == 0]
    anchors = [a for a in matched if a.target is not None and a.target.is_anchor]
    report.anchors_examined = len(anchors)
    report.anchors_within_tolerance_before = sum(
        1 for a in anchors
        if a.octaves_out == 0 and abs(a.deviation_cents) < a.target.tolerance_cents)
    report.octave_errors = sum(1 for a in matched if a.octaves_out != 0)
    report.beyond_correction = sum(
        1 for a in anchors
        if a.octaves_out == 0 and abs(a.deviation_cents) > MAX_CORRECTION_CENTS)
    report.unmatched_sung = sum(1 for a in alignments if a.target is None)
    report.phrases_measured = len(group_measured_phrases(notes))
    planned_phrases = group_target_phrases(targets)
    matched_targets = {id(a.target) for a in matched}
    report.unmatched_planned = sum(
        1 for phrase in planned_phrases for target in phrase if id(target) not in matched_targets)
    report.phrases_matched = sum(
        1 for phrase in planned_phrases
        if any(id(target) in matched_targets for target in phrase))

    output = vocal.copy()
    for alignment in alignments:
        if not alignment.correct or alignment.target is None:
            report.notes_left_alone += 1
            continue

        note = alignment.measured
        # Start at the vowel, not at the syllable.
        #
        # `segment_notes` already begins a note at its first voiced frame, so an
        # unvoiced consonant is mostly outside it — but the detector's analysis
        # window is about 38 ms wide and centred, so the boundary is fuzzy by
        # half of that, and a plosive can sit inside the first frames. The plan
        # says how long the consonant is; skipping it costs nothing on a note
        # with no onset and stops a /t/ or an /s/ from being pitch-shifted,
        # which is the single most recognisable sound of autotune.
        onset = max(0.0, float(alignment.target.onset_seconds))
        start = int(round((note.start_seconds + onset) * sample_rate))
        end = min(output.size, int(round(note.end_seconds * sample_rate)))
        if end - start < int(MIN_CORRECTABLE_SECONDS * sample_rate):
            report.notes_left_alone += 1
            report.decisions.append(
                f"{note.start_seconds:6.2f}s  only {max(0, end - start) / sample_rate:.2f}s "
                f"of vowel after the consonant: too short to correct")
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
    deviations_after = [abs(a.deviation_cents) for a in after
                       if a.target is not None and a.octaves_out == 0]
    after_anchors = [a for a in after if a.target is not None and a.target.is_anchor]
    report.anchors_within_tolerance_after = sum(
        1 for a in after_anchors
        if a.octaves_out == 0 and abs(a.deviation_cents) < a.target.tolerance_cents)
    report.median_deviation_before_cents = float(np.median(deviations_before)) if deviations_before else 0.0
    report.median_deviation_after_cents = float(np.median(deviations_after)) if deviations_after else 0.0

    # A correction that made things worse is a correction that must be undone.
    # It should not happen — every shift is measured before and after — but
    # "should not happen" is not a guarantee, and returning the vocal ACE-Step
    # made is always an available and honest outcome.
    if (report.notes_corrected > 0
            and report.anchors_examined > 0
            and report.anchors_within_tolerance_after < report.anchors_within_tolerance_before):
        report.decisions.append(
            f"reverted: correcting moved {report.anchors_within_tolerance_before} notes in tune "
            f"down to {report.anchors_within_tolerance_after}")
        report.notes_corrected = 0
        report.anchors_within_tolerance_after = report.anchors_within_tolerance_before
        report.median_deviation_after_cents = report.median_deviation_before_cents
        return vocal, report
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

    ## The runtime budget

    ZeroGPU allocates a Space a bounded slice per request and takes the GPU back
    at the end of it. This runs *after* a generation that has already spent most
    of that slice, so the question is not how fast this is, it is whether the
    song comes back at all. Measured on a 209-second vocal stem at 44.1 kHz,
    418 planned notes, 38 phrases, on CPU:

        stage                          seconds
        detect_f0 (twice)                 8.9
        segment_notes                     0.1
        align (phrase + note DP)          0.0
        shifting 35 notes                 0.2
        --------------------------------------
        correct_vocal                     9.2
        separate (Hybrid Demucs)          not measured: no torchaudio here

    Only `separate` is unmeasured, and it is the one stage that runs on the GPU
    rather than the CPU — on the hardware this deploys to it is a single forward
    pass of a model already resident. `report.stage_seconds` carries the real
    figures back with every song, so the estimate is replaced by a measurement
    the first time this runs for real.

    The CPU figure was 107 seconds before `_yin_difference` was computed by FFT,
    which would have exceeded the whole slice on its own. That is recorded here
    rather than quietly fixed, because "it is fast enough" is a claim that needs
    a number beside it.
    """
    report = CorrectionReport()
    if not targets:
        report.unavailable = "No target melody was supplied, so there is nothing to correct against."
        return mix, report

    started = time.perf_counter()
    vocal, backing, problem = separate(mix, sample_rate, device)
    separation_seconds = time.perf_counter() - started
    if problem is not None or vocal.size == 0:
        report.unavailable = problem or "The separator returned no vocal."
        report.stage_seconds = {"separate": round(separation_seconds, 3)}
        return mix, report

    corrected_started = time.perf_counter()
    corrected, report = correct_vocal(vocal, sample_rate, targets)
    report.stage_seconds = {
        "separate": round(separation_seconds, 3),
        "measure_align_correct": round(time.perf_counter() - corrected_started, 3),
    }
    if report.unavailable is not None:
        return mix, report
    if report.notes_corrected == 0:
        # Nothing was wrong. Return the original mix rather than a reconstruction
        # of it: summing the separator's stems is never bit-exact, and there is
        # no reason to pay that when no correction was made.
        return mix, report

    remix_started = time.perf_counter()
    mixed = remix(corrected, backing)
    report.stage_seconds["remix"] = round(time.perf_counter() - remix_started, 3)
    report.stage_seconds["total"] = round(
        sum(value for key, value in report.stage_seconds.items() if key != "total"), 3)
    return mixed, report


# ------------------------------------------------------------- readiness ------


def readiness(sample_rate: int = 44100, device: str = "cuda") -> dict[str, object]:
    """Everything that has to be true before this runs on a real song.

    The review asked for a real-run readiness checklist, and a checklist that
    lives in a document is a document. This one executes: it imports what it
    needs, loads what it loads, and reports what it found. It costs no GPU time
    beyond moving the separator's weights, it changes nothing, and it can be
    called from the Space's own startup or from a smoke test.

    It never raises. Every check that fails becomes a string in `problems`,
    because the point is to list *all* of them rather than to stop at the first.
    """
    found: dict[str, object] = {"ready": False, "problems": []}
    problems: list[str] = found["problems"]  # type: ignore[assignment]

    found["numpy"] = np.__version__
    try:
        import scipy
        found["scipy"] = scipy.__version__
    except Exception as error:
        problems.append(f"scipy is not importable: {error}")

    try:
        import torch
        found["torch"] = torch.__version__
        found["cuda_available"] = bool(torch.cuda.is_available())
        if device.startswith("cuda") and not torch.cuda.is_available():
            problems.append("device is cuda but torch reports no CUDA device")
    except Exception as error:
        problems.append(f"torch is not importable: {error}")

    try:
        import torchaudio
        found["torchaudio"] = torchaudio.__version__
        bundle = torchaudio.pipelines.HDEMUCS_HIGH_MUSDB_PLUS
        found["separator_sample_rate"] = int(bundle.sample_rate)
        found["separator_sources"] = list(bundle.sources)
        if "vocals" not in bundle.sources:
            problems.append("the separator bundle has no 'vocals' source")
        if int(bundle.sample_rate) != sample_rate:
            # Not a problem: `separate` resamples. Recorded because a mismatch
            # is the difference between one resample per song and none, and
            # because a silent mismatch is how a stage ends up running at the
            # wrong rate for a year.
            found["resample_needed"] = True
    except Exception as error:
        problems.append(f"torchaudio / Hybrid Demucs unavailable: {error}")

    # The DSP itself, on a signal whose answer is known. If this fails, nothing
    # downstream is worth running.
    try:
        seconds = 0.5
        time_axis = np.arange(int(seconds * sample_rate)) / sample_rate
        probe = sum(np.sin(2 * np.pi * 220.0 * harmonic * time_axis) / harmonic
                    for harmonic in range(1, 8))
        track = detect_f0(probe / np.max(np.abs(probe)) * 0.5, sample_rate)
        voiced = track.f0[track.voiced]
        measured = float(np.median(voiced)) if voiced.size else 0.0
        found["probe_hz"] = round(measured, 2)
        if measured <= 0 or abs(cents_between(measured, 220.0)) > 20.0:
            problems.append(f"the detector read a 220 Hz probe as {measured:.2f} Hz")
        shifted = _shift_note(probe, 0, probe.size, 2.0 ** (50 / 1200))
        if shifted.size != probe.size:
            problems.append("the shifter did not preserve the note length")
    except Exception as error:
        problems.append(f"the DSP probe failed: {error}")

    found["ready"] = not problems
    return found
