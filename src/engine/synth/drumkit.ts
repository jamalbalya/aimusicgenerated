/**
 * Synthesised drum kit. Every piece is generated from oscillators and noise —
 * pitch-swept sines for the drums, filtered noise for the metals — so the kit
 * costs nothing to download and can be retuned per genre.
 */

import { Biquad, DelayLine, Noise, saturate } from './dsp'
import type { DrumName } from '../compose/types'

export interface DrumRequest {
  drum: DrumName
  velocity: number
  sampleRate: number
  /** Beats converted to seconds — only open hats and cymbals use it. */
  duration: number
  seed: number
  /** 0..1 — genre character. Higher is brighter and snappier. */
  brightness: number
  /** Tuning offset in semitones for the pitched drums. */
  tune: number
}

/** Longest tail each piece can produce, in seconds. */
const TAILS: Record<DrumName, number> = {
  kick: 0.9, snare: 0.5, clap: 0.5, rim: 0.14, hatClosed: 0.09, hatOpen: 0.55,
  hatPedal: 0.12, tomLow: 0.7, tomMid: 0.55, tomHigh: 0.45, crash: 2.4, ride: 1.6,
  shaker: 0.14, tambourine: 0.3, cowbell: 0.35, conga: 0.35, perc: 0.3,
  reverseCymbal: 1.6, sweepUp: 1.6, impact: 2,
}

export function drumLength(request: DrumRequest): number {
  const tail = TAILS[request.drum] ?? 0.5
  return Math.ceil((Math.max(tail, request.duration) + 0.05) * request.sampleRate)
}

export function renderDrum(request: DrumRequest): Float32Array {
  const { drum, velocity, sampleRate, brightness } = request
  const length = drumLength(request)
  const out = new Float32Array(length)
  const noise = new Noise(request.seed || 7)
  const tune = Math.pow(2, request.tune / 12)

  switch (drum) {
    case 'kick':
      pitchedDrum(out, sampleRate, 58 * tune, 42 * tune, 0.035, 0.42, 0.9, velocity, 0.55 + brightness * 0.2)
      addClick(out, sampleRate, noise, 2600, 0.004, velocity * (0.18 + brightness * 0.22))
      break
    case 'tomLow':
      pitchedDrum(out, sampleRate, 120 * tune, 82 * tune, 0.02, 0.4, 0.45, velocity, 0.35)
      addNoise(out, sampleRate, noise, 400, 1.2, 0.16, velocity * 0.2)
      break
    case 'tomMid':
      pitchedDrum(out, sampleRate, 175 * tune, 120 * tune, 0.018, 0.32, 0.4, velocity, 0.3)
      addNoise(out, sampleRate, noise, 600, 1.2, 0.14, velocity * 0.2)
      break
    case 'tomHigh':
      pitchedDrum(out, sampleRate, 240 * tune, 170 * tune, 0.015, 0.26, 0.35, velocity, 0.3)
      addNoise(out, sampleRate, noise, 900, 1.2, 0.12, velocity * 0.2)
      break
    case 'snare':
      pitchedDrum(out, sampleRate, 210 * tune, 165 * tune, 0.008, 0.11, 0.3, velocity, 0.25)
      addNoise(out, sampleRate, noise, 1900 + brightness * 1400, 0.9, 0.17, velocity * 0.85)
      addNoise(out, sampleRate, noise, 4800, 1.6, 0.06, velocity * 0.35)
      break
    case 'rim':
      pitchedDrum(out, sampleRate, 1700 * tune, 1200 * tune, 0.001, 0.03, 0.1, velocity, 0.35)
      addNoise(out, sampleRate, noise, 3200, 2.4, 0.03, velocity * 0.45)
      break
    case 'clap':
      renderClap(out, sampleRate, noise, velocity, brightness)
      break
    case 'hatClosed':
      renderMetal(out, sampleRate, noise, 0.055, velocity, 8200 + brightness * 3000, 0.9)
      break
    case 'hatPedal':
      renderMetal(out, sampleRate, noise, 0.08, velocity * 0.7, 7000, 0.8)
      break
    case 'hatOpen':
      renderMetal(out, sampleRate, noise, Math.min(0.5, Math.max(0.16, request.duration)), velocity, 8000 + brightness * 2500, 1)
      break
    case 'crash':
      renderMetal(out, sampleRate, noise, 2.2, velocity, 5200, 1.5, true)
      break
    case 'ride':
      renderMetal(out, sampleRate, noise, 1.3, velocity * 0.8, 7200, 1.1, true)
      pitchedDrum(out, sampleRate, 620, 600, 0.002, 0.5, 0.16, velocity * 0.35, 0.2)
      break
    case 'shaker':
      renderMetal(out, sampleRate, noise, 0.1, velocity * 0.8, 9500, 0.6)
      break
    case 'tambourine':
      renderMetal(out, sampleRate, noise, 0.26, velocity * 0.8, 8800, 1.2, true)
      break
    case 'cowbell':
      renderCowbell(out, sampleRate, velocity, tune)
      break
    case 'conga':
      pitchedDrum(out, sampleRate, 300 * tune, 240 * tune, 0.004, 0.24, 0.32, velocity, 0.28)
      addNoise(out, sampleRate, noise, 1400, 1.4, 0.05, velocity * 0.18)
      break
    case 'perc':
      pitchedDrum(out, sampleRate, 900 * tune, 520 * tune, 0.002, 0.14, 0.16, velocity, 0.24)
      addNoise(out, sampleRate, noise, 3400, 1.8, 0.06, velocity * 0.35)
      break
    case 'impact':
      pitchedDrum(out, sampleRate, 90 * tune, 34 * tune, 0.02, 1.4, 1.8, velocity, 0.7)
      addNoise(out, sampleRate, noise, 220, 0.8, 1.2, velocity * 0.4)
      break
    case 'reverseCymbal':
      renderReverse(out, sampleRate, noise, velocity, 1.4)
      break
    case 'sweepUp':
      renderSweep(out, sampleRate, noise, velocity)
      break
  }

  return out
}

