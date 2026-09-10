/** Tempo, key, loudness and waveform analysis. */

import { NOTE_NAMES, type PitchClass } from '../theory/pitch'
import { stft } from './stft'
import { toMono, type AudioData } from './wav'

export interface TempoResult {
  bpm: number
  /** 0..1 — how strongly the winning tempo beat the alternatives. */
  confidence: number
  /** Detected beat positions in seconds. */
  beats: number[]
}

/**
 * Tempo detection via spectral flux and autocorrelation of the onset envelope.
 * Half- and double-time candidates are folded into a musical range so a 75 BPM
 * ballad is not reported as 150.
 */
export function detectTempo(audio: AudioData, minBpm = 60, maxBpm = 200): TempoResult {
  const mono = toMono(audio)
  if (mono.length < 4096) return { bpm: 120, confidence: 0, beats: [] }

  const frameSize = 1024
  const hopSize = 256
  const spectrum = stft(mono, frameSize, hopSize, audio.sampleRate)
  const frameRate = audio.sampleRate / hopSize

  // Spectral flux: positive change in magnitude, summed across bins.
  const flux = new Float32Array(spectrum.magnitude.length)
  for (let f = 1; f < spectrum.magnitude.length; f++) {
    const current = spectrum.magnitude[f]!
    const previous = spectrum.magnitude[f - 1]!
    let sum = 0
    for (let bin = 0; bin < current.length; bin++) {
      const diff = current[bin]! - previous[bin]!
      if (diff > 0) sum += diff
    }
    flux[f] = sum
  }

  // Remove the slow-moving average so loud sections do not dominate.
  const smoothed = new Float32Array(flux.length)
  const windowSize = Math.round(frameRate * 0.4)
  let running = 0
  for (let i = 0; i < flux.length; i++) {
    running += flux[i]!
    if (i >= windowSize) running -= flux[i - windowSize]!
    const average = running / Math.min(i + 1, windowSize)
    smoothed[i] = Math.max(0, flux[i]! - average)
  }

  const minLag = Math.floor((60 / maxBpm) * frameRate)
  const maxLag = Math.ceil((60 / minBpm) * frameRate)
  if (maxLag >= smoothed.length) return { bpm: 120, confidence: 0, beats: [] }

  let bestLag = minLag
  let bestScore = -Infinity
  let secondScore = -Infinity
  const scores = new Float32Array(maxLag + 1)

  for (let lag = minLag; lag <= maxLag; lag++) {
    let sum = 0
    let count = 0
    for (let i = lag; i < smoothed.length; i++) {
      sum += smoothed[i]! * smoothed[i - lag]!
      count++
    }
    // Reinforce with the first harmonic: a real tempo also correlates at 2x.
    const doubleLag = lag * 2
    let harmonic = 0
    if (doubleLag < smoothed.length) {
      for (let i = doubleLag; i < smoothed.length; i++) {
        harmonic += smoothed[i]! * smoothed[i - doubleLag]!
      }
      harmonic /= Math.max(1, smoothed.length - doubleLag)
    }
    const score = sum / Math.max(1, count) + harmonic * 0.5
    scores[lag] = score
    if (score > bestScore) {
      secondScore = bestScore
      bestScore = score
      bestLag = lag
    } else if (score > secondScore) {
      secondScore = score
    }
  }

  let bpm = (60 * frameRate) / bestLag
  // Fold into the most musical octave.
  while (bpm < 70) bpm *= 2
  while (bpm > 190) bpm /= 2

  const confidence = bestScore > 0 && Number.isFinite(secondScore)
    ? Math.max(0, Math.min(1, 1 - secondScore / bestScore))
    : 0

  // Find beat positions by picking peaks at the detected period.
  const beats: number[] = []
  const period = bestLag
  let phase = 0
  let bestPhaseScore = -Infinity
  for (let candidate = 0; candidate < period; candidate++) {
    let sum = 0
    for (let i = candidate; i < smoothed.length; i += period) sum += smoothed[i]!
    if (sum > bestPhaseScore) {
      bestPhaseScore = sum
      phase = candidate
    }
  }
  for (let i = phase; i < smoothed.length; i += period) beats.push(i / frameRate)

  return { bpm: Math.round(bpm * 10) / 10, confidence, beats }
}

