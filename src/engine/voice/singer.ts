/**
 * Singing voice synthesiser.
 *
 * A source-filter model: a glottal pulse train (with jitter, shimmer and
 * vibrato) drives a bank of resonant band-pass filters set to the formants of
 * whatever phoneme is currently sounding. Consonants are rendered as noise
 * bursts, stops and nasal resonances between the vowels. Everything is
 * generated from first principles, so it runs offline with no voice model to
 * download.
 */

import { midiToFreq, clamp, lerp } from '../core/units'
import { Rng } from '../core/rng'
import { Biquad, fastSin, fastTanh, Noise } from '../synth/dsp'
import type { Consonant, Syllable } from './phonemes'
import {
  CONSONANTS, DIPHTHONG_TARGET, vowelFormants, VOICE_CENTER,
  type Formant, type VoiceType,
} from './formants'

export interface SingStyle {
  voice: VoiceType
  /** Vibrato depth in cents. */
  vibratoDepth: number
  vibratoRate: number
  /** Seconds before vibrato reaches full depth. */
  vibratoOnset: number
  /** 0..1 — breathiness mixed into the glottal source. */
  breathiness: number
  /** 0..1 — how hard the voice is pushed; adds harmonics and brightness. */
  power: number
  /** 0..1 — random pitch/amplitude variation; 0 is robotic. */
  humanize: number
  /** Semitone scoop into the start of a note. */
  scoop: number
}

export const SING_PRESETS: Record<string, SingStyle> = {
  pop: { voice: 'alto', vibratoDepth: 22, vibratoRate: 5.4, vibratoOnset: 0.28, breathiness: 0.22, power: 0.6, humanize: 0.5, scoop: 0.5 },
  soft: { voice: 'androgynous', vibratoDepth: 14, vibratoRate: 4.8, vibratoOnset: 0.35, breathiness: 0.4, power: 0.35, humanize: 0.45, scoop: 0.3 },
  power: { voice: 'tenor', vibratoDepth: 30, vibratoRate: 5.8, vibratoOnset: 0.2, breathiness: 0.12, power: 0.9, humanize: 0.55, scoop: 0.8 },
  soprano: { voice: 'soprano', vibratoDepth: 34, vibratoRate: 5.6, vibratoOnset: 0.25, breathiness: 0.18, power: 0.7, humanize: 0.5, scoop: 0.4 },
  baritone: { voice: 'baritone', vibratoDepth: 18, vibratoRate: 5, vibratoOnset: 0.3, breathiness: 0.16, power: 0.65, humanize: 0.5, scoop: 0.5 },
  bass: { voice: 'bass', vibratoDepth: 14, vibratoRate: 4.6, vibratoOnset: 0.35, breathiness: 0.14, power: 0.7, humanize: 0.45, scoop: 0.4 },
  rap: { voice: 'baritone', vibratoDepth: 4, vibratoRate: 4, vibratoOnset: 0.6, breathiness: 0.3, power: 0.55, humanize: 0.7, scoop: 0.2 },
  choir: { voice: 'alto', vibratoDepth: 26, vibratoRate: 5, vibratoOnset: 0.4, breathiness: 0.3, power: 0.45, humanize: 0.6, scoop: 0.25 },
  robot: { voice: 'androgynous', vibratoDepth: 0, vibratoRate: 0, vibratoOnset: 1, breathiness: 0.05, power: 0.6, humanize: 0, scoop: 0 },
}

export const SING_PRESET_NAMES = Object.keys(SING_PRESETS)

/** Formant coefficients are refreshed every 32 samples (~0.7 ms). */
const FORMANT_UPDATE_SAMPLES = 32

export interface SungNoteRequest {
  midi: number
  /** Held duration in seconds. */
  duration: number
  velocity: number
  /**
   * The sounds to sing. Null means this note continues the syllable before it,
   * which is what a melisma is.
   */
  sounds: Syllable | null
  sampleRate: number
  style: SingStyle
  seed: number
  /** True when the note continues the previous syllable (melisma or slur). */
  legato: boolean
}

/** Formant filter bank; one band-pass per resonance, summed. */
class FormantBank {
  private readonly filters: Biquad[]
  private current: Formant[]

  constructor(private readonly sampleRate: number, initial: Formant[]) {
    this.current = initial.map((f) => ({ ...f }))
    this.filters = initial.map(() => new Biquad(sampleRate))
    this.applyCoefficients()
  }

