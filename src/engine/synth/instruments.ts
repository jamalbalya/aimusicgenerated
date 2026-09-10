/**
 * Instrument voices. Each renders one note into its own buffer, which the
 * renderer then mixes into the track. Every voice is a real synthesis model —
 * subtractive, FM, additive or Karplus-Strong — so nothing here needs samples
 * to download.
 */

import { midiToFreq } from '../core/units'
import {
  adsrValue, Biquad, DelayLine, envelopeLength, fastSin, Noise, oscillator, saturate,
  type AdsrParams, type Waveform,
} from './dsp'
import type { InstrumentId } from '../compose/types'

export interface VoiceRequest {
  midi: number
  /** Held length in seconds, before the release tail. */
  duration: number
  velocity: number
  sampleRate: number
  /** 0..1 — genre brightness, opens or closes the voice's filter. */
  brightness: number
  /** Deterministic per-note seed. */
  seed: number
}

interface Patch {
  env: AdsrParams
  /** Oscillator layers: waveform, detune in cents, relative level. */
  layers: { wave: Waveform; detune: number; level: number; octave?: number; pulseWidth?: number }[]
  /** Base filter cutoff in Hz before brightness and key tracking. */
  cutoff: number
  resonance: number
  /** How far the filter envelope opens the cutoff, in octaves. */
  filterEnv: number
  /** Per-voice saturation. */
  drive: number
  /** Amount of noise mixed in at the attack (breath, pick, hammer). */
  noiseAttack: number
  /** Vibrato depth in cents and rate in Hz. */
  vibrato?: { depth: number; rate: number; delay: number }
  /** Uses Karplus-Strong instead of the oscillator bank. */
  plucked?: boolean
  /** FM operator: ratio and index. */
  fm?: { ratio: number; index: number; decay: number }
  /** Additive partial levels, for bells and pianos. */
  partials?: number[]
}