/** Sine body with an exponential pitch drop — the core of most drum sounds. */
function pitchedDrum(
  out: Float32Array, sampleRate: number,
  startHz: number, endHz: number,
  pitchDecay: number, ampDecay: number, tail: number,
  velocity: number, drive: number,
): void {
  const length = Math.min(out.length, Math.ceil(tail * sampleRate))
  let phase = 0
  for (let i = 0; i < length; i++) {
    const t = i / sampleRate
    const freq = endHz + (startHz - endHz) * Math.exp(-t / Math.max(1e-4, pitchDecay))
    phase += freq / sampleRate
    const amp = Math.exp(-t / Math.max(1e-4, ampDecay))
    out[i]! += saturate(Math.sin(2 * Math.PI * phase) * amp * velocity, drive)
  }
}

function addNoise(
  out: Float32Array, sampleRate: number, noise: Noise,
  centerHz: number, q: number, decay: number, velocity: number,
): void {
  const filter = new Biquad(sampleRate)
  filter.bandpass(centerHz, q)
  const length = Math.min(out.length, Math.ceil(decay * 5 * sampleRate))
  for (let i = 0; i < length; i++) {
    const t = i / sampleRate
    const amp = Math.exp(-t / Math.max(1e-4, decay))
    out[i]! += filter.process(noise.next()) * amp * velocity
  }
}

function addClick(
  out: Float32Array, sampleRate: number, noise: Noise,
  centerHz: number, decay: number, velocity: number,
): void {
  const filter = new Biquad(sampleRate)
  filter.highpass(centerHz, 0.9)
  const length = Math.min(out.length, Math.ceil(decay * 8 * sampleRate))
  for (let i = 0; i < length; i++) {
    const amp = Math.exp(-(i / sampleRate) / Math.max(1e-5, decay))
    out[i]! += filter.process(noise.next()) * amp * velocity
  }
}

