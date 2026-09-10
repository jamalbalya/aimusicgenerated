/** Building blocks shared by every synthesiser and effect. */

import { clamp } from '../core/units'

/** Direct-form-II biquad using the RBJ cookbook coefficients. */
export class Biquad {
  private b0 = 1; private b1 = 0; private b2 = 0
  private a1 = 0; private a2 = 0
  private z1 = 0; private z2 = 0

  constructor(private readonly sampleRate: number) {}

  reset(): void {
    this.z1 = 0
    this.z2 = 0
  }

  private setCoefficients(b0: number, b1: number, b2: number, a0: number, a1: number, a2: number): void {
    this.b0 = b0 / a0
    this.b1 = b1 / a0
    this.b2 = b2 / a0
    this.a1 = a1 / a0
    this.a2 = a2 / a0
  }

  lowpass(freq: number, q = 0.707): void {
    const w0 = (2 * Math.PI * clamp(freq, 20, this.sampleRate * 0.49)) / this.sampleRate
    const alpha = Math.sin(w0) / (2 * Math.max(0.1, q))
    const cos = Math.cos(w0)
    this.setCoefficients((1 - cos) / 2, 1 - cos, (1 - cos) / 2, 1 + alpha, -2 * cos, 1 - alpha)
  }

  highpass(freq: number, q = 0.707): void {
    const w0 = (2 * Math.PI * clamp(freq, 20, this.sampleRate * 0.49)) / this.sampleRate
    const alpha = Math.sin(w0) / (2 * Math.max(0.1, q))
    const cos = Math.cos(w0)
    this.setCoefficients((1 + cos) / 2, -(1 + cos), (1 + cos) / 2, 1 + alpha, -2 * cos, 1 - alpha)
  }

  bandpass(freq: number, q = 1): void {
    const w0 = (2 * Math.PI * clamp(freq, 20, this.sampleRate * 0.49)) / this.sampleRate
    const alpha = Math.sin(w0) / (2 * Math.max(0.1, q))
    const cos = Math.cos(w0)
    this.setCoefficients(alpha, 0, -alpha, 1 + alpha, -2 * cos, 1 - alpha)
  }

  peaking(freq: number, q: number, gainDb: number): void {
    const A = Math.pow(10, gainDb / 40)
    const w0 = (2 * Math.PI * clamp(freq, 20, this.sampleRate * 0.49)) / this.sampleRate
    const alpha = Math.sin(w0) / (2 * Math.max(0.1, q))
    const cos = Math.cos(w0)
    this.setCoefficients(1 + alpha * A, -2 * cos, 1 - alpha * A, 1 + alpha / A, -2 * cos, 1 - alpha / A)
  }

  lowShelf(freq: number, gainDb: number, slope = 1): void {
    const A = Math.pow(10, gainDb / 40)
    const w0 = (2 * Math.PI * clamp(freq, 20, this.sampleRate * 0.49)) / this.sampleRate
    const cos = Math.cos(w0)
    const alpha = (Math.sin(w0) / 2) * Math.sqrt((A + 1 / A) * (1 / slope - 1) + 2)
    const twoSqrtAAlpha = 2 * Math.sqrt(A) * alpha
    this.setCoefficients(
      A * ((A + 1) - (A - 1) * cos + twoSqrtAAlpha),
      2 * A * ((A - 1) - (A + 1) * cos),
      A * ((A + 1) - (A - 1) * cos - twoSqrtAAlpha),
      (A + 1) + (A - 1) * cos + twoSqrtAAlpha,
      -2 * ((A - 1) + (A + 1) * cos),
      (A + 1) + (A - 1) * cos - twoSqrtAAlpha,
    )
  }

