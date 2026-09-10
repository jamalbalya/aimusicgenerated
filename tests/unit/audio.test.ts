import { describe, expect, it } from 'vitest'
import { Fft, hannWindow, nextPowerOfTwo } from '../../src/engine/audio/fft'
import { binFrequency, istft, stft } from '../../src/engine/audio/stft'
import { decodeWav, encodeWav, toMono, toStereo, audioDuration, type AudioData } from '../../src/engine/audio/wav'
import { encodeMp3, isMp3SampleRate } from '../../src/engine/audio/mp3'
import { pitchShift, resample, timeStretch, varispeed } from '../../src/engine/audio/pitchshift'
import { detectKey, detectTempo, measureLoudness, waveformPeaks } from '../../src/engine/audio/analyze'
import { separateStems, splitVocals } from '../../src/engine/audio/separate'
import {
  applyChorus, applyCompression, applyDistortion, applyEcho, applyLimiter, applyReverb,
  concat, equalize, fade, gain, mixDown, normalizeLoudness, normalizePeak, reduceNoise, reverse, trim,
} from '../../src/engine/audio/effects'
import { adsrValue, Biquad, envelopeLength, fastSin, fastTanh, oscillator, saturate } from '../../src/engine/synth/dsp'

const RATE = 22050

function sine(freq: number, seconds: number, rate = RATE, amplitude = 0.5): Float32Array {
  const out = new Float32Array(Math.round(seconds * rate))
  for (let i = 0; i < out.length; i++) out[i] = Math.sin((2 * Math.PI * freq * i) / rate) * amplitude
  return out
}

function rms(signal: Float32Array): number {
  let sum = 0
  for (let i = 0; i < signal.length; i++) sum += signal[i]! * signal[i]!
  return Math.sqrt(sum / Math.max(1, signal.length))
}

function dominantFrequency(signal: Float32Array, rate: number): number {
  const size = nextPowerOfTwo(Math.min(8192, signal.length))
  const fft = new Fft(size)
  const window = hannWindow(size)
  const real = new Float64Array(size)
  const imag = new Float64Array(size)
  const offset = Math.floor((signal.length - size) / 2)
  for (let i = 0; i < size; i++) real[i] = (signal[offset + i] ?? 0) * window[i]!
  fft.forward(real, imag)
  let best = 0
  let bestBin = 0
  for (let bin = 1; bin < size / 2; bin++) {
    const magnitude = Math.hypot(real[bin]!, imag[bin]!)
    if (magnitude > best) {
      best = magnitude
      bestBin = bin
    }
  }
  return (bestBin * rate) / size
}

describe('dsp primitives', () => {
  it('fastSin tracks Math.sin', () => {
    for (let i = 0; i < 200; i++) {
      const turns = i / 200
      expect(fastSin(turns)).toBeCloseTo(Math.sin(2 * Math.PI * turns), 3)
    }
    expect(fastSin(2.25)).toBeCloseTo(Math.sin(2 * Math.PI * 0.25), 3)
    expect(fastSin(-0.25)).toBeCloseTo(Math.sin(-2 * Math.PI * 0.25), 3)
  })

  it('fastTanh tracks Math.tanh and saturates', () => {
    for (let x = -4; x <= 4; x += 0.1) expect(fastTanh(x)).toBeCloseTo(Math.tanh(x), 3)
    expect(fastTanh(50)).toBe(1)
    expect(fastTanh(-50)).toBe(-1)
  })

  it('saturate is a pass-through at zero and bounded above it', () => {
    expect(saturate(0.5, 0)).toBe(0.5)
    for (const amount of [0.2, 0.5, 1]) {
      expect(Math.abs(saturate(1, amount))).toBeLessThanOrEqual(1.001)
      expect(saturate(0, amount)).toBeCloseTo(0, 9)
    }
  })

  it('oscillators stay in range', () => {
    for (const wave of ['sine', 'saw', 'square', 'triangle', 'pulse'] as const) {
      for (let i = 0; i < 200; i++) {
        const value = oscillator(wave, i / 200, 0.01)
        expect(Number.isFinite(value)).toBe(true)
        expect(Math.abs(value)).toBeLessThanOrEqual(2)
      }
    }
  })

  it('adsr starts at zero, reaches sustain, and ends at zero', () => {
    const env = { attack: 0.01, decay: 0.1, sustain: 0.6, release: 0.2 }
    expect(adsrValue(-1, 1, env)).toBe(0)
    expect(adsrValue(0, 1, env)).toBe(0)
    expect(adsrValue(0.5, 1, env)).toBeCloseTo(0.6, 3)
    expect(adsrValue(1.3, 1, env)).toBe(0)
    expect(envelopeLength(1, env)).toBeCloseTo(1.2, 6)
    // A note cut off during its attack must not jump to full level.
    expect(adsrValue(0.006, 0.005, env)).toBeLessThan(0.6)
  })

  it('biquad low-pass attenuates above its corner', () => {
    const low = new Biquad(RATE)
    low.lowpass(500, 0.707)
    const input = sine(4000, 0.2)
    const output = input.slice()
    low.processBuffer(output)
    expect(rms(output)).toBeLessThan(rms(input) * 0.2)

    const pass = new Biquad(RATE)
    pass.lowpass(8000, 0.707)
    const passed = sine(400, 0.2)
    const before = rms(passed)
    pass.processBuffer(passed)
    expect(rms(passed)).toBeGreaterThan(before * 0.8)
  })

  it('biquad high-pass removes DC', () => {
    const filter = new Biquad(RATE)
    filter.highpass(200, 0.707)
    const buffer = new Float32Array(RATE).fill(0.5)
    filter.processBuffer(buffer)
    expect(Math.abs(buffer[buffer.length - 1]!)).toBeLessThan(0.01)
  })
})