  /** Moves the resonances toward `target` by factor `amount` (0..1). */
  glideTo(target: Formant[], amount: number): void {
    for (let i = 0; i < this.current.length; i++) {
      const to = target[i] ?? this.current[i]!
      const from = this.current[i]!
      from.freq = lerp(from.freq, to.freq, amount)
      from.bandwidth = lerp(from.bandwidth, to.bandwidth, amount)
      from.amp = lerp(from.amp, to.amp, amount)
    }
    this.applyCoefficients()
  }

  private applyCoefficients(): void {
    for (let i = 0; i < this.filters.length; i++) {
      const formant = this.current[i]!
      const q = Math.max(0.5, formant.freq / Math.max(20, formant.bandwidth))
      this.filters[i]!.bandpass(clamp(formant.freq, 60, this.sampleRate * 0.45), q)
    }
  }

  process(input: number): number {
    let sum = 0
    for (let i = 0; i < this.filters.length; i++) {
      sum += this.filters[i]!.process(input) * this.current[i]!.amp
    }
    return sum
  }
}

/**
 * Rosenberg glottal pulse: the derivative-of-glottal-flow shape that gives a
 * voiced source its characteristic spectrum. `phase` runs 0..1 per period.
 */
function glottalPulse(phase: number, openQuotient: number): number {
  const open = clamp(openQuotient, 0.3, 0.9)
  const closeStart = open * 0.7
  if (phase < closeStart) {
    const x = phase / closeStart
    return 3 * x * x - 2 * x * x * x
  }
  if (phase < open) {
    const x = (phase - closeStart) / (open - closeStart)
    return 1 - x * x
  }
  return 0
}

interface Segment {
  /** Duration in seconds. */
  seconds: number
  formants: Formant[]
  /** 0 = pure noise, 1 = pure voiced source. */
  voicing: number
  /** Noise band for fricatives and bursts. */
  noiseHz: number
  noiseQ: number
  noiseLevel: number
  /** Overall level for this segment. */
  level: number
  /** Silence before a stop's burst. */
  closure?: boolean
}

/**
 * A trill is the tongue tip bouncing, so the sound is a run of taps rather than
 * one steady constriction: alternating loud and quiet segments at the trill's
 * own rate is what the ear hears as a rolled r.
 */
function trillSegments(
  rateHz: number, seconds: number, formants: Formant[], spec: { noiseHz: number; noiseQ: number },
): Segment[] {
  const taps = Math.max(2, Math.round(seconds * rateHz))
  const step = seconds / (taps * 2)
  const segments: Segment[] = []
  for (let i = 0; i < taps; i++) {
    segments.push({ seconds: step, formants, voicing: 1, noiseHz: spec.noiseHz, noiseQ: spec.noiseQ, noiseLevel: 0.02, level: 0.28 })
    segments.push({ seconds: step, formants, voicing: 1, noiseHz: spec.noiseHz, noiseQ: spec.noiseQ, noiseLevel: 0.02, level: 0.95 })
  }
  return segments
}

function consonantSegments(
  phoneme: Consonant,
  vowelFormantSet: Formant[],
  rate: number,
  position: 'onset' | 'coda',
): Segment[] {
  const spec = CONSONANTS[phoneme]
  const seconds = spec.duration * rate
  const formants = spec.formants ?? vowelFormantSet

  switch (spec.kind) {
    case 'stop':
      return [
        { seconds: seconds * 0.55, formants, voicing: spec.voiced ? 0.35 : 0, noiseHz: spec.noiseHz, noiseQ: spec.noiseQ, noiseLevel: 0, level: spec.voiced ? 0.12 : 0, closure: true },
        { seconds: seconds * 0.45, formants, voicing: spec.voiced ? 0.5 : 0, noiseHz: spec.noiseHz, noiseQ: spec.noiseQ, noiseLevel: 0.65, level: 0.75 },
      ]
    case 'affricate':
      return [
        { seconds: seconds * 0.3, formants, voicing: spec.voiced ? 0.3 : 0, noiseHz: spec.noiseHz, noiseQ: spec.noiseQ, noiseLevel: 0, level: 0, closure: true },
        { seconds: seconds * 0.7, formants, voicing: spec.voiced ? 0.4 : 0, noiseHz: spec.noiseHz, noiseQ: spec.noiseQ, noiseLevel: 0.7, level: 0.7 },
      ]
    case 'fricative':
      return [{ seconds, formants, voicing: spec.voiced ? 0.45 : 0, noiseHz: spec.noiseHz, noiseQ: spec.noiseQ, noiseLevel: spec.voiced ? 0.45 : 0.6, level: 0.6 }]
    case 'aspirate':
      return [{ seconds, formants: vowelFormantSet, voicing: 0, noiseHz: spec.noiseHz, noiseQ: spec.noiseQ, noiseLevel: 0.4, level: 0.45 }]
    case 'nasal':
      return [{ seconds, formants, voicing: 1, noiseHz: spec.noiseHz, noiseQ: spec.noiseQ, noiseLevel: 0.02, level: position === 'coda' ? 0.7 : 0.8 }]
    case 'liquid':
    case 'glide':
      if (spec.trill !== undefined) return trillSegments(spec.trill, seconds, formants, spec)
      return [{ seconds, formants, voicing: 1, noiseHz: spec.noiseHz, noiseQ: spec.noiseQ, noiseLevel: 0.02, level: 0.85 }]
  }
}

