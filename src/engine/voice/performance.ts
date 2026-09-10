/**
 * What a singer is asked to do, described independently of who sings it.
 *
 * The composition engine decides the words, the notes and the shape of the
 * song. How those become sound is a separate job, and the two are joined by
 * this: a plain description of a vocal performance — every syllable, the sounds
 * it is made of, when it starts, how long it lasts, what pitch it sits on, and
 * how it should be delivered.
 *
 * Nothing here knows how the voice is produced. That is the point. A formant
 * synthesiser, a neural singing model and a hosted service can each be handed
 * the same performance, which is what makes the singer replaceable without
 * touching anything that composes.
 */

import type { Score, ScoreNote, SectionKind } from '../compose/types'
import type { LanguageId } from '../lang/types'
import type { Syllable } from './phonemes'
import { beatsToSeconds } from '../core/units'

/** Who sings a given line. */
export type VocalRole = 'lead' | 'response' | 'harmony'

/** How a note is joined to the one before it. */
export type Articulation =
  /** Struck fresh, with its own consonant. */
  | 'attack'
  /** Slurred from the previous note, same syllable. */
  | 'melisma'
  /** New syllable, but no gap before it. */
  | 'legato'

export interface VocalNote {
  startSeconds: number
  durationSeconds: number
  /** Concert pitch as a MIDI number; fractional values are allowed. */
  midi: number
  /** The syllable and the sounds it is made of. Null continues the one before. */
  syllable: Syllable | null
  /** 0..1 */
  velocity: number
  articulation: Articulation
  /** Depth in cents and rate in Hz; onset is seconds before it reaches full depth. */
  vibrato: { depth: number; rate: number; onset: number }
  /** Semitones the pitch slides up into the note from. */
  slide: number
  /** 0..1 — how much this note is leaned on. */
  emphasis: number
  /** Seconds of breath after this note, at a phrase end. */
  breathAfter: number
}

export interface VocalPhrase {
  sectionIndex: number
  sectionKind: SectionKind
  /** The section's own label, tags and all. */
  sectionLabel: string
  role: VocalRole
  /** The written line, for lyric sheets and for a renderer that wants text. */
  text: string
  notes: VocalNote[]
}

/** The character of the voice asked for, independent of any renderer. */
export interface VocalProfile {
  gender: 'male' | 'female' | 'auto'
  /** Named register, e.g. baritone. Renderers map this onto their own voices. */
  register: string
  /** 0..1 — how hard the voice is pushed. */
  power: number
  /** 0..1 */
  breathiness: number
  /** 0..1 — how much the delivery varies note to note. */
  expressiveness: number
  /** Free text from the style description, for renderers that read prose. */
  description: string
}

export interface VocalPerformance {
  language: LanguageId
  profile: VocalProfile
  bpm: number
  /** Every phrase in the song, in order. */
  phrases: VocalPhrase[]
}

/** Total sung length in seconds, for sizing a buffer. */
export function performanceLength(performance: VocalPerformance): number {
  let end = 0
  for (const phrase of performance.phrases) {
    for (const note of phrase.notes) {
      end = Math.max(end, note.startSeconds + note.durationSeconds)
    }
  }
  return end
}

/** How many syllables actually get sung. */
export function performanceSyllableCount(performance: VocalPerformance): number {
  let count = 0
  for (const phrase of performance.phrases) {
    for (const note of phrase.notes) if (note.syllable) count++
  }
  return count
}

/* ------------------------------------------------------------- building --- */

/**
 * A line that asks a question and is answered by the next one.
 *
 * Call and response is a conversation, so the two halves should not sound like
 * the same person singing twice. Spotting it is a matter of punctuation: a
 * question mark, then an answer.
 */
function isCallAndResponse(lines: string[]): boolean {
  if (lines.length < 4 || lines.length % 2 !== 0) return false
  let pairs = 0
  for (let i = 0; i + 1 < lines.length; i += 2) {
    if (/[?？]\s*$/.test(lines[i]!)) pairs++
  }
  return pairs >= lines.length / 4
}