  highShelf(freq: number, gainDb: number, slope = 1): void {
    const A = Math.pow(10, gainDb / 40)
    const w0 = (2 * Math.PI * clamp(freq, 20, this.sampleRate * 0.49)) / this.sampleRate
    const cos = Math.cos(w0)
    const alpha = (Math.sin(w0) / 2) * Math.sqrt((A + 1 / A) * (1 / slope - 1) + 2)
    const twoSqrtAAlpha = 2 * Math.sqrt(A) * alpha
    this.setCoefficients(
      A * ((A + 1) + (A - 1) * cos + twoSqrtAAlpha),
      -2 * A * ((A - 1) + (A + 1) * cos),
      A * ((A + 1) + (A - 1) * cos - twoSqrtAAlpha),
      (A + 1) - (A - 1) * cos + twoSqrtAAlpha,
      2 * ((A - 1) - (A + 1) * cos),
      (A + 1) - (A - 1) * cos - twoSqrtAAlpha,
    )
  }

  process(input: number): number {
    const output = this.b0 * input + this.z1
    this.z1 = this.b1 * input - this.a1 * output + this.z2
    this.z2 = this.b2 * input - this.a2 * output
    return output
  }

  processBuffer(buffer: Float32Array): void {
    for (let i = 0; i < buffer.length; i++) buffer[i] = this.process(buffer[i]!)
  }
}

export interface AdsrParams {
  /** Seconds. */
  attack: number
  decay: number
  /** 0..1 level held while the note is on. */
  sustain: number
  release: number
}

/** Envelope level ignoring release — the attack/decay/sustain contour. */
function sustainContour(t: number, env: AdsrParams): number {
  const { attack, decay, sustain } = env
  if (t <= 0) return 0
  if (t < attack) {
    const x = t / Math.max(1e-5, attack)
    return x * x * (3 - 2 * x) // smoothstep attack, no click
  }
  const afterAttack = t - attack
  if (afterAttack < decay) {
    const x = afterAttack / Math.max(1e-5, decay)
    const inverse = 1 - x
    return 1 + (sustain - 1) * (1 - inverse * inverse)
  }
  return sustain
}

/**
 * Envelope value at time `t` for a note held for `holdSeconds`. The release
 * starts from whatever level the contour had actually reached, so a note cut
 * short during its attack does not jump to full volume first.
 */
export function adsrValue(t: number, holdSeconds: number, env: AdsrParams): number {
  if (t < 0) return 0
  if (t < holdSeconds) return sustainContour(t, env)
  const phase = (t - holdSeconds) / Math.max(1e-5, env.release)
  if (phase >= 1) return 0
  // Quadratic fall-off; Math.pow on the per-sample path is not worth the 0.2.
  const remaining = 1 - phase
  return sustainContour(holdSeconds, env) * remaining * remaining
}

/** Total sounding length of a note including its release tail. */
export function envelopeLength(holdSeconds: number, env: AdsrParams): number {
  return Math.max(holdSeconds, env.attack + env.decay) + env.release
}

/**
 * Sine lookup table. Rendering a three-minute arrangement means tens of
 * millions of sine evaluations; a 4096-entry table with linear interpolation
 * is indistinguishable at audio resolution and several times faster.
 */
const SINE_TABLE_SIZE = 4096
const SINE_TABLE = (() => {
  const table = new Float32Array(SINE_TABLE_SIZE + 1)
  for (let i = 0; i <= SINE_TABLE_SIZE; i++) {
    table[i] = Math.sin((2 * Math.PI * i) / SINE_TABLE_SIZE)
  }
  return table
})()

/** Sine of a phase expressed in turns (0..1 is one cycle). */
export function fastSin(phaseTurns: number): number {
  let phase = phaseTurns - Math.floor(phaseTurns)
  phase *= SINE_TABLE_SIZE
  const index = phase | 0
  const frac = phase - index
  const a = SINE_TABLE[index]!
  return a + (SINE_TABLE[index + 1]! - a) * frac
}

/**
 * Rational approximation of tanh — accurate to about 1e-4 over the range that
 * matters for saturation, and far cheaper than the real thing.
 */
export function fastTanh(x: number): number {
  if (x < -4.97) return -1
  if (x > 4.97) return 1
  const x2 = x * x
  const numerator = x * (135135 + x2 * (17325 + x2 * (378 + x2)))
  const denominator = 135135 + x2 * (62370 + x2 * (3150 + x2 * 28))
  return numerator / denominator
}

