/**
 * What the vocal is *supposed* to sing, decided before anything is generated.
 *
 * This is the piece the whole pitch pipeline stands on, and the reason is worth
 * stating plainly: **you cannot correct a pitch without knowing what it should
 * have been**. Correcting each note to its own nearest semitone is not pitch
 * correction — a wrong note sung perfectly in tune is already on a semitone,
 * and snapping it to itself changes nothing while reporting success. That
 * failure mode is not hypothetical; it is the one this project measured on a
 * real song and spent a long time chasing.
 *
 * So the target is derived musically, from the plan, not from the audio:
 *
 *   lyric syllable → phrase → bar → chord → target note → target frequency
 *
 * The chord underneath a syllable decides what that syllable may sing. Phrase
 * position decides whether it is free to move or must resolve. Section decides
 * register and intensity. None of it reads the generated audio, which is the
 * point: the audio is the thing being judged, so it cannot also be the standard.
 *
 * What this is not: a claim that ACE-Step will sing this melody. It will not —
 * `text2music` has no melody input, and `constraints.ts` files that under
 * NOT_CONTROLLED_BY_ACE_STEP. This is the *reference* the returned vocal is
 * measured and corrected against.
 */

import { SCALES, type PitchClass } from '../theory/pitch'

import { harmonicScaleFor } from '../compose/harmony'
import type { SectionKind } from '../compose/types'
import type { LivePlan } from './plan'

/** Comfortable sung ranges, in MIDI, by the voice a request asked for. */
export const VOCAL_RANGES: Record<string, { low: number; high: number }> = {
  // Roughly E2–E4 and G3–G5: the ranges a singer sits in without strain, not
  // the extremes they can reach. A melody written to the extremes is a melody
  // that will be sung badly.
  male: { low: 45, high: 64 },
  female: { low: 55, high: 76 },
  auto: { low: 50, high: 71 },
}

/** How loud and how high a section sits, 0..1, relative to the song. */
const SECTION_INTENSITY: Record<SectionKind, number> = {
  intro: 0.3,
  verse: 0.45,
  prechorus: 0.65,
  chorus: 0.85,
  bridge: 0.6,
  solo: 0.5,
  drop: 0.95,
  breakdown: 0.35,
  outro: 0.3,
}

export interface TargetNote {
  /** Index in the melody, from 0. */
  index: number
  /** Beat this note starts on, from the top of the song. */
  startBeat: number
  /** Length in beats. */
  durationBeats: number
  /** Seconds from the start of the song, at the planned tempo. */
  startSeconds: number
  endSeconds: number
  /** The note itself. */
  midi: number
  /** Equal-tempered frequency of `midi`, at A4 = 440. */
  frequencyHz: number
  /** The syllable this note carries. */
  syllable: string
  /** Which line of the sheet it belongs to. */
  phrase: number
  section: SectionKind
  sectionName: string
  /** The chord sounding underneath, as pitch classes. */
  chordPitchClasses: PitchClass[]
  /** True when this note is a tone of that chord rather than a colour. */
  isChordTone: boolean
  /**
   * How firmly this note is fixed.
   *
   * `anchor` notes are the ones a listener hears as the melody: phrase ends,
   * long notes, downbeats. They must be right. `passing` notes are on their way
   * somewhere and may be left alone — correcting an expressive approach note
   * onto a chord tone is how a vocal is made robotic.
   */
  role: 'anchor' | 'passing'
}

export interface TargetMelody {
  notes: TargetNote[]
  bpm: number
  beatsPerBar: number
  tonic: PitchClass
  scale: string
  /** The MIDI range the melody was written inside. */
  range: { low: number; high: number }
  /** Why a melody could not be written, when one could not. */
  unavailable?: string
}

/** Equal temperament, A4 = 440 Hz = MIDI 69. */
export const midiToHz = (midi: number): number => 440 * Math.pow(2, (midi - 69) / 12)

/** The inverse, for turning a measured frequency into a note. */
export const hzToMidi = (hz: number): number => 69 + 12 * Math.log2(hz / 440)

/** Cents between two frequencies. Positive means `actual` is sharp. */
export const centsBetween = (actual: number, target: number): number =>
  1200 * Math.log2(actual / target)

/**
 * Moves a pitch class into the octave that sits nearest a centre note.
 *
 * Melodies are written by choosing a scale degree and then choosing where to
 * put it, and "where" is decided by the voice rather than by theory. A tenor
 * and an alto sing the same tune in different octaves.
 */
function nearOctave(pitchClass: number, centre: number, range: { low: number; high: number }): number {
  let best = pitchClass
  let bestDistance = Infinity
  for (let midi = range.low; midi <= range.high; midi++) {
    if (((midi % 12) + 12) % 12 !== ((pitchClass % 12) + 12) % 12) continue
    const distance = Math.abs(midi - centre)
    if (distance < bestDistance) {
      bestDistance = distance
      best = midi
    }
  }
  return best
}

/**
 * Writes the melody one syllable at a time.
 *
 * The rules, in the order they apply:
 *
 *  1. A syllable that ends a phrase resolves to a chord tone. That is what
 *     makes a line sound finished rather than interrupted.
 *  2. A syllable on a downbeat lands on a chord tone. These are the notes the
 *     ear uses to hear the harmony.
 *  3. Everything else may step to a neighbouring scale degree, which is what
 *     gives a melody shape instead of making it an arpeggio.
 *  4. The line stays inside the voice's range and moves by step where it can —
 *     a melody that leaps constantly is not one a person would sing.
 */
