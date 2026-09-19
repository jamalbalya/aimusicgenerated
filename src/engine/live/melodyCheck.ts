/**
 * Does the target melody deserve to be a target?
 *
 * The correction stage takes this melody as its standard and moves a real
 * vocal onto it. That inverts the usual relationship between a bug and its
 * consequence: a melody that is merely *odd* produces a vocal that is
 * confidently, audibly wrong, because every anchor gets dragged onto it. The
 * failure mode to prevent is not "no correction" — it is
 *
 *     CORRECT PITCH + WRONG MELODY
 *
 * which sounds worse than the uncorrected take and reports success.
 *
 * So the melody is checked before it is used, deterministically, against the
 * things that make a line singable and the things that make it belong to this
 * song. Nothing here is heuristic scoring: every check either holds or names
 * the note it failed on.
 *
 * `error` means the melody must not be used as a correction reference. Sending
 * no melody is a real option and a safe one — the song comes back as ACE-Step
 * made it, which is where this project started. `warning` means the melody is
 * usable and something about it is worth seeing.
 */

import { SCALES, type ScaleName } from '../theory/pitch'
import { BEATS_PER_BAR } from './songHarmony'
import type { TargetMelody, TargetNote } from './targetMelody'

export type MelodyProblemCode =
  | 'OUT_OF_SCALE'
  | 'ANCHOR_OFF_CHORD'
  | 'FLAT_CONTOUR'
  | 'OUT_OF_RANGE'
  | 'EXCESSIVE_LEAP'
  | 'UNRESOLVED_PHRASE'
  | 'SECTION_DISCONTINUITY'
  | 'NO_CHORUS_LIFT'
  | 'NO_CLIMAX'
  | 'BAD_NOTE_DURATION'
  | 'OVERLAPPING_NOTES'
  | 'BAD_MELISMA'
  | 'NO_BREATH'
  | 'UNRESOLVED_SUSPENSION'

export interface MelodyProblem {
  code: MelodyProblemCode
  severity: 'error' | 'warning'
  message: string
  /** The note it was found on, when it was found on one. */
  noteIndex?: number
}

export interface MelodyCheck {
  /** False when any problem is an error: do not use this melody as a target. */
  usable: boolean
  problems: MelodyProblem[]
  /** Every check that ran and held, for a report that shows its work. */
  passed: string[]
}

/** The widest interval a sung line may leap, in semitones. An octave. */
const MAX_LEAP_SEMITONES = 12

/** Share of a line that may be leaps larger than a fourth before it is a warning. */
const MAX_LEAP_SHARE = 0.3