export interface KeyResult {
  tonic: PitchClass
  scale: 'major' | 'minor'
  label: string
  confidence: number
  /** Normalised 12-bin chroma, for display. */
  chroma: number[]
}

// Krumhansl-Schmuckler key profiles.
const MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88]
const MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17]

/** Chroma vector: energy per pitch class across the whole file. */
export function computeChroma(audio: AudioData): number[] {
  const mono = toMono(audio)
  const chroma = new Array(12).fill(0)
  if (mono.length < 4096) return chroma

  const frameSize = 4096
  const hopSize = frameSize
  const spectrum = stft(mono, frameSize, hopSize, audio.sampleRate)

  for (const frame of spectrum.magnitude) {
    for (let bin = 1; bin < frame.length; bin++) {
      const freq = (bin * audio.sampleRate) / frameSize
      if (freq < 55 || freq > 4200) continue
      const midi = 69 + 12 * Math.log2(freq / 440)
      const pitchClass = ((Math.round(midi) % 12) + 12) % 12
      chroma[pitchClass] += frame[bin]! * frame[bin]!
    }
  }

  const total = chroma.reduce((a, b) => a + b, 0)
  return total > 0 ? chroma.map((v) => v / total) : chroma
}

/** Correlates the chroma against all 24 key profiles. */
export function detectKey(audio: AudioData): KeyResult {
  const chroma = computeChroma(audio)

  const correlate = (profile: number[], rotation: number): number => {
    let sumXY = 0
    let sumX = 0
    let sumY = 0
    let sumX2 = 0
    let sumY2 = 0
    for (let i = 0; i < 12; i++) {
      const x = chroma[(i + rotation) % 12]!
      const y = profile[i]!
      sumXY += x * y
      sumX += x
      sumY += y
      sumX2 += x * x
      sumY2 += y * y
    }
    const numerator = 12 * sumXY - sumX * sumY
    const denominator = Math.sqrt((12 * sumX2 - sumX * sumX) * (12 * sumY2 - sumY * sumY))
    return denominator > 1e-9 ? numerator / denominator : 0
  }

  let best = { tonic: 0 as PitchClass, scale: 'major' as 'major' | 'minor', score: -Infinity }
  let second = -Infinity
  for (let tonic = 0; tonic < 12; tonic++) {
    for (const scale of ['major', 'minor'] as const) {
      const score = correlate(scale === 'major' ? MAJOR_PROFILE : MINOR_PROFILE, tonic)
      if (score > best.score) {
        second = best.score
        best = { tonic: tonic as PitchClass, scale, score }
      } else if (score > second) {
        second = score
      }
    }
  }

  const confidence = Number.isFinite(second) && best.score > 0
    ? Math.max(0, Math.min(1, (best.score - second) / Math.max(1e-6, best.score)))
    : 0

  return {
    tonic: best.tonic,
    scale: best.scale,
    label: `${NOTE_NAMES[best.tonic]} ${best.scale}`,
    confidence,
    chroma,
  }
}

export interface LoudnessResult {
  peak: number
  peakDb: number
  rmsDb: number
  /** K-weighted loudness estimate in LUFS. */
  lufs: number
  /** True when any sample reaches full scale. */
  clipping: boolean
}

/**
 * Loudness measurement. The LUFS figure applies the ITU-R BS.1770 K-weighting
 * (a high-shelf plus a high-pass) before integrating, which is what makes it
 * track perceived loudness rather than raw energy.
 */