export function buildTargetMelody(plan: LivePlan, vocalGender: 'male' | 'female' | 'auto'): TargetMelody {
  const { music, lyrics } = plan
  const range = VOCAL_RANGES[vocalGender] ?? VOCAL_RANGES.auto!
  const bpm = music.targetBpm
  const beatsPerBar = 4
  const secondsPerBeat = 60 / bpm
  const tonic = ((music.tonic % 12) + 12) % 12 as PitchClass
  const harmonicScale = harmonicScaleFor(music.scale as never)
  const scaleSteps = SCALES[harmonicScale] ?? SCALES.major!
  const scalePitchClasses = scaleSteps.map((step) => (((tonic + step) % 12) as PitchClass))

  if (music.instrumental) {
    return {
      notes: [], bpm, beatsPerBar, tonic, scale: harmonicScale, range,
      unavailable: 'This is an instrumental: there is no vocal to write a melody for.',
    }
  }
  if (lyrics.sections.length === 0 || lyrics.syllables === 0) {
    return {
      notes: [], bpm, beatsPerBar, tonic, scale: harmonicScale, range,
      unavailable: 'No sung syllables were found, so there is nothing to write a melody for.',
    }
  }

  // The chord under each bar. The planner names a harmonic character rather
  // than a progression, so the melody is written against the tonic triad and
  // the scale — which is the honest reduction: without a real progression, a
  // chord tone means a tone of the key's own triad.
  const tonicTriad: PitchClass[] = [
    tonic,
    scalePitchClasses[2] ?? ((tonic + 4) % 12) as PitchClass,
    scalePitchClasses[4] ?? ((tonic + 7) % 12) as PitchClass,
  ]

  const notes: TargetNote[] = []
  let beat = 0
  let previousMidi = (range.low + range.high) / 2
  let phrase = 0

  for (const section of lyrics.sections) {
    const intensity = SECTION_INTENSITY[section.kind] ?? 0.5
    // Louder sections sit higher. Not by a lot: a chorus a fifth above a verse
    // is a different song, not a bigger one.
    const centre = range.low + (range.high - range.low) * (0.35 + intensity * 0.3)
    const sectionLines = Math.max(1, section.lines)

    for (let line = 0; line < sectionLines; line++) {
      // Syllables are distributed evenly across the line's own bars. Without a
      // forced aligner this is an estimate, and it is labelled as one — the
      // alignment step matches it to what was actually sung.
      const syllablesInLine = Math.max(1, Math.round(section.syllables / sectionLines))
      const beatsPerSyllable = Math.max(0.25, beatsPerBar / Math.max(1, syllablesInLine))

      for (let index = 0; index < syllablesInLine; index++) {
        const last = index === syllablesInLine - 1
        const onDownbeat = Math.abs(beat % beatsPerBar) < 1e-6
        const mustBeChordTone = last || onDownbeat

        const candidates = mustBeChordTone ? tonicTriad : scalePitchClasses
        // Step where possible: the candidate nearest the previous note, not a
        // random member of the set.
        let chosen = previousMidi
        let bestDistance = Infinity
        for (const pitchClass of candidates) {
          const midi = nearOctave(pitchClass, last ? centre : previousMidi, range)
          const distance = Math.abs(midi - previousMidi)
            // A tiny pull toward the section's centre, so a line drifts home
            // rather than wandering to an edge of the range and staying there.
            + Math.abs(midi - centre) * 0.15
          if (distance < bestDistance) {
            bestDistance = distance
            chosen = midi
          }
        }

        const midi = Math.max(range.low, Math.min(range.high, Math.round(chosen)))
        const durationBeats = last ? beatsPerSyllable * 1.5 : beatsPerSyllable
        const pitchClass = ((midi % 12) + 12) % 12 as PitchClass

        notes.push({
          index: notes.length,
          startBeat: beat,
          durationBeats,
          startSeconds: beat * secondsPerBeat,
          endSeconds: (beat + durationBeats) * secondsPerBeat,
          midi,
          frequencyHz: midiToHz(midi),
          syllable: '',
          phrase,
          section: section.kind,
          sectionName: section.sectionName,
          chordPitchClasses: tonicTriad,
          isChordTone: tonicTriad.includes(pitchClass),
          // A note is an anchor when the ear lands on it: the end of a phrase,
          // a downbeat, or a note held longer than a beat.
          role: (last || onDownbeat || durationBeats >= 1) ? 'anchor' : 'passing',
        })

        previousMidi = midi
        beat += durationBeats
      }
      phrase++
    }
  }

  return { notes, bpm, beatsPerBar, tonic, scale: harmonicScale, range }
}

/** Every anchor note, which are the ones correction must get right. */
export function anchorNotes(melody: TargetMelody): TargetNote[] {
  return melody.notes.filter((note) => note.role === 'anchor')
}

/**
 * The melody as the Space receives it: a compact JSON payload.
 *
 * Sent alongside the request so the correction stage has the same reference the
 * planner wrote, rather than re-deriving it from a plan it does not have. Kept
 * small deliberately — a four-minute song is a few hundred notes, and this
 * travels in an HTTP body next to a 4096-character lyric sheet.
 */
export interface MelodyPayload {
  bpm: number
  tonic: number
  scale: string
  rangeLow: number
  rangeHigh: number
  /** [startSeconds, endSeconds, midi, isAnchor] per note, rounded. */
  notes: [number, number, number, 0 | 1][]
}

export function melodyPayload(melody: TargetMelody): MelodyPayload {
  return {
    bpm: melody.bpm,
    tonic: melody.tonic,
    scale: melody.scale,
    rangeLow: melody.range.low,
    rangeHigh: melody.range.high,
    notes: melody.notes.map((note) => [
      Math.round(note.startSeconds * 1000) / 1000,
      Math.round(note.endSeconds * 1000) / 1000,
      note.midi,
      note.role === 'anchor' ? 1 : 0,
    ]),
  }
}
