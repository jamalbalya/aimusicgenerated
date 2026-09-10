/** Mix effects: reverb, delay, chorus, compression, sidechain and limiting. */

import { clamp, dbToGain } from '../core/units'
import { Biquad, DelayLine, saturate } from './dsp'

/**
 * Integer-delay line. The reverb and limiter only ever read at fixed whole-
 * sample offsets, so they can skip the interpolation and modulo arithmetic a
 * general fractional delay needs — which matters when these run over every
 * sample of the whole mix.
 */
class IntDelay {
  private readonly buffer: Float32Array
  private readonly mask: number
  private index = 0

  constructor(minSamples: number) {
    // Power-of-two length lets the wrap be a bitwise AND.
    let size = 4
    while (size < minSamples + 2) size <<= 1
    this.buffer = new Float32Array(size)
    this.mask = size - 1
  }

  /** Reads the sample written `delay` samples ago, then writes a new one. */
  step(input: number, delay: number): number {
    const output = this.buffer[(this.index - delay) & this.mask]!
    this.buffer[this.index] = input
    this.index = (this.index + 1) & this.mask
    return output
  }

  peek(delay: number): number {
    return this.buffer[(this.index - delay) & this.mask]!
  }

  write(input: number): void {
    this.buffer[this.index] = input
    this.index = (this.index + 1) & this.mask
  }
}

/**
 * Freeverb-style reverb: parallel comb filters into series allpasses, with the
 * right channel's delays offset so the tail is genuinely stereo.
 */
export class Reverb {
  private readonly combs: { line: IntDelay; delay: number; store: number }[][] = [[], []]
  private readonly allpasses: { line: IntDelay; delay: number }[][] = [[], []]
  private damping: number
  private feedback: number

  private static readonly COMB_TUNING = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617]
  private static readonly ALLPASS_TUNING = [556, 441, 341, 225]
  private static readonly STEREO_SPREAD = 23

  /** `size` 0..1 sets tail length; `damp` 0..1 rolls off the high end. */
  constructor(sampleRate: number, size: number, damp: number) {
    const scale = sampleRate / 44100
    this.feedback = 0.7 + clamp(size, 0, 1) * 0.28
    this.damping = clamp(damp, 0, 0.95)

    for (let channel = 0; channel < 2; channel++) {
      const offset = channel * Reverb.STEREO_SPREAD
      for (const tuning of Reverb.COMB_TUNING) {
        const delay = Math.round((tuning + offset) * scale)
        this.combs[channel]!.push({ line: new IntDelay(delay), delay, store: 0 })
      }
      for (const tuning of Reverb.ALLPASS_TUNING) {
        const delay = Math.round((tuning + offset) * scale)
        this.allpasses[channel]!.push({ line: new IntDelay(delay), delay })
      }
    }
  }

  /** Processes one mono input sample into a stereo pair. */
  process(input: number): [number, number] {
    const out: [number, number] = [0, 0]
    for (let channel = 0; channel < 2; channel++) {
      const combs = this.combs[channel]!
      const damping = this.damping
      const feedback = this.feedback
      let sum = 0
      for (let c = 0; c < combs.length; c++) {
        const comb = combs[c]!
        const delayed = comb.line.peek(comb.delay)
        comb.store = delayed * (1 - damping) + comb.store * damping
        comb.line.write(input * 0.015 + comb.store * feedback)
        sum += delayed
      }
      const allpasses = this.allpasses[channel]!
      for (let a = 0; a < allpasses.length; a++) {
        const allpass = allpasses[a]!
        const delayed = allpass.line.peek(allpass.delay)
        allpass.line.write(sum + delayed * 0.5)
        sum = delayed - sum
      }
      out[channel] = sum
    }
    return out
  }
}

/** Tempo-synced stereo ping-pong delay with a damped feedback path. */
export class PingPongDelay {
  private readonly left: DelayLine
  private readonly right: DelayLine
  private readonly damp: Biquad
  private readonly delaySamples: number

  constructor(sampleRate: number, delaySeconds: number, private readonly feedback: number) {
    this.delaySamples = Math.max(2, Math.round(delaySeconds * sampleRate))
    this.left = new DelayLine(this.delaySamples + 4)
    this.right = new DelayLine(this.delaySamples + 4)
    this.damp = new Biquad(sampleRate)
    this.damp.lowpass(4200, 0.7)
  }

  process(input: number): [number, number] {
    const leftOut = this.left.read(this.delaySamples)
    const rightOut = this.right.read(this.delaySamples)
    this.left.write(this.damp.process(input + rightOut * this.feedback))
    this.right.write(leftOut * this.feedback + input * 0.3)
    return [leftOut, rightOut]
  }
}

/** Three-voice chorus — widens pads and guitars without smearing transients. */
export class Chorus {
  private readonly line: DelayLine
  private phase = 0

  constructor(private readonly sampleRate: number, private readonly depth: number) {
    this.line = new DelayLine(Math.ceil(sampleRate * 0.05))
  }

  process(input: number): [number, number] {
    this.line.write(input)
    this.phase += 0.6 / this.sampleRate
    if (this.phase > 1) this.phase -= 1
    const base = this.sampleRate * 0.012
    const sweep = this.sampleRate * 0.004 * this.depth
    const left = this.line.read(base + Math.sin(2 * Math.PI * this.phase) * sweep)
    const right = this.line.read(base + Math.sin(2 * Math.PI * (this.phase + 0.37)) * sweep)
    return [left, right]
  }
}

export interface CompressorSettings {
  thresholdDb: number
  ratio: number
  attackMs: number
  releaseMs: number
  makeupDb: number
}

/**
 * Feed-forward peak compressor. The detector runs per sample, but the gain
 * curve — the expensive log/pow part — is evaluated at control rate and
 * interpolated, which is both standard practice and far faster.
 */
