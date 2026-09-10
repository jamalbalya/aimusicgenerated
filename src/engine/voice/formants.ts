/**
 * Formant data for the vocal tract model.
 *
 * Values are centre frequency / bandwidth / relative amplitude for the first
 * four resonances of each vowel, from the standard measured tables, adjusted
 * for singing rather than speech (a slightly lowered larynx and a "singer's
 * formant" boost around 2.8 kHz for the higher voices).
 */

import type { Consonant, Vowel } from './phonemes'

export interface Formant {
  freq: number
  bandwidth: number
  /** Linear amplitude, 0..1. */
  amp: number
}

export type VoiceType = 'soprano' | 'alto' | 'tenor' | 'baritone' | 'bass' | 'androgynous'

/** Vowel formants for a mid-range adult voice, in Hz. */
const BASE_VOWELS: Record<Vowel, Formant[]> = {
  IY: [{ freq: 280, bandwidth: 60, amp: 1 }, { freq: 2250, bandwidth: 90, amp: 0.5 }, { freq: 2890, bandwidth: 130, amp: 0.32 }, { freq: 3600, bandwidth: 180, amp: 0.13 }],
  IH: [{ freq: 400, bandwidth: 70, amp: 1 }, { freq: 1920, bandwidth: 100, amp: 0.44 }, { freq: 2560, bandwidth: 140, amp: 0.26 }, { freq: 3500, bandwidth: 190, amp: 0.1 }],
  EY: [{ freq: 440, bandwidth: 70, amp: 1 }, { freq: 2000, bandwidth: 100, amp: 0.46 }, { freq: 2650, bandwidth: 140, amp: 0.28 }, { freq: 3500, bandwidth: 190, amp: 0.1 }],
  EH: [{ freq: 550, bandwidth: 80, amp: 1 }, { freq: 1770, bandwidth: 100, amp: 0.5 }, { freq: 2490, bandwidth: 140, amp: 0.28 }, { freq: 3400, bandwidth: 190, amp: 0.1 }],
  AE: [{ freq: 690, bandwidth: 90, amp: 1 }, { freq: 1660, bandwidth: 110, amp: 0.56 }, { freq: 2490, bandwidth: 150, amp: 0.3 }, { freq: 3400, bandwidth: 200, amp: 0.1 }],
  AA: [{ freq: 730, bandwidth: 90, amp: 1 }, { freq: 1090, bandwidth: 110, amp: 0.5 }, { freq: 2440, bandwidth: 150, amp: 0.18 }, { freq: 3400, bandwidth: 200, amp: 0.06 }],
  AO: [{ freq: 570, bandwidth: 80, amp: 1 }, { freq: 840, bandwidth: 100, amp: 0.56 }, { freq: 2410, bandwidth: 140, amp: 0.14 }, { freq: 3300, bandwidth: 200, amp: 0.05 }],
  OW: [{ freq: 450, bandwidth: 70, amp: 1 }, { freq: 800, bandwidth: 90, amp: 0.5 }, { freq: 2400, bandwidth: 140, amp: 0.11 }, { freq: 3300, bandwidth: 200, amp: 0.04 }],
  UH: [{ freq: 440, bandwidth: 70, amp: 1 }, { freq: 1020, bandwidth: 100, amp: 0.42 }, { freq: 2240, bandwidth: 140, amp: 0.14 }, { freq: 3300, bandwidth: 200, amp: 0.05 }],
  UW: [{ freq: 300, bandwidth: 60, amp: 1 }, { freq: 870, bandwidth: 90, amp: 0.35 }, { freq: 2240, bandwidth: 140, amp: 0.1 }, { freq: 3300, bandwidth: 200, amp: 0.04 }],
  AH: [{ freq: 600, bandwidth: 80, amp: 1 }, { freq: 1170, bandwidth: 100, amp: 0.5 }, { freq: 2390, bandwidth: 140, amp: 0.18 }, { freq: 3300, bandwidth: 200, amp: 0.06 }],
  ER: [{ freq: 490, bandwidth: 70, amp: 1 }, { freq: 1350, bandwidth: 100, amp: 0.5 }, { freq: 1690, bandwidth: 130, amp: 0.42 }, { freq: 3300, bandwidth: 200, amp: 0.08 }],
  // Diphthongs use their starting position; the singer glides to the target.
  AY: [{ freq: 700, bandwidth: 90, amp: 1 }, { freq: 1200, bandwidth: 110, amp: 0.5 }, { freq: 2450, bandwidth: 150, amp: 0.2 }, { freq: 3400, bandwidth: 200, amp: 0.07 }],
  OY: [{ freq: 550, bandwidth: 80, amp: 1 }, { freq: 900, bandwidth: 100, amp: 0.5 }, { freq: 2400, bandwidth: 140, amp: 0.15 }, { freq: 3300, bandwidth: 200, amp: 0.05 }],
  AW: [{ freq: 700, bandwidth: 90, amp: 1 }, { freq: 1100, bandwidth: 110, amp: 0.5 }, { freq: 2450, bandwidth: 150, amp: 0.18 }, { freq: 3400, bandwidth: 200, amp: 0.06 }],
}

