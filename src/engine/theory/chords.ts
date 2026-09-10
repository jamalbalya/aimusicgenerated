/** Chord construction, roman-numeral parsing and voicing. */

import { FLAT_NAMES, NOTE_NAMES, SCALES, type PitchClass, type ScaleName } from './pitch'

export type ChordQuality =
  | 'maj' | 'min' | 'dim' | 'aug'
  | 'maj7' | 'min7' | 'dom7' | 'min7b5' | 'dim7'
  | 'sus2' | 'sus4' | 'add9' | 'maj9' | 'min9' | 'dom9' | 'min6' | 'maj6'

/** Semitone intervals above the root for each quality. */
export const CHORD_INTERVALS: Record<ChordQuality, number[]> = {
  maj: [0, 4, 7],
  min: [0, 3, 7],
  dim: [0, 3, 6],
  aug: [0, 4, 8],
  maj7: [0, 4, 7, 11],
  min7: [0, 3, 7, 10],
  dom7: [0, 4, 7, 10],
  min7b5: [0, 3, 6, 10],
  dim7: [0, 3, 6, 9],
  sus2: [0, 2, 7],
  sus4: [0, 5, 7],
  add9: [0, 4, 7, 14],
  maj9: [0, 4, 7, 11, 14],
  min9: [0, 3, 7, 10, 14],
  dom9: [0, 4, 7, 10, 14],
  min6: [0, 3, 7, 9],
  maj6: [0, 4, 7, 9],
}

const QUALITY_LABEL: Record<ChordQuality, string> = {
  maj: '', min: 'm', dim: 'dim', aug: 'aug',
  maj7: 'maj7', min7: 'm7', dom7: '7', min7b5: 'm7b5', dim7: 'dim7',
  sus2: 'sus2', sus4: 'sus4', add9: 'add9', maj9: 'maj9', min9: 'm9',
  dom9: '9', min6: 'm6', maj6: '6',
}

export interface Chord {
  /** Root pitch class, 0..11. */
  root: PitchClass
  quality: ChordQuality
  /** Scale degree (0-indexed) this chord was built on, when known. */
  degree?: number
  /** Bass pitch class for slash chords; defaults to the root. */
  bass?: PitchClass
}

/**
 * Keys whose scale is written with flats.
 *
 * A chord chart in C minor reads B♭ and A♭, never A♯ and G♯: the letters have
 * to run A-B-C-D-E-F-G once each, and a player reading sharps in a flat key has
 * to translate every bar. The same twelve sounds, spelled the way the key
 * spells them.
 */
const FLAT_TONICS = new Set<PitchClass>([1, 3, 5, 8, 10])

/** True when this key is conventionally written with flats. */
export function keyUsesFlats(tonic: PitchClass, scale: ScaleName): boolean {
  // A minor key is written like its relative major, three semitones up.
  const relativeMajor = scale.includes('inor') || scale === 'dorian' || scale === 'phrygian'
    ? (((tonic + 3) % 12) as PitchClass)
    : tonic
  return FLAT_TONICS.has(relativeMajor)
}

export function chordName(chord: Chord, useFlats = false): string {
  const names = useFlats ? FLAT_NAMES : NOTE_NAMES
  const base = `${names[chord.root]}${QUALITY_LABEL[chord.quality]}`
  if (chord.bass !== undefined && chord.bass !== chord.root) {
    return `${base}/${names[chord.bass]}`
  }
  return base
}

/** Pitch classes contained in the chord. */
export function chordPitchClasses(chord: Chord): PitchClass[] {
  const set = new Set<number>()
  for (const interval of CHORD_INTERVALS[chord.quality]) {
    set.add((chord.root + interval) % 12)
  }
  if (chord.bass !== undefined) set.add(chord.bass % 12)
  return [...set].sort((a, b) => a - b)
}

/** Absolute MIDI notes of the chord stacked from `rootMidi`. */
export function chordNotes(chord: Chord, rootOctave = 4): number[] {
  const base = (rootOctave + 1) * 12 + chord.root
  return CHORD_INTERVALS[chord.quality].map((i) => base + i)
}

/**
 * Diatonic triad/seventh quality for a degree of a scale, derived from the
 * scale's own intervals rather than a hard-coded table — so it stays correct
 * for dorian, phrygian, harmonic minor and the rest.
 */
export function diatonicQuality(scale: ScaleName, degree: number, seventh = false): ChordQuality {
  const steps = SCALES[scale] as readonly number[]
  const len = steps.length
  const at = (i: number) => {
    const octave = Math.floor(i / len)
    const idx = ((i % len) + len) % len
    return steps[idx]! + octave * 12
  }
  const root = at(degree)
  const third = at(degree + 2) - root
  const fifth = at(degree + 4) - root
  const seventhInterval = at(degree + 6) - root

  if (!seventh) {
    if (third === 4 && fifth === 7) return 'maj'
    if (third === 3 && fifth === 7) return 'min'
    if (third === 3 && fifth === 6) return 'dim'
    if (third === 4 && fifth === 8) return 'aug'
    // Pentatonic and other gapped scales can produce a suspended stack.
    if (third === 5) return 'sus4'
    if (third === 2) return 'sus2'
    return third <= 3 ? 'min' : 'maj'
  }

  if (third === 4 && fifth === 7) return seventhInterval === 11 ? 'maj7' : 'dom7'
  if (third === 3 && fifth === 7) return 'min7'
  if (third === 3 && fifth === 6) return seventhInterval === 9 ? 'dim7' : 'min7b5'
  if (third === 4 && fifth === 8) return 'aug'
  if (third === 5) return 'sus4'
  if (third === 2) return 'sus2'
  return third <= 3 ? 'min7' : 'maj7'
}