const PATCHES: Record<InstrumentId, Patch> = {
  grandPiano: {
    env: { attack: 0.002, decay: 1.4, sustain: 0.22, release: 0.5 },
    layers: [{ wave: 'sine', detune: 0, level: 1 }],
    partials: [1, 0.5, 0.32, 0.18, 0.12, 0.07, 0.05, 0.03],
    cutoff: 5200, resonance: 0.6, filterEnv: 1.4, drive: 0.06, noiseAttack: 0.06,
  },
  electricPiano: {
    env: { attack: 0.004, decay: 1.1, sustain: 0.28, release: 0.5 },
    layers: [{ wave: 'sine', detune: 0, level: 1 }],
    fm: { ratio: 3.02, index: 2.6, decay: 0.35 },
    cutoff: 4200, resonance: 0.5, filterEnv: 0.9, drive: 0.1, noiseAttack: 0.02,
  },
  organ: {
    env: { attack: 0.012, decay: 0.1, sustain: 0.92, release: 0.12 },
    layers: [{ wave: 'sine', detune: 0, level: 1 }],
    partials: [1, 0.7, 0.5, 0, 0.35, 0, 0.2, 0.14],
    cutoff: 6000, resonance: 0.4, filterEnv: 0.2, drive: 0.18, noiseAttack: 0,
  },
  nylonGuitar: {
    env: { attack: 0.003, decay: 0.9, sustain: 0.05, release: 0.35 },
    layers: [{ wave: 'saw', detune: 0, level: 1 }],
    plucked: true,
    cutoff: 3200, resonance: 0.7, filterEnv: 1.2, drive: 0.08, noiseAttack: 0.22,
  },
  cleanGuitar: {
    env: { attack: 0.002, decay: 1.2, sustain: 0.08, release: 0.3 },
    layers: [{ wave: 'saw', detune: 0, level: 1 }],
    plucked: true,
    cutoff: 4200, resonance: 0.9, filterEnv: 1.4, drive: 0.14, noiseAttack: 0.18,
  },
  crunchGuitar: {
    env: { attack: 0.004, decay: 0.5, sustain: 0.5, release: 0.22 },
    layers: [{ wave: 'saw', detune: -7, level: 0.7 }, { wave: 'saw', detune: 7, level: 0.7 }, { wave: 'square', detune: 0, level: 0.4 }],
    cutoff: 2800, resonance: 1.1, filterEnv: 0.9, drive: 0.55, noiseAttack: 0.1,
  },
  distortedGuitar: {
    env: { attack: 0.005, decay: 0.4, sustain: 0.62, release: 0.2 },
    layers: [{ wave: 'saw', detune: -9, level: 0.8 }, { wave: 'saw', detune: 9, level: 0.8 }, { wave: 'square', detune: 0, level: 0.5, octave: -1 }],
    cutoff: 2400, resonance: 1.3, filterEnv: 0.7, drive: 0.85, noiseAttack: 0.06,
  },
  acousticBass: {
    env: { attack: 0.006, decay: 0.7, sustain: 0.2, release: 0.25 },
    layers: [{ wave: 'triangle', detune: 0, level: 1 }],
    plucked: true,
    cutoff: 1400, resonance: 0.6, filterEnv: 1.1, drive: 0.12, noiseAttack: 0.14,
  },
  electricBass: {
    env: { attack: 0.004, decay: 0.5, sustain: 0.55, release: 0.2 },
    layers: [{ wave: 'saw', detune: 0, level: 0.7 }, { wave: 'triangle', detune: 0, level: 0.6 }],
    cutoff: 1600, resonance: 0.9, filterEnv: 1.5, drive: 0.28, noiseAttack: 0.05,
  },
  subBass: {
    env: { attack: 0.006, decay: 0.4, sustain: 0.85, release: 0.35 },
    layers: [{ wave: 'sine', detune: 0, level: 1 }],
    cutoff: 900, resonance: 0.4, filterEnv: 0.6, drive: 0.35, noiseAttack: 0.02,
  },
  synthBass: {
    env: { attack: 0.004, decay: 0.3, sustain: 0.6, release: 0.16 },
    layers: [{ wave: 'saw', detune: -5, level: 0.8 }, { wave: 'square', detune: 5, level: 0.5 }],
    cutoff: 1300, resonance: 1.4, filterEnv: 2, drive: 0.3, noiseAttack: 0,
  },
  reeseBass: {
    env: { attack: 0.01, decay: 0.3, sustain: 0.75, release: 0.2 },
    layers: [{ wave: 'saw', detune: -14, level: 0.8 }, { wave: 'saw', detune: 14, level: 0.8 }, { wave: 'saw', detune: 0, level: 0.5, octave: -1 }],
    cutoff: 1100, resonance: 1.6, filterEnv: 1.6, drive: 0.45, noiseAttack: 0,
  },
  sawLead: {
    env: { attack: 0.01, decay: 0.25, sustain: 0.72, release: 0.22 },
    layers: [{ wave: 'saw', detune: -8, level: 0.7 }, { wave: 'saw', detune: 8, level: 0.7 }, { wave: 'saw', detune: 0, level: 0.6 }],
    cutoff: 3400, resonance: 1.2, filterEnv: 1.8, drive: 0.28, noiseAttack: 0,
    vibrato: { depth: 14, rate: 5.2, delay: 0.25 },
  },
  squareLead: {
    env: { attack: 0.006, decay: 0.2, sustain: 0.7, release: 0.16 },
    layers: [{ wave: 'pulse', detune: 0, level: 0.9, pulseWidth: 0.35 }, { wave: 'pulse', detune: 6, level: 0.4, pulseWidth: 0.2 }],
    cutoff: 3800, resonance: 1, filterEnv: 1.5, drive: 0.2, noiseAttack: 0,
    vibrato: { depth: 12, rate: 5.6, delay: 0.2 },
  },
  pluck: {
    env: { attack: 0.002, decay: 0.32, sustain: 0.02, release: 0.22 },
    layers: [{ wave: 'saw', detune: 0, level: 1 }],
    cutoff: 4200, resonance: 1.6, filterEnv: 2.6, drive: 0.15, noiseAttack: 0.08,
  },
  bell: {
    env: { attack: 0.003, decay: 1.6, sustain: 0.06, release: 1.1 },
    layers: [{ wave: 'sine', detune: 0, level: 1 }],
    partials: [1, 0, 0.6, 0, 0.35, 0.2, 0, 0.12],
    fm: { ratio: 3.51, index: 3.2, decay: 0.9 },
    cutoff: 7000, resonance: 0.4, filterEnv: 0.6, drive: 0.04, noiseAttack: 0.02,
  },
  marimba: {
    env: { attack: 0.002, decay: 0.42, sustain: 0.02, release: 0.28 },
    layers: [{ wave: 'sine', detune: 0, level: 1 }],
    partials: [1, 0, 0, 0.42, 0, 0, 0, 0.12],
    cutoff: 4600, resonance: 0.5, filterEnv: 1, drive: 0.05, noiseAttack: 0.12,
  },
  warmPad: {
    env: { attack: 0.55, decay: 1.2, sustain: 0.72, release: 1.4 },
    layers: [{ wave: 'saw', detune: -11, level: 0.55 }, { wave: 'saw', detune: 11, level: 0.55 }, { wave: 'triangle', detune: 0, level: 0.5 }],
    cutoff: 1900, resonance: 0.7, filterEnv: 1.1, drive: 0.06, noiseAttack: 0,
  },
  glassPad: {
    env: { attack: 0.4, decay: 1.4, sustain: 0.66, release: 1.8 },
    layers: [{ wave: 'saw', detune: -6, level: 0.5 }, { wave: 'sine', detune: 0, level: 0.5, octave: 1 }, { wave: 'triangle', detune: 6, level: 0.4 }],
    cutoff: 3200, resonance: 0.9, filterEnv: 1.4, drive: 0.04, noiseAttack: 0.03,
  },
  choirPad: {
    env: { attack: 0.4, decay: 1, sustain: 0.78, release: 1.6 },
    layers: [{ wave: 'saw', detune: -8, level: 0.5 }, { wave: 'saw', detune: 8, level: 0.5 }],
    cutoff: 1500, resonance: 1.8, filterEnv: 0.7, drive: 0.05, noiseAttack: 0.1,
    vibrato: { depth: 18, rate: 4.6, delay: 0.5 },
  },
  strings: {
    env: { attack: 0.16, decay: 0.7, sustain: 0.78, release: 0.7 },
    layers: [{ wave: 'saw', detune: -9, level: 0.6 }, { wave: 'saw', detune: 4, level: 0.6 }, { wave: 'saw', detune: 12, level: 0.4 }],
    cutoff: 2600, resonance: 0.8, filterEnv: 1, drive: 0.07, noiseAttack: 0.05,
    vibrato: { depth: 16, rate: 5.4, delay: 0.35 },
  },
  brass: {
    env: { attack: 0.055, decay: 0.4, sustain: 0.76, release: 0.32 },
    layers: [{ wave: 'saw', detune: -4, level: 0.7 }, { wave: 'square', detune: 4, level: 0.4 }],
    cutoff: 2200, resonance: 1.1, filterEnv: 2.2, drive: 0.34, noiseAttack: 0.06,
    vibrato: { depth: 10, rate: 5, delay: 0.4 },
  },
  flute: {
    env: { attack: 0.07, decay: 0.3, sustain: 0.8, release: 0.28 },
    layers: [{ wave: 'sine', detune: 0, level: 1 }, { wave: 'triangle', detune: 5, level: 0.18 }],
    cutoff: 3600, resonance: 0.5, filterEnv: 0.8, drive: 0.03, noiseAttack: 0.4,
    vibrato: { depth: 20, rate: 5.6, delay: 0.3 },
  },
  violin: {
    env: { attack: 0.09, decay: 0.4, sustain: 0.8, release: 0.35 },
    layers: [{ wave: 'saw', detune: -3, level: 0.75 }, { wave: 'saw', detune: 3, level: 0.6 }],
    cutoff: 3000, resonance: 1.2, filterEnv: 1.2, drive: 0.12, noiseAttack: 0.14,
    vibrato: { depth: 26, rate: 6, delay: 0.25 },
  },
  cello: {
    env: { attack: 0.1, decay: 0.5, sustain: 0.78, release: 0.5 },
    layers: [{ wave: 'saw', detune: -4, level: 0.8 }, { wave: 'triangle', detune: 4, level: 0.5 }],
    cutoff: 1500, resonance: 1, filterEnv: 1.1, drive: 0.14, noiseAttack: 0.12,
    vibrato: { depth: 20, rate: 5.2, delay: 0.3 },
  },
  harp: {
    env: { attack: 0.002, decay: 1.5, sustain: 0.03, release: 0.9 },
    layers: [{ wave: 'triangle', detune: 0, level: 1 }],
    plucked: true,
    cutoff: 5000, resonance: 0.5, filterEnv: 1.2, drive: 0.03, noiseAttack: 0.12,
  },
  sitar: {
    env: { attack: 0.003, decay: 1.1, sustain: 0.1, release: 0.7 },
    layers: [{ wave: 'saw', detune: 0, level: 1 }],
    plucked: true,
    cutoff: 3400, resonance: 2.2, filterEnv: 1.6, drive: 0.3, noiseAttack: 0.24,
  },
  accordion: {
    env: { attack: 0.05, decay: 0.2, sustain: 0.86, release: 0.2 },
    layers: [{ wave: 'saw', detune: -12, level: 0.5 }, { wave: 'square', detune: 12, level: 0.45 }, { wave: 'saw', detune: 0, level: 0.4 }],
    cutoff: 2800, resonance: 1, filterEnv: 0.6, drive: 0.2, noiseAttack: 0.04,
  },
  chiptune: {
    env: { attack: 0.001, decay: 0.08, sustain: 0.68, release: 0.05 },
    layers: [{ wave: 'pulse', detune: 0, level: 1, pulseWidth: 0.25 }],
    cutoff: 12000, resonance: 0.3, filterEnv: 0, drive: 0.05, noiseAttack: 0,
    vibrato: { depth: 22, rate: 7, delay: 0.12 },
  },
  noiseSweep: {
    env: { attack: 0.6, decay: 0.4, sustain: 0.5, release: 0.6 },
    layers: [{ wave: 'saw', detune: 0, level: 0.2 }],
    cutoff: 1800, resonance: 2.4, filterEnv: 3, drive: 0.1, noiseAttack: 1,
  },
  vocal: {
    // Replaced by the singing synthesiser; kept so the instrument map is total.
    env: { attack: 0.03, decay: 0.3, sustain: 0.8, release: 0.25 },
    layers: [{ wave: 'saw', detune: 0, level: 1 }],
    cutoff: 3000, resonance: 1, filterEnv: 0.6, drive: 0.05, noiseAttack: 0.1,
    vibrato: { depth: 24, rate: 5.4, delay: 0.3 },
  },
}