export class Compressor {
  private envelope = 0
  private readonly attackCoefficient: number
  private readonly releaseCoefficient: number
  private readonly makeupGain: number
  private currentGain: number
  private targetGain: number
  private counter = 0

  private static readonly CONTROL_INTERVAL = 16

  constructor(sampleRate: number, private readonly settings: CompressorSettings) {
    this.attackCoefficient = Math.exp(-1 / ((settings.attackMs / 1000) * sampleRate))
    this.releaseCoefficient = Math.exp(-1 / ((settings.releaseMs / 1000) * sampleRate))
    this.makeupGain = dbToGain(settings.makeupDb)
    this.currentGain = this.makeupGain
    this.targetGain = this.makeupGain
  }

  /** Returns the gain multiplier for this sample. */
  gainFor(level: number): number {
    const magnitude = Math.abs(level)
    const coefficient = magnitude > this.envelope ? this.attackCoefficient : this.releaseCoefficient
    this.envelope = magnitude + coefficient * (this.envelope - magnitude)

    if (this.counter <= 0) {
      this.counter = Compressor.CONTROL_INTERVAL
      const levelDb = 20 * Math.log10(Math.max(1e-6, this.envelope))
      const over = levelDb - this.settings.thresholdDb
      this.targetGain = over <= 0
        ? this.makeupGain
        : dbToGain(this.settings.makeupDb - (over - over / this.settings.ratio))
    }
    this.counter--
    this.currentGain += (this.targetGain - this.currentGain) * 0.08
    return this.currentGain
  }
}

/**
 * Look-ahead brickwall limiter. The delay line holds the signal while the gain
 * envelope catches up, so peaks are caught before they clip rather than after.
 */
export class Limiter {
  private readonly lookaheadSamples: number
  private readonly lines: IntDelay[]
  private envelope = 1
  private readonly releaseCoefficient: number

  constructor(sampleRate: number, private readonly ceiling = 0.97, lookaheadMs = 4, releaseMs = 60) {
    this.lookaheadSamples = Math.max(1, Math.round((lookaheadMs / 1000) * sampleRate))
    this.lines = [new IntDelay(this.lookaheadSamples), new IntDelay(this.lookaheadSamples)]
    this.releaseCoefficient = Math.exp(-1 / ((releaseMs / 1000) * sampleRate))
  }

  process(left: number, right: number): [number, number] {
    const delayedLeft = this.lines[0]!.step(left, this.lookaheadSamples)
    const delayedRight = this.lines[1]!.step(right, this.lookaheadSamples)
    const peak = Math.max(Math.abs(left), Math.abs(right))
    const target = peak > this.ceiling ? this.ceiling / peak : 1
    this.envelope = target < this.envelope
      ? target
      : target + this.releaseCoefficient * (this.envelope - target)

    return [
      clamp(delayedLeft * this.envelope, -1, 1),
      clamp(delayedRight * this.envelope, -1, 1),
    ]
  }
}

/**
 * Sidechain envelope from the kick pattern: a per-sample duck curve that other
 * tracks are multiplied by. This is the pumping that makes dance mixes breathe.
 */
export function buildSidechainEnvelope(
  kickTimesSeconds: number[],
  totalSamples: number,
  sampleRate: number,
  attackSeconds = 0.004,
  releaseSeconds = 0.22,
): Float32Array {
  const envelope = new Float32Array(totalSamples).fill(1)
  if (kickTimesSeconds.length === 0) return envelope

  const attackSamples = Math.max(1, Math.round(attackSeconds * sampleRate))
  const releaseSamples = Math.max(1, Math.round(releaseSeconds * sampleRate))

  for (const time of kickTimesSeconds) {
    const start = Math.round(time * sampleRate)
    if (start >= totalSamples) continue
    for (let i = 0; i < attackSamples; i++) {
      const index = start + i
      if (index < 0 || index >= totalSamples) continue
      const value = 1 - (i / attackSamples)
      if (value < envelope[index]!) envelope[index] = value
    }
    for (let i = 0; i < releaseSamples; i++) {
      const index = start + attackSamples + i
      if (index < 0 || index >= totalSamples) break
      const progress = i / releaseSamples
      const value = progress * progress * (3 - 2 * progress)
      if (value < envelope[index]!) envelope[index] = value
    }
  }
  return envelope
}

/** Applies a static shelving/high-pass EQ to a mono buffer in place. */
export function applyTrackEq(
  buffer: Float32Array,
  sampleRate: number,
  options: { highPassHz?: number; lowShelfDb?: number; highShelfDb?: number; presenceDb?: number },
): void {
  if (options.highPassHz && options.highPassHz > 20) {
    const filter = new Biquad(sampleRate)
    filter.highpass(options.highPassHz, 0.707)
    filter.processBuffer(buffer)
  }
  if (options.lowShelfDb) {
    const filter = new Biquad(sampleRate)
    filter.lowShelf(180, options.lowShelfDb)
    filter.processBuffer(buffer)
  }
  if (options.highShelfDb) {
    const filter = new Biquad(sampleRate)
    filter.highShelf(6000, options.highShelfDb)
    filter.processBuffer(buffer)
  }
  if (options.presenceDb) {
    // A wide bell rather than a narrow one: the aim is to open the whole
    // consonant band, not to ring on one frequency.
    const filter = new Biquad(sampleRate)
    filter.peaking(3000, 0.8, options.presenceDb)
    filter.processBuffer(buffer)
  }
}

/** Applies saturation across a buffer in place. */
export function applyDrive(buffer: Float32Array, amount: number): void {
  if (amount <= 0) return
  for (let i = 0; i < buffer.length; i++) buffer[i] = saturate(buffer[i]!, amount)
}