/** Where each diphthong glides to. */
export const DIPHTHONG_TARGET: Partial<Record<Vowel, Vowel>> = {
  AY: 'IY', OY: 'IY', EY: 'IY', OW: 'UW', AW: 'UW',
}

/** Vocal tract length scaling per voice type; shorter tract = higher formants. */
const TRACT_SCALE: Record<VoiceType, number> = {
  soprano: 1.18, alto: 1.09, androgynous: 1.0, tenor: 0.97, baritone: 0.92, bass: 0.86,
}

/** Comfortable centre pitch (MIDI) for each voice type. */
export const VOICE_CENTER: Record<VoiceType, number> = {
  soprano: 69, alto: 64, androgynous: 62, tenor: 57, baritone: 52, bass: 47,
}

export const VOICE_TYPES: VoiceType[] = ['soprano', 'alto', 'androgynous', 'tenor', 'baritone', 'bass']

/** Formants for a vowel as sung by a given voice type. */
export function vowelFormants(vowel: Vowel, voice: VoiceType): Formant[] {
  const scale = TRACT_SCALE[voice]
  const base = BASE_VOWELS[vowel] ?? BASE_VOWELS.AH
  const singersFormant = voice === 'soprano' || voice === 'alto' ? 0.9 : 1.25
  return base.map((formant, index) => ({
    freq: formant.freq * scale,
    bandwidth: formant.bandwidth * (0.8 + scale * 0.25),
    amp: formant.amp * (index === 2 ? singersFormant : 1),
  }))
}

export type ConsonantKind = 'stop' | 'fricative' | 'nasal' | 'liquid' | 'glide' | 'affricate' | 'aspirate'

export interface ConsonantSpec {
  kind: ConsonantKind
  /** Voiced consonants keep the glottal source running. */
  voiced: boolean
  /** Noise band centre and Q for fricatives and stop bursts. */
  noiseHz: number
  noiseQ: number
  /** Nominal duration in seconds at a normal singing tempo. */
  duration: number
  /** Formant targets for nasals, liquids and glides. */
  formants?: Formant[]
}

