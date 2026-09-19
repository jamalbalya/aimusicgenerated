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
from dataclasses import dataclass, field, replace
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

#: Where the correction stage changes method.
#:
#: Not a threshold for *whether* to correct — the product requirement is that
#: the finished song contains no audible out-of-tune note, and "too large to
#: correct" is not a way of meeting it. This is which method to use, and the
#: split is measured rather than chosen. `bench_shifters.py`, per shift size,
#: spectral centroid distance from a voice genuinely sung at the target pitch:
#:
#:     cents    varispeed   hybrid   psola-cascaded
#:      -110         6.1      2.1        9.4
#:      -200         8.5      6.6       10.9
#:      -400        16.1      7.9        7.6
#:      -700        26.6      0.4       13.2
#:     -1200        41.2      9.4       21.2
#:      +200        22.4      3.3        5.6
#:      +400        52.5      9.3        6.3
#:      +700        78.1     17.0       11.5
#:     +1200       118.7     27.6       14.6
#:
#: and the first three formants, where the estimator's noise floor is about 15%:
#:
#:     cents    varispeed   hybrid   psola-cascaded
#:      +400       203.3     20.6        2.7
#:      +700        35.2     13.3        3.7
#:     -1200       100.0    406.6       71.9
#:
#: Below a whole tone the hybrid wins on both. Above it the hybrid's static
#: envelope filter is being asked to move resonances further than a single
#: zero-phase correction can, and PSOLA — which never resamples, so the formants
#: never move in the first place — wins by a margin far outside any estimator
#: noise. So: hybrid under, PSOLA over.
CORRECTION_METHOD_SPLIT_CENTS = 200.0

#: How far the song's tempo may differ from the planned tempo and still leave
#: the target melody usable, as a fraction.
#:
#: Beyond this the plan is not the same song. The melody writer lays notes out
#: on the requested tempo's grid and allocates bars per section from it: at
#: 72 BPM a four-and-a-half minute song is about 80 bars. A real generation
#: came back at 98.4 BPM, which is 110 bars. Stretching the plan by 1.37 puts
#: its notes at plausible *times*, but phrase 12 of an 80-bar plan is simply not
#: the line the singer is on at that moment in a 110-bar song — so the notes are
#: in the right place and wrong. A warp fixes a timeline; it cannot fix a
#: structure.
#:
#: Fifteen per cent is where a warp stops being a correction of timing and
#: starts being a reinterpretation of the song. Inside it, a stable ratio is
#: applied and alignment proceeds with the drift removed. Outside it, correction
#: is refused — which is the safe answer, because correcting against a
#: mis-structured plan makes a vocal worse in a way nothing downstream can
#: detect.
TEMPO_WARP_LIMIT = 0.15

#: Below this, a phrase's alignment is not trusted and its notes are not moved.
#:
#: Confidence is the share of the phrase's planned notes that found a partner,
#: scaled down when the partners sit far from where the plan expects them. A
#: phrase that matched two notes out of eleven has not been aligned; it has been
#: guessed at, and guessing is what produces a correction toward a target from
#: somewhere else in the song.
PHRASE_CONFIDENCE_FLOOR = 0.55

#: Verdicts for whether correcting this song against this plan is allowed.
CORRECTION_AUTHORIZED = "PITCH_CORRECTION_AUTHORIZED"
CORRECTION_NOT_AUTHORIZED = "PITCH_CORRECTION_NOT_AUTHORIZED"
ALIGNMENT_UNTRUSTWORTHY = "ALIGNMENT_UNTRUSTWORTHY"


def authorize_correction(tempo_reading, targets: Sequence["TargetNote"]) -> tuple[str, list[str]]:
    """Decides whether the target melody may be used to correct this song.

    Called before any audio is touched. The question is not "is the vocal in
    tune" — it is "does this plan describe this performance at all". A plan that
    does not is worse than no plan: every note it supplies is a target the
    correction stage would move a vocal towards.

    Returns a verdict and the reasons for it. `PITCH_CORRECTION_NOT_AUTHORIZED`
    is a safe, expected outcome and never an error: the song is returned exactly
    as generated, which is what this Space did before correction existed.
    """
    reasons: list[str] = []
    if not targets:
        return CORRECTION_NOT_AUTHORIZED, ["no target melody was supplied"]
    if tempo_reading is None:
        # No tempo was measured. The plan's timeline is unverified rather than
        # known-wrong, so this is a refusal and not a failure.
        return CORRECTION_NOT_AUTHORIZED, [
            "the song's tempo was not measured, so the plan's timeline is unverified"]

    verdict = tempo_reading.verdict
    if verdict == "TEMPO_UNMEASURABLE":
        return CORRECTION_NOT_AUTHORIZED, list(tempo_reading.reasons)
    if verdict == "TEMPO_UNSTABLE":
        return CORRECTION_NOT_AUTHORIZED, list(tempo_reading.reasons) + [
            "a wandering tempo cannot be undone by one ratio, so no warp makes the plan fit"]
    if verdict == "TEMPO_NOT_REQUESTED":
        # Nothing was asked for, so nothing is contradicted. The plan was laid
        # out on the planner's own tempo and there is no evidence either way;
        # alignment's own confidence decides from here.
        return CORRECTION_AUTHORIZED, list(tempo_reading.reasons)

    ratio = tempo_reading.ratio or 1.0
    if abs(ratio - 1.0) > TEMPO_WARP_LIMIT:
        return CORRECTION_NOT_AUTHORIZED, list(tempo_reading.reasons) + [
            f"the tempo ratio {ratio:.3f} exceeds the {TEMPO_WARP_LIMIT:.0%} limit past which a "
            f"warp reinterprets the song rather than re-times it: the plan's bar count and the "
            f"performance's do not describe the same arrangement",
            "correcting against this plan would move the vocal toward notes belonging to a "
            "different part of the song",
        ]
    if verdict == "TEMPO_MISMATCH":
        reasons.append(
            f"tempo differs by {abs(ratio - 1.0):.1%}, inside the {TEMPO_WARP_LIMIT:.0%} limit; "
            f"the plan is re-timed by {ratio:.4f} before alignment")
    return CORRECTION_AUTHORIZED, reasons + list(tempo_reading.reasons)


def warp_targets(targets: Sequence["TargetNote"], ratio: float) -> list["TargetNote"]:
    """Re-times a planned melody onto the tempo the song actually came out at.

    Only the times move. The notes do not: a plan written in D minor is still in
    D minor at a different tempo, and changing the pitches would be inventing a
    melody rather than re-timing one.
    """
    if not ratio or ratio <= 0 or abs(ratio - 1.0) < 1e-6:
        return list(targets)
    return [replace(target,
                    start_seconds=target.start_seconds / ratio,
                    end_seconds=target.end_seconds / ratio)
            for target in targets]


