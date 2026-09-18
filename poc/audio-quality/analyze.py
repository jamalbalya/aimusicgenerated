#!/usr/bin/env python3
"""Measure a generated song, and say which measurements can be trusted.

Written for one question: when a song sounds unharmonious, which part of it is
actually wrong? Guessing from a listen does not survive an argument, and neither
does a single number. So every measurement here is either something the file
plainly states (duration, peak, clipping) or something estimated with a stated
method, and the estimates that can mislead say so in their own output rather
than in a footnote nobody reads.

Two of these deserve their scepticism up front.

Key and chord estimates are template matches over a dense mix. They confuse a
key with its relative minor, and they read a loud sustained bass note as a chord
root. Treat them as "the harmonic material sits around here", never as a
transcription.

The vocal measurements depend on separating a voice from a band, and this does
it with REPET-SIM, which assumes the accompaniment repeats and the voice does
not. It leaks, both ways. A proper separator (Demucs) would be better and is
used when it is installed; --require-demucs refuses to report vocal numbers
without it, which is the right setting when the answer matters.

The melody-versus-harmony figure is the one worth explaining. Asking "is the
sung note in the chord" gives a number with nothing to compare it against — 38%
means nothing on its own. So the same melody is also scored against the
accompaniment at the wrong moments, forty times, which is what a melody with no
relationship to the harmony would score. The distance between the two is the
finding; the raw percentage is not.

Usage:
    python analyze.py song.wav [more.wav ...] [--json out.json] [--require-demucs]

Several files are compared take by take, which is how a setting is shown to make
a difference: one sample cannot separate the setting from the seed.
"""

from __future__ import annotations

import argparse
import json
import math
import sys
import warnings
from dataclasses import dataclass, field, asdict
from pathlib import Path

warnings.filterwarnings("ignore")

sys.path.insert(0, str(Path(__file__).parent))
import harmony  # noqa: E402
import intonation  # noqa: E402
import separate_vocals  # noqa: E402

PITCH_CLASSES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]

#: Window for the intonation pass. Long, because a cent of precision on a held
#: note needs it; the cost is that vibrato faster than ~1.3 Hz is averaged away,
#: which `intonation` reports rather than hides.
INTONATION_WINDOW = 16384

#: Krumhansl-Schmuckler key profiles.
MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88]
MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17]

#: Analysis sample rate. Everything below assumes it.
SR = 22050
HOP = 256

#: How many wrong-moment alignments the melody is scored against.
NULL_SHIFTS = 40

#: A sample at or above this counts as clipped.
CLIP_THRESHOLD = 0.999


@dataclass
class Measurement:
    """A number, and how much weight it will bear."""

    value: object
    confidence: str  # "measured" | "estimated" | "unavailable"
    method: str
    caveat: str = ""


@dataclass
class Report:
    path: str
    #: Set by the harmonic pass so the verdict can require both conditions.
    harmony_result: object = None
    measurements: dict = field(default_factory=dict)
    notes: list = field(default_factory=list)

    def add(self, name: str, value: object, confidence: str, method: str, caveat: str = "") -> None:
        self.measurements[name] = asdict(Measurement(value, confidence, method, caveat))


def load(path: Path):
    import librosa
    import soundfile as sf

    info = sf.info(str(path))
    stereo, native_sr = sf.read(str(path), always_2d=True, dtype="float32")
    mono = librosa.resample(stereo.mean(axis=1), orig_sr=native_sr, target_sr=SR)
    return stereo, native_sr, mono, info


def loudness_and_clipping(report: Report, stereo, native_sr: int) -> None:
    import numpy as np

    peak = float(np.abs(stereo).max())
    rms = float(np.sqrt((stereo ** 2).mean()))
    clipped = int((np.abs(stereo) >= CLIP_THRESHOLD).sum())
    report.add("peak_dbfs", round(20 * math.log10(peak + 1e-12), 2), "measured",
               "maximum absolute sample")
    report.add("rms_dbfs", round(20 * math.log10(rms + 1e-12), 2), "measured",
               "root mean square over the whole file")
    report.add("crest_factor_db", round(20 * math.log10(peak / (rms + 1e-12)), 2), "measured",
               "peak minus RMS; a small value means heavy limiting")
    report.add("clipped_samples", clipped, "measured",
               f"samples at or above {CLIP_THRESHOLD} full scale",
               "A lossy file can exceed full scale on decode without having been clipped when made.")

    if stereo.shape[1] == 2:
        mid = (stereo[:, 0] + stereo[:, 1]) / 2
        side = (stereo[:, 0] - stereo[:, 1]) / 2
        report.add("stereo_correlation", round(float(np.corrcoef(stereo[:, 0], stereo[:, 1])[0, 1]), 4),
                   "measured", "Pearson correlation of the two channels",
                   "1.0 is mono; near 0 or negative risks collapsing in mono playback.")
        report.add("side_to_mid_ratio",
                   round(float(np.sqrt((side ** 2).mean()) / (np.sqrt((mid ** 2).mean()) + 1e-12)), 4),
                   "measured", "RMS of the difference channel over the sum channel")


