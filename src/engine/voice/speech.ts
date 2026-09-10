/**
 * Offline text-to-speech.
 *
 * The browser's own SpeechSynthesis voices sound better, but they cannot be
 * captured to a file in most browsers and are not available at all in some. So
 * the studio also carries this formant speech synthesiser, which shares the
 * singer's vocal-tract model but drives it with a speech prosody contour
 * instead of a melody. It always works, always exports, and never needs a key.
 */

import { clamp, midiToFreq } from '../core/units'
import { Rng } from '../core/rng'
import { Biquad, fastSin, Noise } from '../synth/dsp'
import { syllableToPhonemes, type Consonant, type Vowel } from './phonemes'
import { CONSONANTS, DIPHTHONG_TARGET, vowelFormants, VOICE_CENTER, type Formant, type VoiceType } from './formants'
import { lineSyllables, splitSyllables, tokenizeWords } from '../lyrics/syllables'
import type { AudioData } from '../audio/wav'

export interface SpeechVoice {
  id: string
  label: string
  type: VoiceType
  /** Base pitch in Hz. */
  pitchHz: number
  /** Words per minute. */
  rate: number
  /** 0..1 */
  breathiness: number
  /** Semitone range of the intonation contour. */
  intonation: number
}

export const SPEECH_VOICES: SpeechVoice[] = [
  { id: 'aria', label: 'Aria — bright soprano', type: 'soprano', pitchHz: 232, rate: 165, breathiness: 0.24, intonation: 5 },
  { id: 'nova', label: 'Nova — warm alto', type: 'alto', pitchHz: 196, rate: 158, breathiness: 0.2, intonation: 4.5 },
  { id: 'sage', label: 'Sage — neutral', type: 'androgynous', pitchHz: 168, rate: 160, breathiness: 0.22, intonation: 4 },
  { id: 'atlas', label: 'Atlas — clear tenor', type: 'tenor', pitchHz: 138, rate: 155, breathiness: 0.18, intonation: 4 },
  { id: 'orson', label: 'Orson — deep baritone', type: 'baritone', pitchHz: 112, rate: 145, breathiness: 0.16, intonation: 3.5 },
  { id: 'vale', label: 'Vale — low bass', type: 'bass', pitchHz: 92, rate: 138, breathiness: 0.15, intonation: 3 },
  { id: 'echo', label: 'Echo — whisper', type: 'androgynous', pitchHz: 160, rate: 150, breathiness: 0.85, intonation: 2.5 },
  { id: 'circuit', label: 'Circuit — robotic', type: 'androgynous', pitchHz: 128, rate: 150, breathiness: 0.04, intonation: 0.3 },
]

export interface SpeakOptions {
  voice: SpeechVoice
  /** Multiplier on the voice's base rate; 1 is normal. */
  speed?: number
  /** Pitch offset in semitones. */
  pitchSemitones?: number
  /** 0..1 — how much intonation movement. 0 is monotone. */
  expressiveness?: number
  sampleRate?: number
  seed?: string
}

interface SpeechSegment {
  seconds: number
  formants: Formant[]
  voicing: number
  noiseHz: number
  noiseQ: number
  noiseLevel: number
  level: number
  /** Relative pitch for this segment, in semitones from the base. */
  pitchOffset: number
}

/** Splits text into sentences, keeping the terminator so intonation can use it. */
export function splitSentences(text: string): { text: string; terminator: string }[] {
  const out: { text: string; terminator: string }[] = []
  const pattern = /[^.!?…]+[.!?…]*/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(text)) !== null) {
    const raw = match[0]!.trim()
    if (!raw) continue
    const terminatorMatch = /[.!?…]+$/.exec(raw)
    out.push({
      text: raw.replace(/[.!?…]+$/, '').trim(),
      terminator: terminatorMatch ? terminatorMatch[0]! : '',
    })
  }
  if (out.length === 0 && text.trim()) out.push({ text: text.trim(), terminator: '' })
  return out
}

function consonantSegment(
  phoneme: Consonant,
  vowelSet: Formant[],
  rate: number,
  pitchOffset: number,
): SpeechSegment[] {
  const spec = CONSONANTS[phoneme]
  const seconds = spec.duration * rate
  const formants = spec.formants ?? vowelSet
  const base = { formants, noiseHz: spec.noiseHz, noiseQ: spec.noiseQ, pitchOffset }

  switch (spec.kind) {
    case 'stop':
    case 'affricate':
      return [
        { ...base, seconds: seconds * 0.5, voicing: spec.voiced ? 0.3 : 0, noiseLevel: 0, level: spec.voiced ? 0.1 : 0 },
        { ...base, seconds: seconds * 0.5, voicing: spec.voiced ? 0.45 : 0, noiseLevel: 0.7, level: 0.7 },
      ]
    case 'fricative':
      return [{ ...base, seconds, voicing: spec.voiced ? 0.4 : 0, noiseLevel: spec.voiced ? 0.5 : 0.65, level: 0.55 }]
    case 'aspirate':
      return [{ ...base, formants: vowelSet, seconds, voicing: 0, noiseLevel: 0.45, level: 0.4 }]
    default:
      return [{ ...base, seconds, voicing: 1, noiseLevel: 0.02, level: 0.85 }]
  }
}