export function getPatch(instrument: InstrumentId): Patch {
  return PATCHES[instrument] ?? PATCHES.grandPiano
}

export interface InstrumentVoiceRequest extends VoiceRequest {
  instrument: InstrumentId
}

/** Buffer length in samples needed for one note, including its tail. */
export function voiceLength(request: InstrumentVoiceRequest): number {
  const patch = getPatch(request.instrument)
  return Math.ceil(envelopeLength(request.duration, patch.env) * request.sampleRate) + 4
}

/** Renders one note and returns its mono buffer. */
export function renderVoice(request: InstrumentVoiceRequest): Float32Array {
  const patch = getPatch(request.instrument)
  const { sampleRate, midi, duration, velocity } = request
  const totalSeconds = envelopeLength(duration, patch.env)
  const length = Math.max(4, Math.ceil(totalSeconds * sampleRate))
  const out = new Float32Array(length)
  const freq = midiToFreq(midi)
  const noise = new Noise(request.seed || 1)

  if (patch.plucked) {
    renderPlucked(out, freq, duration, velocity, sampleRate, patch, noise)
  } else {
    renderOscillators(out, freq, duration, velocity, sampleRate, patch, noise)
  }

  // Voice filter with its own envelope; key tracking keeps high notes bright.
  const filter = new Biquad(sampleRate)
  const keyTrack = Math.pow(2, (midi - 60) / 24)
  const baseCutoff = patch.cutoff * keyTrack * (0.55 + request.brightness * 0.9)
  const envAmount = Math.pow(2, patch.filterEnv)
  // Recomputing filter coefficients every 256 samples is inaudible and keeps
  // the trig cost off the per-sample path.
  const chunk = 256
  for (let i = 0; i < length; i += chunk) {
    const t = i / sampleRate
    const env = adsrValue(t, duration, patch.env)
    const cutoff = Math.min(sampleRate * 0.45, baseCutoff * (1 + (envAmount - 1) * env))
    filter.lowpass(cutoff, 0.707 + patch.resonance)
    const end = Math.min(length, i + chunk)
    for (let j = i; j < end; j++) out[j] = filter.process(out[j]!)
  }

  if (patch.drive > 0) {
    for (let i = 0; i < length; i++) out[i] = saturate(out[i]!, patch.drive)
  }

  return out
}