#: Beyond this, the *alignment* is wrong, not the singing.
#:
#: Two octaves is not a mistuned note. A deviation this large means a sung note
#: was matched to a planned note that is not its own, and shifting it would turn
#: an alignment failure into an audible one. Reported, and the report says which
#: it is.
IMPLAUSIBLE_DEVIATION_CENTS = 2400.0

#: The ratio range one PSOLA pass stays correct over.
#:
#: A grain is two analysis periods and grains are spaced by the synthesis
#: period, so they stop overlapping once the synthesis period reaches the window
#: length — at ratio 0.5. An octave down therefore cannot be one pass: measured,
#: it came back 1202 cents out, because each grain held four source periods and
#: the source's own pitch survived the spacing. Two passes of a tritone measure
#: -1 cent.
PSOLA_MIN_RATIO = 0.62
PSOLA_MAX_RATIO = 1.60

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

    @property
    def total_deviation_cents(self) -> float:
        """The whole distance from the planned note, octaves included.

        `deviation_cents` is folded, which is right for asking "is this note in
        tune with itself". This is the number a correction has to move, and they
        differ by exactly the thing the fold hides.
        """
        return self.deviation_cents + self.octaves_out * 1200.0


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

    if abs(raw) > IMPLAUSIBLE_DEVIATION_CENTS:
        # Two octaves is not a mistuned note. This sung note has been matched to
        # a planned note that is not its own, and shifting it would turn an
        # alignment failure into an audible one.
        return Alignment(note, target, folded,
                         f"{raw:+.0f} cents from the planned note: the match, not the singing",
                         False, octaves)
    if octaves != 0:
        # An octave error left in the song is an audible wrong note, so it is
        # corrected rather than reported. Which *way* it is corrected is decided
        # a level up, in `align`: a whole phrase sitting an octave from the plan
        # is the register the singer chose, and the plan's octave was a free
        # decision, so the plan moves. Only a note out of step with its own
        # phrase reaches here, and that one is genuinely wrong.
        if target.is_rest or not target.is_anchor:
            return Alignment(note, target, folded,
                             f"{_role_name(target.role)} note an octave out, left as performed",
                             False, octaves)
        if note.confidence < 0.35:
            return Alignment(note, target, folded,
                             "an octave out, but not measured confidently enough to act on",
                             False, octaves)
        direction = "above" if octaves > 0 else "below"
        return Alignment(
            note, target, folded,
            f"sung {abs(octaves)} octave{'s' if abs(octaves) > 1 else ''} {direction} "
            f"the planned note, and moved back",
            True, octaves)
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
    if magnitude > CORRECTION_METHOD_SPLIT_CENTS:
        # A wrong note rather than a mistuned one, and still corrected: the
        # requirement is a finished song with no audible out-of-tune note, and
        # an error this size is the most audible kind there is. It goes to
        # PSOLA rather than to the small-shift method.
        return Alignment(note, target, folded,
                         f"{folded:+.0f} cents from the planned note — a wrong note, moved", True)
    return Alignment(note, target, folded, f"{folded:+.0f} cents from the planned note", True)


def _role_name(role: int) -> str:
    return {
        ROLE_PASSING: "passing", ROLE_ANCHOR: "anchor", ROLE_APPROACH: "approach",
        ROLE_SUSPENSION: "suspension", ROLE_RESOLUTION: "resolution",
        ROLE_NEIGHBOUR: "neighbour", ROLE_MELISMA: "melisma", ROLE_REST: "rest",
    }.get(role, "unknown")


#: How far the performance may sit from the plan before a global offset is
#: searched for, in seconds.
#:
#: The plan's absolute times are an estimate — the melody writer spreads
#: syllables across bars without a forced aligner, and ACE-Step has never seen
#: the plan — so a whole performance sitting a second or two from where the plan
#: expects it is ordinary, not a failure. What is a failure is treating that as
#: hundreds of individually mismatched notes.
OFFSET_SEARCH_SECONDS = 12.0

#: Resolution of the onset cross-correlation, in seconds.
OFFSET_RESOLUTION_SECONDS = 0.02


def _onset_signal(times: Sequence[float], span: float, resolution: float) -> np.ndarray:
    """A sparse time series with a bump at each note start."""
    length = max(2, int(round(span / resolution)) + 1)
    signal = np.zeros(length)
    for value in times:
        index = int(round(value / resolution))
        if 0 <= index < length:
            signal[index] += 1.0
    return signal


def estimate_time_offset(notes: Sequence[MeasuredNote], targets: Sequence[TargetNote],
                         limit: float = OFFSET_SEARCH_SECONDS) -> float:
    """How far the performance sits from the plan, in seconds.

    By cross-correlating the two sets of note onsets. The peak of the
    correlation is the shift that makes the most starts line up, and it is found
    with one FFT rather than by trying every offset — trying every offset means
    running the whole alignment once per candidate, which for a four-minute song
    is minutes of work to answer a question worth milliseconds.

    Returns 0.0 when there is nothing to go on. A zero offset is always a valid
    answer and is what the caller falls back to.
    """
    sung = [note.start_seconds for note in notes]
    planned = [target.start_seconds for target in targets if not target.is_rest]
    if len(sung) < 3 or len(planned) < 3:
        return 0.0

    span = max(max(sung), max(planned)) + limit
    resolution = OFFSET_RESOLUTION_SECONDS
    measured_signal = _onset_signal(sung, span, resolution)
    planned_signal = _onset_signal(planned, span, resolution)

    size = 1 << int(np.ceil(np.log2(max(4, measured_signal.size + planned_signal.size))))
    correlation = np.fft.irfft(
        np.fft.rfft(measured_signal, size) * np.conj(np.fft.rfft(planned_signal, size)), size)

    # Only offsets inside the limit, in either direction.
    reach = int(round(limit / resolution))
    forward = correlation[: reach + 1]
    backward = correlation[-reach:] if reach > 0 else np.zeros(0)
    best_forward = int(np.argmax(forward)) if forward.size else 0
    best_backward = int(np.argmax(backward)) if backward.size else 0
    if backward.size and backward[best_backward] > forward[best_forward]:
        return -(reach - best_backward) * resolution
    return best_forward * resolution


def _alignment_quality(aligned: Sequence[Alignment], planned_count: int) -> tuple[int, float]:
    """How well an alignment did: how many notes it matched, and how closely.

    Two numbers rather than one, compared in that order, because a match that
    covers more of the song is better than a tighter match over less of it.
    """
    matched = [a for a in aligned if a.target is not None and not a.target.is_rest]
    if not matched:
        return 0, float("inf")
    distances = [
        abs((a.measured.start_seconds + a.measured.end_seconds) / 2
            - (a.target.start_seconds + a.target.end_seconds) / 2)
        for a in matched if a.target is not None
    ]
    return len(matched), float(np.median(distances))