describe('fft and stft', () => {
  it('rejects non power-of-two sizes', () => {
    expect(() => new Fft(100)).toThrow()
    expect(nextPowerOfTwo(100)).toBe(128)
    expect(nextPowerOfTwo(128)).toBe(128)
  })

  it('round-trips through forward and inverse', () => {
    const size = 256
    const fft = new Fft(size)
    const real = new Float64Array(size)
    const imag = new Float64Array(size)
    const original = new Float64Array(size)
    for (let i = 0; i < size; i++) {
      original[i] = Math.sin((2 * Math.PI * 7 * i) / size) + 0.3 * Math.cos((2 * Math.PI * 21 * i) / size)
      real[i] = original[i]!
    }
    fft.forward(real, imag)
    fft.inverse(real, imag)
    for (let i = 0; i < size; i++) expect(real[i]).toBeCloseTo(original[i]!, 8)
  })

  it('locates a pure tone', () => {
    expect(dominantFrequency(sine(1000, 0.5), RATE)).toBeCloseTo(1000, -1)
  })

  it('stft then istft reconstructs the signal', () => {
    const signal = sine(440, 0.4)
    const spectrum = stft(signal, 1024, 256, RATE)
    const restored = istft(spectrum)
    expect(restored.length).toBe(signal.length)
    // Ignore the first and last frame, where the overlap is incomplete.
    for (let i = 1024; i < signal.length - 1024; i++) {
      expect(restored[i]).toBeCloseTo(signal[i]!, 3)
    }
  })

  it('reports bin frequencies', () => {
    expect(binFrequency(10, 1024, 44100)).toBeCloseTo((10 * 44100) / 1024, 6)
  })
})

describe('wav', () => {
  const audio: AudioData = { channels: [sine(440, 0.2), sine(660, 0.2)], sampleRate: RATE }

  it('round-trips at 16 bit', () => {
    const decoded = decodeWav(encodeWav(audio, 16))
    expect(decoded.sampleRate).toBe(RATE)
    expect(decoded.channels).toHaveLength(2)
    expect(decoded.channels[0]!.length).toBe(audio.channels[0]!.length)
    for (let i = 0; i < 500; i++) expect(decoded.channels[0]![i]).toBeCloseTo(audio.channels[0]![i]!, 3)
  })

  it('round-trips at 24 and 32 bit', () => {
    for (const depth of [24, 32] as const) {
      const decoded = decodeWav(encodeWav(audio, depth))
      for (let i = 0; i < 500; i++) expect(decoded.channels[1]![i]).toBeCloseTo(audio.channels[1]![i]!, 5)
    }
  })

  it('clamps out-of-range samples instead of wrapping', () => {
    const hot: AudioData = { channels: [new Float32Array([2, -2, 0])], sampleRate: RATE }
    const decoded = decodeWav(encodeWav(hot, 16))
    expect(decoded.channels[0]![0]).toBeCloseTo(1, 3)
    expect(decoded.channels[0]![1]).toBeCloseTo(-1, 3)
  })

  it('rejects non-WAV data', () => {
    expect(() => decodeWav(new ArrayBuffer(8))).toThrow()
    expect(() => decodeWav(new TextEncoder().encode('not a wav file at all!!').buffer)).toThrow()
  })

  it('handles empty audio', () => {
    const empty: AudioData = { channels: [new Float32Array(0)], sampleRate: RATE }
    expect(decodeWav(encodeWav(empty)).channels[0]!.length).toBe(0)
    expect(audioDuration(empty)).toBe(0)
  })

  it('converts between mono and stereo', () => {
    expect(toMono(audio).length).toBe(audio.channels[0]!.length)
    const stereo = toStereo({ channels: [sine(440, 0.1)], sampleRate: RATE })
    expect(stereo.channels).toHaveLength(2)
    expect(stereo.channels[0]![10]).toBe(stereo.channels[1]![10])
  })
})

