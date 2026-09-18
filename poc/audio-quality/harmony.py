"""Whether the notes being sung belong to what the band is playing.

This is the measure that found the fault, and it is a different question from
intonation in a way worth being blunt about: **a vocal can be perfectly in tune
and still be wrong**. Every note landing within five cents of the twelve-tone
grid says the singer is accurate. It says nothing about whether those were the
notes the chord wanted. A line sung cleanly, in the right key, against chords it
does not fit is exactly what a listener calls off-key — and no amount of pitch
correction repairs it, because the pitches are not the problem. Moving them onto
the chord would be rewriting the melody, not tuning it.

The measurement is a comparison, never a bare percentage. Asking "is the sung
note in the chord" gives a number with nothing to judge it against: 32% sounds
poor until you know that a melody with no relationship to the accompaniment
scores 34%. So the same line is also scored against the accompaniment at forty
wrong moments, and the distance between the two is the finding. A z near zero
means the singer might as well be singing over different bars.

Both sides must be isolated. Measured on a mix, the piano leaks into the "vocal"
and correlates with itself in the accompaniment, and the score comes back
strongly positive for a line that is actually unrelated — which is precisely what
happened here before separation was available: z = +6.46 contaminated, +0.34 on
isolated stems.
"""

from __future__ import annotations

from dataclasses import dataclass, field, asdict

#: How many wrong-moment alignments the melody is scored against.
NULL_SHIFTS = 40

#: Where a z-score stops being consistent with chance. Two standard deviations
#: is the usual convention and it is used here as a convention, not a law.
Z_UNRELATED = 2.0

#: Below this, the melody is treated as having no demonstrable relationship to
#: the harmony. It is a threshold on evidence, not on musical taste.
Z_FAIL = 1.0

PITCH_CLASSES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
MAJOR_STEPS = [0, 2, 4, 5, 7, 9, 11]
MINOR_STEPS = [0, 2, 3, 5, 7, 8, 10]
MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88]
MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17]


@dataclass
class HarmonyReport:
    frames: int
    analysed_seconds: float

    key: str | None = None
    in_key_percent: float | None = None

    strongest_percent: float | None = None
    top3_percent: float | None = None
    weakest4_percent: float | None = None
    mean_support: float | None = None

    null_top3_percent: float | None = None
    null_mean_support: float | None = None
    z: float | None = None

    #: Stretches where the sung note sat among the accompaniment's weakest, long
    #: enough to be heard as a clash rather than a passing tone.
    clashes: list = field(default_factory=list)

    isolated: bool = False
    limitations: list = field(default_factory=list)

    @property
    def sufficient(self) -> bool:
        return self.frames >= 100 and self.z is not None

    @property
    def compatible(self) -> bool | None:
        """Whether the melody demonstrably follows the harmony. None when unknown."""
        if not self.sufficient:
            return None
        return self.z >= Z_UNRELATED

    def as_dict(self) -> dict:
        out = asdict(self)
        out["compatible"] = self.compatible
        out["sufficient"] = self.sufficient
        return out


def estimate_key(chroma) -> tuple:
    """Root and mode of the accompaniment, by profile correlation."""
    import numpy as np

    profile = chroma.mean(axis=1)
    profile = (profile - profile.mean()) / (profile.std() + 1e-9)
    best = None
    for root in range(12):
        for name, template in (("major", MAJOR_PROFILE), ("minor", MINOR_PROFILE)):
            rolled = np.roll(template, root)
            rolled = (rolled - rolled.mean()) / (rolled.std() + 1e-9)
            score = float((profile * rolled).mean())
            if best is None or score > best[0]:
                best = (score, root, name)
    _, root, mode = best
    steps = MAJOR_STEPS if mode == "major" else MINOR_STEPS
    return root, mode, {(root + step) % 12 for step in steps}


