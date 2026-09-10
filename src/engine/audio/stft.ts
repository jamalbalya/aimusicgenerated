/** Short-time Fourier transform with overlap-add resynthesis. */

import { Fft, hannWindow } from './fft'

export interface Spectrogram {
  /** Magnitude per frame; frames[f][bin]. */
  magnitude: Float32Array[]
  /** Phase per frame, in radians. */
  phase: Float32Array[]
  frameSize: number
  hopSize: number
  /** Number of usable bins, frameSize/2 + 1. */
  binCount: number
  sampleRate: number
  /** Original signal length, so resynthesis can trim back to it. */
  length: number
}

export function stft(
  signal: Float32Array,
  frameSize = 2048,
  hopSize = frameSize / 4,
  sampleRate = 44100,
): Spectrogram {
  const fft = new Fft(frameSize)
  const window = hannWindow(frameSize)
  const binCount = frameSize / 2 + 1
  const frameCount = Math.max(1, Math.ceil(signal.length / hopSize))

  const magnitude: Float32Array[] = []
  const phase: Float32Array[] = []
  const real = new Float64Array(frameSize)
  const imag = new Float64Array(frameSize)

  for (let f = 0; f < frameCount; f++) {
    const offset = f * hopSize
    real.fill(0)
    imag.fill(0)
    for (let i = 0; i < frameSize; i++) {
      const index = offset + i
      real[i] = index < signal.length ? signal[index]! * window[i]! : 0
    }
    fft.forward(real, imag)

    const frameMagnitude = new Float32Array(binCount)
    const framePhase = new Float32Array(binCount)
    for (let bin = 0; bin < binCount; bin++) {
      const re = real[bin]!
      const im = imag[bin]!
      frameMagnitude[bin] = Math.hypot(re, im)
      framePhase[bin] = Math.atan2(im, re)
    }
    magnitude.push(frameMagnitude)
    phase.push(framePhase)
  }

  return { magnitude, phase, frameSize, hopSize, binCount, sampleRate, length: signal.length }
}

/**
 * Overlap-add resynthesis. The window is applied a second time and the result
 * divided by the summed window power, which is what keeps a Hann analysis and
 * a Hann synthesis from colouring the output.
 */
export function istft(spectrogram: Spectrogram, magnitudeOverride?: Float32Array[]): Float32Array {
  const { frameSize, hopSize, binCount, phase } = spectrogram
  const magnitude = magnitudeOverride ?? spectrogram.magnitude
  const fft = new Fft(frameSize)
  const window = hannWindow(frameSize)

  const outputLength = (magnitude.length - 1) * hopSize + frameSize
  const output = new Float32Array(outputLength)
  const windowSum = new Float32Array(outputLength)

  const real = new Float64Array(frameSize)
  const imag = new Float64Array(frameSize)

  for (let f = 0; f < magnitude.length; f++) {
    const frameMagnitude = magnitude[f]!
    const framePhase = phase[f]!
    real.fill(0)
    imag.fill(0)

    for (let bin = 0; bin < binCount; bin++) {
      const m = frameMagnitude[bin]!
      const p = framePhase[bin]!
      const re = m * Math.cos(p)
      const im = m * Math.sin(p)
      real[bin] = re
      imag[bin] = im
      // Mirror into the negative frequencies to keep the signal real.
      if (bin > 0 && bin < frameSize / 2) {
        real[frameSize - bin] = re
        imag[frameSize - bin] = -im
      }
    }

    fft.inverse(real, imag)

    const offset = f * hopSize
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

  return output.subarray(0, spectrogram.length) as Float32Array
}

/** Centre frequency of an FFT bin. */
export function binFrequency(bin: number, frameSize: number, sampleRate: number): number {
  return (bin * sampleRate) / frameSize
}