describe('mp3', () => {
  it('produces a valid MPEG bitstream', () => {
    const audio: AudioData = { channels: [sine(440, 0.5, 44100), sine(440, 0.5, 44100)], sampleRate: 44100 }
    const encoded = encodeMp3(audio, 128)
    expect(encoded.length).toBeGreaterThan(1000)
    // Frame sync: eleven set bits.
    expect(encoded[0]).toBe(0xff)
    expect((encoded[1]! & 0xe0)).toBe(0xe0)
  })

  it('accepts the sample rates the studio renders at', () => {
    for (const rate of [22050, 32000, 44100]) expect(isMp3SampleRate(rate)).toBe(true)
    expect(isMp3SampleRate(37000)).toBe(false)
    expect(() => encodeMp3({ channels: [new Float32Array(10)], sampleRate: 37000 })).toThrow()
  })
})

describe('pitch and time', () => {
  it('resamples to the expected length', () => {
    const signal = sine(440, 0.4)
    expect(resample(signal, 2).length).toBe(Math.round(signal.length / 2))
    expect(resample(signal, 1).length).toBe(signal.length)
  })

  it('time-stretches without changing pitch', () => {
    const signal = sine(440, 0.8)
    const stretched = timeStretch(signal, 1.5, 1024)
    expect(stretched.length).toBeGreaterThan(signal.length * 1.3)
    expect(dominantFrequency(stretched, RATE)).toBeCloseTo(440, -1)
  })

  it('pitch-shifts without changing length', () => {
    const signal = sine(440, 0.8)
    const up = pitchShift(signal, { semitones: 12, frameSize: 1024 })
    expect(up.length).toBe(signal.length)
    expect(dominantFrequency(up, RATE)).toBeGreaterThan(700)
    const down = pitchShift(signal, { semitones: -12, frameSize: 1024 })
    expect(dominantFrequency(down, RATE)).toBeLessThan(300)
  })

  it('is a no-op for zero shift', () => {
    const signal = sine(440, 0.2)
    expect(pitchShift(signal, { semitones: 0 })).toEqual(signal)
    expect(timeStretch(signal, 1)).toEqual(signal)
  })

  it('varispeed changes both speed and pitch', () => {
    const audio: AudioData = { channels: [sine(440, 0.6)], sampleRate: RATE }
    const fast = varispeed(audio, 2)
    expect(fast.channels[0]!.length).toBeCloseTo(audio.channels[0]!.length / 2, -1)
  })

  it('never produces NaN', () => {
    const signal = sine(300, 0.5)
    for (const semitones of [-7, -3, 5, 9]) {
      const out = pitchShift(signal, { semitones, preserveFormants: true, frameSize: 1024 })
      for (let i = 0; i < out.length; i++) expect(Number.isFinite(out[i]!)).toBe(true)
    }
  })
})