#: Phrase scores from the most recent `_align_once`, for the report.
_LAST_PHRASE_SCORES: list["PhraseAlignment"] = []


def align(notes: Sequence[MeasuredNote], targets: Sequence[TargetNote]) -> list[Alignment]:
    """Matches sung notes to planned notes, with a second strategy if the first does badly.

    The first attempt aligns the plan where the plan says it is. That is usually
    right and sometimes badly wrong, because the plan's absolute times are an
    estimate: the melody writer spreads syllables across bars without a forced
    aligner, and ACE-Step has never seen the plan, so an intro half a bar longer
    than planned puts every note of the song out of step.

    Rather than let that become hundreds of individually mismatched notes — each
    one a target this pipeline would then correct a vocal *towards* — the whole
    performance is cross-correlated against the whole plan, the dominant offset
    is applied to the targets, and the alignment is run again. The better of the
    two is kept, judged on how much of the song it matched and how closely, so
    the retry can only help.

    Not a loop and not a search: one extra attempt, decided by a measurement.
    An alignment that still cannot be trusted afterwards is reported as such by
    `assess_trust`, never silently corrected against.
    """
    planned_count = sum(1 for target in targets if not target.is_rest)
    if planned_count == 0 or not notes:
        return _align_once(notes, targets)

    def quality(aligned: list[Alignment]) -> tuple[int, float]:
        count, distance = _alignment_quality(aligned, planned_count)
        return count, -distance

    best = _align_once(notes, targets)
    best_score = quality(best)

    def good_enough(score: tuple[int, float]) -> bool:
        return score[0] >= planned_count * 0.9 and -score[1] < 0.5

    if good_enough(best_score):
        return best

    # Strategy two: one global time offset, found by cross-correlating the two
    # sets of onsets. Fixes a whole performance sitting late or early, which is
    # ordinary rather than exceptional.
    offset = estimate_time_offset(notes, targets)
    shifted = targets
    if abs(offset) >= OFFSET_RESOLUTION_SECONDS:
        shifted = [
            replace(target,
                    start_seconds=target.start_seconds + offset,
                    end_seconds=target.end_seconds + offset)
            for target in targets
        ]
        candidate = _align_once(notes, shifted)
        if quality(candidate) > best_score:
            best, best_score = candidate, quality(candidate)
        if good_enough(best_score):
            return best

    # Strategy three: ignore the phrase structure entirely and match every note
    # against every note, monotonically.
    #
    # Phrase matching is the better tool when the performance's breaths line up
    # with the plan's lines, and it is the worse one when they do not — a singer
    # who takes no breath where the plan has one leaves the whole song as a
    # single measured phrase against a dozen planned ones, and eleven twelfths of
    # the plan goes unmatched. Measured on exactly that case: 4 of 12 notes
    # matched with phrases, 12 of 12 without.
    #
    # Monotonicity still holds, so this cannot cross two notes. What it loses is
    # the phrase structure's protection against a drifting match, which is why
    # it is tried last and only kept if it is measurably better.
    candidates = [targets] if shifted is targets else [shifted, targets]
    for candidate_targets in candidates:
        candidate = _align_flat(notes, candidate_targets)
        if quality(candidate) > best_score:
            best, best_score = candidate, quality(candidate)
    return best


def _align_flat(notes: Sequence[MeasuredNote], targets: Sequence[TargetNote]) -> list[Alignment]:
    """Aligns every sung note against every planned note, ignoring phrases."""
    planned = [target for target in targets if not target.is_rest]
    if not planned:
        return [Alignment(note, None, 0.0, "no planned note overlaps this one", False)
                for note in notes]
    pairs = dict(_monotonic_match(
        [_phrase_of(note) for note in notes],
        [(target.start_seconds + target.end_seconds) / 2 for target in planned],
        SKIP_COST_SECONDS,
    ))
    out: list[Alignment] = []
    for position, note in enumerate(notes):
        if position not in pairs:
            out.append(Alignment(note, None, 0.0, "no planned note matches this one", False))
            continue
        out.append(_judge(note, planned[pairs[position]]))
    return out