/**
 * Builds the segment timeline for one sung note. Consonants take fixed time at
 * the edges; the vowel stretches to fill whatever is left, which is exactly how
 * singing works.
 */
export function planSegments(request: SungNoteRequest): Segment[] {
  const { sounds, duration, style } = request
  const rate = clamp(duration / 0.45, 0.55, 1.5)

  if (!sounds || request.legato) {
    // A continuation: hold the previous vowel colour. The renderer supplies it.
    const formants = vowelFormants('AH', style.voice)
    return [{ seconds: duration, formants, voicing: 1, noiseHz: 1200, noiseQ: 1, noiseLevel: 0.02, level: 1 }]
  }

  const vowelSet = vowelFormants(sounds.vowel, style.voice)
  const segments: Segment[] = []

  for (const consonant of sounds.onset) {
    segments.push(...consonantSegments(consonant, vowelSet, rate, 'onset'))
  }
  const codaSegments: Segment[] = []
  for (const consonant of sounds.coda) {
    codaSegments.push(...consonantSegments(consonant, vowelSet, rate, 'coda'))
  }

  const consonantTime = [...segments, ...codaSegments].reduce((sum, s) => sum + s.seconds, 0)
  // The vowel always keeps at least a third of the note.
  const vowelSeconds = Math.max(duration * 0.34, duration - consonantTime)
  const scale = consonantTime > 0 && consonantTime + vowelSeconds > duration
    ? Math.max(0.3, (duration - vowelSeconds) / consonantTime)
    : 1
  for (const segment of [...segments, ...codaSegments]) segment.seconds *= scale

  // Diphthongs glide toward a second vowel position across the held vowel. The
  // language may have named the second target itself, as Spanish and Finnish
  // spell theirs out; English writes them as one letter, so the table supplies
  // the target instead.
  const target = sounds.glide ?? DIPHTHONG_TARGET[sounds.vowel]
  if (target) {
    segments.push({ seconds: vowelSeconds * 0.6, formants: vowelSet, voicing: 1, noiseHz: 1200, noiseQ: 1, noiseLevel: 0.02, level: 1 })
    segments.push({ seconds: vowelSeconds * 0.4, formants: vowelFormants(target, style.voice), voicing: 1, noiseHz: 1200, noiseQ: 1, noiseLevel: 0.02, level: 1 })
  } else {
    segments.push({ seconds: vowelSeconds, formants: vowelSet, voicing: 1, noiseHz: 1200, noiseQ: 1, noiseLevel: 0.02, level: 1 })
  }

  segments.push(...codaSegments)
  return segments
}

/** Total rendered length of a sung note, including its release. */
export function sungNoteLength(request: SungNoteRequest): number {
  return Math.ceil((request.duration + 0.12) * request.sampleRate)
}