describe('analysis', () => {
  it('detects a click-track tempo', () => {
    const bpm = 120
    const seconds = 8
    const signal = new Float32Array(seconds * RATE)
    const period = Math.round((60 / bpm) * RATE)
    for (let beat = 0; beat * period < signal.length; beat++) {
      const start = beat * period
      for (let i = 0; i < 900 && start + i < signal.length; i++) {
        signal[start + i] = Math.sin((2 * Math.PI * 80 * i) / RATE) * Math.exp(-i / 300)
      }
    }
    const result = detectTempo({ channels: [signal], sampleRate: RATE })
    expect(Math.abs(result.bpm - bpm)).toBeLessThan(4)
    expect(result.beats.length).toBeGreaterThan(4)
  })

  it('degrades gracefully on tiny input', () => {
    const result = detectTempo({ channels: [new Float32Array(100)], sampleRate: RATE })
    expect(result.bpm).toBe(120)
    expect(result.confidence).toBe(0)
  })

  it('detects the key of a C major triad drone', () => {
    const length = 4 * RATE
    const signal = new Float32Array(length)
    for (const freq of [261.63, 329.63, 392.0, 523.25]) {
      for (let i = 0; i < length; i++) signal[i]! += Math.sin((2 * Math.PI * freq * i) / RATE) * 0.2
    }
    const key = detectKey({ channels: [signal], sampleRate: RATE })
    expect(key.tonic).toBe(0)
    expect(key.chroma).toHaveLength(12)
  })

  it('measures loudness and detects clipping', () => {
    const quiet = measureLoudness({ channels: [sine(440, 0.5, RATE, 0.1)], sampleRate: RATE })
    const loud = measureLoudness({ channels: [sine(440, 0.5, RATE, 0.9)], sampleRate: RATE })
    expect(loud.rmsDb).toBeGreaterThan(quiet.rmsDb)
    expect(loud.lufs).toBeGreaterThan(quiet.lufs)
    expect(quiet.clipping).toBe(false)
    expect(measureLoudness({ channels: [new Float32Array([1, -1, 1])], sampleRate: RATE }).clipping).toBe(true)
    const silent = measureLoudness({ channels: [new Float32Array(0)], sampleRate: RATE })
    expect(silent.peak).toBe(0)
  })

  it('computes waveform peaks', () => {
    const peaks = waveformPeaks({ channels: [sine(440, 1)], sampleRate: RATE }, 100)
    expect(peaks.length).toBe(200)
    for (let i = 0; i < 100; i++) {
      expect(peaks[i * 2]).toBeLessThanOrEqual(peaks[i * 2 + 1]!)
    }
    expect(waveformPeaks({ channels: [new Float32Array(0)], sampleRate: RATE }, 10).length).toBe(20)
  })
})

describe('separation', () => {
  /** Centre-panned "vocal" plus a hard-panned "instrument". */
  function makeMix(): AudioData {
    const seconds = 2
    const length = seconds * RATE
    const left = new Float32Array(length)
    const right = new Float32Array(length)
    for (let i = 0; i < length; i++) {
      const vocal = Math.sin((2 * Math.PI * 330 * i) / RATE) * 0.4
      const guitar = Math.sin((2 * Math.PI * 1200 * i) / RATE) * 0.35
      left[i] = vocal + guitar
      right[i] = vocal - guitar
    }
    return { channels: [left, right], sampleRate: RATE }
  }

  it('pulls the centred source out and leaves the sides behind', () => {
    const { vocals, instrumental } = splitVocals(makeMix(), { frameSize: 1024 })
    expect(dominantFrequency(vocals.channels[0]!, RATE)).toBeCloseTo(330, -2)
    expect(dominantFrequency(instrumental.channels[0]!, RATE)).toBeCloseTo(1200, -2)
    expect(rms(vocals.channels[0]!)).toBeGreaterThan(0.01)
  })

  it('produces four stems of the right length with no NaN', () => {
    const mix = makeMix()
    const result = separateStems(mix, { frameSize: 1024 })
    for (const stem of Object.values(result.stems)) {
      expect(stem.channels).toHaveLength(2)
      expect(stem.channels[0]!.length).toBe(mix.channels[0]!.length)
      for (let i = 0; i < stem.channels[0]!.length; i += 37) {
        expect(Number.isFinite(stem.channels[0]![i]!)).toBe(true)
      }
    }
    expect(result.instrumental.channels[0]!.length).toBe(mix.channels[0]!.length)
  })

  it('handles mono input', () => {
    const mono: AudioData = { channels: [sine(440, 1)], sampleRate: RATE }
    const result = separateStems(mono, { frameSize: 1024 })
    expect(result.stems.vocals.channels[0]!.length).toBe(mono.channels[0]!.length)
  })

  it('reports progress from start to finish', () => {
    const seen: number[] = []
    separateStems(makeMix(), { frameSize: 1024, onProgress: (p) => seen.push(p) })
    expect(seen[0]).toBeLessThan(0.2)
    expect(seen[seen.length - 1]).toBe(1)
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1]!)
  })
})