export const CONSONANTS: Record<Consonant, ConsonantSpec> = {
  P: { kind: 'stop', voiced: false, noiseHz: 900, noiseQ: 0.8, duration: 0.055 },
  B: { kind: 'stop', voiced: true, noiseHz: 700, noiseQ: 0.8, duration: 0.05 },
  T: { kind: 'stop', voiced: false, noiseHz: 3600, noiseQ: 1.1, duration: 0.05 },
  D: { kind: 'stop', voiced: true, noiseHz: 2600, noiseQ: 1.1, duration: 0.045 },
  K: { kind: 'stop', voiced: false, noiseHz: 2000, noiseQ: 0.9, duration: 0.055 },
  G: { kind: 'stop', voiced: true, noiseHz: 1600, noiseQ: 0.9, duration: 0.05 },
  F: { kind: 'fricative', voiced: false, noiseHz: 5200, noiseQ: 0.6, duration: 0.08 },
  V: { kind: 'fricative', voiced: true, noiseHz: 4200, noiseQ: 0.6, duration: 0.07 },
  TH: { kind: 'fricative', voiced: false, noiseHz: 6200, noiseQ: 0.5, duration: 0.075 },
  DH: { kind: 'fricative', voiced: true, noiseHz: 4600, noiseQ: 0.5, duration: 0.06 },
  S: { kind: 'fricative', voiced: false, noiseHz: 6800, noiseQ: 1.4, duration: 0.09 },
  Z: { kind: 'fricative', voiced: true, noiseHz: 5200, noiseQ: 1.4, duration: 0.08 },
  SH: { kind: 'fricative', voiced: false, noiseHz: 3400, noiseQ: 1.2, duration: 0.095 },
  ZH: { kind: 'fricative', voiced: true, noiseHz: 3000, noiseQ: 1.2, duration: 0.08 },
  CH: { kind: 'affricate', voiced: false, noiseHz: 3200, noiseQ: 1.2, duration: 0.09 },
  JH: { kind: 'affricate', voiced: true, noiseHz: 2800, noiseQ: 1.2, duration: 0.08 },
  M: {
    kind: 'nasal', voiced: true, noiseHz: 400, noiseQ: 1, duration: 0.07,
    formants: [{ freq: 280, bandwidth: 90, amp: 1 }, { freq: 1100, bandwidth: 120, amp: 0.18 }, { freq: 2300, bandwidth: 200, amp: 0.06 }, { freq: 3200, bandwidth: 260, amp: 0.02 }],
  },
  N: {
    kind: 'nasal', voiced: true, noiseHz: 400, noiseQ: 1, duration: 0.065,
    formants: [{ freq: 300, bandwidth: 90, amp: 1 }, { freq: 1500, bandwidth: 130, amp: 0.2 }, { freq: 2600, bandwidth: 210, amp: 0.07 }, { freq: 3300, bandwidth: 260, amp: 0.02 }],
  },
  NG: {
    kind: 'nasal', voiced: true, noiseHz: 400, noiseQ: 1, duration: 0.075,
    formants: [{ freq: 280, bandwidth: 90, amp: 1 }, { freq: 1900, bandwidth: 140, amp: 0.16 }, { freq: 2400, bandwidth: 220, amp: 0.06 }, { freq: 3200, bandwidth: 260, amp: 0.02 }],
  },
  L: {
    kind: 'liquid', voiced: true, noiseHz: 500, noiseQ: 1, duration: 0.06,
    formants: [{ freq: 380, bandwidth: 80, amp: 1 }, { freq: 1200, bandwidth: 110, amp: 0.36 }, { freq: 2600, bandwidth: 160, amp: 0.12 }, { freq: 3400, bandwidth: 220, amp: 0.04 }],
  },
  R: {
    kind: 'liquid', voiced: true, noiseHz: 500, noiseQ: 1, duration: 0.06,
    formants: [{ freq: 340, bandwidth: 80, amp: 1 }, { freq: 1100, bandwidth: 110, amp: 0.4 }, { freq: 1500, bandwidth: 140, amp: 0.34 }, { freq: 3300, bandwidth: 220, amp: 0.04 }],
  },
  W: {
    kind: 'glide', voiced: true, noiseHz: 500, noiseQ: 1, duration: 0.055,
    formants: [{ freq: 290, bandwidth: 70, amp: 1 }, { freq: 610, bandwidth: 90, amp: 0.42 }, { freq: 2200, bandwidth: 150, amp: 0.08 }, { freq: 3200, bandwidth: 220, amp: 0.03 }],
  },
  Y: {
    kind: 'glide', voiced: true, noiseHz: 500, noiseQ: 1, duration: 0.05,
    formants: [{ freq: 280, bandwidth: 60, amp: 1 }, { freq: 2200, bandwidth: 100, amp: 0.48 }, { freq: 2900, bandwidth: 150, amp: 0.24 }, { freq: 3600, bandwidth: 220, amp: 0.06 }],
  },
  HH: { kind: 'aspirate', voiced: false, noiseHz: 1500, noiseQ: 0.4, duration: 0.06 },
}