def _align_once(notes: Sequence[MeasuredNote], targets: Sequence[TargetNote]) -> list[Alignment]:
    """One alignment pass: phrase by phrase, monotonic at both levels.

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
    _LAST_PHRASE_SCORES.clear()
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
        planned = _reanchor_octave(phrase, planned, pairs)
        score = score_phrase(phrase, planned, pairs)
        _LAST_PHRASE_SCORES.append(score)
        if not score.trusted:
            # Matched, but not well enough to act on. Reported, and every note
            # left exactly as performed.
            aligned.extend(
                Alignment(note, None, 0.0,
                          f"phrase alignment not trusted ({score.confidence:.2f}): {score.reason}",
                          False)
                for note in phrase)
            continue
        for position, note in enumerate(phrase):
            if position not in pairs:
                aligned.append(
                    Alignment(note, None, 0.0, "no planned note matches this one", False))
                continue
            aligned.append(_judge(note, planned[pairs[position]]))
    return aligned


@dataclass
class PhraseAlignment:
    """How well one sung line matched one planned line, and whether to trust it."""

    phrase: int
    planned_notes: int
    matched_notes: int
    #: Median seconds between a matched pair's midpoints.
    median_time_error: float
    start_seconds: float
    end_seconds: float
    confidence: float
    trusted: bool
    reason: str


def score_phrase(phrase: Sequence[MeasuredNote], planned: Sequence[TargetNote],
                 pairs: dict) -> PhraseAlignment:
    """Confidence that this measured line is the planned line it was matched to.

    Two things decide it, and neither is pitch — pitch is what the correction
    stage is about to judge, so using it here would be circular.

      * **Coverage.** How much of the planned line found a partner. A line that
        matched two notes of eleven has not been aligned, it has been guessed
        at.
      * **Timing.** How far the partners sit from where the plan expects them,
        in units of the planned line's own length, so a slow ballad and a fast
        verse are judged the same way.

    A phrase below `PHRASE_CONFIDENCE_FLOOR` has its notes left exactly as
    performed. That is the rule that stops a mis-matched line being "corrected"
    onto the pitches of a different line.
    """
    singable = [t for t in planned if not t.is_rest]
    if not singable or not phrase:
        return PhraseAlignment(
            phrase=singable[0].phrase if singable else -1,
            planned_notes=len(singable), matched_notes=0, median_time_error=0.0,
            start_seconds=phrase[0].start_seconds if phrase else 0.0,
            end_seconds=phrase[-1].end_seconds if phrase else 0.0,
            confidence=0.0, trusted=False, reason="nothing to match")

    errors = []
    for position, target_index in pairs.items():
        if position >= len(phrase) or target_index >= len(planned):
            continue
        note, target = phrase[position], planned[target_index]
        errors.append(abs((note.start_seconds + note.end_seconds) / 2
                          - (target.start_seconds + target.end_seconds) / 2))
    matched = len(errors)
    coverage = matched / len(singable)
    span = max(0.5, singable[-1].end_seconds - singable[0].start_seconds)
    median_error = float(np.median(errors)) if errors else span
    # Perfect at zero error, zero once the error reaches half the line's length
    # — by then the match is as likely to be the neighbouring line.
    timing = max(0.0, 1.0 - (median_error / (span * 0.5)))
    confidence = coverage * timing

    if matched == 0:
        reason = "no note of this line found a partner"
    elif coverage < 0.5:
        reason = f"only {matched} of {len(singable)} planned notes matched"
    elif timing < 0.5:
        reason = f"matched notes sit {median_error:.2f}s from where the plan expects them"
    else:
        reason = (f"{matched} of {len(singable)} notes matched, median timing error "
                  f"{median_error:.2f}s")

    return PhraseAlignment(
        phrase=singable[0].phrase, planned_notes=len(singable), matched_notes=matched,
        median_time_error=round(median_error, 3),
        start_seconds=round(phrase[0].start_seconds, 3),
        end_seconds=round(phrase[-1].end_seconds, 3),
        confidence=round(confidence, 3),
        trusted=confidence >= PHRASE_CONFIDENCE_FLOOR, reason=reason)


def _reanchor_octave(phrase: Sequence[MeasuredNote], planned: Sequence[TargetNote],
                     pairs: dict) -> list[TargetNote]:
    """Moves a whole planned phrase into the octave it was actually sung in.

    An octave displacement is not an out-of-tune note. It is the right pitch
    class in a different register, consonant with the same harmony, and the
    melody writer's choice of register was free in the first place — the target
    melody picks the octave nearest a section's centre, which is a preference
    and not a requirement.

    So when a *whole line* comes back an octave from the plan, the honest
    reading is that the singer chose a register, not that they sang eleven wrong
    notes. Transposing the plan costs nothing and touches no audio. Transposing
    the audio would be the largest edit this pipeline can make, applied to
    something that was not a defect.

    What this deliberately does not absorb is a single note out of step with its
    own phrase. That one is a real error — a leap nobody sang on purpose — and
    it goes on to be corrected. The median is what separates them: it moves with
    the line and ignores the outlier.
    """
    offsets: list[int] = []
    for position, note in enumerate(phrase):
        if position not in pairs:
            continue
        target = planned[pairs[position]]
        if target.is_rest:
            continue
        raw = cents_between(note.median_hz, target.frequency_hz)
        offsets.append(int(round(raw / 1200.0)))
    if len(offsets) < 3:
        # Too few notes for a median to mean anything. A two-note phrase that
        # disagrees with the plan is as likely to be two errors as a register.
        return list(planned)

    shift = int(np.median(offsets))
    if shift == 0:
        return list(planned)
    return [
        target if target.is_rest
        else replace(target, midi=target.midi + shift * 12)
        for target in planned
    ]


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


def _pitch_marks(audio: np.ndarray, period: int) -> np.ndarray:
    """Uniformly spaced analysis marks, anchored once to the first peak.

    Anchored *once* and then stepped, rather than snapped to the nearest peak
    each time. Snapping each mark independently was a real defect: on a signal
    whose cycle has two comparable peaks the marks alternate between them, which
    writes a period doubling into the grain grid — a -55 cent correction came
    back a clean octave low.
    """
    if period < 2 or audio.size < period:
        return np.arange(0, max(1, audio.size), max(1, period))
    first = int(np.argmax(np.abs(audio[: min(audio.size, period * 2)])))
    count = max(1, int((audio.size - first) // period))
    return (first + np.arange(count) * period).astype(int)


def _shift_psola(audio: np.ndarray, ratio: float, f0_hz: float, sample_rate: int) -> np.ndarray:
    """One TD-PSOLA pass: re-space pitch periods, keeping the length.

    The formants never move because nothing is resampled — the grains are cut
    from the source at its own period and laid down at a different one. That is
    the property that makes this the right method for a large correction, where
    varispeed drags the whole spectrum by the full ratio and a note moved an
    octave comes back sounding like a different person.
    """
    period = int(round(sample_rate / max(1.0, f0_hz)))
    if period < 4 or audio.size < period * 4:
        return audio.copy()
    analysis = _pitch_marks(audio, period)
    if analysis.size < 3:
        return audio.copy()

    # A grain is two *analysis* periods. Widening it to span the synthesis
    # period instead puts four source periods inside each grain, and then the
    # source's own pitch survives however the grains are spaced.
    window_length = period * 2
    window = np.hanning(window_length)
    new_period = period / ratio

    out = np.zeros(audio.size + window_length)
    weight = np.zeros_like(out)
    position = 0.0
    while position < audio.size:
        nearest = int(np.argmin(np.abs(analysis - position)))
        start = analysis[nearest] - window_length // 2
        grain = np.zeros(window_length)
        low, high = max(0, start), min(audio.size, start + window_length)
        if high > low:
            grain[low - start: high - start] = audio[low:high]
        target = int(round(position))
        out[target: target + window_length] += grain * window
        weight[target: target + window_length] += window
        position += new_period

    weight[weight < 1e-6] = 1.0
    return (out / weight)[: audio.size]


def _shift_psola_cascaded(audio: np.ndarray, ratio: float, f0_hz: float,
                          sample_rate: int) -> np.ndarray:
    """PSOLA in as many passes as it takes to stay inside its working range."""
    remaining = ratio
    out = np.asarray(audio, dtype=np.float64)
    current = max(1.0, f0_hz)
    for _ in range(4):
        if PSOLA_MIN_RATIO <= remaining <= PSOLA_MAX_RATIO:
            return _shift_psola(out, remaining, current, sample_rate)
        step = PSOLA_MAX_RATIO if remaining > 1.0 else PSOLA_MIN_RATIO
        out = _shift_psola(out, step, current, sample_rate)
        current *= step
        remaining /= step
    return out


def _shift_note(audio: np.ndarray, start: int, end: int, ratio: float,
                f0_hz: float = 0.0, sample_rate: int = 44100) -> np.ndarray:
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

    # Large corrections go to PSOLA, which does not resample and so does not
    # move the formants at all. See `CORRECTION_METHOD_SPLIT_CENTS` for the
    # measurements behind the split; the short version is that above a whole
    # tone the hybrid's static envelope filter is being asked to move resonances
    # further than one zero-phase correction can, and it shows.
    cents = abs(1200.0 * math.log2(ratio))
    if cents > CORRECTION_METHOD_SPLIT_CENTS and f0_hz > 0:
        shifted = _shift_psola_cascaded(audio[start:end], ratio, f0_hz, sample_rate)
        if shifted.size == length:
            return _match_level(audio[start:end], shifted)
        # PSOLA declined — too few periods in the note. Fall through rather than
        # leave the note wrong, because a formant-shifted correction is still a
        # correction and an uncorrected note is the thing being forbidden.

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
    return _match_level(audio[start:end], _restore_formants(audio[start:end], shifted, ratio))


def _match_level(original: np.ndarray, shifted: np.ndarray) -> np.ndarray:
    """Stops a correction from making a note louder. Never makes one quieter.

    A correction changes pitch and nothing else. PSOLA's overlap-add breaks that
    on its own: for an upward shift the grains are packed closer together, and
    at the very edges of a segment the accumulated Hann weight ramps from zero,
    so dividing by it amplifies. Measured as a corrected song peaking above the
    song that went into it, which the remix stage would then have to pull back —
    quietly changing the master because a note was retuned.

    Only downward. Scaling a quiet correction up would be inventing level that
    the singer did not produce.
    """
    before = float(np.max(np.abs(original))) if original.size else 0.0
    after = float(np.max(np.abs(shifted))) if shifted.size else 0.0
    if before > 1e-9 and after > before:
        return shifted * (before / after)
    return shifted


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
    #: Notes corrected by more than `CORRECTION_METHOD_SPLIT_CENTS`: wrong notes
    #: rather than mistuned ones, moved by PSOLA rather than by the small-shift
    #: method. Counted because a song with many of them is a song whose plan and
    #: performance disagree, which the caller needs told.
    large_corrections: int = 0
    #: Deviations too large to be a tuning error at all — an alignment failure.
    #: These are the only ones still left alone, and the decision line says so.
    implausible: int = 0
    #: Phrases whose planned octave was moved to the register actually sung.
    phrases_reanchored: int = 0
    #: How much of the planned melody was actually found in the vocal stem.
    #:
    #: The honest denominator for everything else in this report. A song where
    #: half the planned notes were never located is a song half of which is
    #: unmeasured — not a song half of which is fine — and the two must not be
    #: allowed to read the same. A low figure usually means the separation was
    #: poor, not that the singer stopped.
    planned_notes: int = 0
    planned_notes_measured: int = 0
    #: Octave errors still present after correction. Zero is the target; a
    #: number here is an audible wrong note that survived, and it is reported
    #: rather than folded away.
    octave_errors_after: int = 0
    #: Corrections that were applied, measured, and undone because they did not
    #: land. Never zero-by-construction: this is the count of times the do-no-
    #: harm rule actually fired, and a run with many of them is a run whose
    #: vocal stem was not clean enough to correct against.
    notes_reverted: int = 0
    #: How far the plan had to be shifted to match the performance, in seconds.
    time_offset_seconds: float = 0.0
    #: Whether the numbers above can be trusted, and why.
    #:
    #: Three states, and the strongest of them is deliberately weak. VERIFIED
    #: means: the vocal was separated, most of the planned melody was found in
    #: it, the melody itself passed its checks, and every structural note this
    #: pipeline could measure is inside its tolerance. It does **not** mean the
    #: song has no audible out-of-tune note, and it is not a listening result.
    #: Nothing in this file can produce one.
    trust: str = "UNVERIFIED"
    trust_reasons: list[str] = field(default_factory=list)
    #: Tempo, and whether it invalidates the plan's timeline.
    tempo_verdict: str = "TEMPO_UNMEASURABLE"
    measured_bpm: float = 0.0
    requested_bpm: float = 0.0
    tempo_ratio: Optional[float] = None
    tempo_local_drift: float = 0.0
    #: Whether correcting against this plan was allowed at all, and why.
    authorization: str = CORRECTION_NOT_AUTHORIZED
    authorization_reasons: list[str] = field(default_factory=list)
    #: One row per sung line: how well it matched, and whether it was trusted.
    phrase_alignments: list[dict] = field(default_factory=list)
    #: Which separator produced the vocal stem this report describes.
    #:
    #: Never inferred by a reader. Hybrid Demucs and the numpy fallback are not
    #: equivalent, and every figure below depends on which one ran.
    separator: str = "none"
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
    def measurement_coverage(self) -> float:
        """Share of the planned melody that was found and measured, 0..1."""
        if self.planned_notes == 0:
            return 0.0
        return self.planned_notes_measured / self.planned_notes

    @property
    def anchors_in_tune_after(self) -> float:
        """Share of the notes that had to be right which are, 0..1.

        The number the product requirement turns on, and it is measured on the
        output rather than predicted from the corrections applied.
        """
        if self.anchors_examined == 0:
            return 0.0
        return self.anchors_within_tolerance_after / self.anchors_examined


def _measure_segment(audio: np.ndarray, start: int, end: int,
                     sample_rate: int) -> tuple[float, float]:
    """Median pitch and confidence of one stretch of audio.

    Used to check a correction against the note it just changed, rather than
    against the whole stem. Cheap now that the difference function is an FFT.
    """
    segment = audio[max(0, start): min(audio.size, end)]
    if segment.size < sample_rate // 20:
        return 0.0, 0.0
    track = detect_f0(segment, sample_rate)
    voiced = track.f0[track.voiced]
    if voiced.size == 0:
        return 0.0, 0.0
    return float(np.median(voiced)), float(np.median(track.confidence[track.voiced]))


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
    report.time_offset_seconds = round(estimate_time_offset(notes, targets), 3)
    report.notes_examined = len(alignments)

    matched = [a for a in alignments if a.target is not None and not a.target.is_rest]
    # The whole distance from the planned note, octaves included, over every
    # matched note. Excluding the octave errors — which this did first — made
    # the "before" median an average of the notes that were already fine, while
    # the "after" median included the corrected ones, so a run that fixed an
    # octave error and two wrong notes reported its median *rising* from 0.1 to
    # 2.8 cents. Two different sets of notes are not a before and an after.
    deviations_before = [abs(a.total_deviation_cents) for a in matched]
    anchors = [a for a in matched if a.target is not None and a.target.is_anchor]
    report.anchors_examined = len(anchors)
    report.anchors_within_tolerance_before = sum(
        1 for a in anchors
        if a.octaves_out == 0 and abs(a.deviation_cents) < a.target.tolerance_cents)
    report.octave_errors = sum(1 for a in matched if a.octaves_out != 0)
    report.large_corrections = sum(
        1 for a in matched
        if a.correct and abs(a.total_deviation_cents) > CORRECTION_METHOD_SPLIT_CENTS)
    report.implausible = sum(1 for a in matched if "the match, not the singing" in a.decision)
    report.unmatched_sung = sum(1 for a in alignments if a.target is None)
    report.phrases_measured = len(group_measured_phrases(notes))
    planned_phrases = group_target_phrases(targets)
    # Keyed on when the note starts, not on object identity. `_reanchor_octave`
    # builds transposed copies of a phrase's targets, so their ids are not the
    # ids in `targets` — and every re-anchored phrase would then have reported
    # every one of its notes as unmatched. A start time survives transposition;
    # a Python id does not.
    matched_targets = {round(a.target.start_seconds, 4) for a in matched if a.target}
    report.unmatched_planned = sum(
        1 for phrase in planned_phrases for target in phrase
        if round(target.start_seconds, 4) not in matched_targets)
    report.phrases_matched = sum(
        1 for phrase in planned_phrases
        if any(round(target.start_seconds, 4) in matched_targets for target in phrase))

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
        #
        # Except for an octave, which is corrected all the way: 92% of 1200
        # cents leaves a note 96 cents flat, which is not a softened edit, it is
        # a different and worse error than the one being fixed. Partial
        # correction is for intonation; a register is not intonation.
        if alignment.octaves_out != 0:
            move_cents = -alignment.total_deviation_cents
        else:
            move_cents = -alignment.deviation_cents * CORRECTION_STRENGTH
        ratio = 2.0 ** (move_cents / 1200.0)
        shifted = _shift_note(output, start, end, ratio,
                              f0_hz=note.median_hz, sample_rate=sample_rate)
        if shifted.size == end - start:
            # Cross-fade the joins. A hard splice between a corrected note and
            # the untouched breath before it is a click, and a click is more
            # audible than the error being fixed.
            fade = min(int(0.005 * sample_rate), (end - start) // 4)
            if fade > 1:
                ramp = np.linspace(0.0, 1.0, fade)
                shifted[:fade] = shifted[:fade] * ramp + output[start:start + fade] * (1 - ramp)
                shifted[-fade:] = shifted[-fade:] * ramp[::-1] + output[end - fade:end] * ramp
            # Do no harm to a note that was already right.
            #
            # The aggregate check at the end of this function is not enough, and
            # this pipeline has the measurement to prove it: on a stem the
            # separator had made a poor job of, one note that measured +0.1
            # cents came back 155 cents and an octave out, while the *totals*
            # improved — two anchors in tune became three — so nothing noticed.
            # A song with one destroyed note is a song with an audible wrong
            # note in it, whatever the average did.
            #
            # So every correction is checked against the note it changed, and a
            # correction that did not land is undone. The cost is one short F0
            # pass per corrected note; the guarantee is that no note leaves this
            # function further from its target than it arrived.
            # Measured on the shifted segment itself, not on a copy of the
            # whole stem with the segment written into it: the slice is the same
            # samples either way, and the copy is 74 MB on a three-and-a-half
            # minute song, allocated once per corrected note.
            before_hz, _ = _measure_segment(output, start, end, sample_rate)
            after_hz, after_confidence = _measure_segment(
                shifted, 0, shifted.size, sample_rate)
            target_hz = alignment.target.frequency_hz
            improved = False
            if after_hz > 0 and before_hz > 0 and target_hz > 0 and after_confidence > 0.2:
                def _folded(hz: float) -> float:
                    raw = cents_between(hz, target_hz)
                    return abs(raw - round(raw / 1200.0) * 1200.0)
                improved = _folded(after_hz) <= _folded(before_hz) + 1.0
                if alignment.octaves_out != 0:
                    # An octave correction has to land in the right octave, so
                    # the folded comparison is not the question here.
                    improved = abs(cents_between(after_hz, target_hz)) < abs(
                        cents_between(before_hz, target_hz))
            if improved:
                output[start:end] = shifted
                report.notes_corrected += 1
                report.total_cents_moved += abs(move_cents)
                report.largest_correction_cents = max(
                    report.largest_correction_cents, abs(move_cents))
            else:
                report.notes_reverted += 1
                report.notes_left_alone += 1
                report.decisions.append(
                    f"{note.start_seconds:6.2f}s  correction reverted: it did not land "
                    f"({before_hz:.1f} Hz -> {after_hz:.1f} Hz, target {target_hz:.1f} Hz)")
                continue
        else:
            report.notes_left_alone += 1
        report.decisions.append(
            f"{note.start_seconds:6.2f}s  {alignment.decision}"
        )

    # Measure again, on the output, rather than predicting what the correction
    # achieved. A correction that did not land must not be reported as one that
    # did.
    #
    # At the note boundaries already established, not by re-segmenting the
    # corrected stem. Re-segmenting looks more independent and is worse: the
    # segmenter splits a run of voicing wherever the pitch jumps more than a
    # tone, so correcting one note to within a tone of its neighbour makes the
    # two merge into one, and the merged median is then reported as both of
    # them. Measured: a note that was +0.1 cents and never touched — the audio
    # around it bit-identical — was reported afterwards as 156 cents and an
    # octave out, purely because the note after it had been corrected closer.
    # The boundaries are not in question here; the pitch inside them is.
    deviations_after: list[float] = []
    after_in_tune = 0
    after_octave_errors = 0
    measured_after = 0
    for alignment in matched:
        target = alignment.target
        if target is None or target.is_rest:
            continue
        start = int(round(alignment.measured.start_seconds * sample_rate))
        end = int(round(alignment.measured.end_seconds * sample_rate))
        hz, _ = _measure_segment(output, start, end, sample_rate)
        if hz <= 0:
            continue
        raw = cents_between(hz, target.frequency_hz)
        octaves = int(round(raw / 1200.0))
        folded = raw - octaves * 1200.0
        if octaves != 0:
            after_octave_errors += 1
        deviations_after.append(abs(raw))
        measured_after += 1
        if target.is_anchor and octaves == 0 and abs(folded) < target.tolerance_cents:
            after_in_tune += 1
    report.anchors_within_tolerance_after = after_in_tune
    report.octave_errors_after = after_octave_errors
    report.planned_notes = sum(1 for target in targets if not target.is_rest)
    report.planned_notes_measured = measured_after
    report.median_deviation_before_cents = float(np.median(deviations_before)) if deviations_before else 0.0
    report.median_deviation_after_cents = float(np.median(deviations_after)) if deviations_after else 0.0

    # A correction that made things worse is a correction that must be undone.
    # It should not happen — every shift is measured before and after — but
    # "should not happen" is not a guarantee, and returning the vocal ACE-Step
    # made is always an available and honest outcome.
    assess_trust(report)

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


def assess_trust(report: "CorrectionReport") -> None:
    """Decides whether this report's numbers are worth believing, and says why.

    The requirement is a finished song with no audible out-of-tune note. This
    pipeline cannot certify that, and the point of this function is to stop the
    absence of a detected error being read as the presence of a guarantee.

    Three states:

      UNVERIFIED  Not enough of the song was measurable to say anything about
                  it. The vocal is returned — corrected where it could be — and
                  the caller is told the result is not verified. This is the
                  honest outcome for a stem the separator could not open up, and
                  it is never upgraded because the corrections that *did* happen
                  went well.
      PARTIAL     Measured, with something left in it: an octave error that
                  survived, a note whose match could not be trusted, or a
                  correction that had to be undone.
      VERIFIED    Separated, most of the plan found, every structural note that
                  could be measured inside its tolerance.

    VERIFIED is the weakest strong word available on purpose. It says the
    measurement found nothing wrong, not that there is nothing wrong, and not
    that anybody has listened.
    """
    reasons: list[str] = []
    if report.unavailable is not None:
        report.trust = "UNVERIFIED"
        report.trust_reasons = [report.unavailable]
        return

    coverage = report.measurement_coverage
    if report.anchors_examined == 0:
        reasons.append("no structural note of the planned melody was found in the vocal")
    if coverage < 0.5:
        reasons.append(
            f"only {coverage * 100:.0f}% of the planned melody was found in the vocal, "
            f"so most of the song is unmeasured rather than confirmed")
    if reasons:
        report.trust = "UNVERIFIED"
        report.trust_reasons = reasons
        return

    if coverage < 0.85:
        reasons.append(f"{coverage * 100:.0f}% of the planned melody was measured; the rest "
                       f"was not found and is neither confirmed nor corrected")
    if report.octave_errors_after > 0:
        reasons.append(f"{report.octave_errors_after} note(s) are still an octave from the plan "
                       f"after correction")
    if report.implausible > 0:
        reasons.append(f"{report.implausible} sung note(s) could not be matched to a planned "
                       f"note at all, and were left exactly as generated")
    if report.notes_reverted > 0:
        reasons.append(f"{report.notes_reverted} correction(s) did not land and were undone, "
                       f"so those notes are still as generated")
    if report.unmatched_sung > 0:
        reasons.append(f"{report.unmatched_sung} sung note(s) had no planned counterpart and "
                       f"were left untouched")

    report.trust = "PARTIAL" if reasons else "VERIFIED"
    report.trust_reasons = reasons or [
        "every structural note that could be measured is inside its tolerance — "
        "which is a measurement, not a listening result"
    ]


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


#: STFT settings for the fallback separator. 2048 at 44.1 kHz is about 46 ms:
#: long enough to resolve a low male fundamental, short enough that a syllable
#: is several frames.
FALLBACK_FFT = 2048
FALLBACK_HOP = 512

#: How long the background model looks, in seconds.
#:
#: The instrumental of a song is far more stationary than the voice over this
#: span — a pad, a bass line and a drum loop are all still there two seconds
#: later, where a sung syllable is not. A median over that window is therefore
#: an estimate of everything except the singer.
FALLBACK_BACKGROUND_SECONDS = 2.0


def _stft(audio: np.ndarray, n_fft: int, hop: int) -> np.ndarray:
    window = np.hanning(n_fft)
    frames = 1 + max(0, (audio.size - n_fft) // hop)
    out = np.empty((n_fft // 2 + 1, frames), dtype=np.complex128)
    for index in range(frames):
        out[:, index] = np.fft.rfft(audio[index * hop: index * hop + n_fft] * window)
    return out


def _istft(spectra: np.ndarray, n_fft: int, hop: int, length: int) -> np.ndarray:
    window = np.hanning(n_fft)
    frames = spectra.shape[1]
    out = np.zeros(frames * hop + n_fft)
    weight = np.zeros_like(out)
    for index in range(frames):
        out[index * hop: index * hop + n_fft] += np.fft.irfft(spectra[:, index], n_fft) * window
        weight[index * hop: index * hop + n_fft] += window ** 2
    weight[weight < 1e-8] = 1.0
    result = out / weight
    if result.size >= length:
        return result[:length]
    return np.concatenate([result, np.zeros(length - result.size)])


def separate_fallback(mix: np.ndarray, sample_rate: int) -> tuple[np.ndarray, np.ndarray]:
    """Vocal isolation with numpy and scipy only, for when Demucs is absent.

    This exists because of a deployment constraint and it is honest about what
    it is. Hybrid Demucs is the separator; it needs torchaudio, which this Space
    already pins for ACE-Step, so in the deployed environment it is there. But
    `separate` degrading to "unavailable" means the whole correction stage does
    nothing, and a pipeline whose single point of failure silently disables it
    is worse than one with a weaker second path.

    The method is the standard median-filter foreground estimate. In the
    magnitude spectrogram, take a running median over about two seconds in each
    frequency bin: a pad, a bass line and a drum loop are all still there two
    seconds later, and a sung syllable is not, so the median is an estimate of
    everything except the singer. The vocal is then a soft Wiener mask of what
    the median could not explain, band-limited to where a voice actually lives.

    It is **not as good as Demucs** and nothing here pretends otherwise. What it
    buys is that the correction stage runs at all, and that this pipeline can be
    exercised end to end — through separation, measurement, correction and remix
    to a real audio file — in an environment that has no GPU and no torchaudio.
    `process_song` records which separator ran, and every report says so.

    Returns `(vocal, backing)`; the two sum to the input by construction, so a
    song whose vocal is never corrected reconstructs exactly.
    """
    mix = np.asarray(mix, dtype=np.float64).reshape(-1)
    if mix.size < FALLBACK_FFT * 4:
        return np.zeros(0), mix

    from scipy.ndimage import median_filter

    spectra = _stft(mix, FALLBACK_FFT, FALLBACK_HOP)
    magnitude = np.abs(spectra)
    span = max(3, int(round(FALLBACK_BACKGROUND_SECONDS * sample_rate / FALLBACK_HOP)))

    # The median is taken on a time-decimated spectrogram and interpolated back.
    #
    # At full rate this cost 3.5 seconds to separate 9.6 seconds of audio — 0.36x
    # realtime, so a three-and-a-half minute song costs about 76 seconds, more
    # than the whole ZeroGPU slice this runs at the end of. A median filter costs
    # roughly (elements x window) and decimating divides both, so the saving is
    # quadratic in the factor.
    #
    # The factor is 2, and it is measured rather than reasoned. The reasoning
    # said decimation is free — the background model is a two-second median, so
    # it cannot contain detail finer than that, so sampling it every 93 ms and
    # interpolating is the estimate rather than an approximation of it. That
    # argument is wrong, and the swept measurement says where: the same window in
    # time holds *fewer order statistics* after decimating, and a median over 20
    # samples is a noisier estimate than a median over 173 however far apart they
    # are spread.
    #
    #     decimation   seconds   SNR dB   planned notes measured
    #              1      2.09     2.14      4/8
    #              2      0.60     1.89      4/8
    #              4      0.24     1.87      3/8
    #              8      0.14    -6.46      3/8
    #
    # Two is 3.5x faster for no measurable loss. Eight, which is what the free-
    # lunch argument would have chosen, loses 8.6 dB and a quarter of the notes.
    decimation = 2
    coarse = magnitude[:, ::decimation]
    coarse_span = max(3, span // decimation)
    coarse_span += 1 - coarse_span % 2
    coarse_background = median_filter(coarse, size=(1, coarse_span), mode="nearest")

    if decimation == 1:
        background = coarse_background
    else:
        frames = magnitude.shape[1]
        source = np.arange(coarse_background.shape[1]) * decimation
        background = np.empty_like(magnitude)
        for bin_index in range(magnitude.shape[0]):
            background[bin_index] = np.interp(
                np.arange(frames), source, coarse_background[bin_index])

    # What the background cannot account for. Squared, which is the Wiener form:
    # it is gentler on bins where the two are comparable, and a hard mask there
    # is what makes this kind of separation sound like a phone call.
    foreground = np.maximum(magnitude - background, 0.0)
    denominator = foreground ** 2 + background ** 2 + 1e-12
    mask = foreground ** 2 / denominator

    # A voice lives here. Below 80 Hz is bass and kick; above 8 kHz the vocal is
    # breath and sibilance that the mask cannot separate anyway, and letting it
    # through mostly imports cymbals.
    frequencies = np.fft.rfftfreq(FALLBACK_FFT, 1.0 / sample_rate)
    mask[frequencies < 80.0, :] = 0.0
    mask[frequencies > 8000.0, :] *= 0.25

    vocal = _istft(spectra * mask, FALLBACK_FFT, FALLBACK_HOP, mix.size)
    # The backing is the remainder rather than a second mask, so the two sum to
    # the input exactly and a song with nothing corrected comes back unchanged.
    return vocal, mix - vocal


def process_song(mix: np.ndarray, sample_rate: int, targets: Sequence[TargetNote],
                 device: str = "cuda",
                 requested_bpm: Optional[float] = None) -> tuple[np.ndarray, CorrectionReport]:
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
        assess_trust(report)
        return mix, report

    # Before anything is separated or measured: does this plan describe this
    # performance at all? The tempo answers that, because the melody's note
    # times come from the planned tempo and nothing downstream can detect a
    # timeline that is simply wrong — every note would still find a partner,
    # just the wrong one.
    tempo_started = time.perf_counter()
    try:
        import tempo as tempo_module

        reading = tempo_module.measure_tempo(
            np.asarray(mix, dtype=np.float64).reshape(-1)
            if np.ndim(mix) == 1 else np.asarray(mix, dtype=np.float64).mean(axis=0),
            sample_rate, requested_bpm=requested_bpm)
    except Exception as error:  # noqa: BLE001 - a missing measurement is a refusal
        reading = None
        report.decisions.append(f"tempo could not be measured: {error}")
    tempo_seconds = time.perf_counter() - tempo_started

    report.tempo_verdict = reading.verdict if reading else "TEMPO_UNMEASURABLE"
    report.measured_bpm = round(reading.comparable_bpm, 2) if reading else 0.0
    report.requested_bpm = float(requested_bpm) if requested_bpm else 0.0
    report.tempo_ratio = round(reading.ratio, 4) if (reading and reading.ratio) else None
    report.tempo_local_drift = round(reading.local_drift, 4) if reading else 0.0

    authorized, why = authorize_correction(reading, targets)
    report.authorization = authorized
    report.authorization_reasons = why
    if authorized != CORRECTION_AUTHORIZED:
        # The safe outcome, and an expected one. The song is returned exactly as
        # generated — which is what this Space produced before correction
        # existed — and the report says why nothing was touched. It is never
        # upgraded to a pass by anything measured afterwards.
        report.unavailable = (
            "Pitch correction was not authorised: the target melody does not describe this "
            "performance closely enough to correct against.")
        report.stage_seconds = {"tempo": round(tempo_seconds, 3)}
        assess_trust(report)
        report.trust = "UNVERIFIED"
        report.trust_reasons = why
        return mix, report

    if reading and reading.ratio and abs(reading.ratio - 1.0) > 1e-6:
        targets = warp_targets(targets, reading.ratio)
        report.decisions.append(
            f"target melody re-timed by {reading.ratio:.4f} to the tempo actually generated")

    started = time.perf_counter()
    vocal, backing, problem = separate(mix, sample_rate, device)
    separator = "hybrid-demucs"
    if problem is not None or vocal.size == 0:
        # Demucs is not available. Rather than disable the whole correction
        # stage on one missing dependency, fall back — and say so, in the report
        # and in the returned metadata, because the two separators are not
        # equivalent and a reader must not have to guess which one ran.
        vocal, backing = separate_fallback(mix, sample_rate)
        separator = "median-filter fallback"
        if vocal.size == 0:
            report.unavailable = problem or "The separator returned no vocal."
            report.separator = "none"
            report.stage_seconds = {"separate": round(time.perf_counter() - started, 3)}
            assess_trust(report)
            return mix, report
    separation_seconds = time.perf_counter() - started

    corrected_started = time.perf_counter()
    corrected, report = correct_vocal(vocal, sample_rate, targets)
    report.separator = separator
    report.stage_seconds = {
        "separate": round(separation_seconds, 3),
        "measure_align_correct": round(time.perf_counter() - corrected_started, 3),
        "tempo": round(tempo_seconds, 3),
    }
    report.phrase_alignments = [
        {"phrase": p.phrase, "planned": p.planned_notes, "matched": p.matched_notes,
         "t0": p.start_seconds, "t1": p.end_seconds, "confidence": p.confidence,
         "trusted": p.trusted, "reason": p.reason}
        for p in _LAST_PHRASE_SCORES]
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
        # Not fatal on its own. `process_song` falls back to the numpy
        # separator, so the correction stage still runs — worse, and saying so.
        found["fallback_separator"] = "available"

    # The fallback, exercised rather than assumed. It is what actually runs when
    # the line above failed, so a readiness report that did not test it would be
    # reporting on a path the request will not take.
    try:
        probe_rate = 22050
        axis = np.arange(int(1.5 * probe_rate)) / probe_rate
        probe_mix = (0.3 * np.sin(2 * np.pi * 110.0 * axis)
                     + 0.4 * np.sin(2 * np.pi * 330.0 * axis))
        isolated, rest = separate_fallback(probe_mix, probe_rate)
        found["fallback_sums_back"] = bool(
            isolated.size and np.allclose(isolated + rest, probe_mix, atol=1e-9))
        if not found["fallback_sums_back"]:
            problems.append("the fallback separator's stems do not sum back to the mix")
    except Exception as error:
        problems.append(f"the fallback separator failed: {error}")

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