def frequency_balance(report: Report, mono) -> None:
    import numpy as np

    bands = {
        "sub_20_80": (20, 80), "bass_80_250": (80, 250), "low_mid_250_800": (250, 800),
        "mid_800_2k": (800, 2000), "presence_2k_5k": (2000, 5000), "high_5k_11k": (5000, 11000),
    }
    spectrum = np.abs(np.fft.rfft(mono * np.hanning(len(mono))))
    freqs = np.fft.rfftfreq(len(mono), 1 / SR)
    total = spectrum.sum() + 1e-12
    share = {name: round(float(spectrum[(freqs >= lo) & (freqs < hi)].sum() / total * 100), 2)
             for name, (lo, hi) in bands.items()}
    report.add("band_energy_percent", share, "measured",
               "share of total spectral magnitude per band",
               "Balance is genre-dependent. This is for comparing takes, not for judging one.")


def tempo(report: Report, mono) -> None:
    import librosa
    import numpy as np

    global_bpm = float(np.atleast_1d(librosa.beat.beat_track(y=mono, sr=SR)[0])[0])
    window = 30 * SR
    per_window = [
        round(float(librosa.feature.tempo(y=mono[i:i + window], sr=SR)[0]), 1)
        for i in range(0, max(len(mono) - window // 2, 1), window)
        if len(mono[i:i + window]) > SR * 5
    ]
    spread = (max(per_window) - min(per_window)) if per_window else 0.0
    report.add("tempo_bpm", round(global_bpm, 2), "estimated",
               "librosa beat tracking over the whole file",
               "Octave errors are common: half or double the true tempo is a normal failure.")
    report.add("tempo_per_30s", per_window, "estimated", "beat tracking per 30-second window")
    report.add("tempo_spread_bpm", round(float(spread), 1), "estimated",
               "widest minus narrowest windowed tempo",
               "A large spread may be a drifting tempo or may be octave errors between windows.")


def _key_of(chroma):
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
                best = (score, PITCH_CLASSES[root], name)
    return best


def harmony_of_mix(report: Report, mono):
    import librosa
    import numpy as np

    harmonic = librosa.effects.harmonic(mono, margin=3.0)
    chroma = librosa.feature.chroma_cqt(y=harmonic, sr=SR, bins_per_octave=36)
    score, root, mode = _key_of(chroma)
    report.add("key_estimate", f"{root} {mode}", "estimated",
               "Krumhansl-Schmuckler profile correlation on CQT chroma",
               "Relative major and minor share a pitch-class profile and are routinely swapped. "
               "Read this as a tonal centre, not as the key.")
    report.add("key_correlation", round(float(score), 3), "estimated",
               "correlation with the best-matching profile",
               "Below about 0.5 the reading is weak and the piece may have no stable centre.")

    _, beats = librosa.beat.beat_track(y=mono, sr=SR, trim=False)
    synced = librosa.util.sync(chroma, beats, aggregate=np.median)
    templates, names = [], []
    for root_index in range(12):
        for third, suffix in ((4, ""), (3, "m")):
            template = np.zeros(12)
            template[root_index] = template[(root_index + third) % 12] = template[(root_index + 7) % 12] = 1
            templates.append(template)
            names.append(PITCH_CLASSES[root_index] + suffix)
    matrix = np.array(templates)
    matrix = matrix / np.linalg.norm(matrix, axis=1, keepdims=True)
    normalised = synced / (np.linalg.norm(synced, axis=0, keepdims=True) + 1e-9)
    chords = [names[i] for i in (matrix @ normalised).argmax(axis=0)]
    minor_share = sum(1 for c in chords if c.endswith("m")) / max(len(chords), 1)
    top = sorted({c: chords.count(c) for c in set(chords)}.items(), key=lambda kv: -kv[1])[:6]
    report.add("chord_histogram_top6", [[c, n] for c, n in top], "estimated",
               "major/minor triad template match on beat-synchronous chroma",
               "A sustained bass note is often read as a chord root. Sevenths and suspensions "
               "are not modelled at all.")
    report.add("minor_triad_share", round(float(minor_share), 3), "estimated",
               "fraction of beats whose best match is a minor triad",
               "Useful for 'was this dark or bright', not for naming the harmony.")
    return chroma


def isolate(stereo, sample_rate: int):
    """The real split, when this machine can do it. (vocals, accompaniment, note).

    Returns `(None, None, why)` when it cannot, and the caller reports
    ANALYSIS_UNAVAILABLE rather than measuring the mix and calling it a verdict.
    """
    state = separate_vocals.availability()
    if not state.ready:
        return None, None, state.reason
    try:
        voice, rest, rate = separate_vocals.separate(stereo, sample_rate)
    except separate_vocals.SeparatorUnavailable as error:
        return None, None, str(error)
    ratio, good, why = separate_vocals.separation_quality(voice, rest, rate)
    if not good:
        return None, None, why
    import librosa
    if rate != SR:
        voice = librosa.resample(voice, orig_sr=rate, target_sr=SR)
        rest = librosa.resample(rest, orig_sr=rate, target_sr=SR)
    return voice, rest, why


def separate(mono, require_demucs: bool):
    """Voice and accompaniment. Returns (voice, accompaniment, method, trustworthy)."""
    import librosa
    import numpy as np

    try:
        import torch  # noqa: F401
        from demucs.apply import apply_model
        from demucs.pretrained import get_model

        model = get_model("htdemucs")
        # Demucs wants stereo at its own rate; give it the mono we analyse.
        wav = torch.tensor(np.stack([mono, mono]))[None]
        stems = apply_model(model, wav, progress=False)[0]
        vocals = stems[model.sources.index("vocals")].mean(axis=0).numpy()
        rest = sum(stems[i] for i, s in enumerate(model.sources) if s != "vocals").mean(axis=0).numpy()
        return vocals, rest, "demucs htdemucs", True
    except Exception as error:  # noqa: BLE001 - any failure means fall back or stop
        if require_demucs:
            raise SystemExit(
                f"--require-demucs was given and Demucs is unavailable: {error}\n"
                "Install it with `pip install demucs` on a machine that can reach its weights."
            ) from error

    spectrum, phase = librosa.magphase(librosa.stft(mono, n_fft=2048, hop_length=HOP))
    filtered = np.minimum(spectrum, librosa.decompose.nn_filter(
        spectrum, aggregate=np.median, metric="cosine",
        width=int(librosa.time_to_frames(2, sr=SR, hop_length=HOP))))
    voice_mask = librosa.util.softmask(spectrum - filtered, 10 * filtered, power=2)
    music_mask = librosa.util.softmask(filtered, 10 * (spectrum - filtered), power=2)
    voice = librosa.istft(spectrum * voice_mask * phase, hop_length=HOP, length=len(mono))
    music = librosa.istft(spectrum * music_mask * phase, hop_length=HOP, length=len(mono))
    return voice, music, "librosa REPET-SIM softmask", False


def vocals(report: Report, mono, require_demucs: bool, stereo=None, native_sr: int = 0) -> None:
    import librosa
    import numpy as np

    # A trained separator if this machine has one; the classical fallback only
    # for the figures that never claimed to be about the voice alone.
    isolated_voice = isolated_rest = None
    isolation_note = "Not attempted."
    if stereo is not None and native_sr:
        isolated_voice, isolated_rest, isolation_note = isolate(stereo, native_sr)
    report.add("vocal_isolation", isolated_voice is not None, "measured",
               "whether a trained separator produced the vocal stem", isolation_note)

    if isolated_voice is not None:
        voice, music, method, trustworthy = isolated_voice, isolated_rest, "spleeter 2stems", True
    else:
        voice, music, method, trustworthy = separate(mono, require_demucs)
    confidence = "estimated" if trustworthy else "estimated"
    leak_caveat = "" if trustworthy else (
        "REPET-SIM is not a source separator. Piano and sustained bass leak into the voice and "
        "quiet singing leaks into the accompaniment, so every vocal number here can be wrong in "
        "either direction. Install Demucs for figures worth arguing about."
    )

    report.add("separation_method", method, "measured", "which separator produced the vocal track")
    report.add("voice_to_music_db",
               round(float(20 * math.log10(
                   (np.sqrt((voice ** 2).mean()) + 1e-12) / (np.sqrt((music ** 2).mean()) + 1e-12))), 2),
               confidence, "RMS of the vocal track over the accompaniment",
               (leak_caveat + " A lead vocal usually sits at or above the band; well below it "
                "suggests the voice is buried.").strip())

    f0, voiced_flag, voiced_prob = librosa.pyin(
        voice, fmin=95, fmax=520, sr=SR, frame_length=2048, hop_length=HOP, fill_na=np.nan)
    times = librosa.times_like(f0, sr=SR, hop_length=HOP)
    formant = np.abs(librosa.stft(voice, n_fft=2048, hop_length=HOP))
    freqs = librosa.fft_frequencies(sr=SR, n_fft=2048)
    formant_energy = formant[(freqs >= 1500) & (freqs < 4000)].sum(axis=0)[:len(f0)]
    sung = voiced_flag & np.isfinite(f0) & (voiced_prob > 0.5) & (formant_energy > np.percentile(formant_energy, 55))

    if sung.sum() < 50:
        report.add("vocal_pitch", None, "unavailable",
                   "pyin on the separated vocal", "Too few voiced frames to report a range.")
        return

    midi = librosa.hz_to_midi(f0[sung])
    report.add("vocal_pitch_median_note", librosa.midi_to_note(int(round(float(np.median(midi))))),
               confidence, "median of pyin f0 over sung frames",
               (leak_caveat + " pyin also makes octave errors, locking onto the second harmonic; "
                "check the partial series before concluding a voice sits too high.").strip())
    report.add("vocal_pitch_range_notes",
               [librosa.midi_to_note(int(np.floor(np.percentile(midi, 2)))),
                librosa.midi_to_note(int(np.ceil(np.percentile(midi, 98))))],
               confidence, "2nd to 98th percentile of tracked f0")
    report.add("sung_share_percent", round(float(100 * sung.mean()), 1), confidence,
               "fraction of frames judged to be singing")

    first = next((times[i] for i in range(len(sung)) if sung[i:i + 8].all()), None)
    report.add("first_vocal_entry_s", round(float(first), 2) if first is not None else None,
               confidence, "start of the first sustained sung run")

    _melody_versus_harmony(report, music, f0, sung, confidence, leak_caveat)
    _timing(report, mono, voice, report_confidence=confidence)
    # Before the intonation pass, which needs the harmonic result to decide a
    # verdict: both conditions have to hold, and in tune is only one of them.
    _harmonic_compatibility(report, times, f0, sung, music, trustworthy)
    _intonation(report, voice if trustworthy else mono, f0, sung,
                "" if trustworthy else leak_caveat, isolated=trustworthy)
    _vibrato_pass(report, voice, "" if trustworthy else leak_caveat, isolated=trustworthy)


def _harmonic_compatibility(report: Report, times, f0, sung, music, isolated: bool) -> None:
    """Does the melody fit the chords — a separate question from being in tune.

    These two are routinely confused, and the confusion is expensive: a take can
    be in tune to a cent and still be singing over the wrong bars. Intonation
    asks whether a note landed on the twelve-tone grid; this asks whether the
    note it landed on was the one the accompaniment is playing under. A melody
    can pass the first and fail the second, and no amount of pitch correction
    repairs that, because pitch correction moves notes to the nearest grid
    position and they are already there.

    The score is only meaningful on separated stems. On a mix the accompaniment
    is inside the "vocal" too, so the melody correlates with itself and the
    figure looks excellent whatever was sung. `HarmonyReport.isolated` carries
    that distinction into the verdict, which refuses to pass on a mix.
    """
    result = harmony.compatibility(
        times, f0, sung, music, SR, HOP, isolated=isolated)
    report.harmony_result = result

    confidence = "estimated" if result.sufficient else "unavailable"
    report.add("harmony_frames", result.frames, "measured",
               "sung frames scored against the accompaniment")
    report.add("harmony_seconds", round(result.analysed_seconds, 1), "measured",
               "how much singing that covers")
    report.add("harmony_isolated", result.isolated, "measured",
               "whether both sides came from a trained separator",
               "" if result.isolated else
               "Not isolated. The accompaniment leaks into the vocal track and correlates with "
               "itself, which inflates this score badly. No verdict can rest on it.")

    if not result.sufficient:
        report.add("harmonic_compatibility", None, "unavailable",
                   "melody against the accompaniment's chroma, versus a null",
                   " ".join(result.limitations))
        return

    report.add("harmony_key", result.key, "estimated",
               "key of the accompaniment, by profile correlation",
               "Confuses a key with its relative minor. Context, not transcription.")
    report.add("harmony_in_key_percent", round(result.in_key_percent, 1), "estimated",
               "per cent of sung frames whose pitch class is in that key",
               "High is necessary and nowhere near sufficient: the right scale played over "
               "the wrong chord is still the wrong note.")
    report.add("harmony_mean_support", round(result.mean_support, 3), "estimated",
               "how present the sung pitch class is in the accompaniment's chroma")
    report.add("harmony_mean_support_null", round(result.null_mean_support, 3), "estimated",
               f"the same melody scored at {harmony.NULL_SHIFTS} wrong moments")
    report.add("harmony_top3_percent", round(result.top3_percent, 1), "estimated",
               "sung pitch class among the accompaniment's three strongest, per cent")
    report.add("harmony_top3_percent_null", round(result.null_top3_percent, 1), "estimated",
               "the same figure at the wrong moments")
    report.add("harmony_weakest4_percent", round(result.weakest4_percent, 1), "estimated",
               "per cent of sung frames whose pitch class is among the four weakest")
    report.add("harmony_z", round(result.z, 2), "estimated",
               "null standard deviations the real alignment beats chance by",
               f"This is the figure to read. Below {harmony.Z_UNRELATED} the melody is "
               "statistically indistinguishable from the same line sung over the wrong bars.")
    report.add("harmonic_compatibility", result.compatible, confidence,
               "whether the melody demonstrably follows the accompaniment")
    report.add("harmony_clashes", [list(span) for span in result.clashes[:12]], "estimated",
               "stretches where the sung pitch class sat among the accompaniment's weakest",
               "Longest first. These are where a listener hears the song go wrong.")
    report.add("harmony_limitations", result.limitations, "measured",
               "what this pass cannot support")


def _melody_versus_harmony(report, music, f0, sung, confidence, leak_caveat) -> None:
    import librosa
    import numpy as np

    chroma = librosa.feature.chroma_cqt(y=librosa.effects.harmonic(music, margin=3.0), sr=SR, hop_length=HOP)
    frames = min(chroma.shape[1], len(f0))
    chroma, f0, sung = chroma[:, :frames], f0[:frames], sung[:frames]
    normalised = chroma / (chroma.max(axis=0, keepdims=True) + 1e-9)
    pitch_class = np.mod(np.round(librosa.hz_to_midi(f0)), 12)
    usable = sung & np.isfinite(pitch_class)
    indices = np.where(usable)[0]
    if len(indices) < 50:
        return
    classes = pitch_class[usable].astype(int)

    def agreement(shift: int):
        at = (indices + shift) % frames
        support = normalised[classes, at]
        rank = (normalised[:, at] > support).sum(axis=0)
        return float(support.mean()), float((rank < 3).mean())

    real_support, real_top3 = agreement(0)
    rng = np.random.default_rng(0)
    nulls = np.array([agreement(int(rng.integers(frames // 8, frames - frames // 8)))
                      for _ in range(NULL_SHIFTS)])
    sigma = nulls[:, 0].std()

    report.add("melody_harmony_support", round(real_support, 3), confidence,
               "how present the sung pitch class is in the accompaniment's chroma, averaged")
    report.add("melody_harmony_support_null", round(float(nulls[:, 0].mean()), 3), confidence,
               f"the same melody scored against the accompaniment at {NULL_SHIFTS} wrong moments")
    report.add("melody_harmony_z", round(float((real_support - nulls[:, 0].mean()) / (sigma + 1e-9)), 2),
               confidence,
               "how many null standard deviations the real alignment beats chance by",
               (leak_caveat + " This is the number to read. Near zero means the melody is no more "
                "in the harmony than if it were played over the wrong bars; clearly positive means "
                "it follows the chords, however loosely.").strip())
    report.add("melody_in_chord_top3_percent", round(100 * real_top3, 1), confidence,
               "sung pitch class among the accompaniment's three strongest, per cent",
               "Meaningless without the null figure beside it.")


def _timing(report, mono, voice, report_confidence: str) -> None:
    import librosa
    import numpy as np

    _, beats = librosa.beat.beat_track(y=mono, sr=SR, trim=False)
    beat_times = librosa.frames_to_time(beats, sr=SR)
    if len(beat_times) < 8:
        return
    onsets = librosa.onset.onset_detect(
        onset_envelope=librosa.onset.onset_strength(y=voice, sr=SR, hop_length=HOP),
        sr=SR, hop_length=HOP, units="time", backtrack=False)
    if len(onsets) < 20:
        return
    deviation = np.abs(onsets[:, None] - beat_times[None, :]).min(axis=1)
    # What randomly placed onsets would score, so a dense grid cannot flatter the result.
    rng = np.random.default_rng(1)
    null = np.mean([
        np.abs(rng.uniform(beat_times[0], beat_times[-1], len(onsets))[:, None]
               - beat_times[None, :]).min(axis=1).mean()
        for _ in range(100)
    ])
    report.add("vocal_onset_to_beat_ms", round(float(1000 * np.median(deviation)), 1), report_confidence,
               "median distance from a vocal onset to the nearest beat")
    report.add("vocal_onset_to_beat_null_ms", round(float(1000 * null), 1), report_confidence,
               "what randomly placed onsets would score against the same grid",
               "If the real figure is not clearly below this, the test has no power here and says "
               "nothing about whether the phrasing sits with the beat.")


def _refine_f0(signal, centre_sample: int, guess_hz: float, sample_rate: int):
    """Sub-bin frequency of the strongest harmonic near a guess.

    `pyin` quantises to a tenth of a semitone by default — ten cents, which is
    coarser than the thing being measured, and produces a median that lands on
    the same lattice point in every region of a song. That artefact is what this
    exists to avoid: a long window and a quadratic fit around the peak give
    roughly a cent, and the harmonic is divided back down to the fundamental.
    """
    import numpy as np

    n = INTONATION_WINDOW
    start = centre_sample - n // 2
    if start < 0 or start + n > len(signal):
        return float("nan")
    spectrum = np.abs(np.fft.rfft(signal[start:start + n] * np.hanning(n)))
    best_magnitude, best_f0 = 0.0, float("nan")
    for harmonic in (1, 2, 3):
        target = guess_hz * harmonic
        if target >= sample_rate / 2 - 50:
            break
        bin_index = int(round(target / (sample_rate / n)))
        low, high = max(1, bin_index - 4), min(len(spectrum) - 2, bin_index + 5)
        peak = low + int(np.argmax(spectrum[low:high]))
        if peak < 1 or peak >= len(spectrum) - 1:
            continue
        a, b, c = (math.log(spectrum[peak - 1] + 1e-12), math.log(spectrum[peak] + 1e-12),
                   math.log(spectrum[peak + 1] + 1e-12))
        delta = 0.5 * (a - c) / (a - 2 * b + c + 1e-12)
        if abs(delta) > 1:
            continue
        if spectrum[peak] > best_magnitude:
            best_magnitude = float(spectrum[peak])
            best_f0 = (peak + delta) * sample_rate / n / harmonic
    return best_f0


def _intonation(report: Report, mono, f0, sung, leak_caveat: str,
                isolated: bool = False) -> None:
    """Is it in tune, is it the right note, and how much of the song was heard."""
    import librosa
    import numpy as np

    times = librosa.times_like(f0, sr=SR, hop_length=HOP)
    refined = np.full(len(f0), np.nan)
    for i in np.where(sung)[0]:
        refined[i] = _refine_f0(mono, int(times[i] * SR), float(f0[i]), SR)
    # A refinement that disagrees with the tracker by more than a semitone has
    # locked onto something else; drop it rather than average it in.
    usable = sung & np.isfinite(refined) & (np.abs(1200 * np.log2(refined / f0)) < 120)

    result = intonation.measure(
        times, refined, usable, len(mono) / SR,
        isolated_vocal=isolated,
        analysis_window_seconds=INTONATION_WINDOW / SR,
        contamination_note=leak_caveat or (
            "Measured on a mix. A pitch tracker follows the loudest harmonic source, and "
            "piano, upright bass and saxophone share a male singer's register."),
    )

    report.add("intonation_frames", result.frames, "measured", "frames the intonation pass used")
    report.add("intonation_seconds", round(result.analysed_seconds, 1), "measured",
               "how much audio those frames cover")
    report.add("intonation_coverage_percent", round(result.coverage_percent, 1), "measured",
               "that duration as a share of the whole track",
               "A figure drawn from a small share of a song is not a statement about the song.")
    report.add("intonation_confidence", result.confidence, "measured",
               "how much weight these numbers will bear")

    if not result.sufficient:
        report.add("intonation", None, "unavailable", "intonation pass",
                   " ".join(result.limitations))
        return

    report.add("grid_median_cents", round(result.grid_median_cents, 1), "estimated",
               "median distance to the nearest twelve-tone semitone",
               "Bounded to +/-50 by construction. It says whether notes landed on the grid, "
               "never whether they were the right notes. A wrong note sung perfectly scores 0.")
    report.add("grid_bias_cents", round(result.grid_bias_cents, 1), "estimated",
               "mean signed deviation; a bias means the whole take sits flat or sharp")
    report.add("grid_worse_than", result.grid_worse_than, "estimated",
               "per cent of frames past 15, 25 and 35 cents")
    if result.notes:
        report.add("note_count", len(result.notes), "measured", "held notes found")
        report.add("note_centre_median_cents", round(result.note_centre_median_cents, 1),
                   "estimated", "how far each held note's own centre sits from the grid")
        report.add("note_drift_median_cents", round(result.note_drift_median_cents, 1),
                   "estimated", "median slide from the start of a note to its end",
                   "Fitted as a trend, so an even wobble is not counted as a slide.")
        report.add("note_spread_median_cents", round(result.note_spread_median_cents, 1),
                   "estimated", "median spread within a held note: vibrato and wobble together")
        report.add("notes_drifting_over_50c", round(result.notes_drifting_over_50c, 1),
                   "estimated", "per cent of held notes that slide more than half a semitone")
    # The whole range, reported separately. A median over a take can sit inside
    # tolerance while one register alone is twice as far out, and that register
    # is the one a listener notices.
    registers = intonation.by_register(result.notes)
    report.add("registers", [
        {
            "register": r.name, "notes": r.notes, "seconds": round(r.seconds, 1),
            "median_centre_cents": None if r.median_centre_error_cents is None
            else round(r.median_centre_error_cents, 1),
            "worst_centre_cents": None if r.worst_centre_error_cents is None
            else round(r.worst_centre_error_cents, 1),
            "median_drift_cents": None if r.median_drift_cents is None
            else round(r.median_drift_cents, 1),
        }
        for r in registers
    ], "estimated", "held notes split into low, mid and high",
        "Bands for a male voice. They say where a note sat, not which vocal "
        "mechanism produced it.")

    leaps = intonation.transitions(result.notes)
    report.add("large_intervals", [
        {"at_s": round(t.at_s, 1), "semitones": round(t.semitones, 1),
         "gap_s": round(t.gap_s, 2)}
        for t in leaps[:12]
    ], "estimated", f"jumps of {intonation.LARGE_INTERVAL_SEMITONES} semitones or more between held notes",
        "Listed, not judged. A wide leap can be the line or can be the tracker "
        "catching a harmonic; the numbers alone cannot tell them apart.")

    status, reasons = intonation.verdict(result, registers, report.harmony_result)
    report.add("verdict", status, "measured", "generate-analyse-regenerate status",
               " ".join(reasons))

    report.add("intonation_limitations", result.limitations, "measured",
               "what these figures cannot support")
    report.add("intonation_contaminated", result.contaminated, "measured",
               "whether the measured signal is an isolated vocal",
               result.contamination_note)


def _vibrato_pass(report: Report, voice, leak_caveat: str, isolated: bool = False) -> None:
    """A second, much shorter window, for the wobble the first one averages away.

    Its own `pyin` run rather than a reuse of the main one: the window length is
    the whole point, and 46 ms is chosen so a 6 Hz vibrato survives tracking
    instead of being smoothed into a straight line. The pitch it reports is far
    coarser than the main pass's, which is why nothing but modulation is taken
    from it.
    """
    import librosa
    import numpy as np

    window = max(256, int(round(intonation.VIBRATO_WINDOW_SECONDS * SR)))
    hop = max(64, int(round(intonation.VIBRATO_HOP_SECONDS * SR)))
    # `pyin` needs two periods of the lowest pitch inside its window.
    lowest = max(95.0, 2.0 * SR / window)
    f0, flag, prob = librosa.pyin(voice, fmin=lowest, fmax=900, sr=SR,
                                  frame_length=window, hop_length=hop, fill_na=np.nan)
    times = librosa.times_like(f0, sr=SR, hop_length=hop)
    voiced = flag & np.isfinite(f0) & (prob > 0.5)

    result = intonation.measure_vibrato(
        times, f0, voiced, len(voice) / SR,
        window_seconds=window / SR, hop_seconds=hop / SR, isolated_vocal=isolated)

    report.add("vibrato_window_ms", round(1000 * window / SR, 1), "measured",
               "the vibrato pass's own analysis window")
    report.add("vibrato_hop_ms", round(1000 * hop / SR, 1), "measured", "and its hop")
    report.add("vibrato_windows", result.windows, "measured", "voiced frames it examined")
    report.add("vibrato_coverage_percent", round(result.coverage_percent, 1), "measured",
               "share of the track those frames cover")
    report.add("vibrato_notes_examined", result.notes_examined, "measured",
               f"notes held at least {intonation.MIN_VIBRATO_SECONDS:.2f} s")
    report.add("vibrato_notes_with_vibrato", result.notes_with_vibrato, "measured",
               "of those, how many carried periodic modulation")
    report.add("vibrato_confidence", result.confidence, "measured",
               "how much weight these numbers will bear")
    if result.median_rate_hz is not None:
        report.add("vibrato_rate_hz", round(result.median_rate_hz, 2), "estimated",
                   "median modulation rate across those notes")
        report.add("vibrato_extent_cents", round(result.median_extent_cents, 1), "estimated",
                   "median peak swing, corrected for what the window shrinks",
                   "A singer's vibrato is roughly 20-100 cents; wider reads as a wobble.")
        report.add("vibrato_frames_percent", round(result.frames_with_vibrato_percent, 1),
                   "estimated", "share of voiced frames inside a note carrying vibrato")
    else:
        report.add("vibrato", None, "unavailable", "vibrato pass",
                   " ".join(result.limitations))
    report.add("vibrato_limitations", result.limitations, "measured",
               "what this pass cannot support",
               (leak_caveat + " " + result.contamination_note).strip())


def section_map(report: Report, mono) -> None:
    import numpy as np

    window = 5 * SR
    energy = [float(np.sqrt((mono[i:i + window] ** 2).mean()))
              for i in range(0, len(mono) - window, window)]
    if not energy:
        return
    loudest = max(energy) + 1e-12
    report.add("energy_profile_5s", [round(e / loudest, 3) for e in energy], "measured",
               "RMS per 5-second window, relative to the loudest window",
               "Shows where the arrangement builds and drops. It cannot name a section.")
    peak_at = int(np.argmax(energy)) * 5
    report.add("loudest_point_s", peak_at, "measured", "start of the loudest 5-second window",
               "In a song that builds to a final chorus this should be late, not early.")


def analyse(path: Path, require_demucs: bool) -> Report:
    report = Report(path=str(path))
    stereo, native_sr, mono, info = load(path)
    report.add("duration_s", round(float(info.duration), 3), "measured", "container header")
    report.add("sample_rate", info.samplerate, "measured", "container header")
    report.add("channels", info.channels, "measured", "container header")
    loudness_and_clipping(report, stereo, native_sr)
    frequency_balance(report, mono)
    tempo(report, mono)
    harmony_of_mix(report, mono)
    section_map(report, mono)
    vocals(report, mono, require_demucs, stereo=stereo, native_sr=native_sr)
    return report


def render(report: Report) -> None:
    print(f"\n=== {report.path} ===")
    for name, entry in report.measurements.items():
        mark = {"measured": "  ", "estimated": "~ ", "unavailable": "! "}[entry["confidence"]]
        print(f"{mark}{name}: {entry['value']}")
        if entry["caveat"]:
            for line in entry["caveat"].split(". "):
                if line.strip():
                    print(f"      note: {line.strip().rstrip('.')}.")
    print("\n  '~' marks an estimate. Read its note before quoting it.")


def compare(reports: list[Report]) -> None:
    if len(reports) < 2:
        print("\nOne sample. A single take cannot separate a setting from the seed it was drawn "
              "with — generate at least three before concluding anything about a setting.")
        return
    print(f"\n=== {len(reports)} takes compared ===")
    keys = ["duration_s", "tempo_bpm", "key_estimate", "minor_triad_share", "peak_dbfs",
            "voice_to_music_db", "melody_harmony_z", "first_vocal_entry_s"]
    width = max(len(k) for k in keys)
    for key in keys:
        values = [r.measurements.get(key, {}).get("value") for r in reports]
        print(f"  {key.ljust(width)} : {values}")
    print("\n  Spread across takes with identical settings is the model's own variance. "
          "A setting has to move a number further than that to have done anything.")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("files", nargs="+", type=Path)
    parser.add_argument("--json", type=Path, help="write the full report here")
    parser.add_argument("--require-demucs", action="store_true",
                        help="refuse to report vocal numbers without a real source separator")
    args = parser.parse_args()

    reports = []
    for path in args.files:
        if not path.exists():
            print(f"no such file: {path}", file=sys.stderr)
            return 2
        report = analyse(path, args.require_demucs)
        render(report)
        reports.append(report)
    compare(reports)

    if args.json:
        args.json.write_text(json.dumps([asdict(r) for r in reports], indent=2))
        print(f"\nwritten: {args.json}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
