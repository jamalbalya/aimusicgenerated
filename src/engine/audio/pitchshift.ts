/**
 * Phase-vocoder time stretching and pitch shifting, with independent formant
 * control — that last part is what separates a natural-sounding transposition
 * from a chipmunk.
 */

import { Fft, hannWindow } from './fft'
import type { AudioData } from './wav'

/**
 * Stretches a signal in time by `ratio` (2 = twice as long) without changing
 * pitch. Phases are advanced by the true instantaneous frequency of each bin,
 * which is what keeps transients from smearing into a wash.
 */
export function timeStretch(
  signal: Float32Array,
  ratio: number,
  frameSize = 2048,
  overlap = 4,
): Float32Array {
  if (Math.abs(ratio - 1) < 1e-6 || signal.length === 0) return signal.slice()

  const analysisHop = Math.floor(frameSize / overlap)
  const synthesisHop = Math.max(1, Math.round(analysisHop * ratio))
  const fft = new Fft(frameSize)
  const window = hannWindow(frameSize)
  const bins = frameSize / 2 + 1

  const frameCount = Math.max(1, Math.floor((signal.length - frameSize) / analysisHop) + 1)
  const outputLength = frameCount * synthesisHop + frameSize
  const output = new Float32Array(outputLength)
  const windowSum = new Float32Array(outputLength)

  const real = new Float64Array(frameSize)
  const imag = new Float64Array(frameSize)
  const lastPhase = new Float64Array(bins)
  const sumPhase = new Float64Array(bins)
  const expectedAdvance = new Float64Array(bins)
  for (let bin = 0; bin < bins; bin++) {
    expectedAdvance[bin] = (2 * Math.PI * analysisHop * bin) / frameSize
  }

  for (let f = 0; f < frameCount; f++) {
    const offset = f * analysisHop
    for (let i = 0; i < frameSize; i++) {
      const index = offset + i
      real[i] = index < signal.length ? signal[index]! * window[i]! : 0
      imag[i] = 0
    }
    fft.forward(real, imag)

    for (let bin = 0; bin < bins; bin++) {
      const re = real[bin]!
      const im = imag[bin]!
      const magnitude = Math.hypot(re, im)
      const phase = Math.atan2(im, re)

      // Wrap the phase difference into (-pi, pi] to recover true frequency.
      let delta = phase - lastPhase[bin]! - expectedAdvance[bin]!
      delta = delta - 2 * Math.PI * Math.round(delta / (2 * Math.PI))
      lastPhase[bin] = phase

      const trueFrequency = expectedAdvance[bin]! + delta
      sumPhase[bin]! += (trueFrequency * synthesisHop) / analysisHop

      const outPhase = sumPhase[bin]!
      const outRe = magnitude * Math.cos(outPhase)
      const outIm = magnitude * Math.sin(outPhase)
      real[bin] = outRe
      imag[bin] = outIm
      if (bin > 0 && bin < frameSize / 2) {
        real[frameSize - bin] = outRe
        imag[frameSize - bin] = -outIm
      }
    }

    fft.inverse(real, imag)

    const outOffset = f * synthesisHop
    for (let i = 0; i < frameSize; i++) {
      const w = window[i]!
      output[outOffset + i]! += real[i]! * w
      windowSum[outOffset + i]! += w * w
    }
  }

  for (let i = 0; i < outputLength; i++) {
    const sum = windowSum[i]!
    if (sum > 1e-8) output[i]! /= sum
  }

  const target = Math.max(1, Math.round(signal.length * ratio))
  return output.subarray(0, Math.min(target, outputLength)) as Float32Array
}

/** Linear-interpolating resampler; also used to change playback speed. */
export function resample(signal: Float32Array, ratio: number): Float32Array {
  if (Math.abs(ratio - 1) < 1e-9 || signal.length === 0) return signal.slice()
  const outputLength = Math.max(1, Math.round(signal.length / ratio))
  const output = new Float32Array(outputLength)
  for (let i = 0; i < outputLength; i++) {
    const position = i * ratio
    const index = Math.floor(position)
    const frac = position - index
    const a = signal[Math.min(index, signal.length - 1)]!
    const b = signal[Math.min(index + 1, signal.length - 1)]!
    output[i] = a + (b - a) * frac
  }
  return output
}

/**
 * Estimates the spectral envelope by smoothing the log-magnitude spectrum.
 * Used to preserve (or deliberately shift) formants when transposing.
 */
function spectralEnvelope(magnitude: Float64Array, bins: number, smoothing: number): Float64Array {
  const envelope = new Float64Array(bins)
  const half = Math.max(1, Math.round(smoothing))
  let sum = 0
  let count = 0
  // Running-sum box filter over the log spectrum.
  for (let bin = 0; bin < Math.min(bins, half + 1); bin++) {
    sum += Math.log(magnitude[bin]! + 1e-9)
    count++
  }
  for (let bin = 0; bin < bins; bin++) {
    envelope[bin] = Math.exp(sum / Math.max(1, count))
    const add = bin + half + 1
    const remove = bin - half
    if (add < bins) {
      sum += Math.log(magnitude[add]! + 1e-9)
      count++
    }
    if (remove >= 0) {
      sum -= Math.log(magnitude[remove]! + 1e-9)
      count--
    }
  }
  return envelope
}