/**
 * Builds the segment timeline for a whole utterance, including the pitch
 * contour: a declining baseline across each sentence, a rise on questions,
 * stress on the first syllable of longer words, and pauses at punctuation.
 */
export function planSpeech(text: string, options: SpeakOptions): SpeechSegment[] {
  const voice = options.voice
  const speed = clamp(options.speed ?? 1, 0.4, 3)
  const expressiveness = clamp(options.expressiveness ?? 1, 0, 2)
  const rng = new Rng(options.seed ?? text)

  // Seconds per syllable, derived from words per minute at ~1.4 syllables/word.
  const syllableSeconds = 60 / (voice.rate * speed * 1.4)
  const segments: SpeechSegment[] = []

  for (const sentence of splitSentences(text)) {
    const words = tokenizeWords(sentence.text)
    if (words.length === 0) continue
    const totalSyllables = Math.max(1, lineSyllables(sentence.text).length)
    let syllableIndex = 0

    for (let w = 0; w < words.length; w++) {
      const chunks = splitSyllables(words[w]!)
      for (let c = 0; c < chunks.length; c++) {
        const progress = syllableIndex / totalSyllables
        // Declination: pitch falls gradually through a sentence.
        let pitchOffset = -progress * voice.intonation * 0.55 * expressiveness
        // Stress the first syllable of a multi-syllable word.
        if (c === 0 && chunks.length > 1) pitchOffset += voice.intonation * 0.35 * expressiveness
        // Questions rise on the final syllables.
        if (sentence.terminator.includes('?') && progress > 0.75) {
          pitchOffset += (progress - 0.75) * 4 * voice.intonation * expressiveness
        }
        if (sentence.terminator.includes('!')) pitchOffset += voice.intonation * 0.2 * expressiveness
        pitchOffset += rng.normal(0, 0.35 * expressiveness)

        const parts = syllableToPhonemes(chunks[c]!)
        const vowelSet = vowelFormants(parts.vowel, voice.type)
        const rate = 1

        for (const consonant of parts.onset) {
          segments.push(...consonantSegment(consonant, vowelSet, rate, pitchOffset))
        }

        const consonantTime = parts.onset.length * 0.05 + parts.coda.length * 0.05
        const vowelSeconds = Math.max(0.05, syllableSeconds - consonantTime)
        pushVowel(segments, parts.vowel, voice.type, vowelSeconds, pitchOffset, vowelSet)

        for (const consonant of parts.coda) {
          segments.push(...consonantSegment(consonant, vowelSet, rate, pitchOffset))
        }
        syllableIndex++
      }

      // A short gap between words keeps speech from running together.
      segments.push(silence(syllableSeconds * 0.16))
    }

    // Sentence-final pause, longer after a full stop than a comma.
    segments.push(silence(sentence.terminator ? 0.34 : 0.16))
  }

  if (segments.length === 0) segments.push(silence(0.2))
  return segments
}

function pushVowel(
  segments: SpeechSegment[],
  vowel: Vowel,
  voiceType: VoiceType,
  seconds: number,
  pitchOffset: number,
  vowelSet: Formant[],
): void {
  const target = DIPHTHONG_TARGET[vowel]
  const common = { voicing: 1, noiseHz: 1200, noiseQ: 1, noiseLevel: 0.02, level: 1, pitchOffset }
  if (target) {
    segments.push({ ...common, seconds: seconds * 0.6, formants: vowelSet })
    segments.push({ ...common, seconds: seconds * 0.4, formants: vowelFormants(target, voiceType) })
  } else {
    segments.push({ ...common, seconds, formants: vowelSet })
  }
}

function silence(seconds: number): SpeechSegment {
  return {
    seconds, formants: vowelFormants('AH', 'androgynous'), voicing: 0,
    noiseHz: 1000, noiseQ: 1, noiseLevel: 0, level: 0, pitchOffset: 0,
  }
}