/** PolyBLEP correction — removes most of the aliasing from hard-edged waves. */
function polyBlep(phase: number, increment: number): number {
  if (phase < increment) {
    const t = phase / increment
    return t + t - t * t - 1
  }
  if (phase > 1 - increment) {
    const t = (phase - 1) / increment
    return t * t + t + t + 1
  }
  return 0
}

export type Waveform = 'sine' | 'saw' | 'square' | 'triangle' | 'pulse'

/** One band-limited oscillator sample. `phase` and `increment` are in turns. */
export function oscillator(wave: Waveform, phase: number, increment: number, pulseWidth = 0.5): number {
  switch (wave) {
    case 'sine':
      return fastSin(phase)
    case 'saw':
      return 2 * phase - 1 - polyBlep(phase, increment)
    case 'square': {
      const naive = phase < 0.5 ? 1 : -1
      return naive - polyBlep(phase, increment) + polyBlep((phase + 0.5) % 1, increment)
    }
    case 'pulse': {
      const naive = phase < pulseWidth ? 1 : -1
      return naive - polyBlep(phase, increment) + polyBlep((phase + (1 - pulseWidth)) % 1, increment)
    }
    case 'triangle': {
      // Integrated square: no aliasing worth correcting at audio rates.
      const t = phase < 0.5 ? phase * 4 - 1 : 3 - phase * 4
      return t
    }
  }
}

/** Deterministic white noise — a small xorshift so renders are reproducible. */
export class Noise {
  private state: number

  constructor(seed = 0x1234567) {
    this.state = seed >>> 0 || 1
  }

  next(): number {
    let x = this.state
    x ^= x << 13
    x ^= x >>> 17
    x ^= x << 5
    this.state = x >>> 0
    return (this.state / 2147483648) - 1
  }
}

/** Soft saturation. `amount` 0..1; 0 is a clean pass-through. */
export function saturate(sample: number, amount: number): number {
  if (amount <= 0) return sample
  const drive = 1 + amount * 8
  const normalise = 1 / fastTanh(drive)
  return fastTanh(sample * drive) * normalise * (1 - amount * 0.25) + sample * amount * 0.25
}

/** Hard-knee limiter safety net, applied last. */
export function clip(sample: number): number {
  return sample > 1 ? 1 : sample < -1 ? -1 : sample
}

/** Fractional-delay line with linear interpolation. */
export class DelayLine {
  private buffer: Float32Array
  private writeIndex = 0

  constructor(maxSamples: number) {
    this.buffer = new Float32Array(Math.max(2, Math.ceil(maxSamples)))
  }

  write(sample: number): void {
    this.buffer[this.writeIndex] = sample
    this.writeIndex = (this.writeIndex + 1) % this.buffer.length
  }

  read(delaySamples: number): number {
    const length = this.buffer.length
    const delay = clamp(delaySamples, 0, length - 2)
    const readPos = this.writeIndex - delay + length
    const index = Math.floor(readPos) % length
    const frac = readPos - Math.floor(readPos)
    const a = this.buffer[index]!
    const b = this.buffer[(index + 1) % length]!
    return a + (b - a) * frac
  }
}

/** One-pole low-pass, used for smoothing control signals. */
export class OnePole {
  private z = 0

  constructor(private coefficient: number) {}

  setCutoff(freqHz: number, sampleRate: number): void {
    this.coefficient = Math.exp((-2 * Math.PI * freqHz) / sampleRate)
  }

  process(input: number): number {
    this.z = input * (1 - this.coefficient) + this.z * this.coefficient
    return this.z
  }
}

/** Adds `source` into `target` starting at `offset`, clipping at the edges. */
export function mixInto(target: Float32Array, source: Float32Array, offset: number, gain = 1): void {
  const start = Math.max(0, Math.floor(offset))
  const sourceStart = start - Math.floor(offset)
  const count = Math.min(source.length - sourceStart, target.length - start)
  for (let i = 0; i < count; i++) {
    target[start + i]! += source[sourceStart + i]! * gain
  }
}