/** Hi-hats and cymbals: high-passed noise, optionally with metallic ringing. */
function renderMetal(
  out: Float32Array, sampleRate: number, noise: Noise,
  decay: number, velocity: number, cutoffHz: number, q: number,
  metallic = false,
): void {
  const highpass = new Biquad(sampleRate)
  highpass.highpass(cutoffHz, q)
  const bandpass = new Biquad(sampleRate)
  bandpass.bandpass(cutoffHz * 1.35, 1.2)

  // Six inharmonic square oscillators is the classic 808 metal recipe.
  const ratios = [1, 1.342, 1.2312, 1.6532, 1.9523, 2.1523]
  const base = metallic ? 320 : 540
  const phases = new Float32Array(ratios.length)

  const length = Math.min(out.length, Math.ceil(decay * 4 * sampleRate))
  for (let i = 0; i < length; i++) {
    const t = i / sampleRate
    const amp = Math.exp(-t / Math.max(1e-4, decay * 0.34))
    let sample = noise.next() * 0.7
    if (metallic) {
      let metal = 0
      for (let r = 0; r < ratios.length; r++) {
        phases[r] = (phases[r]! + (base * ratios[r]!) / sampleRate) % 1
        metal += phases[r]! < 0.5 ? 1 : -1
      }
      sample += (metal / ratios.length) * 0.5
    }
    const filtered = highpass.process(sample) * 0.7 + bandpass.process(sample) * 0.3
    out[i]! += filtered * amp * velocity
  }
}

function renderClap(
  out: Float32Array, sampleRate: number, noise: Noise,
  velocity: number, brightness: number,
): void {
  // Three quick bursts then a longer tail — what makes a clap sound like hands.
  const bursts = [0, 0.011, 0.022, 0.034]
  const filter = new Biquad(sampleRate)
  filter.bandpass(1300 + brightness * 900, 1.1)
  for (let i = 0; i < out.length; i++) {
    const t = i / sampleRate
    let amp = 0
    for (const offset of bursts) {
      if (t >= offset) amp += Math.exp(-(t - offset) / 0.009)
    }
    amp += Math.exp(-t / 0.16) * 0.5
    out[i]! += filter.process(noise.next()) * Math.min(1.4, amp) * velocity * 0.5
  }
}

function renderCowbell(out: Float32Array, sampleRate: number, velocity: number, tune: number): void {
  const f1 = 587 * tune
  const f2 = 845 * tune
  let p1 = 0
  let p2 = 0
  const filter = new Biquad(sampleRate)
  filter.bandpass(f2, 2.4)
  const length = Math.min(out.length, Math.ceil(0.3 * sampleRate))
  for (let i = 0; i < length; i++) {
    const t = i / sampleRate
    p1 = (p1 + f1 / sampleRate) % 1
    p2 = (p2 + f2 / sampleRate) % 1
    const square = (p1 < 0.5 ? 1 : -1) + (p2 < 0.5 ? 1 : -1)
    const amp = Math.exp(-t / 0.09)
    out[i]! += filter.process(square * 0.5) * amp * velocity
  }
}

function renderReverse(out: Float32Array, sampleRate: number, noise: Noise, velocity: number, seconds: number): void {
  const length = Math.min(out.length, Math.ceil(seconds * sampleRate))
  const filter = new Biquad(sampleRate)
  filter.highpass(3000, 0.8)
  for (let i = 0; i < length; i++) {
    const progress = i / length
    out[i]! += filter.process(noise.next()) * Math.pow(progress, 2.4) * velocity
  }
}

function renderSweep(out: Float32Array, sampleRate: number, noise: Noise, velocity: number): void {
  const length = Math.min(out.length, Math.ceil(1.5 * sampleRate))
  const filter = new Biquad(sampleRate)
  const line = new DelayLine(1024)
  const chunk = 128
  for (let i = 0; i < length; i += chunk) {
    const progress = i / length
    filter.bandpass(300 + Math.pow(progress, 2) * 7000, 2.2)
    const end = Math.min(length, i + chunk)
    for (let j = i; j < end; j++) {
      const value = filter.process(noise.next())
      line.write(value)
      out[j]! += (value + line.read(220) * 0.4) * progress * velocity * 0.8
    }
  }
}