/** Vibrato grows with the section's energy and the length of the note. */
function vibratoFor(intensity: number, durationSeconds: number, profile: VocalProfile) {
  const depth = (14 + intensity * 22) * (0.6 + profile.expressiveness * 0.6)
  return {
    depth: durationSeconds < 0.25 ? 0 : depth,
    rate: 4.8 + intensity * 1.2,
    // A held note does not shake straight away; it opens up as it is held.
    onset: Math.min(0.45, durationSeconds * 0.45),
  }
}

export interface PerformanceOptions {
  profile: VocalProfile
  /** Section labels, so a phrase can carry the tag its lyricist wrote. */
  labels: string[]
}

/**
 * Reads a composed score and writes down what the singer has to do.
 *
 * Phrases are cut where the composer marked them, which is one lyric line each,
 * so a breath lands where a line ends rather than in the middle of a sentence.
 */
export function buildVocalPerformance(
  score: Score, options: PerformanceOptions,
): VocalPerformance {
  const track = score.tracks.find((candidate) => candidate.id === 'vocal')
  const phrases: VocalPhrase[] = []
  if (!track || track.notes.length === 0) {
    return { language: score.language, profile: options.profile, bpm: score.bpm, phrases }
  }

  // Group the notes into phrases, one per lyric line.
  const groups: ScoreNote[][] = []
  let current: ScoreNote[] = []
  for (let i = 0; i < track.notes.length; i++) {
    const note = track.notes[i]!
    if (i > 0 && note.phraseStart && current.length > 0) {
      groups.push(current)
      current = []
    }
    current.push(note)
  }
  if (current.length > 0) groups.push(current)

  const sectionAt = (beat: number): number => {
    for (let i = 0; i < score.sections.length; i++) {
      const section = score.sections[i]!
      if (beat >= section.startBeat && beat < section.startBeat + section.lengthBeats) return i
    }
    return Math.max(0, score.sections.length - 1)
  }

  // Which sections are a conversation rather than a solo.
  const linesBySection = new Map<number, string[]>()
  for (const group of groups) {
    const index = sectionAt(group[0]!.start)
    const text = group[0]!.phraseText ?? group.map((note) => note.syllable).filter(Boolean).join(' ')
    const list = linesBySection.get(index)
    if (list) list.push(text)
    else linesBySection.set(index, [text])
  }
  const conversational = new Set<number>()
  for (const [index, lines] of linesBySection) {
    const label = options.labels[index] ?? ''
    if (isCallAndResponse(lines) || /call and response/i.test(label)) conversational.add(index)
  }
  const answeredSoFar = new Map<number, number>()

  for (const group of groups) {
    const sectionIndex = sectionAt(group[0]!.start)
    const section = score.sections[sectionIndex]!
    const intensity = section.intensity

    // In a conversation the second line of each pair is the answer.
    let role: VocalRole = 'lead'
    if (conversational.has(sectionIndex)) {
      const seen = answeredSoFar.get(sectionIndex) ?? 0
      role = seen % 2 === 1 ? 'response' : 'lead'
      answeredSoFar.set(sectionIndex, seen + 1)
    }

    const notes: VocalNote[] = group.map((note, index) => {
      const durationSeconds = beatsToSeconds(note.duration, score.bpm)
      const last = index === group.length - 1
      const articulation: Articulation = note.sounds
        ? (note.legato === true ? 'legato' : 'attack')
        : 'melisma'
      return {
        startSeconds: beatsToSeconds(note.start, score.bpm),
        durationSeconds,
        midi: note.midi,
        syllable: note.sounds ?? null,
        velocity: note.velocity,
        articulation,
        vibrato: vibratoFor(intensity, durationSeconds, options.profile),
        // A response is thrown out rather than eased into.
        slide: role === 'response' ? 0 : (index === 0 ? 0.6 + intensity * 0.5 : 0.15),
        emphasis: index === 0 ? 0.7 + intensity * 0.3 : 0.4 + intensity * 0.3,
        // Room to breathe at the end of a line, and only there.
        breathAfter: last ? Math.min(0.35, 0.12 + (1 - intensity) * 0.25) : 0,
      }
    })

    phrases.push({
      sectionIndex,
      sectionKind: section.kind,
      sectionLabel: options.labels[sectionIndex] ?? section.label,
      role,
      text: group[0]!.phraseText ?? group.map((note) => note.syllable).filter(Boolean).join(' '),
      notes,
    })
  }

  return { language: score.language, profile: options.profile, bpm: score.bpm, phrases }
}