/** Renders one sung note into a mono buffer. */
export function renderSungNote(request: SungNoteRequest): Float32Array {
  const { sampleRate, style, velocity } = request
  const segments = planSegments(request)
  const length = sungNoteLength(request)
  const out = new Float32Array(length)
  const rng = new Rng(request.seed || 11)
  const noise = new Noise((request.seed || 11) ^ 0x5f3a)

  const bank = new FormantBank(sampleRate, segments[0]!.formants)
  const noiseFilter = new Biquad(sampleRate)
  noiseFilter.bandpass(segments[0]!.noiseHz, segments[0]!.noiseQ)
  // Radiation from the lips differentiates the flow: +6 dB per octave across
  // the whole band. Modelling it as a high-pass leaves the upper formants with
  // no source energy to shape, which is what makes formant synthesis sound
  // like it is speaking through a pillow.
  let radiationPrevious = 0
  const radiate = (sample: number): number => {
    const out = sample - 0.97 * radiationPrevious
    radiationPrevious = sample
    return out
  }

  const baseFreq = midiToFreq(request.midi)
  // Slight per-note detune keeps a doubled vocal from sounding like one voice.
  const detune = rng.normal(0, 4 * style.humanize)
  const openQuotient = 0.75 - style.power * 0.28

  let phase = 0
  let segmentIndex = 0
  let segmentStart = 0
  let jitter = 0
  let shimmer = 1

  const attack = 0.018
  const release = 0.09
  const holdSeconds = request.duration

  for (let i = 0; i < length; i++) {
    const t = i / sampleRate

    // Advance the segment timeline.
    while (
      segmentIndex < segments.length - 1 &&
      t >= segmentStart + segments[segmentIndex]!.seconds
    ) {
      segmentStart += segments[segmentIndex]!.seconds
      segmentIndex++
      const next = segments[segmentIndex]!
      noiseFilter.bandpass(next.noiseHz, next.noiseQ)
    }
    const segment = segments[Math.min(segmentIndex, segments.length - 1)]!
    // Formants glide rather than jump — abrupt switches sound like clicks.
    // The glide is stepped at control rate; recomputing four band-pass filters
    // every sample would dominate the render time and is inaudible anyway.
    if ((i & (FORMANT_UPDATE_SAMPLES - 1)) === 0) {
      bank.glideTo(segment.formants, 0.22)
    }

    // --- Pitch ------------------------------------------------------------
    let cents = detune
    if (style.vibratoDepth > 0) {
      const onset = clamp((t - style.vibratoOnset) / 0.35, 0, 1)
      cents += fastSin(style.vibratoRate * t) * style.vibratoDepth * onset
    }
    if (style.scoop > 0 && t < 0.09) {
      cents -= style.scoop * 100 * (1 - t / 0.09) * (1 - t / 0.09)
    }
    if (style.humanize > 0) {
      // Slow drift plus fast jitter, both small — this is what stops the voice
      // from sounding like a synthesiser holding a perfect pitch.
      jitter = jitter * 0.9995 + rng.normal(0, 0.6 * style.humanize) * 0.0005
      cents += jitter * 100 + rng.normal(0, 1.2 * style.humanize)
      shimmer = shimmer * 0.9998 + (1 + rng.normal(0, 0.05 * style.humanize)) * 0.0002
    }
    const freq = baseFreq * Math.pow(2, cents / 1200)

    // --- Source -----------------------------------------------------------
    phase += freq / sampleRate
    if (phase >= 1) phase -= 1
    const voiced = glottalPulse(phase, openQuotient) * 2 - 0.6
    const breath = noise.next() * (style.breathiness * 0.35 + segment.noiseLevel)
    const source = voiced * segment.voicing + noiseFilter.process(breath) * (segment.noiseLevel > 0.05 ? 1 : 0.35)

    // --- Filter and envelope ---------------------------------------------
    let sample = bank.process(source)
    sample = radiate(sample)

    let amp: number
    if (t < attack) amp = t / attack
    else if (t < holdSeconds) amp = 1
    else {
      const phaseOut = (t - holdSeconds) / release
      amp = phaseOut >= 1 ? 0 : (1 - phaseOut) * (1 - phaseOut)
    }

    out[i] = sample * amp * segment.level * velocity * shimmer * (0.5 + style.power * 0.6)
  }

  // A gentle push through tanh adds the harmonic richness a real voice has.
  const driveAmount = 1 + style.power * 1.6
  let peak = 0
  for (let i = 0; i < length; i++) {
    const value = fastTanh(out[i]! * driveAmount) / driveAmount
    out[i] = value
    const magnitude = Math.abs(value)
    if (magnitude > peak) peak = magnitude
  }

  // Level every note to the same peak, scaled by velocity. The differentiator
  // modelling lip radiation attenuates by 20 dB or more at the pitches people
  // sing at, and the amount depends on the vowel and the note — so a fixed
  // makeup gain would leave the line lurching in volume from word to word.
  if (peak > 1e-6) {
    const target = 0.92 * velocity
    const scale = target / peak
    for (let i = 0; i < length; i++) out[i]! *= scale
  }

  return out
}

export { VOICE_CENTER }
export type { VoiceType }