describe('effects', () => {
  const audio: AudioData = { channels: [sine(440, 1), sine(440, 1)], sampleRate: RATE }

  it('trims to the requested window', () => {
    const trimmed = trim(audio, 0.25, 0.75)
    expect(trimmed.channels[0]!.length).toBeCloseTo(RATE * 0.5, -2)
    // Out-of-range requests clamp instead of throwing.
    expect(trim(audio, -5, 100).channels[0]!.length).toBe(audio.channels[0]!.length)
    expect(trim(audio, 0.8, 0.2).channels[0]!.length).toBe(0)
  })

  it('fades in and out', () => {
    const faded = fade(audio, 0.1, 0.1)
    expect(Math.abs(faded.channels[0]![0]!)).toBeLessThan(0.01)
    expect(Math.abs(faded.channels[0]![faded.channels[0]!.length - 1]!)).toBeLessThan(0.02)
  })

  it('reverses', () => {
    const reversed = reverse(audio)
    const last = audio.channels[0]!.length - 1
    expect(reversed.channels[0]![0]).toBeCloseTo(audio.channels[0]![last]!, 6)
  })

  it('applies gain', () => {
    expect(rms(gain(audio, -6).channels[0]!)).toBeCloseTo(rms(audio.channels[0]!) * 0.5012, 3)
  })

  it('normalises peak and loudness', () => {
    const quiet: AudioData = { channels: [sine(440, 0.5, RATE, 0.05)], sampleRate: RATE }
    const peakNormalised = normalizePeak(quiet, -1)
    let peak = 0
    for (const value of peakNormalised.channels[0]!) peak = Math.max(peak, Math.abs(value))
    expect(peak).toBeCloseTo(0.891, 2)

    const loudnessNormalised = normalizeLoudness(quiet, -14)
    expect(rms(loudnessNormalised.channels[0]!)).toBeGreaterThan(rms(quiet.channels[0]!))
    // Silence must not be amplified into noise or NaN.
    const silence: AudioData = { channels: [new Float32Array(1000)], sampleRate: RATE }
    for (const value of normalizePeak(silence).channels[0]!) expect(value).toBe(0)
  })

  it('concatenates and layers clips', () => {
    const joined = concat([audio, audio])
    expect(joined.channels[0]!.length).toBe(audio.channels[0]!.length * 2)
    expect(concat([]).channels[0]!.length).toBe(0)

    const layered = mixDown([{ audio }, { audio, offsetSeconds: 0.5, gainDb: -6 }])
    expect(layered.channels[0]!.length).toBeCloseTo(RATE * 1.5, -2)
  })

  it('equalises', () => {
    const cut = equalize({ channels: [sine(4000, 0.4)], sampleRate: RATE }, [{ type: 'lowPass', freq: 500 }])
    expect(rms(cut.channels[0]!)).toBeLessThan(rms(sine(4000, 0.4)) * 0.3)
    expect(equalize(audio, []).channels[0]!.length).toBe(audio.channels[0]!.length)
  })

  it('adds reverb, echo, chorus and distortion without NaN', () => {
    const processors: [string, AudioData][] = [
      ['reverb', applyReverb(audio, { size: 0.6, damping: 0.4, mix: 0.4 })],
      ['echo', applyEcho(audio, { delaySeconds: 0.25, feedback: 0.4, mix: 0.4 })],
      ['chorus', applyChorus(audio, 0.6, 0.5)],
      ['distortion', applyDistortion(audio, 0.6)],
      ['compression', applyCompression(audio, { thresholdDb: -18, ratio: 4, attackMs: 5, releaseMs: 80, makeupDb: 3 })],
      ['limiter', applyLimiter(audio, 0.9)],
      ['denoise', reduceNoise(audio, 0.6)],
    ]
    for (const [name, result] of processors) {
      expect(result.channels[0]!.length, name).toBeGreaterThan(0)
      for (let i = 0; i < result.channels[0]!.length; i += 53) {
        expect(Number.isFinite(result.channels[0]![i]!), `${name} @${i}`).toBe(true)
      }
    }
  })

  it('limits peaks to the ceiling', () => {
    const hot: AudioData = { channels: [sine(200, 0.5, RATE, 3), sine(200, 0.5, RATE, 3)], sampleRate: RATE }
    const limited = applyLimiter(hot, 0.9)
    for (const value of limited.channels[0]!) expect(Math.abs(value)).toBeLessThanOrEqual(0.95)
  })
})
