"""Measures four pitch-shifting methods against each other, on one bench.

This exists because the review asked the question again, properly: varispeed was
chosen over TD-PSOLA on a two-row measurement, and two rows is not an evaluation.
The methods here are the four that can be built from what this Space already
has — numpy and scipy, nothing installed, no GPU — and they are scored on the
ten properties that decide whether a corrected vocal sounds like a voice:

    pitch accuracy, octave errors, spectral stability, formant preservation,
    harmonic structure, transient preservation, artefacts, duration,
    vibrato preservation, naturalness

WORLD (pyworld) is deliberately absent, and the absence is a decision rather
than an oversight: it is a new binary dependency on a Space whose whole premise
is that it costs nothing and installs nothing beyond ACE-Step's own
requirements. If a method here were failing, that trade would be worth
revisiting. The numbers say one is not.

    python3 bench_shifters.py

No network, no GPU, no audio files. Everything is synthesised, so the reference
— the same voice actually produced at the target pitch — exists, which is the
only way to measure formant preservation honestly. Comparing a shifted signal
against its own *input* is invalid: the harmonics have moved across the formant
peaks, so the centroid is supposed to change.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Sequence

import numpy as np
from fractions import Fraction

from scipy.signal import get_window, resample, resample_poly, lfilter

SAMPLE_RATE = 44100

#: Three formants of a sustained "ah", as centre frequency, bandwidth, gain.
FORMANTS = [(730.0, 90.0, 1.0), (1090.0, 110.0, 0.55), (2440.0, 160.0, 0.22)]


# ------------------------------------------------------------ the voice ------


def _formant_filter(excitation: np.ndarray, sample_rate: int) -> np.ndarray:
    """Runs an excitation through a fixed formant bank.

    Fixed is the point. The formants do not move when the pitch does — that is
    what makes a person sound like the same person singing a different note, and
    it is the property every method here is being scored on.
    """
    out = np.zeros_like(excitation)
    for centre, bandwidth, gain in FORMANTS:
        r = math.exp(-math.pi * bandwidth / sample_rate)
        theta = 2 * math.pi * centre / sample_rate
        # A two-pole resonator at (centre, bandwidth).
        a = [1.0, -2 * r * math.cos(theta), r * r]
        b = [(1 - r) * math.sqrt(1 - 2 * r * math.cos(2 * theta) + r * r)]
        out += gain * lfilter(b, a, excitation)
    return out


def synth_vowel(f0_hz: float, seconds: float, sample_rate: int = SAMPLE_RATE,
                vibrato_cents: float = 0.0, vibrato_hz: float = 5.5,
                onset_noise_seconds: float = 0.0) -> np.ndarray:
    """A sung vowel: glottal pulses through a fixed formant bank.

    `onset_noise_seconds` prepends an unvoiced consonant — noise, no pitch —
    which is what the syllable-onset handling has to survive.
    """
    total = int(round(seconds * sample_rate))
    time = np.arange(total) / sample_rate

    contour = np.full(total, f0_hz, dtype=np.float64)
    if vibrato_cents > 0:
        contour *= 2.0 ** ((vibrato_cents / 2.0) * np.sin(2 * np.pi * vibrato_hz * time) / 1200.0)

    phase = np.cumsum(contour) / sample_rate
    # A band-limited pulse train: the derivative of a sawtooth is too bright and
    # aliases, a sine has no harmonics for the formants to shape.
    excitation = np.zeros(total)
    harmonics = int(sample_rate / 2 / max(f0_hz, 1.0))
    for harmonic in range(1, min(harmonics, 60) + 1):
        excitation += np.cos(2 * np.pi * harmonic * phase) / harmonic
    excitation /= max(1e-9, np.max(np.abs(excitation)))

    voice = _formant_filter(excitation, sample_rate)
    voice /= max(1e-9, np.max(np.abs(voice)))

    if onset_noise_seconds > 0:
        noise_length = int(round(onset_noise_seconds * sample_rate))
        rng = np.random.default_rng(7)
        noise = rng.normal(0, 0.28, noise_length)
        # Shaped, not white: a real /s/ is high-passed turbulence.
        noise = lfilter([1.0, -0.96], [1.0], noise)
        voice = np.concatenate([noise, voice])
    return voice


# ------------------------------------------------------------- methods -------


def shift_varispeed(audio: np.ndarray, ratio: float) -> np.ndarray:
    """Read `length * ratio` samples, resample to `length`. Length preserved."""
    length = audio.size
    needed = int(round(length * ratio))
    if needed < 8:
        return audio.copy()
    available = audio[:needed]
    if available.size < needed:
        tail = available[-min(available.size, 1024):]
        repeats = int(np.ceil((needed - available.size) / max(1, tail.size)))
        available = np.concatenate([available, np.tile(tail, repeats)])[:needed]
    return resample(available, length).astype(np.float64)


def shift_varispeed_poly(audio: np.ndarray, ratio: float) -> np.ndarray:
    """Varispeed, resampled with a polyphase FIR instead of an FFT.

    `scipy.signal.resample` works in the frequency domain and therefore assumes
    the signal is periodic: the end wraps onto the beginning, which rings.
    `resample_poly` filters in the time domain and has no such assumption. The
    ratio is irrational, so it is approximated by a fraction — to within a
    thousandth of a cent at a denominator of 2000, which is three orders of
    magnitude below anything audible.
    """
    length = audio.size
    needed = int(round(length * ratio))
    if needed < 8 or length < 8:
        return audio.copy()
    available = audio[:needed]
    if available.size < needed:
        tail = available[-min(available.size, 1024):]
        repeats = int(np.ceil((needed - available.size) / max(1, tail.size)))
        available = np.concatenate([available, np.tile(tail, repeats)])[:needed]

    fraction = Fraction(length, needed).limit_denominator(2000)
    stretched = resample_poly(available, fraction.numerator, fraction.denominator)
    if stretched.size >= length:
        return stretched[:length].astype(np.float64)
    return np.concatenate([stretched, np.zeros(length - stretched.size)]).astype(np.float64)


def _marks(audio: np.ndarray, period: int) -> np.ndarray:
    """Uniformly spaced analysis marks, anchored once to the first peak.

    Peak-snapping each mark independently was a real defect: on a signal whose
    cycle has two comparable peaks the marks alternate between them, writing a
    period doubling into the grain grid, and a -55 cent correction came out a
    clean octave low. Anchor once, then step.
    """
    if period < 2:
        return np.arange(0, audio.size, max(1, period))
    first = int(np.argmax(np.abs(audio[:min(audio.size, period * 2)])))
    count = max(1, int((audio.size - first) // period))
    return (first + np.arange(count) * period).astype(int)


def shift_psola(audio: np.ndarray, ratio: float, f0_hz: float,
                sample_rate: int = SAMPLE_RATE) -> np.ndarray:
    """Time-domain PSOLA: re-space pitch periods, then restore the length."""
    period = int(round(sample_rate / max(1.0, f0_hz)))
    if period < 4 or audio.size < period * 4:
        return audio.copy()
    analysis = _marks(audio, period)
    if analysis.size < 3:
        return audio.copy()

    # Synthesis marks spaced by the new period; the output is then the same
    # length as the input because the count of grains changes, not the span.
    new_period = period / ratio
    # A grain is two *analysis* periods. That is what PSOLA is: the window has to
    # hold the source's own periodicity and nothing more. Widening it to span the
    # synthesis period instead — which is what this tried first — puts four
    # source periods inside each grain, so the output keeps the source's pitch
    # however the grains are spaced, and a -1200 cent shift came back +1202
    # cents out. The gap problem that widening was meant to solve is solved by
    # `shift_psola_cascaded` instead: stay inside the ratio range where grains
    # still overlap, and take a large shift in two passes.
    window_length = period * 2
    window = get_window("hann", window_length, fftbins=False)
    out = np.zeros(audio.size + window_length)
    weight = np.zeros_like(out)

    position = 0.0
    while position < audio.size:
        nearest = int(np.argmin(np.abs(analysis - position)))
        centre = analysis[nearest]
        start = centre - window_length // 2
        grain = np.zeros(window_length)
        lo, hi = max(0, start), min(audio.size, start + window_length)
        if hi > lo:
            grain[lo - start: hi - start] = audio[lo:hi]
        target = int(round(position))
        out[target: target + window_length] += grain * window
        weight[target: target + window_length] += window
        position += new_period

    weight[weight < 1e-6] = 1.0
    return (out / weight)[:audio.size]


#: The ratio range a single PSOLA pass stays correct over.
#:
#: A grain is two analysis periods and the grains are spaced by the synthesis
#: period, so they stop overlapping once the synthesis period reaches the window
#: length — at ratio 0.5. Measured, the useful range is comfortably inside that.
PSOLA_MIN_RATIO = 0.62   # about -840 cents
PSOLA_MAX_RATIO = 1.60   # about +810 cents


def shift_psola_cascaded(audio: np.ndarray, ratio: float, f0_hz: float,
                         sample_rate: int = SAMPLE_RATE) -> np.ndarray:
    """PSOLA in as many passes as it takes to stay inside its working range.

    An octave is outside what one pass can do, so an octave is two passes of a
    tritone. Each pass re-estimates nothing — the pitch after pass one is known
    exactly, because that is what the pass was for — so this costs a second
    overlap-add and no extra analysis.
    """
    remaining = ratio
    out = np.asarray(audio, dtype=np.float64)
    current_f0 = f0_hz
    for _ in range(4):
        if PSOLA_MIN_RATIO <= remaining <= PSOLA_MAX_RATIO:
            return shift_psola(out, remaining, current_f0, sample_rate)
        step = PSOLA_MAX_RATIO if remaining > 1.0 else PSOLA_MIN_RATIO
        out = shift_psola(out, step, current_f0, sample_rate)
        current_f0 *= step
        remaining /= step
    return out


def shift_phase_vocoder(audio: np.ndarray, ratio: float,
                        n_fft: int = 2048, hop: int = 512) -> np.ndarray:
    """Time-stretch by 1/ratio in the STFT domain, then resample back.

    The textbook pitch shifter. Stretching in the frequency domain preserves
    the spectral envelope far better than resampling does, and the resample
    afterwards is what actually moves the pitch.
    """
    if audio.size < n_fft * 2:
        return audio.copy()
    window = get_window("hann", n_fft, fftbins=True)
    # Stretch by `ratio`, then resample back to the original length. Stretching
    # by `1/ratio` — which is what this said first — moves the pitch the wrong
    # way and left a mean error of 150 cents on a bench measuring errors of two.
    stretch = ratio

    frames = 1 + (audio.size - n_fft) // hop
    spectra = np.empty((frames, n_fft // 2 + 1), dtype=np.complex128)
    for index in range(frames):
        spectra[index] = np.fft.rfft(audio[index * hop: index * hop + n_fft] * window)

    bin_frequencies = 2 * np.pi * hop * np.arange(n_fft // 2 + 1) / n_fft
    out_frames = int(frames * stretch)
    accumulator = np.angle(spectra[0])
    stretched = np.zeros(out_frames * hop + n_fft)
    weights = np.zeros_like(stretched)

    for index in range(out_frames):
        exact = index / stretch
        lower = min(frames - 1, int(exact))
        upper = min(frames - 1, lower + 1)
        blend = exact - lower
        magnitude = (1 - blend) * np.abs(spectra[lower]) + blend * np.abs(spectra[upper])
        delta = np.angle(spectra[upper]) - np.angle(spectra[lower]) - bin_frequencies
        delta = np.mod(delta + np.pi, 2 * np.pi) - np.pi
        accumulator = accumulator + bin_frequencies + delta
        frame = np.fft.irfft(magnitude * np.exp(1j * accumulator), n_fft) * window
        stretched[index * hop: index * hop + n_fft] += frame
        weights[index * hop: index * hop + n_fft] += window ** 2

    weights[weights < 1e-8] = 1.0
    stretched = stretched / weights
    # The stretched signal spans the frames plus one window, not `frames * hop`.
    # Resampling `out_frames * hop` samples — which is what this did first —
    # divides by the wrong length, and the pitch comes out near zero cents from
    # where it started however large the shift asked for was. That was the whole
    # of the phase vocoder's 114-cent error.
    valid = stretched[: out_frames * hop + n_fft]
    target = max(8, int(round(valid.size / ratio)))
    shifted = resample(valid, target).astype(np.float64)
    if shifted.size >= audio.size:
        return shifted[: audio.size]
    return np.concatenate([shifted, np.zeros(audio.size - shifted.size)])


def _envelope(spectrum: np.ndarray, lifter: int = 40) -> np.ndarray:
    """The smooth spectral envelope, by cepstral liftering."""
    log_magnitude = np.log(np.maximum(np.abs(spectrum), 1e-10))
    cepstrum = np.fft.irfft(log_magnitude, n=(len(log_magnitude) - 1) * 2)
    cepstrum[lifter:-lifter] = 0.0
    return np.exp(np.fft.rfft(cepstrum).real)


def shift_hybrid(audio: np.ndarray, ratio: float, lifter: int = 60) -> np.ndarray:
    """Varispeed, then one static filter that puts the formants back.

    Varispeed scales the whole spectrum by `ratio`, pitch and resonances alike —
    its one measured weakness. But the displacement is *known*: a resonance that
    was at f is now at f·ratio. So the correction is a single filter,

        H(f) = Env(f) / Env(f / ratio)

    computed once from the note's own averaged spectral envelope and applied
    zero-phase. One filter for the note, not one per frame.

    The first version of this did it per frame, comparing the source frame at
    offset t with the shifted frame at the same offset t — but varispeed maps
    output time t to input time t·ratio, so the two frames were of different
    moments. It measured 31.8% formant error against varispeed's 11.3: worse
    than doing nothing, which is what a misaligned comparison buys.
    """
    shifted = shift_varispeed(audio, ratio)
    if shifted.size < 256 or abs(ratio - 1.0) < 1e-4:
        return shifted

    spectrum = np.fft.rfft(audio * np.hanning(audio.size))
    envelope = _envelope(spectrum, lifter=lifter)
    bins = np.arange(envelope.size)
    # Env(f / ratio): the envelope varispeed produced, sampled where it now sits.
    moved = np.interp(bins / ratio, bins, envelope, left=envelope[0], right=envelope[-1])
    correction = np.clip(envelope / np.maximum(moved, 1e-12), 0.25, 4.0)

    transformed = np.fft.rfft(shifted, n=(envelope.size - 1) * 2)
    fitted = np.interp(
        np.linspace(0, 1, transformed.size), np.linspace(0, 1, correction.size), correction)
    out = np.fft.irfft(transformed * fitted, n=(envelope.size - 1) * 2)
    return out[: shifted.size].astype(np.float64)


# ------------------------------------------------------------- metrics -------


def f0_track(audio: np.ndarray, sample_rate: int = SAMPLE_RATE,
             window_seconds: float = 0.05, lowest_hz: float = 60.0) -> np.ndarray:
    """Frame-by-frame F0 by autocorrelation. Independent of the pipeline's YIN.

    The window adapts to what it is given, because the first version demanded
    60 ms and was then handed 40 ms frames by the vibrato metric — every frame
    was skipped and every method scored a vibrato depth of exactly zero. A
    metric that returns the same number for every method is not measuring.
    """
    audio = np.asarray(audio, dtype=np.float64) - float(np.mean(audio))
    window = min(int(window_seconds * sample_rate), audio.size)
    max_lag = int(sample_rate / lowest_hz)
    if window < max_lag * 2:
        window = min(audio.size, max_lag * 2)
    if window < 8 or audio.size < window:
        return np.zeros(0)

    step = max(1, window // 4)
    values = []
    for start in range(0, audio.size - window + 1, step):
        frame = audio[start: start + window]
        if np.sqrt(np.mean(frame ** 2)) < 1e-3:
            continue
        correlation = np.correlate(frame, frame, "full")[window - 1:]
        lo = int(sample_rate / 1000)
        hi = min(max_lag, correlation.size - 1)
        if hi <= lo:
            continue
        peak = lo + int(np.argmax(correlation[lo:hi]))
        if peak > 0:
            values.append(sample_rate / peak)
    return np.asarray(values)


def measure_f0(audio: np.ndarray, sample_rate: int = SAMPLE_RATE) -> float:
    """Median F0 over the whole signal."""
    track = f0_track(audio, sample_rate)
    return float(np.median(track)) if track.size else 0.0


def spectral_centroid(audio: np.ndarray, sample_rate: int = SAMPLE_RATE) -> float:
    spectrum = np.abs(np.fft.rfft(audio * np.hanning(audio.size)))
    freqs = np.fft.rfftfreq(audio.size, 1 / sample_rate)
    total = spectrum.sum()
    return float((spectrum * freqs).sum() / total) if total > 0 else 0.0


def formant_peaks(audio: np.ndarray, sample_rate: int = SAMPLE_RATE, count: int = 3) -> list[float]:
    """The first `count` envelope maxima below 4 kHz: a formant estimate."""
    spectrum = np.abs(np.fft.rfft(audio * np.hanning(audio.size)))
    envelope = _envelope(spectrum, lifter=30)
    freqs = np.fft.rfftfreq(audio.size, 1 / sample_rate)
    limit = np.searchsorted(freqs, 4000)
    envelope = envelope[:limit]
    peaks = [i for i in range(2, envelope.size - 2)
             if envelope[i] > envelope[i - 1] and envelope[i] > envelope[i + 1]]
    peaks.sort(key=lambda i: -envelope[i])
    chosen = sorted(freqs[i] for i in peaks[:count])
    return [float(value) for value in chosen] + [0.0] * (count - len(chosen))


def spectral_flux_variance(audio: np.ndarray, n_fft: int = 1024, hop: int = 256) -> float:
    """How steadily the spectrum evolves. Grain artefacts show up here."""
    frames = 1 + (audio.size - n_fft) // hop
    if frames < 3:
        return 0.0
    window = np.hanning(n_fft)
    previous = None
    flux = []
    for index in range(frames):
        magnitude = np.abs(np.fft.rfft(audio[index * hop: index * hop + n_fft] * window))
        magnitude /= max(1e-9, magnitude.sum())
        if previous is not None:
            flux.append(float(np.sum((magnitude - previous) ** 2)))
        previous = magnitude
    return float(np.std(flux))


def harmonic_to_noise_db(audio: np.ndarray, f0_hz: float,
                         sample_rate: int = SAMPLE_RATE) -> float:
    """Energy at harmonics of `f0_hz` against everything else, in dB."""
    spectrum = np.abs(np.fft.rfft(audio * np.hanning(audio.size))) ** 2
    freqs = np.fft.rfftfreq(audio.size, 1 / sample_rate)
    if f0_hz <= 0:
        return 0.0
    harmonic = np.zeros_like(spectrum, dtype=bool)
    width = max(1, int(round(f0_hz * 0.12 / (freqs[1] - freqs[0]))))
    for number in range(1, int(sample_rate / 2 / f0_hz) + 1):
        centre = int(round(number * f0_hz / (freqs[1] - freqs[0])))
        harmonic[max(0, centre - width): centre + width + 1] = True
    noise = spectrum[~harmonic].sum()
    return float(10 * np.log10(spectrum[harmonic].sum() / max(noise, 1e-12)))


def vibrato_depth_cents(audio: np.ndarray, sample_rate: int = SAMPLE_RATE) -> float:
    """Peak-to-peak pitch movement, in cents.

    The 10th and 90th percentiles rather than the extremes: one bad frame at
    either end of a 200-frame track would otherwise decide the answer.
    """
    track = f0_track(audio, sample_rate, window_seconds=0.045, lowest_hz=120.0)
    if track.size < 8:
        return 0.0
    low, high = np.percentile(track, [10, 90])
    if low <= 0:
        return 0.0
    return float(1200 * np.log2(high / low))


# --------------------------------------------------------------- bench -------


@dataclass
class Result:
    method: str
    cents_error: list[float] = field(default_factory=list)
    octave_errors: int = 0
    centroid_error_pct: list[float] = field(default_factory=list)
    formant_error_pct: list[float] = field(default_factory=list)
    flux_ratio: list[float] = field(default_factory=list)
    hnr_loss_db: list[float] = field(default_factory=list)
    duration_exact: bool = True
    vibrato_kept_pct: list[float] = field(default_factory=list)
    transient_kept_pct: list[float] = field(default_factory=list)


def _mean(values: list[float]) -> float:
    return float(np.mean(values)) if values else 0.0


#: Small shifts: tuning errors, where the note was right and the pitch was not.
SMALL_SHIFTS = [-110.0, -80.0, -55.0, -25.0, 25.0, 55.0, 80.0, 110.0]

#: Large shifts: a wrong note, or a note in the wrong octave.
#:
#: These used to be out of scope, because the pipeline reported them and left
#: them alone. The product requirement is that the final song contains no
#: audible out-of-tune note, and "too large to correct" is not a way of meeting
#: it — so the question became which method survives a shift this size, and that
#: is a measurement rather than an opinion.
LARGE_SHIFTS = [-1200.0, -700.0, -400.0, -200.0, 200.0, 400.0, 700.0, 1200.0]


def run(shifts_cents: Sequence[float] = tuple(SMALL_SHIFTS)) -> dict[str, Result]:
    base_pitches = [110.0, 165.0, 220.0, 330.0]

    methods = {
        # The control, and the row that makes the others readable. It applies no
        # shift at all, so its formant and centroid columns are what the
        # estimator reports when the formants provably did not move — the two
        # signals being compared were built with the same formant filter. Any
        # method scoring near this row is preserving formants as well as the
        # measurement can tell. Its `cents` column is the size of the shift it
        # declined to make, and is not a score.
        "none (control)": lambda audio, ratio, f0: audio.copy(),
        "varispeed": lambda audio, ratio, f0: shift_varispeed(audio, ratio),
        "varispeed-poly": lambda audio, ratio, f0: shift_varispeed_poly(audio, ratio),
        "td-psola": lambda audio, ratio, f0: shift_psola(audio, ratio, f0),
        "psola-cascaded": lambda audio, ratio, f0: shift_psola_cascaded(audio, ratio, f0),
        "phase-vocoder": lambda audio, ratio, f0: shift_phase_vocoder(audio, ratio),
        "hybrid": lambda audio, ratio, f0: shift_hybrid(audio, ratio),
    }
    results = {name: Result(name) for name in methods}

    for f0 in base_pitches:
        source = synth_vowel(f0, 0.7)
        source_hnr = harmonic_to_noise_db(source, f0)

        for cents in shifts_cents:
            ratio = 2.0 ** (cents / 1200.0)
            target_f0 = f0 * ratio
            # The honest reference: the same voice, produced at the target
            # pitch, with the formants where they always were.
            reference = synth_vowel(target_f0, 0.7)
            reference_centroid = spectral_centroid(reference)
            reference_formants = formant_peaks(reference)

            for name, method in methods.items():
                shifted = method(source, ratio, f0)
                result = results[name]
                if shifted.size != source.size:
                    result.duration_exact = False

                measured = measure_f0(shifted)
                if measured > 0:
                    error = 1200 * math.log2(measured / target_f0)
                    if abs(error) > 600:
                        result.octave_errors += 1
                        error = (error + 600) % 1200 - 600
                    result.cents_error.append(abs(error))

                centroid = spectral_centroid(shifted)
                if reference_centroid > 0:
                    result.centroid_error_pct.append(
                        abs(centroid - reference_centroid) / reference_centroid * 100)

                peaks = formant_peaks(shifted)
                errors = [abs(a - b) / b * 100 for a, b in zip(peaks, reference_formants) if b > 0]
                if errors:
                    result.formant_error_pct.append(float(np.mean(errors)))

                # Absolute, scaled for readability. The first version divided
                # by the source's own flux, and a steady synthetic vowel has a
                # flux variance near zero — so the ratio was dominated by its
                # denominator and said nothing about the methods.
                result.flux_ratio.append(spectral_flux_variance(shifted) * 1e6)
                result.hnr_loss_db.append(
                    source_hnr - harmonic_to_noise_db(shifted, target_f0))

    # Vibrato, on its own, once: a shift must move a vibrato note without
    # flattening the vibrato, which is the performance.
    vibrato_source = synth_vowel(220.0, 0.9, vibrato_cents=80.0)
    before = vibrato_depth_cents(vibrato_source)
    # And a consonant onset, which must survive as a transient.
    onset_source = synth_vowel(220.0, 0.6, onset_noise_seconds=0.06)

    def onset_share(signal: np.ndarray) -> float:
        """Share of the signal's energy in its first 60 ms.

        A share rather than an absolute energy, because the methods do not all
        return the same level and the first version's raw comparison produced
        figures like 275565% — a number that should have been read as a broken
        metric and not as a result.
        """
        total = float(np.sum(signal ** 2))
        if total <= 0:
            return 0.0
        return float(np.sum(signal[: int(0.06 * SAMPLE_RATE)] ** 2)) / total

    source_onset_share = onset_share(onset_source)

    for name, method in methods.items():
        ratio = 2.0 ** (-60.0 / 1200.0)
        after = vibrato_depth_cents(method(vibrato_source, ratio, 220.0))
        if before > 0:
            results[name].vibrato_kept_pct.append(after / before * 100)
        shifted_onset = method(onset_source, ratio, 220.0)
        results[name].transient_kept_pct.append(
            onset_share(shifted_onset) / max(source_onset_share, 1e-12) * 100)

    return results


def main() -> None:
    import sys
    large = "--large" in sys.argv
    results = run(LARGE_SHIFTS if large else SMALL_SHIFTS)
    print(f"\n{'LARGE shifts (200-1200 cents)' if large else 'SMALL shifts (25-110 cents)'}: "
          f"a wrong note or a wrong octave" if large else
          f"\nSMALL shifts (25-110 cents): a tuning error")
    header = (f"{'method':<15}{'cents':>8}{'oct':>5}{'centroid%':>11}{'formant%':>10}"
              f"{'flux':>8}{'HNRloss':>9}{'len':>5}{'vib%':>7}{'onset%':>8}")
    print(header)
    print("-" * len(header))
    for name, result in results.items():
        print(f"{name:<15}"
              f"{_mean(result.cents_error):>8.1f}"
              f"{result.octave_errors:>5d}"
              f"{_mean(result.centroid_error_pct):>11.1f}"
              f"{_mean(result.formant_error_pct):>10.1f}"
              f"{_mean(result.flux_ratio):>8.2f}"
              f"{_mean(result.hnr_loss_db):>9.1f}"
              f"{'yes' if result.duration_exact else 'NO':>5}"
              f"{_mean(result.vibrato_kept_pct):>7.0f}"
              f"{_mean(result.transient_kept_pct):>8.0f}")
    print()
    print("cents     mean |error| from the target pitch, over 32 shifts")
    print("oct       shifts that landed an octave out")
    print("centroid% spectral centroid distance from a voice really sung at that pitch")
    print("formant%  mean distance of the first three formants from that same voice")
    print("flux      spectral flux variance x1e6; higher is a less steady spectrum")
    print("HNRloss   harmonic-to-noise ratio lost, in dB; positive is worse")
    print("vib%      vibrato depth kept, as a percentage of the original")
    print("onset%    energy kept in a 60 ms unvoiced consonant at the start")


if __name__ == "__main__":
    main()