/** Builds the diatonic chord for a scale degree in the given key. */
export function diatonicChord(
  tonic: PitchClass,
  scale: ScaleName,
  degree: number,
  seventh = false,
): Chord {
  const steps = SCALES[scale] as readonly number[]
  const len = steps.length
  const idx = ((degree % len) + len) % len
  const root = (tonic + steps[idx]!) % 12
  return { root, quality: diatonicQuality(scale, idx, seventh), degree: idx }
}

const ROMAN_TO_INDEX: Record<string, number> = {
  i: 0, ii: 1, iii: 2, iv: 3, v: 4, vi: 5, vii: 6,
}

/**
 * Parses a roman numeral such as "vi", "IVmaj7", "bVII" or "V/V" into a chord
 * in the given key. Case carries the quality (upper = major-ish), and an
 * explicit suffix overrides it.
 */
export function parseRoman(symbol: string, tonic: PitchClass, scale: ScaleName): Chord {
  const match = /^(b|#)?([ivIV]+)(.*)$/.exec(symbol.trim())
  if (!match) return diatonicChord(tonic, scale, 0)

  const accidental = match[1] ?? ''
  const numeral = match[2]!
  const suffix = (match[3] ?? '').trim()

  const degree = ROMAN_TO_INDEX[numeral.toLowerCase()] ?? 0
  const steps = SCALES[scale] as readonly number[]
  // An accidental measures from the parallel major, which is the convention:
  // "bVII" is ten semitones above the tonic in any mode, so it stays the same
  // chord whether the song is in major or natural minor.
  const reference = accidental ? (SCALES.major as readonly number[]) : steps
  let rootOffset = reference[degree % reference.length] ?? 0
  if (accidental === 'b') rootOffset -= 1
  if (accidental === '#') rootOffset += 1
  const root = ((tonic + rootOffset) % 12 + 12) % 12

  const isUpper = numeral === numeral.toUpperCase()
  let quality: ChordQuality
  if (suffix && suffix in QUALITY_BY_SUFFIX) {
    quality = QUALITY_BY_SUFFIX[suffix]!
  } else if (accidental) {
    // Borrowed chords (bVI, bVII, bIII) are major by convention.
    quality = isUpper ? 'maj' : 'min'
  } else {
    quality = diatonicQuality(scale, degree, false)
    // An explicitly cased numeral overrides the diatonic default (e.g. "V" in
    // a minor key means a major dominant, not the diatonic minor v).
    if (isUpper && (quality === 'min' || quality === 'dim')) quality = 'maj'
    if (!isUpper && quality === 'maj') quality = 'min'
  }

  return { root, quality, degree }
}

const QUALITY_BY_SUFFIX: Record<string, ChordQuality> = {
  m: 'min', min: 'min', maj: 'maj', dim: 'dim', aug: 'aug',
  '7': 'dom7', maj7: 'maj7', m7: 'min7', min7: 'min7',
  m7b5: 'min7b5', dim7: 'dim7', sus2: 'sus2', sus4: 'sus4',
  add9: 'add9', maj9: 'maj9', m9: 'min9', '9': 'dom9', '6': 'maj6', m6: 'min6',
}

/**
 * Voices a chord near a target register, preferring the smallest total motion
 * from the previous voicing. Real voice leading — this is what stops generated
 * chord tracks from lurching an octave between bars.
 */
export function voiceChord(
  chord: Chord,
  previous: number[] | null,
  centerMidi = 60,
  voices = 4,
): number[] {
  const intervals = CHORD_INTERVALS[chord.quality]
  const tones: number[] = []
  for (let i = 0; i < voices; i++) {
    tones.push(intervals[i % intervals.length]! + 12 * Math.floor(i / intervals.length))
  }

  // Candidate voicings: the chord tones placed in a few nearby octaves.
  const candidates: number[][] = []
  for (let octave = 2; octave <= 5; octave++) {
    const base = (octave + 1) * 12 + chord.root
    candidates.push(tones.map((t) => base + t))
  }

  let best = candidates[0]!
  let bestCost = Infinity
  for (const candidate of candidates) {
    const avg = candidate.reduce((a, b) => a + b, 0) / candidate.length
    let cost = Math.abs(avg - centerMidi) * 0.6
    if (previous && previous.length > 0) {
      for (let i = 0; i < candidate.length; i++) {
        const prev = previous[Math.min(i, previous.length - 1)]!
        cost += Math.abs(candidate[i]! - prev)
      }
    }
    if (cost < bestCost) {
      bestCost = cost
      best = candidate
    }
  }
  return best.slice()
}