def compatibility(
    times,
    vocal_hz,
    voiced,
    accompaniment,
    sample_rate: int,
    hop_length: int,
    *,
    isolated: bool = False,
    min_clash_seconds: float = 0.8,
) -> HarmonyReport:
    """Score the sung line against the accompaniment's own chroma."""
    import librosa
    import numpy as np

    times = np.asarray(times, dtype=float)
    vocal_hz = np.asarray(vocal_hz, dtype=float)
    voiced = np.asarray(voiced, dtype=bool) & np.isfinite(vocal_hz) & (vocal_hz > 0)

    frame_seconds = float(times[1] - times[0]) if len(times) > 1 else 0.0
    report = HarmonyReport(
        frames=int(voiced.sum()),
        analysed_seconds=float(voiced.sum()) * frame_seconds,
        isolated=isolated,
    )
    if not isolated:
        report.limitations.append(
            "Both sides must be isolated. On a mix the accompaniment leaks into the "
            "vocal and correlates with itself, which inflates this score badly."
        )
    if report.frames < 100:
        report.limitations.append("Too few sung frames to compare against anything.")
        return report

    chroma = librosa.feature.chroma_cqt(
        y=librosa.effects.harmonic(accompaniment, margin=3.0),
        sr=sample_rate, hop_length=hop_length)
    normalised = chroma / (chroma.max(axis=0, keepdims=True) + 1e-9)
    tuning = librosa.estimate_tuning(y=accompaniment, sr=sample_rate)

    midi = librosa.hz_to_midi(vocal_hz) - tuning
    # Unvoiced frames carry NaN, and casting NaN to int is undefined — it
    # produces a platform-dependent value, not an error. Those frames are masked
    # out a few lines below and their pitch classes are never read, so nothing
    # was wrong with the result; but a garbage value sitting in an array waiting
    # for someone to widen a mask is a defect regardless of whether it has bitten
    # yet. Zero where there is no pitch, and the mask still decides what counts.
    usable = np.isfinite(midi)
    classes = np.zeros(len(midi), dtype=int)
    classes[usable] = np.mod(np.round(midi[usable]), 12).astype(int)
    frames = np.clip(librosa.time_to_frames(times, sr=sample_rate, hop_length=hop_length),
                     0, normalised.shape[1] - 1)

    chosen = np.where(voiced)[0]
    at = frames[chosen]
    pitch = classes[chosen]
    support = normalised[pitch, at]
    rank = (normalised[:, at] > support).sum(axis=0)

    report.mean_support = float(support.mean())
    report.strongest_percent = float(100.0 * (rank == 0).mean())
    report.top3_percent = float(100.0 * (rank < 3).mean())
    report.weakest4_percent = float(100.0 * (rank >= 8).mean())

    # The null: the same melody, against the accompaniment at the wrong moments.
    rng = np.random.default_rng(0)
    width = normalised.shape[1]
    supports, top3s = [], []
    for _ in range(NULL_SHIFTS):
        shift = int(rng.integers(width // 8, max(width // 8 + 1, width - width // 8)))
        moved = (at + shift) % width
        null_support = normalised[pitch, moved]
        supports.append(float(null_support.mean()))
        top3s.append(float(((normalised[:, moved] > null_support).sum(axis=0) < 3).mean()))
    supports = np.array(supports)
    report.null_mean_support = float(supports.mean())
    report.null_top3_percent = float(100.0 * np.mean(top3s))
    report.z = float((report.mean_support - supports.mean()) / (supports.std() + 1e-9))

    root, mode, scale = estimate_key(chroma)
    report.key = f"{PITCH_CLASSES[root]} {mode}"
    report.in_key_percent = float(100.0 * np.isin(pitch, list(scale)).mean())

    # Where it clashes for long enough to be heard as one.
    clashing = times[chosen][rank >= 8]
    if len(clashing):
        run = [clashing[0]]
        for moment in clashing[1:]:
            if moment - run[-1] < 0.5:
                run.append(moment)
                continue
            if run[-1] - run[0] >= min_clash_seconds:
                report.clashes.append((round(float(run[0]), 1), round(float(run[-1]), 1)))
            run = [moment]
        if run[-1] - run[0] >= min_clash_seconds:
            report.clashes.append((round(float(run[0]), 1), round(float(run[-1]), 1)))
        report.clashes.sort(key=lambda span: span[0] - span[1])

    report.limitations.append(
        "Chroma from a polyphonic mix, so an implied chord tone the band never "
        "actually sounds counts as absent. Read the z, not the raw percentage."
    )
    return report