function renderOscillators(
  out: Float32Array,
  freq: number,
  duration: number,
  velocity: number,
  sampleRate: number,
  patch: Patch,
  noise: Noise,
): void {
  const length = out.length
  const layers = patch.layers
  const partials = patch.partials
  const hasFm = patch.fm !== undefined

  // Hoist everything the inner loop needs into flat arrays. This is the
  // hottest loop in the whole renderer — a pad can be several million samples.
  const nyquistLimit = sampleRate * 0.49
  const layerCount = layers.length
  const layerWave: Waveform[] = new Array(layerCount)
  const layerLevel = new Float32Array(layerCount)
  const layerPulse = new Float32Array(layerCount)
  const layerRatio = new Float32Array(layerCount)
  let levelSum = 0
  for (let l = 0; l < layerCount; l++) {
    const layer = layers[l]!
    layerWave[l] = layer.wave
    layerLevel[l] = layer.level
    layerPulse[l] = layer.pulseWidth ?? 0.5
    layerRatio[l] = Math.pow(2, (layer.octave ?? 0)) * Math.pow(2, layer.detune / 1200)
    levelSum += layer.level
  }
  if (levelSum <= 0) levelSum = 1
  const invLevelSum = 1 / levelSum

  const phases = new Float64Array(layerCount)
  // Compact the partial table: silent harmonics (an organ drawbar that is
  // pulled out, a bell's missing even partials) should cost nothing per sample.
  let partialCount = 0
  let partialPhases: Float64Array | null = null
  let partialLevel: Float32Array | null = null
  let partialHarmonic: Float32Array | null = null
  let partialDecay: Float32Array | null = null
  let partialDecayStep: Float32Array | null = null
  if (partials) {
    const active: { level: number; harmonic: number; rate: number }[] = []
    for (let p = 0; p < partials.length; p++) {
      const level = partials[p]!
      if (level <= 0) continue
      if (freq * (p + 1) > nyquistLimit) break
      active.push({ level, harmonic: p + 1, rate: 0.6 + p * 0.55 })
    }
    partialCount = active.length
    partialPhases = new Float64Array(partialCount)
    partialLevel = Float32Array.from(active, (a) => a.level)
    partialHarmonic = Float32Array.from(active, (a) => a.harmonic)
    partialDecay = new Float32Array(partialCount).fill(1)
    partialDecayStep = Float32Array.from(active, (a) => Math.exp(-a.rate / sampleRate))
  }

  let fmPhase = 0
  const fmRatio = patch.fm?.ratio ?? 1
  const fmIndex = patch.fm?.index ?? 0
  const fmDecayStep = patch.fm ? Math.exp(-1 / (Math.max(0.02, patch.fm.decay) * sampleRate)) : 1
  let fmDepth = fmIndex

  const noiseFilter = new Biquad(sampleRate)
  noiseFilter.bandpass(Math.min(freq * 2.5, sampleRate * 0.4), 1.4)
  const noiseAttack = patch.noiseAttack
  const sustainedBreath = noiseAttack > 0.5
  const noiseDecayStep = Math.exp(-45 / sampleRate)
  let noiseEnvelope = 1

  const vibrato = patch.vibrato
  const nyquist = nyquistLimit
  const invSampleRate = 1 / sampleRate

  // The amplitude envelope moves slowly; evaluating it every 16 samples and
  // interpolating removes a branchy function call from the per-sample path.
  const ENV_STEP = 16
  let envValue = adsrValue(0, duration, patch.env)
  let envTarget = envValue
  let envSlope = 0

  for (let i = 0; i < length; i++) {
    if ((i % ENV_STEP) === 0) {
      envValue = envTarget
      envTarget = adsrValue((i + ENV_STEP) * invSampleRate, duration, patch.env)
      envSlope = (envTarget - envValue) / ENV_STEP
      if (envValue <= 0 && envTarget <= 0 && i * invSampleRate > duration) break
    }
    const amp = envValue + envSlope * (i % ENV_STEP)
    const t = i * invSampleRate

    let pitchScale = 1
    if (vibrato) {
      const onset = t - vibrato.delay
      if (onset > 0) {
        const depth = vibrato.depth * (onset < 0.4 ? onset / 0.4 : 1)
        pitchScale = Math.pow(2, (fastSin(vibrato.rate * t) * depth) / 1200)
      }
    }

    let sample = 0

    if (partialPhases && partialLevel && partialHarmonic && partialDecay && partialDecayStep) {
      const fundamental = freq * pitchScale * invSampleRate
      for (let p = 0; p < partialCount; p++) {
        const decay = partialDecay[p]! * partialDecayStep[p]!
        partialDecay[p] = decay
        let phase = partialPhases[p]! + fundamental * partialHarmonic[p]!
        if (phase >= 1) phase -= 1
        partialPhases[p] = phase
        sample += fastSin(phase) * partialLevel[p]! * decay
      }
      sample *= 0.6
    }

    if (hasFm) {
      fmDepth *= fmDecayStep
      let modPhase = fmPhase + freq * fmRatio * pitchScale * invSampleRate
      if (modPhase >= 1) modPhase -= 1
      fmPhase = modPhase
      let carrier = phases[0]! + freq * pitchScale * invSampleRate
      if (carrier >= 1) carrier -= 1
      phases[0] = carrier
      sample += fastSin(carrier + fastSin(modPhase) * fmDepth * 0.15915494) * 0.7
    }

    if (partialCount === 0 && !hasFm) {
      for (let l = 0; l < layerCount; l++) {
        const layerFreq = freq * pitchScale * layerRatio[l]!
        if (layerFreq > nyquist) continue
        const increment = layerFreq * invSampleRate
        let phase = phases[l]! + increment
        if (phase >= 1) phase -= 1
        phases[l] = phase
        sample += oscillator(layerWave[l]!, phase, increment, layerPulse[l]!) * layerLevel[l]!
      }
      sample *= invLevelSum
    }

    if (noiseAttack > 0) {
      noiseEnvelope *= noiseDecayStep
      const breath = sustainedBreath ? noiseAttack * 0.35 : noiseAttack * noiseEnvelope
      sample += noiseFilter.process(noise.next()) * breath
    }

    out[i] = sample * amp * velocity
  }
}

/**
 * Karplus-Strong: an excitation burst fed through a delay line with a damping
 * filter. Cheap, and it sounds far more like a real string than any
 * oscillator stack.
 */
function renderPlucked(
  out: Float32Array,
  freq: number,
  duration: number,
  velocity: number,
  sampleRate: number,
  patch: Patch,
  noise: Noise,
): void {
  const length = out.length
  const delaySamples = Math.max(2, sampleRate / freq)
  const line = new DelayLine(Math.ceil(delaySamples) + 4)
  const burst = Math.ceil(delaySamples)
  let previous = 0
  // Damping controls how fast the harmonics die away.
  const damping = 0.5 + Math.min(0.46, patch.env.decay * 0.14)

  for (let i = 0; i < length; i++) {
    const t = i / sampleRate
    const input = i < burst ? noise.next() * (0.6 + patch.noiseAttack * 0.6) : 0
    const delayed = line.read(delaySamples)
    const filtered = delayed * damping + previous * (1 - damping)
    previous = filtered
    const value = input + filtered * 0.995
    line.write(value)
    const amp = adsrValue(t, duration, patch.env)
    out[i] = value * velocity * amp * 0.8
  }
}