export interface PitchShiftOptions {
  /** Shift in semitones. */
  semitones: number
  /** Extra formant shift in semitones; 0 keeps the original character. */
  formantSemitones?: number
  /** True keeps formants where they were (natural transposition). */
  preserveFormants?: boolean
  frameSize?: number
}

/**
 * Shifts pitch without changing length: time-stretch, then resample back.
 * With `preserveFormants`, the spectral envelope is re-imposed after the
 * shift so a voice keeps its identity instead of turning into a cartoon.
 */
export function pitchShift(signal: Float32Array, options: PitchShiftOptions): Float32Array {
  const { semitones } = options
  const formantSemitones = options.formantSemitones ?? 0
  const frameSize = options.frameSize ?? 2048

  if (Math.abs(semitones) < 1e-6 && Math.abs(formantSemitones) < 1e-6) return signal.slice()

  const factor = Math.pow(2, semitones / 12)
  let output = signal
  if (Math.abs(semitones) > 1e-6) {
    const stretched = timeStretch(signal, factor, frameSize)
    output = resample(stretched, factor)
  }

  const totalFormantShift = (options.preserveFormants ? -semitones : 0) + formantSemitones
  if (Math.abs(totalFormantShift) > 1e-6) {
    output = shiftFormants(output, totalFormantShift, frameSize)
  }

  // Length can drift by a frame; trim or pad back to the original.
  if (output.length === signal.length) return output
  const result = new Float32Array(signal.length)
  result.set(output.subarray(0, Math.min(output.length, signal.length)))
  return result
}

/**
 * Moves the spectral envelope up or down without moving the harmonics, which
 * is what changes an apparent vocal-tract size — the "gender" control.
 */
export function shiftFormants(signal: Float32Array, semitones: number, frameSize = 2048): Float32Array {
  if (Math.abs(semitones) < 1e-6) return signal.slice()
  const shift = Math.pow(2, semitones / 12)
  const hop = frameSize / 4
  const fft = new Fft(frameSize)
  const window = hannWindow(frameSize)
  const bins = frameSize / 2 + 1

  const frameCount = Math.max(1, Math.ceil(signal.length / hop))
  const outputLength = frameCount * hop + frameSize
  const output = new Float32Array(outputLength)
  const windowSum = new Float32Array(outputLength)

  const real = new Float64Array(frameSize)
  const imag = new Float64Array(frameSize)
  const magnitude = new Float64Array(bins)

  for (let f = 0; f < frameCount; f++) {
    const offset = f * hop
    for (let i = 0; i < frameSize; i++) {
      const index = offset + i
      real[i] = index < signal.length ? signal[index]! * window[i]! : 0
      imag[i] = 0
    }
    fft.forward(real, imag)

    for (let bin = 0; bin < bins; bin++) {
      magnitude[bin] = Math.hypot(real[bin]!, imag[bin]!)
    }
    const envelope = spectralEnvelope(magnitude, bins, frameSize / 64)

    for (let bin = 0; bin < bins; bin++) {
      const source = bin / shift
      const index = Math.floor(source)
      const frac = source - index
      const a = envelope[Math.min(index, bins - 1)]!
      const b = envelope[Math.min(index + 1, bins - 1)]!
      const shiftedEnvelope = a + (b - a) * frac
      const gain = shiftedEnvelope / (envelope[bin]! + 1e-9)
      const limited = Math.min(6, Math.max(0.05, gain))
      real[bin]! *= limited
      imag[bin]! *= limited
      if (bin > 0 && bin < frameSize / 2) {
        real[frameSize - bin] = real[bin]!
        imag[frameSize - bin] = -imag[bin]!
      }
    }

    fft.inverse(real, imag)
    for (let i = 0; i < frameSize; i++) {
      const w = window[i]!
      output[offset + i]! += real[i]! * w
      windowSum[offset + i]! += w * w
    }
  }

  for (let i = 0; i < outputLength; i++) {
    const sum = windowSum[i]!
    if (sum > 1e-8) output[i]! /= sum
  }
  return output.subarray(0, signal.length) as Float32Array
}

/** Applies pitch shifting to every channel of an audio buffer. */
export function pitchShiftAudio(audio: AudioData, options: PitchShiftOptions): AudioData {
  return {
    channels: audio.channels.map((channel) => pitchShift(channel, options)),
    sampleRate: audio.sampleRate,
  }
}

/** Changes tempo without changing pitch. */
export function timeStretchAudio(audio: AudioData, ratio: number): AudioData {
  return {
    channels: audio.channels.map((channel) => timeStretch(channel, ratio)),
    sampleRate: audio.sampleRate,
  }
}

/** Changes speed and pitch together, like a tape machine. */
export function varispeed(audio: AudioData, ratio: number): AudioData {
  return {
    channels: audio.channels.map((channel) => resample(channel, ratio)),
    sampleRate: audio.sampleRate,
  }
}