/** Estimated duration of an utterance, without rendering it. */
export function estimateSpeechDuration(text: string, options: SpeakOptions): number {
  return planSpeech(text, options).reduce((sum, segment) => sum + segment.seconds, 0)
}

/** Renders speech to a mono buffer wrapped as stereo audio. */
export function synthesizeSpeech(text: string, options: SpeakOptions): AudioData {
  const sampleRate = options.sampleRate ?? 44100
  const voice = options.voice
  const segments = planSpeech(text, options)
  const totalSeconds = segments.reduce((sum, segment) => sum + segment.seconds, 0) + 0.15
  const length = Math.max(1, Math.ceil(totalSeconds * sampleRate))
  const mono = new Float32Array(length)

  const rng = new Rng(`${options.seed ?? text}|speech`)
  const noise = new Noise(0x9e37 ^ length)
  const filters = [new Biquad(sampleRate), new Biquad(sampleRate), new Biquad(sampleRate), new Biquad(sampleRate)]
  const noiseFilter = new Biquad(sampleRate)
  // Lip radiation differentiates the glottal flow: +6 dB per octave across the
  // band, which is what gives the upper formants something to shape.
  // A gentler coefficient than the singer uses: full pre-emphasis makes a
  // speaking voice sound thin and sibilant, where a sung line benefits from
  // the extra brightness.
  let radiationPrevious = 0
  const radiate = (sample: number): number => {
    const out = sample - 0.82 * radiationPrevious
    radiationPrevious = sample
    return out
  }

  const basePitch = voice.pitchHz * Math.pow(2, (options.pitchSemitones ?? 0) / 12)
  const current: Formant[] = segments[0]!.formants.map((f) => ({ ...f }))
  const applyFormants = (): void => {
    for (let i = 0; i < filters.length; i++) {
      const formant = current[i]!
      const q = Math.max(0.5, formant.freq / Math.max(20, formant.bandwidth))
      filters[i]!.bandpass(clamp(formant.freq, 60, sampleRate * 0.45), q)
    }
  }
  applyFormants()
  noiseFilter.bandpass(segments[0]!.noiseHz, segments[0]!.noiseQ)

  let phase = 0
  let segmentIndex = 0
  let segmentStart = 0
  let level = 0
  let pitchSmooth = 0

  const UPDATE = 32

  for (let i = 0; i < length; i++) {
    const t = i / sampleRate
    while (segmentIndex < segments.length - 1 && t >= segmentStart + segments[segmentIndex]!.seconds) {
      segmentStart += segments[segmentIndex]!.seconds
      segmentIndex++
      noiseFilter.bandpass(segments[segmentIndex]!.noiseHz, segments[segmentIndex]!.noiseQ)
    }
    const segment = segments[Math.min(segmentIndex, segments.length - 1)]!

    if ((i % UPDATE) === 0) {
      for (let f = 0; f < current.length; f++) {
        const to = segment.formants[f] ?? current[f]!
        const from = current[f]!
        from.freq += (to.freq - from.freq) * 0.3
        from.bandwidth += (to.bandwidth - from.bandwidth) * 0.3
        from.amp += (to.amp - from.amp) * 0.3
      }
      applyFormants()
    }

    // Smooth the pitch and level so segment boundaries do not click.
    pitchSmooth += (segment.pitchOffset - pitchSmooth) * 0.0012
    level += (segment.level - level) * 0.004

    const jitter = voice.id === 'circuit' ? 0 : rng.normal(0, 1.4)
    const freq = basePitch * Math.pow(2, (pitchSmooth * 100 + jitter) / 1200)

    phase += freq / sampleRate
    if (phase >= 1) phase -= 1
    // A sawtooth-like glottal pulse: rich in harmonics for the formants to shape.
    const glottal = (phase < 0.6 ? fastSin(phase * 0.8333) : 0) * 2 - 0.5
    const breathLevel = voice.breathiness * 0.5 + segment.noiseLevel
    const source = glottal * segment.voicing + noiseFilter.process(noise.next()) * breathLevel

    let sample = 0
    for (let f = 0; f < filters.length; f++) {
      sample += filters[f]!.process(source) * current[f]!.amp
    }
    mono[i] = radiate(sample) * level
  }

  // Normalise so every voice comes out at a comparable level.
  let peak = 0
  for (let i = 0; i < length; i++) {
    const magnitude = Math.abs(mono[i]!)
    if (magnitude > peak) peak = magnitude
  }
  if (peak > 1e-5) {
    const scale = 0.82 / peak
    for (let i = 0; i < length; i++) mono[i]! *= scale
  }

  return { channels: [mono, mono.slice()], sampleRate }
}

export { VOICE_CENTER, midiToFreq }
