"""Pulling the voice out of the mix, when the machine running this can.

Every vocal figure this project produces was, until now, measured on a full mix
containing piano, upright bass and tenor saxophone. A pitch tracker follows
whichever harmonic source is loudest, and a tenor saxophone sits in the same
register as a male singer, so those figures could never be attributed to the
voice. That is why the verdict was ANALYSIS_UNAVAILABLE however good the numbers
looked.

Spleeter's 2stems model separates a mix into vocals and accompaniment, and it
runs on a CPU. It is **optional**: TensorFlow is several hundred megabytes and
the checkpoint is another seventy-three, which is reasonable for an analysis tool
someone runs deliberately and absurd for a browser. Nothing here is imported by
the application, and neither TensorFlow nor the checkpoint belongs in the
repository.

When it is missing, this module says exactly what is missing and the analysis
reports ANALYSIS_UNAVAILABLE. It never falls back to a full-mix measurement and
calls the result a verdict — a number that cannot be attributed to the voice
cannot clear the voice, and dressing one up as a PASS is worse than having no
answer at all.

Installation and the model download are in README.md next to this file.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

#: Where the checkpoint is looked for. Override to keep it elsewhere.
MODEL_DIR = Path(os.environ.get(
    "SPLEETER_MODEL_DIR",
    Path.home() / ".cache" / "aimusicgenerated" / "spleeter-2stems",
))

#: The three files a TensorFlow checkpoint is made of.
CHECKPOINT_FILES = ("model.meta", "model.index", "model.data-00000-of-00001")

#: The graph's own tensor names, read out of the shipped checkpoint rather than
#: guessed: one stereo waveform in, two stereo waveforms out.
INPUT_TENSOR = "waveform:0"
VOCALS_TENSOR = "strided_slice_13:0"
ACCOMPANIMENT_TENSOR = "strided_slice_23:0"

#: The rate the graph was built for. Audio at any other rate is resampled to it
#: before separation and the stems come back at this rate — which changes no
#: pitch, because resampling changes the number of samples per second and the
#: time they represent together.
MODEL_SAMPLE_RATE = 44100

#: Seconds per chunk, and the overlap discarded from each chunk's start. A
#: five-minute song does not need the whole graph's activations in memory at
#: once, and the overlap keeps the seam from landing inside a note.
CHUNK_SECONDS = 30
OVERLAP_SECONDS = 2

#: How far below its own loud level a window must sit to count as a silence in
#: the vocal stem, and how much of the track has to be silent for the split to
#: be believed, in each half of the track separately. Measured on two real
#: songs: a working split is this quiet for 20% of the first half and 31% of
#: the second; a failed one manages 2% and 4%.
QUIET_FLOOR_DB = 30.0
QUIET_FLOOR_RATIO = 10.0 ** (-QUIET_FLOOR_DB / 20.0)
MIN_QUIET_SHARE_PERCENT = 10.0


class SeparatorUnavailable(RuntimeError):
    """Raised when separation cannot be performed, saying precisely why."""


@dataclass
class Availability:
    """Whether separation can run here, and what is missing if not."""

    ready: bool
    reason: str
    tensorflow_version: str | None = None
    model_dir: str = str(MODEL_DIR)


def availability(model_dir: Path | None = None) -> Availability:
    """Check without importing anything heavy unless it is actually there."""
    directory = Path(model_dir) if model_dir is not None else MODEL_DIR

    missing = [name for name in CHECKPOINT_FILES if not (directory / name).is_file()]
    try:
        import tensorflow as tf  # noqa: PLC0415 - deliberately late and optional
        version = str(tf.__version__)
    except Exception as error:  # noqa: BLE001 - any import failure means unavailable
        return Availability(
            ready=False,
            reason=(f"TensorFlow is not importable ({type(error).__name__}). "
                    "See README.md; without it no vocal isolation is possible and the "
                    "analysis reports ANALYSIS_UNAVAILABLE."),
            model_dir=str(directory),
        )

    if missing:
        return Availability(
            ready=False,
            reason=(f"The Spleeter 2stems checkpoint is incomplete in {directory}: "
                    f"missing {', '.join(missing)}. See README.md for the download."),
            tensorflow_version=version,
            model_dir=str(directory),
        )
    return Availability(True, "Spleeter 2stems is available.", version, str(directory))


def separate(
    samples,
    sample_rate: int,
    *,
    model_dir: Path | None = None,
    chunk_seconds: int = CHUNK_SECONDS,
    overlap_seconds: int = OVERLAP_SECONDS,
):
    """Split stereo audio into (vocals, accompaniment), both mono float arrays.

    Raises `SeparatorUnavailable` rather than returning something approximate.
    A caller that cannot separate must report that, not measure the mix and hope.
    """
    import numpy as np

    directory = Path(model_dir) if model_dir is not None else MODEL_DIR
    state = availability(directory)
    if not state.ready:
        raise SeparatorUnavailable(state.reason)

    samples = np.asarray(samples, dtype="float32")
    if samples.ndim == 1:
        samples = np.stack([samples, samples], axis=1)
    if samples.ndim != 2 or samples.shape[1] != 2:
        raise SeparatorUnavailable(
            f"The separator takes stereo audio shaped (samples, 2); got {samples.shape}.")
    if samples.shape[0] < sample_rate // 10:
        raise SeparatorUnavailable(
            "Less than a tenth of a second of audio; there is nothing to separate.")

    if sample_rate != MODEL_SAMPLE_RATE:
        import librosa
        left = librosa.resample(samples[:, 0], orig_sr=sample_rate, target_sr=MODEL_SAMPLE_RATE)
        right = librosa.resample(samples[:, 1], orig_sr=sample_rate, target_sr=MODEL_SAMPLE_RATE)
        samples = np.stack([left, right], axis=1).astype("float32")

    os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "3")
    import tensorflow as tf

    tf.compat.v1.disable_eager_execution()
    graph = tf.Graph()
    chunk = int(chunk_seconds * MODEL_SAMPLE_RATE)
    overlap = int(overlap_seconds * MODEL_SAMPLE_RATE)
    vocals: list = []
    accompaniment: list = []

    with graph.as_default():
        saver = tf.compat.v1.train.import_meta_graph(
            str(directory / "model.meta"), clear_devices=True)
        with tf.compat.v1.Session(graph=graph) as session:
            saver.restore(session, str(directory / "model"))
            waveform = graph.get_tensor_by_name(INPUT_TENSOR)
            voice_out = graph.get_tensor_by_name(VOCALS_TENSOR)
            rest_out = graph.get_tensor_by_name(ACCOMPANIMENT_TENSOR)

            position = 0
            while position < len(samples):
                end = min(len(samples), position + chunk)
                start = max(0, position - overlap)
                segment = samples[start:end]
                lead = position - start
                voice, rest = session.run(
                    [voice_out, rest_out], feed_dict={waveform: segment})
                vocals.append(voice[lead:])
                accompaniment.append(rest[lead:])
                position = end

    voice = np.concatenate(vocals).mean(axis=1)
    rest = np.concatenate(accompaniment).mean(axis=1)
    return voice, rest, MODEL_SAMPLE_RATE


def separation_quality(vocals, accompaniment, sample_rate: int, quiet_seconds: float = 3.0):
    """A sanity check on the split, before any measurement is trusted to it.

    A separator that silently does nothing hands back a "vocal stem" that is
    really the mix, and every figure measured on it is a figure about the band.
    So the split has to demonstrate it worked before anything is believed.

    The test is the stem's own quiet moments. A real vocal stem is near-silent
    wherever nobody is singing — between phrases, under an instrumental break,
    at a breath — while the band plays on through all of it. A failed split has
    no such moments: it inherits the mix's envelope, which is loud throughout.
    So: what share of the track sits more than 30 dB below this stem's own loud
    level? A working split spends a quarter of the song down there; a failed one
    a few per cent.

    This deliberately replaces an earlier check that compared the opening
    seconds against mid-song. That one assumed every song has an instrumental
    intro, so it rejected a perfectly good split on any song that sings from the
    first bar, and it could be fooled the other way by a song that opens on
    silence, where even a failed split looks quiet at the start. The opening
    ratio is still computed and reported, because it is a useful second opinion
    when there is an intro, but it no longer decides anything.

    Returns `(quiet_share_percent, ok, why)`. A caller that ignores the verdict
    is measuring noise.
    """
    import numpy as np

    duration = len(vocals) / sample_rate
    if duration < max(quiet_seconds * 4, 8.0):
        return 0.0, False, "Too short to judge whether the split worked."

    window = max(1, int(0.25 * sample_rate))
    usable = len(vocals) // window * window
    if usable < window * 8:
        return 0.0, False, "Too short to judge whether the split worked."
    levels = np.sqrt((np.asarray(vocals[:usable], dtype="float64")
                      .reshape(-1, window) ** 2).mean(axis=1))

    loud = float(np.percentile(levels, 90))
    if loud < 1e-4:
        return 0.0, False, (
            "The vocal stem is silent throughout; the separator returned nothing to "
            "measure and the analysis should report ANALYSIS_UNAVAILABLE.")

    quiet = levels < loud * QUIET_FLOOR_RATIO
    quiet_share = float(100.0 * quiet.mean())
    # Spread, not just quantity. A song that opens on four seconds of digital
    # silence banks enough "quiet" to clear the threshold even when the split
    # failed and the rest of the stem is the whole mix. A voice stops between
    # phrases all the way through, so both halves have to show it.
    half = len(quiet) // 2
    halves = (float(100.0 * quiet[:half].mean()), float(100.0 * quiet[half:].mean()))

    def level(signal, start: float, stop: float) -> float:
        segment = signal[int(start * sample_rate):int(stop * sample_rate)]
        return float(np.sqrt((np.asarray(segment, dtype="float64") ** 2).mean())) if len(segment) else 0.0

    opening = level(vocals, 0.0, quiet_seconds)
    middle = level(vocals, duration * 0.45, duration * 0.55)
    opening_ratio = middle / (opening + 1e-9)

    ok = min(halves) >= MIN_QUIET_SHARE_PERCENT
    if ok:
        return quiet_share, True, (
            f"Vocal stem is {quiet_share:.0f}% silent by its own standard "
            f"({QUIET_FLOOR_DB:.0f} dB below its loud level), spread across both halves "
            f"({halves[0]:.0f}% and {halves[1]:.0f}%), which a mix never is. "
            f"Opening-to-mid-song ratio {opening_ratio:.0f}x.")
    return quiet_share, False, (
        f"Vocal stem is {quiet_share:.1f}% silent by its own standard "
        f"({QUIET_FLOOR_DB:.0f} dB below its loud level), and only "
        f"{min(halves):.1f}% of one half of the track, against at least "
        f"{MIN_QUIET_SHARE_PERCENT:.0f}% expected in each; it carries the mix's own "
        f"envelope rather than a voice that stops between phrases. Opening-to-mid-song "
        f"ratio {opening_ratio:.1f}x. The split cannot be trusted and the analysis "
        "should report ANALYSIS_UNAVAILABLE.")