export function checkTargetMelody(melody: TargetMelody): MelodyCheck {
  const problems: MelodyProblem[] = []
  const passed: string[] = []
  const add = (
    code: MelodyProblemCode, severity: 'error' | 'warning', message: string, noteIndex?: number,
  ): void => {
    problems.push({ code, severity, message, ...(noteIndex !== undefined ? { noteIndex } : {}) })
  }
  const holds = (label: string, condition: boolean): void => {
    if (condition) passed.push(label)
  }

  const sung = melody.notes.filter((note) => note.role !== 'rest')
  if (sung.length === 0) {
    return { usable: melody.notes.length === 0, problems, passed }
  }

  /* 1. key and scale ----------------------------------------------------- */

  const steps = SCALES[melody.scale as ScaleName] ?? SCALES.major
  const inKey = new Set((steps as readonly number[])
    .map((step) => (((melody.tonic + step) % 12) + 12) % 12))
  const chromatic = sung.filter((note) => !inKey.has(((note.midi % 12) + 12) % 12))
  if (chromatic.length > 0) {
    // The writer works from a ladder built out of the scale, so a note outside
    // it means something downstream moved a note without checking — which is
    // exactly the class of bug this file exists to catch.
    add('OUT_OF_SCALE', 'error',
      `${chromatic.length} note(s) are outside ${melody.scale}, which the melody writer `
      + `cannot produce. The first is ${chromatic[0]!.syllable || 'a note'} in `
      + `${chromatic[0]!.sectionName}.`, chromatic[0]!.index)
  }
  holds('every note belongs to the key', chromatic.length === 0)

  /* 2. chord compatibility ------------------------------------------------ */

  const structural = sung.filter((note) => note.role === 'anchor' || note.role === 'resolution')
  const offChord = structural.filter((note) => {
    const chord = new Set(note.chordPitchClasses.map((pc) => ((pc % 12) + 12) % 12))
    return !chord.has(((note.midi % 12) + 12) % 12)
  })
  if (offChord.length > 0) {
    add('ANCHOR_OFF_CHORD', 'error',
      `${offChord.length} structural note(s) are not in the chord underneath them. The first is `
      + `in bar ${offChord[0]!.bar} over ${offChord[0]!.chordLabel}.`, offChord[0]!.index)
  }
  holds('every structural note is a tone of its own chord', offChord.length === 0)

  /* 3. vocal range -------------------------------------------------------- */

  const outside = sung.filter(
    (note) => note.midi < melody.range.low || note.midi > melody.range.high)
  if (outside.length > 0) {
    add('OUT_OF_RANGE', 'error',
      `${outside.length} note(s) sit outside the ${melody.range.low}–${melody.range.high} `
      + `range this voice was written for.`, outside[0]!.index)
  }
  holds('every note is inside the voice', outside.length === 0)

  /* 4. phrase contour, resolution and leaps -------------------------------- */

  const phrases = new Map<number, TargetNote[]>()
  for (const note of sung) {
    const bucket = phrases.get(note.phrase) ?? []
    bucket.push(note)
    phrases.set(note.phrase, bucket)
  }

  let flat = 0
  let unresolved = 0
  let leapy = 0
  for (const [, notes] of phrases) {
    if (notes.length >= 4) {
      const distinct = new Set(notes.map((note) => note.midi)).size
      // A line on one note is a chant, not a melody. Two distinct pitches
      // across eight syllables is the same problem less obviously.
      if (distinct < 2 || distinct / notes.length < 0.18) flat++
    }
    const last = notes[notes.length - 1]!
    const chord = new Set(last.chordPitchClasses.map((pc) => ((pc % 12) + 12) % 12))
    if (!chord.has(((last.midi % 12) + 12) % 12)) unresolved++

    const leaps = notes.slice(1).filter(
      (note, index) => Math.abs(note.midi - notes[index]!.midi) > 5)
    if (notes.length >= 4 && leaps.length / notes.length > MAX_LEAP_SHARE) leapy++
  }
  if (flat > 0) {
    add('FLAT_CONTOUR', 'warning',
      `${flat} line(s) barely move. A melody that repeats one note is a chant, and a chant is `
      + `a weak reference to correct a vocal against.`)
  }
  holds('every line moves', flat === 0)
  if (unresolved > 0) {
    add('UNRESOLVED_PHRASE', 'error',
      `${unresolved} line(s) end on a note that is not in the chord. A line that does not land `
      + `does not sound finished, and correcting a vocal onto it makes that permanent.`)
  }
  holds('every line ends on a chord tone', unresolved === 0)
  if (leapy > 0) {
    add('EXCESSIVE_LEAP', 'warning',
      `${leapy} line(s) leap more than a fourth on over ${Math.round(MAX_LEAP_SHARE * 100)}% of `
      + `their notes. That is an instrumental line, not a sung one.`)
  }

  // Within a line, not across the breath between two. After a breath a singer
  // can start wherever the next line starts — that is what a breath is for, and
  // a deliberate lift into a final chorus is exactly such a jump. Distance
  // between sections is a separate question and has its own check below.
  let wideLeap: TargetNote | undefined
  for (const [, notes] of phrases) {
    const found = notes.slice(1).find(
      (note, index) => Math.abs(note.midi - notes[index]!.midi) > MAX_LEAP_SEMITONES)
    if (found) { wideLeap = found; break }
  }
  if (wideLeap) {
    add('EXCESSIVE_LEAP', 'error',
      `A leap wider than an octave inside one line, in ${wideLeap.sectionName} at bar `
      + `${wideLeap.bar}. Nobody sings that, so no vocal will match it.`, wideLeap.index)
  }
  holds('no leap inside a line is wider than an octave', wideLeap === undefined)

  /* 5. section continuity, chorus lift, climax ----------------------------- */

  const bySection = new Map<number, TargetNote[]>()
  for (const note of sung) {
    const bucket = bySection.get(note.sectionIndex) ?? []
    bucket.push(note)
    bySection.set(note.sectionIndex, bucket)
  }
  const sections = [...bySection.entries()].sort((a, b) => a[0] - b[0])
  for (let index = 1; index < sections.length; index++) {
    const before = sections[index - 1]![1]
    const after = sections[index]![1]
    const step = Math.abs(after[0]!.midi - before[before.length - 1]!.midi)
    if (step > MAX_LEAP_SEMITONES) {
      add('SECTION_DISCONTINUITY', 'warning',
        `${before[0]!.sectionName} ends and ${after[0]!.sectionName} begins ${step} semitones `
        + `away. A song that jumps that far between sections sounds like two songs.`,
        after[0]!.index)
    }
  }
  holds('sections join without a jump', !problems.some((p) => p.code === 'SECTION_DISCONTINUITY'))

  const average = (kind: string): number => {
    const notes = sung.filter((note) => note.section === kind)
    return notes.length === 0
      ? NaN
      : notes.reduce((total, note) => total + note.midi, 0) / notes.length
  }
  const verse = average('verse')
  const chorus = average('chorus')
  if (Number.isFinite(verse) && Number.isFinite(chorus)) {
    if (chorus <= verse) {
      add('NO_CHORUS_LIFT', 'warning',
        `The chorus sits at or below the verse (${chorus.toFixed(1)} against `
        + `${verse.toFixed(1)} in MIDI). A chorus that does not lift is not heard as one.`)
    }
    holds('the chorus sits above the verse', chorus > verse)
  }

  const choruses = sections.filter(([, notes]) =>
    notes[0]!.section === 'chorus' || notes[0]!.section === 'drop')
  if (choruses.length > 1) {
    const highest = sung.reduce((top, note) => (note.midi > top.midi ? note : top), sung[0]!)
    const lastChorus = choruses[choruses.length - 1]![0]
    if (highest.sectionIndex !== lastChorus) {
      add('NO_CLIMAX', 'warning',
        `The song's highest note is in ${highest.sectionName}, not in the last chorus. `
        + `A final chorus that is not the peak sounds like a repeat.`, highest.index)
    }
    holds('the song peaks in its last chorus', highest.sectionIndex === lastChorus)
  }

  /* 6. rhythm: durations, overlap, melisma, breaths ------------------------ */

  const badDuration = sung.find(
    (note) => note.durationBeats < 0.25 - 1e-9 || note.durationBeats > BEATS_PER_BAR + 1e-9)
  if (badDuration) {
    add('BAD_NOTE_DURATION', 'error',
      `A note of ${badDuration.durationBeats} beats in ${badDuration.sectionName}. Outside `
      + `a sixteenth to a bar, it is not a sung note.`, badDuration.index)
  }
  holds('every note is between a sixteenth and a bar long', badDuration === undefined)

  const overlap = melody.notes.slice(1).find(
    (note, index) => note.startBeat < melody.notes[index]!.startBeat
      + melody.notes[index]!.durationBeats - 1e-6)
  if (overlap) {
    add('OVERLAPPING_NOTES', 'error',
      `Two notes sound at once, at beat ${overlap.startBeat}. One singer cannot, so the `
      + `aligner would see two targets for one sung note.`, overlap.index)
  }
  holds('no two notes overlap in time', overlap === undefined)

  const badMelisma = melody.notes.find((note, index) => {
    if (!note.isMelisma) return false
    const previous = melody.notes[index - 1]
    return !previous
      || previous.syllable !== note.syllable
      || note.onsetSeconds !== 0
      || Math.abs(previous.startBeat + previous.durationBeats - note.startBeat) > 1e-6
  })
  if (badMelisma) {
    add('BAD_MELISMA', 'error',
      `A melisma that does not continue the syllable before it, at bar ${badMelisma.bar}. `
      + `A melisma is one syllable on two notes; anything else is a new word with no consonant.`,
      badMelisma.index)
  }
  holds('every melisma continues its own syllable', badMelisma === undefined)

  const rests = melody.notes.filter((note) => note.role === 'rest')
  const badRest = rests.find((note) => note.midi !== 0 || note.frequencyHz !== 0 || note.syllable)
  if (badRest) {
    add('NO_BREATH', 'error',
      `A rest carrying a pitch, at bar ${badRest.bar}. The correction stage would treat it as `
      + `a note to hit.`, badRest.index)
  }
  if (phrases.size > 1 && rests.length === 0) {
    add('NO_BREATH', 'warning',
      `${phrases.size} lines and not one breath between them. Nobody sings a song without `
      + `breathing, and the aligner uses the breaths to find the lines.`)
  }
  holds('breaths are silent and present', badRest === undefined && rests.length > 0)

  /* 7. suspensions resolve ------------------------------------------------- */

  const danglingSuspension = melody.notes.find((note, index) => {
    if (note.role !== 'suspension') return false
    const next = melody.notes[index + 1]
    return !next || next.role !== 'resolution' || !next.isChordTone
  })
  if (danglingSuspension) {
    add('UNRESOLVED_SUSPENSION', 'error',
      `A suspension with nothing resolving it, at bar ${danglingSuspension.bar}. That is not a `
      + `suspension, it is a wrong note held over a cadence.`, danglingSuspension.index)
  }
  holds('every suspension resolves onto a chord tone',
    danglingSuspension === undefined)

  return {
    usable: !problems.some((problem) => problem.severity === 'error'),
    problems,
    passed,
  }
}