export function measureLoudness(audio: AudioData): LoudnessResult {
  const channels = audio.channels
  const length = channels[0]?.length ?? 0
  if (length === 0) {
    return { peak: 0, peakDb: -Infinity, rmsDb: -Infinity, lufs: -Infinity, clipping: false }
  }

  let peak = 0
  let sumSquares = 0
  let weightedSum = 0
  let clipping = false

  for (const channel of channels) {
    // Two-stage K-weighting, coefficients for 48 kHz scaled by sample rate.
    const shelf = new BiquadState()
    const highpass = new BiquadState()
    const rate = audio.sampleRate
    shelf.setHighShelf(1500, 4, rate)
    highpass.setHighPass(38, rate)

    for (let i = 0; i < length; i++) {
      const sample = channel[i]!
      const magnitude = Math.abs(sample)
      if (magnitude > peak) peak = magnitude
      if (magnitude >= 0.999) clipping = true
      sumSquares += sample * sample
      const weighted = highpass.process(shelf.process(sample))
      weightedSum += weighted * weighted
    }
  }

  const totalSamples = length * channels.length
  const rms = Math.sqrt(sumSquares / totalSamples)
  const weightedRms = Math.sqrt(weightedSum / totalSamples)

  return {
    peak,
    peakDb: 20 * Math.log10(Math.max(1e-6, peak)),
    rmsDb: 20 * Math.log10(Math.max(1e-6, rms)),
    lufs: -0.691 + 20 * Math.log10(Math.max(1e-6, weightedRms)),
    clipping,
  }
}

/** Minimal biquad used only by the loudness meter. */
class BiquadState {
  private b0 = 1; private b1 = 0; private b2 = 0; private a1 = 0; private a2 = 0
  private x1 = 0; private x2 = 0; private y1 = 0; private y2 = 0

  setHighShelf(freq: number, gainDb: number, sampleRate: number): void {
    const A = Math.pow(10, gainDb / 40)
    const w0 = (2 * Math.PI * freq) / sampleRate
    const cos = Math.cos(w0)
    const alpha = Math.sin(w0) / 2 * Math.sqrt(2)
    const twoSqrtAAlpha = 2 * Math.sqrt(A) * alpha
    const a0 = (A + 1) - (A - 1) * cos + twoSqrtAAlpha
    this.b0 = (A * ((A + 1) + (A - 1) * cos + twoSqrtAAlpha)) / a0
    this.b1 = (-2 * A * ((A - 1) + (A + 1) * cos)) / a0
    this.b2 = (A * ((A + 1) + (A - 1) * cos - twoSqrtAAlpha)) / a0
    this.a1 = (2 * ((A - 1) - (A + 1) * cos)) / a0
    this.a2 = ((A + 1) - (A - 1) * cos - twoSqrtAAlpha) / a0
  }

  setHighPass(freq: number, sampleRate: number): void {
    const w0 = (2 * Math.PI * freq) / sampleRate
    const alpha = Math.sin(w0) / (2 * 0.5)
    const cos = Math.cos(w0)
    const a0 = 1 + alpha
    this.b0 = ((1 + cos) / 2) / a0
    this.b1 = (-(1 + cos)) / a0
    this.b2 = ((1 + cos) / 2) / a0
    this.a1 = (-2 * cos) / a0
    this.a2 = (1 - alpha) / a0
  }

  process(x: number): number {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2
    this.x2 = this.x1
    this.x1 = x
    this.y2 = this.y1
    this.y1 = y
    return y
  }
}

/**
 * Min/max peaks per pixel column, for waveform drawing. Returns interleaved
 * [min, max] pairs so a canvas can draw the envelope in one pass.
 */
export function waveformPeaks(audio: AudioData, columns: number): Float32Array {
  const mono = toMono(audio)
  const peaks = new Float32Array(columns * 2)
  if (mono.length === 0 || columns <= 0) return peaks

  const samplesPerColumn = mono.length / columns
  for (let column = 0; column < columns; column++) {
    const start = Math.floor(column * samplesPerColumn)
    const end = Math.min(mono.length, Math.max(start + 1, Math.floor((column + 1) * samplesPerColumn)))
    let min = 1
    let max = -1
    for (let i = start; i < end; i++) {
      const value = mono[i]!
      if (value < min) min = value
      if (value > max) max = value
    }
    peaks[column * 2] = min
    peaks[column * 2 + 1] = max
  }
  return peaks
}
