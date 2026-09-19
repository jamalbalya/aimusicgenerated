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
 * So the target is derived musically, from the plan, in this order:
 *
 *   key → progression → chord per bar → section shape → phrase contour
 *       → syllable rhythm → note → frequency
 *
 * The harmony comes first and it is not a preference. A syllable does not have
 * a pitch. A syllable over a G7, in the eleventh bar of a chorus, two beats from
 * a cadence, sung by a baritone, has a pitch. `songHarmony.ts` answers the first
 * half of that sentence and this file answers the second.
 *
 * ## What the previous version got wrong
 *
 * It wrote one note per syllable, always, over the tonic triad, always. Six
 * consequences, each of which this version addresses and tests:
 *
 *  1. **No real syllables.** It divided a section's syllable count by its line
 *     count and used the average, so a three-syllable line and a twelve-syllable
 *     line got the same number of notes. `note.syllable` was the empty string on
 *     every note in every song.
 *  2. **One chord for the whole song.** Every note's `chordPitchClasses` was the
 *     tonic triad, so "resolve to a chord tone" meant "resolve to the tonic
 *     triad" over a bVI, and the correction stage would have dragged a correctly
 *     sung vocal onto it.
 *  3. **Downbeats never happened.** Beats accumulated from a fractional
 *     syllable length and never reset to a bar line, so `beat % 4 === 0` was
 *     false after the first line and the downbeat rule silently never fired.
 *  4. **No contour.** Note choice minimised distance from the previous note,
 *     which selects the previous note whenever its own pitch class is a
 *     candidate. The line repeated notes and did not move.
 *  5. **No verse/chorus contrast.** The only difference was a centre shifted by
 *     about two semitones, and the distance term outweighed it.
 *  6. **One note per syllable exactly.** No melisma, no sustained vowel, no
 *     breath, no rest, no phrase that holds its last note. A syllable-to-note
 *     algorithm, which is what a vocal melody is not.
 *
 * ## What this is not
 *
 * A claim that ACE-Step will sing this melody. It will not — `text2music` has no
 * melody input, and `constraints.ts` files that under NOT_CONTROLLED_BY_ACE_STEP.
 * This is the *reference* the returned vocal is measured and corrected against,
 * and its value is that it is musically defensible rather than that it is
 * transmitted.
 */

import { SCALES, type PitchClass, type ScaleName } from '../theory/pitch'
import { pronounceLine, type Syllable } from '../lang'
import { Rng } from '../core/rng'

import type { SectionKind } from '../compose/types'
import type { LivePlan } from './plan'
import {
  planSongHarmony, barAtBeat, BEATS_PER_BAR,
  type HarmonyBar, type SongHarmony,
} from './songHarmony'

/** Comfortable sung ranges, in MIDI, by the voice a request asked for. */
export const VOCAL_RANGES: Record<string, { low: number; high: number }> = {
  // Roughly E2–E4 and G3–G5: the ranges a singer sits in without strain, not
  // the extremes they can reach. A melody written to the extremes is a melody
  // that will be sung badly.
  male: { low: 45, high: 64 },
  female: { low: 55, high: 76 },
  auto: { low: 50, high: 71 },
}

/**
 * Consonants produced without the vocal folds.
 *
 * The first thirty to eighty milliseconds of "so" or "ka" is turbulence, not a
 * pitch. Measuring F0 there returns whatever the detector makes of noise, and
 * pitch-shifting it smears a plosive into a chirp. Every note carries how long
 * its onset lasts so the correction stage can start after it — which is §10 of
 * the review, and the reason `onsetSeconds` exists on the payload.
 */
const UNVOICED_CONSONANTS = new Set([
  'P', 'T', 'K', 'F', 'TH', 'S', 'SH', 'CH', 'TS', 'PF', 'HH', 'X', 'CX', 'Q',
])

/** Seconds a consonant occupies before the vowel starts. */
const UNVOICED_ONSET_SECONDS = 0.045
const VOICED_ONSET_SECONDS = 0.022

/**
 * The rhythmic grid, in beats. A sixteenth note at 4/4.
 *
 * Every note start and length is a whole number of these. That is not tidiness:
 * the previous version accumulated fractional durations, so after the first line
 * of a song no note ever started on a beat again, and the rule that put chord
 * tones on downbeats — `beat % 4 === 0` — silently stopped firing for the rest
 * of the song. A melody whose notes do not land on the grid is a melody with no
 * downbeats, and a melody with no downbeats has no metre.
 */
const TICK = 0.25

/** Beats below which a note is too short to be heard as a pitch at all. */
const MIN_NOTE_BEATS = TICK

/**
 * Splits `totalTicks` between syllables in proportion to their weights.
 *
 * Largest-remainder, so the parts sum to the whole exactly and a phrase ends
 * where it was supposed to end. Every syllable gets at least one tick, and when
 * the floor means the parts no longer fit, the longest notes give the time back
 * — shortening a held syllable is survivable, dropping a syllable is not.
 */
function allocateTicks(weights: number[], totalTicks: number): number[] {
  const count = weights.length
  if (count === 0) return []
  const budget = Math.max(totalTicks, count)
  const sum = weights.reduce((a, b) => a + b, 0) || count
  const exact = weights.map((weight) => (weight / sum) * budget)
  const ticks = exact.map((value) => Math.max(1, Math.floor(value)))

  let used = ticks.reduce((a, b) => a + b, 0)
  const byRemainder = exact
    .map((value, index) => ({ index, remainder: value - Math.floor(value) }))
    .sort((a, b) => b.remainder - a.remainder || a.index - b.index)
  for (let at = 0; used < budget; at++, used++) {
    ticks[byRemainder[at % count]!.index]! += 1
  }
  const byLength = ticks
    .map((value, index) => ({ index, value }))
    .sort((a, b) => b.value - a.value || a.index - b.index)
  for (let at = 0; used > budget; at++) {
    const target = byLength[at % count]!.index
    if (ticks[target]! <= 1) continue
    ticks[target]! -= 1
    used--
  }
  return ticks
}

/** A note must be at least this long, in beats, before it can carry a melisma. */
const MELISMA_MIN_BEATS = 1.2

/**
 * Seconds a syllable takes at an unhurried sung tempo.
 *
 * About two and a half syllables a second, which is a ballad's delivery rather
 * than a rap's. In *seconds*, not beats, because the rate a person sings words
 * at does not double when the tempo does — a slow song has longer gaps, not
 * longer syllables.
 *
 * This is what decides how long a phrase takes when there is room to spare, and
 * it is the fix for a defect that survived two attempts at a cap. A sparse
 * sheet — six lines over three and a half minutes — was divided evenly across
 * its bars, so every syllable got a whole bar, every syllable therefore started
 * on a downbeat, and 93% of the notes came out structural: the correction stage
 * handed the entire vocal. Capping the note length did not help, because a
 * two-beat note lands on a strong beat just as reliably as a four-beat one.
 * Nobody sings a line holding each syllable for half a bar. They sing the line
 * at the rate people speak, and then there is a gap.
 */
const NATURAL_SYLLABLE_SECONDS = 0.42

/**
 * The longest a single syllable may be held, in beats.
 *
 * A short lyric in a long section divides into very long notes — a five-syllable
 * outro over eight bars gave the last syllable *fourteen beats*, nearly twelve
 * seconds of one pitch, which is a drone and not a note. A sung note has a
 * ceiling; the time left over is an instrumental tail, and this file says so by
 * writing a rest rather than by stretching a vowel across it.
 *
 * Half a bar, not a whole one, and the difference is measurable. At a whole bar
 * every syllable of a sparse sheet started on a downbeat, so every syllable was
 * structural: 93% of the notes of a six-line sheet over three and a half
 * minutes came out as anchors, which is the correction stage given licence over
 * the entire vocal. Nobody sings a line holding each syllable for a bar; they
 * sing the line and then there is a gap, and that gap is a rest.
 */
const MAX_NOTE_BEATS = BEATS_PER_BAR / 2
/** A phrase's last note may be held a whole bar. That is a real gesture. */
const MAX_FINAL_NOTE_BEATS = BEATS_PER_BAR

/** Same chord, as far as the melody is concerned. */
function sameHarmony(a: PitchClass[], b: PitchClass[]): boolean {
  if (a.length !== b.length) return false
  const set = new Set(b.map((pitchClass) => ((pitchClass % 12) + 12) % 12))
  return a.every((pitchClass) => set.has(((pitchClass % 12) + 12) % 12))
}

/**
 * How long a note starting at `startBeat` may actually be held.
 *
 * A note that sustains into the next bar keeps sounding after the chord under
 * it has changed. It was written as a chord tone of the bar it began in and it
 * finishes as a dissonance against the bar it ends in — held, exposed, and
 * exactly the sustained wrong note the requirement calls an audible fals. So a
 * note stops at the bar line unless the next bar carries the same chord, in
 * which case it may run on.
 */
function holdableBeats(harmony: SongHarmony, startBeat: number, wanted: number): number {
  const first = barAtBeat(harmony, startBeat)
  let available = first.startBeat + first.beats - startBeat
  for (let index = first.index + 1; available < wanted && index < harmony.bars.length; index++) {
    const next = harmony.bars[index]!
    if (!sameHarmony(first.pitchClasses, next.pitchClasses)) break
    available += next.beats
  }
  return Math.max(MIN_NOTE_BEATS, Math.min(wanted, Math.round(available / TICK) * TICK))
}

export type NoteRole =
  /** Structural. The ear hears the melody and the harmony through these. */
  | 'anchor'
  /** A scale tone passing between two chord tones. Free. */
  | 'passing'
  /** A step into an anchor. Nearly free, but it has to point the right way. */
  | 'approach'
  /** A non-chord tone held over a strong beat. It creates the tension. */
  | 'suspension'
  /** Where a suspension goes. Not optional: this is the release. */
  | 'resolution'
  /** A step away and straight back. Ornament. */
  | 'neighbour'
  /** A continuation of the previous syllable, on a new pitch. */
  | 'melisma'
  /** Silence. A breath between phrases, or the gap after a section. */
  | 'rest'

/** How a note is reached from the one before it. */
export type Transition =
  | 'onset' | 'step' | 'leap' | 'repeat' | 'slur' | 'breath' | 'octave-lift'

/** Roles that must be in tune for the song to sound in tune. */
const STRUCTURAL_ROLES: NoteRole[] = ['anchor', 'resolution']

export interface TargetNote {
  /** Index in the melody, from 0. */
  index: number

  /* ---- time --------------------------------------------------------- */
  /** Beat this note starts on, from the top of the song. */
  startBeat: number
  /** Length in beats. */
  durationBeats: number
  /** Seconds from the start of the song, at the planned tempo. */
  startSeconds: number
  endSeconds: number
  /** Bar this note starts in, from 0. */
  bar: number
  /** Position inside that bar, in beats. 0 is the downbeat. */
  beatInBar: number

  /* ---- pitch -------------------------------------------------------- */
  /** The note itself. 0 for a rest. */
  midi: number
  /** Equal-tempered frequency of `midi`, at A4 = 440. 0 for a rest. */
  frequencyHz: number
  /** Scale degree, from 0, or -1 when the note is not in the scale. */
  scaleDegree: number

  /* ---- lyric -------------------------------------------------------- */
  /** The syllable this note carries, as written. Empty for a rest. */
  syllable: string
  /** The whole line the syllable came from, exactly as the person wrote it. */
  lyricLine: string
  /** Position of this syllable in its line, from 0. */
  syllableIndex: number
  /** True when this note continues the previous syllable rather than a new one. */
  isMelisma: boolean
  /** The vowel being sung, as a phoneme code. Empty for a rest. */
  vowel: string
  /**
   * Seconds at the start of this note that are consonant, not pitch.
   *
   * The correction stage measures and shifts from `startSeconds + onsetSeconds`.
   * Shifting a plosive is what makes autotune sound like autotune.
   */
  onsetSeconds: number
  /** True when that onset is unvoiced — noise rather than a low-energy pitch. */
  onsetUnvoiced: boolean

  /* ---- structure ---------------------------------------------------- */
  /** Which phrase of the song, from 0. One phrase is one written line. */
  phrase: number
  /** Position in the phrase, from 0. */
  positionInPhrase: number
  phraseLength: number
  isPhraseStart: boolean
  isPhraseEnd: boolean
  section: SectionKind
  sectionName: string
  sectionIndex: number

  /* ---- harmony ------------------------------------------------------ */
  /** The chord sounding underneath, as pitch classes. */
  chordPitchClasses: PitchClass[]
  /** That chord's name, spelled in the key. */
  chordLabel: string
  /** True when this note is a tone of that chord rather than a colour. */
  isChordTone: boolean

  /* ---- interpretation ----------------------------------------------- */
  role: NoteRole
  transition: Transition
  /**
   * How far the sung note may sit from this one before it is worth correcting,
   * in cents.
   *
   * Not a constant, because the roles are not equivalent. An anchor over a
   * cadence has to be right. An approach note is a gesture and a singer who
   * scoops into it is singing, not making a mistake. Tightening every note to
   * the anchor tolerance is how a vocal is made robotic — which the requirement
   * forbids in the same breath as it forbids the errors.
   */
  toleranceCents: number
}

export interface TargetMelody {
  notes: TargetNote[]
  bpm: number
  beatsPerBar: number
  tonic: PitchClass
  scale: string
  /** The MIDI range the melody was written inside. */
  range: { low: number; high: number }
  /** The harmony the melody was written over. */
  harmony: SongHarmony
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

/* ------------------------------------------------------ section shapes --- */

/**
 * How a section of a song is sung, as opposed to how the whole song is sung.
 *
 * The review's second point: a verse and a chorus are not the same melody at
 * two volumes. A verse is narrow, low and conversational because it is carrying
 * information; a chorus is higher, wider and repeats itself because it is
 * carrying the hook. These numbers are that difference written down.
 */
interface SectionShape {
  /** Where the section sits in the voice, as a fraction of the range. */
  centre: number
  /** How far the line roams from that centre, in semitones. */
  span: number
  /** The shape of each phrase. */
  contour: ContourName
  /** Across the section: each phrase starts this many steps above the last. */
  stepPerPhrase: number
  /** True when later phrases of this kind reuse the first one's shape. */
  motif: boolean
  /** Extra beats the phrase's last note is held for. */
  sustain: number
  /** Beats of silence after each phrase. */
  breath: number
  /** 0..1 — how often a long syllable is given more than one note. */
  melisma: number
}

type ContourName = 'arch' | 'ascend' | 'descend' | 'wave' | 'plateau'

const SECTION_SHAPES: Record<SectionKind, SectionShape> = {
  // Low, still, unhurried. An intro that has words at all usually has few.
  intro: { centre: 0.30, span: 4, contour: 'wave', stepPerPhrase: 0, motif: false, sustain: 1.0, breath: 1.0, melisma: 0.10 },
  // Narrow and conversational. The verse carries the story, so it stays out of
  // the way of the words and keeps something in reserve for the chorus.
  verse: { centre: 0.36, span: 5, contour: 'arch', stepPerPhrase: 0, motif: true, sustain: 0.5, breath: 0.5, melisma: 0.05 },
  // The one section whose job is to go somewhere. Each phrase starts a step
  // higher than the last and the section ends unresolved, on the dominant.
  prechorus: { centre: 0.48, span: 6, contour: 'ascend', stepPerPhrase: 1, motif: false, sustain: 0.5, breath: 0.25, melisma: 0.10 },
  // Higher, wider, and the same tune every time it comes round — which is what
  // makes it a chorus rather than a third verse.
  chorus: { centre: 0.62, span: 8, contour: 'arch', stepPerPhrase: 0, motif: true, sustain: 1.5, breath: 0.5, melisma: 0.25 },
  // Contrast. A different register and a falling line, so the last chorus
  // sounds like an arrival rather than a repeat.
  bridge: { centre: 0.52, span: 7, contour: 'descend', stepPerPhrase: 0, motif: false, sustain: 1.0, breath: 0.75, melisma: 0.20 },
  solo: { centre: 0.42, span: 6, contour: 'wave', stepPerPhrase: 0, motif: false, sustain: 1.0, breath: 0.75, melisma: 0.15 },
  drop: { centre: 0.66, span: 8, contour: 'plateau', stepPerPhrase: 0, motif: true, sustain: 1.0, breath: 0.25, melisma: 0.05 },
  breakdown: { centre: 0.34, span: 4, contour: 'plateau', stepPerPhrase: 0, motif: false, sustain: 1.0, breath: 1.0, melisma: 0.05 },
  // Falling, slow, and resolved. The song has to stop somewhere the ear accepts.
  outro: { centre: 0.32, span: 4, contour: 'descend', stepPerPhrase: -1, motif: false, sustain: 2.5, breath: 1.0, melisma: 0.15 },
}

/**
 * The shape of one sung line, sampled at `t` from 0 to 1.
 *
 * Returns roughly -1..1, scaled later by the section's span. These are the five
 * shapes almost every sung phrase is one of — not a claim that no other shape
 * exists, a claim that a melody built only from these sounds like a melody,
 * where a melody built from none of them sounds like an algorithm.
 */
function contourAt(name: ContourName, t: number): number {
  switch (name) {
    // Up and back down. The default sung phrase: it breathes.
    case 'arch': return Math.sin(Math.PI * t) * 1.1 - 0.35
    // Rising to the end. Unresolved, which is what a pre-chorus wants.
    case 'ascend': return -0.7 + 1.5 * t
    // Falling. An answer rather than a question.
    case 'descend': return 0.8 - 1.6 * t
    // Two small waves around the centre: narrow, restless, conversational.
    case 'wave': return Math.sin(2 * Math.PI * t) * 0.7
    // Held, then dropping away at the end. Dense lines and chanted hooks.
    default: return t < 0.72 ? 0.15 : 0.15 - (t - 0.72) * 4.0
  }
}

/* ----------------------------------------------------------- the ladder --- */

/**
 * Every note of the key inside the singer's range, in order.
 *
 * Melodies are written in scale steps, not semitones — "up two" means two notes
 * of the key, which is three semitones here and four there. Working on an index
 * into this array is what makes "step" and "leap" mean what a musician means by
 * them, and it is why the previous version's semitone arithmetic produced
 * chromatic wandering.
 */
function buildLadder(tonic: PitchClass, scale: ScaleName, range: { low: number; high: number }): number[] {
  const steps = SCALES[scale] ?? SCALES.major
  const pitchClasses = new Set(steps.map((step) => (((tonic + step) % 12) + 12) % 12))
  const ladder: number[] = []
  for (let midi = range.low; midi <= range.high; midi++) {
    if (pitchClasses.has(((midi % 12) + 12) % 12)) ladder.push(midi)
  }
  // A range narrower than the scale would leave this empty and every later
  // lookup undefined. Chromatic is wrong but it is a melody; empty is a crash.
  return ladder.length > 0 ? ladder : [range.low, range.high]
}

/**
 * Stops a breath running into the line it precedes.
 *
 * A phrase's trailing rest is sized to fill the phrase's slot, but it is given
 * at least `shape.breath` beats even when the words already used the slot up.
 * The next phrase then starts at `Math.round(beat)`, which rounds *down* when
 * that overrun is under half a beat — and a rest that ends at 4.25 sits across
 * a line that starts at 4.
 *
 * On most sheets the arithmetic happens to work out. On the Tetap Memilihmu
 * sheet it did not, in seven places, and the melody validator rejected the
 * whole melody for `OVERLAPPING_NOTES`. A rejected melody is not sent at all,
 * so the consequence was not a slightly wrong reference: it was no reference,
 * silently, with the failure only visible in a validator report nobody reads
 * before pressing the button.
 *
 * The repair trims the silence rather than moving the song. A rest is cut back
 * to where the next note begins, and a rest with nothing left is dropped. No
 * sung note changes pitch, start or length, so the melody is the one the
 * planner laid out — it simply no longer claims two notes sound at once.
 * Trimming only ever shortens a rest; a sung note that overlapped would be a
 * different defect and is deliberately left for the validator to catch.
 */
function trimRestsToNextNote(notes: TargetNote[], secondsPerBeat: number): TargetNote[] {
  const kept: TargetNote[] = []
  for (let index = 0; index < notes.length; index++) {
    const note = notes[index]!
    const next = notes[index + 1]
    if (note.role === 'rest' && next !== undefined) {
      const room = next.startBeat - note.startBeat
      if (room <= 1e-9) continue
      if (note.durationBeats > room + 1e-9) {
        note.durationBeats = room
        note.endSeconds = note.startSeconds + room * secondsPerBeat
      }
    }
    kept.push(note)
  }
  for (let index = 0; index < kept.length; index++) kept[index]!.index = index
  return kept
}

/** The rung nearest a MIDI note. */
function rungNear(ladder: number[], midi: number): number {
  let best = 0
  let bestDistance = Infinity
  for (let index = 0; index < ladder.length; index++) {
    const distance = Math.abs(ladder[index]! - midi)
    if (distance < bestDistance) { bestDistance = distance; best = index }
  }
  return best
}

/** The nearest rung to `rung` whose pitch class belongs to `chord`. */
function nearestChordRung(ladder: number[], rung: number, chord: PitchClass[]): number {
  if (chord.length === 0) return rung
  const wanted = new Set(chord.map((pitchClass) => ((pitchClass % 12) + 12) % 12))
  for (let distance = 0; distance < ladder.length; distance++) {
    for (const direction of distance === 0 ? [0] : [-1, 1]) {
      const index = rung + direction * distance
      if (index < 0 || index >= ladder.length) continue
      if (wanted.has(((ladder[index]! % 12) + 12) % 12)) return index
    }
  }
  return rung
}

const clampRung = (ladder: number[], rung: number): number =>
  Math.max(0, Math.min(ladder.length - 1, rung))

/* ------------------------------------------------------------- phrases --- */

/** One written line, turned into the syllables that will be sung. */
interface Phrase {
  line: string
  syllables: Syllable[]
  sectionIndex: number
}

/** Seconds of consonant before the vowel of a syllable sounds. */
function onsetOf(syllable: Syllable): { seconds: number; unvoiced: boolean } {
  if (syllable.onset.length === 0) return { seconds: 0, unvoiced: false }
  let seconds = 0
  let unvoiced = false
  for (const consonant of syllable.onset) {
    if (UNVOICED_CONSONANTS.has(consonant)) {
      seconds += UNVOICED_ONSET_SECONDS
      unvoiced = true
    } else {
      seconds += VOICED_ONSET_SECONDS
    }
  }
  return { seconds, unvoiced }
}

/**
 * How much of a phrase's time each syllable gets.
 *
 * Not equal shares. A syllable that closes on a consonant takes longer to say
 * than an open one; the last syllable of a line is held; a line's first
 * syllable is often picked up quickly. This is an estimate and is labelled as
 * one everywhere it is used — without a forced aligner nothing here knows what
 * ACE-Step will actually do with the words. The alignment stage matches the
 * estimate to what was really sung rather than assuming it was obeyed.
 */
function syllableWeights(syllables: Syllable[], sustain: number): number[] {
  return syllables.map((syllable, index) => {
    let weight = 1
    if (syllable.coda.length > 0) weight += 0.22 * Math.min(2, syllable.coda.length)
    if (syllable.glide) weight += 0.25
    if (index === syllables.length - 1) weight += sustain
    return weight
  })
}

/* --------------------------------------------------------------- notes --- */

/** Payload role codes. The Space reads these; keep them in step with `ROLE_CODES`. */
export const ROLE_CODES: Record<NoteRole, number> = {
  passing: 0, anchor: 1, approach: 2, suspension: 3,
  resolution: 4, neighbour: 5, melisma: 6, rest: 7,
}

/**
 * How far a note of each role may be out before it is worth touching.
 *
 * The anchor figure is the one that decides whether the song is in tune; the
 * rest are deliberately looser, because a performance that is correct on every
 * one of them at 35 cents is a performance with no expression left in it.
 */
const ROLE_TOLERANCE_CENTS: Record<NoteRole, number> = {
  anchor: 35,
  resolution: 40,
  suspension: 45,
  approach: 60,
  neighbour: 60,
  passing: 70,
  melisma: 70,
  rest: 1200,
}

/** The scale degree of a MIDI note in the key, or -1 when it is chromatic. */
function scaleDegreeOf(midi: number, tonic: PitchClass, scale: ScaleName): number {
  const steps = SCALES[scale] ?? SCALES.major
  const interval = (((midi - tonic) % 12) + 12) % 12
  return (steps as readonly number[]).indexOf(interval)
}

/**
 * Writes the melody.
 *
 * The order inside is the order of the docstring at the top of the file, and
 * each stage only reads from the ones above it:
 *
 *  1. Harmony for the whole song, from `songHarmony.ts`.
 *  2. Each written line becomes a phrase of real syllables, in the language the
 *     planner detected.
 *  3. Each section gets a shape — register, span, phrase contour, whether it
 *     repeats itself.
 *  4. Each phrase gets its bars, its contour and its rhythm.
 *  5. Each syllable gets a note, fitted to the chord under it, and classified.
 *  6. Long syllables may be split into a melisma; phrases end with a breath.
 */
export function buildTargetMelody(plan: LivePlan, vocalGender: 'male' | 'female' | 'auto'): TargetMelody {
  const { music, lyrics } = plan
  const range = VOCAL_RANGES[vocalGender] ?? VOCAL_RANGES.auto!
  const harmony = planSongHarmony(plan)
  const bpm = harmony.bpm
  const secondsPerBeat = 60 / bpm
  const tonic = harmony.tonic
  const melodicScale = harmony.melodicScale

  const empty = (reason: string): TargetMelody => ({
    notes: [], bpm, beatsPerBar: BEATS_PER_BAR, tonic, scale: harmony.scale,
    range, harmony, unavailable: reason,
  })

  if (music.instrumental) {
    return empty('This is an instrumental: there is no vocal to write a melody for.')
  }
  if (lyrics.sections.length === 0 || lyrics.syllables === 0) {
    return empty('No sung syllables were found, so there is nothing to write a melody for.')
  }

  const ladder = buildLadder(tonic, melodicScale, range)
  const rng = new Rng(`${plan.spec.seed}-melody-${vocalGender}`)

  // The last chorus (or drop) in the song. Its first phrase is where the song
  // peaks — the one place the melody is allowed to go higher than it has been,
  // which is what makes a final chorus sound like one rather than like the
  // second chorus played again.
  const climaxSection = (() => {
    for (let index = harmony.sections.length - 1; index >= 0; index--) {
      const kind = harmony.sections[index]!.kind
      if (kind === 'chorus' || kind === 'drop') return index
    }
    return -1
  })()
  const chorusCount = harmony.sections.filter((s) => s.kind === 'chorus' || s.kind === 'drop').length

  /**
   * Contours already written, so a chorus is the same tune every time.
   *
   * Keyed by section kind and the phrase's position inside its section, so the
   * second chorus's third line gets the first chorus's third line — not some
   * other line of it. Stored as ladder offsets, which transpose: the same shape
   * over a different chord comes out fitted to that chord.
   *
   * The ornaments are stored with the shape. They were not at first, and the
   * consequence was not subtle: melisma is a per-note decision, so the first
   * chorus put one on a syllable and the second did not, the two lines then had
   * different numbers of notes, and the repeat that was supposed to be the hook
   * shared as little as none of its contour with the original. A chorus repeats
   * its ornaments too.
   */
  const motifs = new Map<string, { offsets: number[]; melismas: boolean[] }>()

  const notes: TargetNote[] = []
  /**
   * Where the previous section's last note ended.
   *
   * A section normally starts at its own first bar, but a sheet whose words do
   * not fit the time asked for will overrun — and that is a conflict the planner
   * reports rather than resolves, because resolving it means deleting somebody's
   * lyrics. What must not happen is two sections' notes overlapping in time: the
   * aligner would then see two planned notes for one sung one. So a section
   * starts at its own bar or where the last one finished, whichever is later.
   */
  let cursor = 0
  let phraseNumber = 0
  let previousRung = rungNear(ladder, range.low + (range.high - range.low) * 0.45)
  let previousMidi = ladder[previousRung]!

  for (const section of harmony.sections) {
    const shape = SECTION_SHAPES[section.kind] ?? SECTION_SHAPES.verse
    const isClimax = section.index === climaxSection && chorusCount > 1

    const phrases: Phrase[] = section.lines
      .map((line) => ({ line, syllables: pronounceLine(line, lyrics.language), sectionIndex: section.index }))
      .filter((phrase) => phrase.syllables.length > 0)
    if (phrases.length === 0) continue

    // The section's own beats, split between its phrases by how many syllables
    // each one carries. A four-word line and a twelve-word line do not get the
    // same bar, which is the defect this replaces.
    const sectionStartBeat = section.startBar * BEATS_PER_BAR
    const sectionBeats = section.bars * BEATS_PER_BAR
    const totalSyllables = phrases.reduce((sum, phrase) => sum + phrase.syllables.length, 0)

    // The register. A final chorus is lifted, and the lift is small on purpose:
    // a chorus a fifth above the verse is a different song, not a bigger one.
    const centreFraction = Math.min(0.92, shape.centre + (isClimax ? 0.08 : 0))
    const sectionCentre = range.low + (range.high - range.low) * centreFraction
    const centreRung = rungNear(ladder, sectionCentre)
    // Span in rungs rather than semitones: a diatonic step is not a constant.
    const rungsPerSemitone = ladder.length > 1
      ? (ladder.length - 1) / Math.max(1, ladder[ladder.length - 1]! - ladder[0]!)
      : 1
    const spanRungs = Math.max(1, Math.round((shape.span / 2) * rungsPerSemitone))

    let beat = Math.max(sectionStartBeat, cursor)

    for (let phraseIndex = 0; phraseIndex < phrases.length; phraseIndex++) {
      const phrase = phrases[phraseIndex]!
      const syllables = phrase.syllables
      const share = syllables.length / Math.max(1, totalSyllables)
      // The phrase's slot in the section: its share of the bars.
      const slotBeats = Math.max(syllables.length * MIN_NOTE_BEATS, sectionBeats * share)
      const breathBeats = Math.round(Math.min(shape.breath, slotBeats * 0.2) / TICK) * TICK
      // How long the words take when nothing is rushing them. When the slot is
      // bigger than that, the surplus is silence — an instrumental gap between
      // lines — and not a syllable stretched to fill it.
      const naturalBeats = syllables.length * (NATURAL_SYLLABLE_SECONDS / secondsPerBeat)
        + shape.sustain
      const singingBeats = Math.max(
        syllables.length * MIN_NOTE_BEATS,
        Math.min(naturalBeats, slotBeats - breathBeats))
      // A phrase begins on a beat. Rounding here rather than letting the
      // previous phrase's rounding decide is what keeps bar lines where the
      // harmony put them, however the syllables before it divided up.
      beat = Math.round(beat)

      /* --- the contour ------------------------------------------------ */

      const motifKey = `${section.kind}:${phraseIndex}`
      const stored = shape.motif ? motifs.get(motifKey) : undefined
      const offsets: number[] = []
      const melismas: boolean[] = []
      for (let index = 0; index < syllables.length; index++) {
        const t = syllables.length === 1 ? 0.5 : index / (syllables.length - 1)
        if (stored && stored.offsets.length > 0) {
          // Reuse by resampling, so a repeated chorus with a line one syllable
          // longer still sings the same shape rather than a different tune.
          const at = Math.round(t * (stored.offsets.length - 1))
          offsets.push(stored.offsets[at]!)
          melismas.push(stored.melismas[at] ?? false)
        } else {
          const base = contourAt(shape.contour, t) * spanRungs
          // A small deterministic wobble, so two lines of the same contour are
          // not identical. Seeded from the plan, so it is the same every press.
          const wobble = rng.next() < 0.28 ? (rng.next() < 0.5 ? -1 : 1) : 0
          offsets.push(Math.round(base) + wobble)
          melismas.push(rng.next() < shape.melisma)
        }
      }
      if (shape.motif && !stored) {
        motifs.set(motifKey, { offsets: offsets.slice(), melismas: melismas.slice() })
      }

      const phraseLift = shape.stepPerPhrase * phraseIndex
      const weights = syllableWeights(syllables, shape.sustain)
      const ticks = allocateTicks(weights, Math.round(singingBeats / TICK))

      /* --- the notes -------------------------------------------------- */

      const phraseStartIndex = notes.length
      let syllableBeat = beat
      // How many melismas this line may carry, and never two in a row.
      // Without a budget a slow chorus put one on every other syllable — the
      // notes were right and the line was unsingable, which is the sort of
      // thing only listening to the output catches.
      let melismaBudget = Math.max(1, Math.round(syllables.length / 6))
      let melismaJustWritten = false

      for (let index = 0; index < syllables.length; index++) {
        const syllable = syllables[index]!
        const isLast = index === syllables.length - 1
        const isFirst = index === 0
        const duration = holdableBeats(harmony, syllableBeat, Math.min(
          (ticks[index] ?? 1) * TICK, isLast ? MAX_FINAL_NOTE_BEATS : MAX_NOTE_BEATS))
        const bar = barAtBeat(harmony, syllableBeat)
        const beatInBar = syllableBeat - bar.startBeat
        const onDownbeat = beatInBar < TICK / 2
        const onBackbeat = Math.abs(beatInBar - BEATS_PER_BAR / 2) < TICK / 2
        // Strong: the ear is listening for the harmony here, so the note has to
        // belong to the chord. Everything else is free to be a colour.
        //
        // Deliberately narrow. The first version called a note strong if it was
        // a downbeat *or* over 1.5 beats long, and in a slow ballad that is most
        // of the song — 59% of the notes came out as anchors, which would have
        // handed the correction stage licence to move nearly every note in the
        // vocal. Half a performance corrected is a machined performance.
        //
        // Metre decides, not length. A `duration >= 2.5` clause looked
        // reasonable and was not: in a sparse song every syllable is long, so
        // it promoted 90% of the notes in a six-line sheet over three and a
        // half minutes. Where a song really does give each syllable its own
        // bar, every syllable really is on a downbeat and really is
        // structural — but that has to follow from the metre rather than from
        // a length threshold that happens to agree with it.
        const strong = isFirst || isLast
          || (onDownbeat && duration >= 0.5)
          || (onBackbeat && duration >= 1.5)

        let rung = clampRung(ladder, centreRung + offsets[index]! + phraseLift)
        if (strong) rung = clampRung(ladder, nearestChordRung(ladder, rung, bar.pitchClasses))

        // The climax note: the highest chord tone in range, on the first strong
        // note of the final chorus's first phrase. One note, once in the song.
        let octaveLift = false
        if (isClimax && phraseIndex === 0 && isFirst) {
          // The highest chord tone that is still within an octave of where the
          // line would otherwise have started. Taking the top of the ladder
          // outright — which is what this did first — put the final chorus 16
          // semitones above the end of the verse before it, across a breath.
          // That is not a climax, it is a different song, and the melody
          // checker caught it as a leap nobody would sing.
          const ceiling = rungNear(ladder, Math.min(range.high, ladder[rung]! + 12))
          const lifted = nearestChordRung(ladder, ceiling, bar.pitchClasses)
          const rise = ladder[lifted]! - ladder[rung]!
          if (rise >= 5 && rise <= 12) { rung = lifted; octaveLift = true }
        }

        const midi = ladder[clampRung(ladder, rung)]!
        const chordSet = new Set(bar.pitchClasses.map((pitchClass) => ((pitchClass % 12) + 12) % 12))
        const isChordTone = chordSet.has(((midi % 12) + 12) % 12)

        const role = classify({ strong, isChordTone })
        const transition = octaveLift ? 'octave-lift' : transitionFrom(previousMidi, midi, isFirst)
        const { seconds: onsetSeconds, unvoiced } = onsetOf(syllable)

        notes.push(makeNote({
          index: notes.length, startBeat: syllableBeat, durationBeats: duration,
          secondsPerBeat, bar, beatInBar, midi, tonic, scale: melodicScale,
          syllable: syllable.text, vowel: syllable.vowel, lyricLine: phrase.line,
          syllableIndex: index, isMelisma: false,
          onsetSeconds: Math.min(onsetSeconds, duration * secondsPerBeat * 0.35),
          onsetUnvoiced: unvoiced,
          phrase: phraseNumber, positionInPhrase: notes.length - phraseStartIndex,
          phraseLength: syllables.length, isPhraseStart: isFirst, isPhraseEnd: isLast,
          section, isChordTone, role, transition,
        }))

        previousMidi = midi
        previousRung = clampRung(ladder, rung)
        syllableBeat += duration

        /* --- melisma ------------------------------------------------- */

        // A held syllable that moves. This is the difference between a sung
        // line and a spoken one on pitches, and the previous version had none
        // of it: one syllable, one note, every time.
        const mayMelisma = melismaBudget > 0 && !melismaJustWritten
          && duration >= MELISMA_MIN_BEATS
        melismaJustWritten = false
        if (mayMelisma && melismas[index]) {
          melismaBudget--
          melismaJustWritten = true
          // On the grid, like everything else, and never so long that the
          // syllable it was taken from drops below one tick.
          const wanted = Math.round(Math.min(duration * 0.4, 0.75) / TICK) * TICK
          const extra = Math.max(TICK, Math.min(wanted, duration - TICK))
          // Take the time from the syllable rather than adding to the phrase,
          // so a melisma never pushes the next line off its bar.
          const previous = notes[notes.length - 1]!
          previous.durationBeats -= extra
          previous.endSeconds = (previous.startBeat + previous.durationBeats) * secondsPerBeat
          const melismaBeat = previous.startBeat + previous.durationBeats
          const melismaBar = barAtBeat(harmony, melismaBeat)
          // Down a step, then the ear hears it as the same syllable settling
          // rather than as a new word.
          const melismaRung = clampRung(ladder, previousRung - 1)
          const melismaMidi = ladder[melismaRung]!
          const melismaChord = new Set(
            melismaBar.pitchClasses.map((pitchClass) => ((pitchClass % 12) + 12) % 12))
          notes.push(makeNote({
            index: notes.length, startBeat: melismaBeat, durationBeats: extra,
            secondsPerBeat, bar: melismaBar, beatInBar: melismaBeat - melismaBar.startBeat,
            midi: melismaMidi, tonic, scale: melodicScale,
            syllable: syllable.text, vowel: syllable.vowel, lyricLine: phrase.line,
            syllableIndex: index, isMelisma: true,
            // No onset: it is the same syllable, already started.
            onsetSeconds: 0, onsetUnvoiced: false,
            phrase: phraseNumber, positionInPhrase: notes.length - phraseStartIndex,
            phraseLength: syllables.length, isPhraseStart: false, isPhraseEnd: isLast,
            section, isChordTone: melismaChord.has(((melismaMidi % 12) + 12) % 12),
            role: 'melisma', transition: 'slur',
          }))
          // `previousMidi` carries into the next note's transition label;
          // `previousRung` does not need updating, because the next syllable
          // takes its rung from the contour rather than from this note, and a
          // second melisma cannot follow this one.
          previousMidi = melismaMidi
        }
      }

      /* --- the breath, and whatever the words did not need --------------- */

      // One rest covering both, so a phrase always occupies its whole slot and
      // the next line starts where the section's bars say it should rather than
      // wherever the syllables happened to run out.
      const slotEnd = Math.round(beat + slotBeats)
      const gapBeats = Math.max(breathBeats, Math.round((slotEnd - syllableBeat) / TICK) * TICK)
      if (gapBeats >= 0.2) {
        const restBar = barAtBeat(harmony, syllableBeat)
        notes.push(makeNote({
          index: notes.length, startBeat: syllableBeat, durationBeats: gapBeats,
          secondsPerBeat, bar: restBar, beatInBar: syllableBeat - restBar.startBeat,
          midi: 0, tonic, scale: melodicScale, syllable: '', vowel: '',
          lyricLine: phrase.line, syllableIndex: syllables.length, isMelisma: false,
          onsetSeconds: 0, onsetUnvoiced: false,
          phrase: phraseNumber, positionInPhrase: notes.length - phraseStartIndex,
          phraseLength: syllables.length, isPhraseStart: false, isPhraseEnd: false,
          section, isChordTone: false, role: 'rest', transition: 'breath',
        }))
        syllableBeat += gapBeats
      }

      resolveSuspensions(notes, phraseStartIndex, ladder)
      applyCadentialSuspension(notes, phraseStartIndex, ladder)
      beat = syllableBeat
      phraseNumber++
    }

    // What is left of the section after the words run out. A rest, explicitly,
    // rather than a note stretched to cover it: the vocal is supposed to be
    // silent here, and a planned rest is how the correction stage is told that
    // anything it hears in this stretch is not a note it should be judging.
    const sectionEnd = sectionStartBeat + sectionBeats
    if (sectionEnd - beat >= 1) {
      const tailBar = barAtBeat(harmony, beat)
      notes.push(makeNote({
        index: notes.length, startBeat: beat, durationBeats: sectionEnd - beat,
        secondsPerBeat, bar: tailBar, beatInBar: beat - tailBar.startBeat,
        midi: 0, tonic, scale: melodicScale, syllable: '', vowel: '',
        lyricLine: '', syllableIndex: 0, isMelisma: false,
        onsetSeconds: 0, onsetUnvoiced: false,
        phrase: phraseNumber, positionInPhrase: 0, phraseLength: 0,
        isPhraseStart: false, isPhraseEnd: false,
        section, isChordTone: false, role: 'rest', transition: 'breath',
      }))
      beat = sectionEnd
    }
    cursor = beat
  }

  return {
    notes: trimRestsToNextNote(notes, secondsPerBeat),
    bpm, beatsPerBar: BEATS_PER_BAR, tonic, scale: harmony.scale, range, harmony,
  }
}

/* ------------------------------------------------------- classification --- */

/**
 * What a note is, from where it sits and what is under it.
 *
 * Three cases and no more, because every extra case here was a way to promote a
 * note to `anchor` that had no business being one. The first version had two
 * such clauses — "a chord tone longer than a beat" and "anything in a cadence
 * bar" — and between them 59% of a ballad's notes came out as anchors, two of
 * them not even chord tones. An anchor is a note the correction stage is
 * allowed to move. The set has to be small and it has to be right.
 *
 * Every strong position is snapped to a chord tone before this runs, so
 * `strong && !isChordTone` is unreachable from the writer and the suspension
 * case exists for `applyCadentialSuspension`, which creates one on purpose.
 */
function classify(context: { strong: boolean; isChordTone: boolean }): NoteRole {
  if (context.strong) return context.isChordTone ? 'anchor' : 'suspension'
  return 'passing'
}

/**
 * Writes a suspension into a phrase's cadence, where the phrase can carry one.
 *
 * A suspension is a note held over from the harmony before it, dissonant
 * against the chord that has arrived, which then steps down onto a chord tone.
 * It is the oldest device in sung melody and the reason a line sounds like it
 * *arrives* rather than simply stopping — and the first version of this file
 * had no mechanism that could produce one, because it snapped every strong note
 * onto a chord tone and left no dissonance to resolve.
 *
 * So one is placed deliberately: the note before a phrase's final anchor is
 * lifted to the scale step above it, and the final anchor becomes its
 * resolution. Only where the phrase is long enough to have somewhere to come
 * from, and only where the note being displaced is a free one.
 */
function applyCadentialSuspension(notes: TargetNote[], from: number, ladder: number[]): void {
  const phrase = notes.slice(from).filter((note) => note.role !== 'rest')
  if (phrase.length < 3) return
  const last = phrase[phrase.length - 1]!
  const before = phrase[phrase.length - 2]!
  if (last.role !== 'anchor' || last.midi <= 0) return
  if (before.role !== 'passing' && before.role !== 'approach') return
  if (before.isMelisma || before.midi <= 0) return

  const lastRung = ladder.indexOf(last.midi)
  if (lastRung < 0 || lastRung + 1 >= ladder.length) return
  const suspended = ladder[lastRung + 1]!
  // Only when the step above is genuinely dissonant against this chord. A
  // "suspension" onto another chord tone resolves nothing.
  const chord = new Set(last.chordPitchClasses.map((pitchClass) => ((pitchClass % 12) + 12) % 12))
  if (chord.has(((suspended % 12) + 12) % 12)) return

  before.midi = suspended
  before.frequencyHz = midiToHz(suspended)
  before.isChordTone = false
  before.role = 'suspension'
  before.toleranceCents = ROLE_TOLERANCE_CENTS.suspension
  before.transition = 'step'
  last.role = 'resolution'
  last.toleranceCents = ROLE_TOLERANCE_CENTS.resolution
}

/**
 * Turns the note after each suspension into its resolution.
 *
 * Run once per phrase, after the phrase is written, because a suspension is
 * only a suspension if something follows it. A suspension with nothing after it
 * is just a wrong note held over a cadence, and it is re-labelled an anchor so
 * the correction stage treats it as one.
 */
function resolveSuspensions(notes: TargetNote[], from: number, ladder: number[]): void {
  // Whatever a phrase ends on — a syllable, a melisma, an ornament — it has to
  // be a chord tone and it has to be structural. A phrase that ends on a
  // passing note does not sound like it has ended, and a melisma that trails
  // off a semitone from the chord is exactly the "audible fals" the requirement
  // names. The writer snaps strong notes, and a trailing melisma is not one.
  const sung = notes.slice(from).filter((note) => note.role !== 'rest')
  const final = sung[sung.length - 1]
  if (final && final.midi > 0 && !final.isChordTone) {
    const rung = ladder.indexOf(final.midi)
    if (rung >= 0) {
      const landed = ladder[nearestChordRung(ladder, rung, final.chordPitchClasses)]!
      final.midi = landed
      final.frequencyHz = midiToHz(landed)
      final.isChordTone = true
    }
  }
  if (final && final.role === 'melisma' && final.isChordTone) {
    final.role = 'resolution'
    final.toleranceCents = ROLE_TOLERANCE_CENTS.resolution
  }

  for (let index = from; index < notes.length; index++) {
    if (notes[index]!.role !== 'suspension') continue
    const next = notes[index + 1]
    if (!next || next.role === 'rest') {
      notes[index]!.role = 'anchor'
      notes[index]!.toleranceCents = ROLE_TOLERANCE_CENTS.anchor
      continue
    }
    if (next.isChordTone) {
      next.role = 'resolution'
      next.toleranceCents = ROLE_TOLERANCE_CENTS.resolution
    }
  }
  // Approach notes: the note before an anchor, a step away from it. Labelled
  // last because it depends on what its neighbour turned out to be.
  for (let index = from; index < notes.length - 1; index++) {
    const note = notes[index]!
    const next = notes[index + 1]!
    if (note.role !== 'passing' || next.role !== 'anchor') continue
    if (Math.abs(next.midi - note.midi) <= 2 && note.midi > 0) {
      note.role = 'approach'
      note.toleranceCents = ROLE_TOLERANCE_CENTS.approach
    }
  }
  // Neighbours: away and straight back to the same note.
  for (let index = from + 1; index < notes.length - 1; index++) {
    const note = notes[index]!
    const before = notes[index - 1]!
    const after = notes[index + 1]!
    if (note.role !== 'passing' && note.role !== 'approach') continue
    if (before.midi > 0 && before.midi === after.midi && Math.abs(note.midi - before.midi) <= 2) {
      note.role = 'neighbour'
      note.toleranceCents = ROLE_TOLERANCE_CENTS.neighbour
    }
  }
}

function transitionFrom(previousMidi: number, midi: number, isFirst: boolean): Transition {
  if (isFirst) return 'onset'
  const interval = Math.abs(midi - previousMidi)
  if (interval === 0) return 'repeat'
  if (interval <= 2) return 'step'
  return 'leap'
}

/* -------------------------------------------------------------- making --- */

function makeNote(fields: {
  index: number; startBeat: number; durationBeats: number; secondsPerBeat: number
  bar: HarmonyBar; beatInBar: number; midi: number; tonic: PitchClass; scale: ScaleName
  syllable: string; vowel: string; lyricLine: string; syllableIndex: number
  isMelisma: boolean; onsetSeconds: number; onsetUnvoiced: boolean
  phrase: number; positionInPhrase: number; phraseLength: number
  isPhraseStart: boolean; isPhraseEnd: boolean
  section: { kind: SectionKind; sectionName: string; index: number }
  isChordTone: boolean; role: NoteRole; transition: Transition
}): TargetNote {
  const { startBeat, durationBeats, secondsPerBeat, midi } = fields
  return {
    index: fields.index,
    startBeat,
    durationBeats,
    startSeconds: startBeat * secondsPerBeat,
    endSeconds: (startBeat + durationBeats) * secondsPerBeat,
    bar: fields.bar.index,
    beatInBar: fields.beatInBar,
    midi,
    frequencyHz: midi > 0 ? midiToHz(midi) : 0,
    scaleDegree: midi > 0 ? scaleDegreeOf(midi, fields.tonic, fields.scale) : -1,
    syllable: fields.syllable,
    lyricLine: fields.lyricLine,
    syllableIndex: fields.syllableIndex,
    isMelisma: fields.isMelisma,
    vowel: fields.vowel,
    onsetSeconds: fields.onsetSeconds,
    onsetUnvoiced: fields.onsetUnvoiced,
    phrase: fields.phrase,
    positionInPhrase: fields.positionInPhrase,
    phraseLength: fields.phraseLength,
    isPhraseStart: fields.isPhraseStart,
    isPhraseEnd: fields.isPhraseEnd,
    section: fields.section.kind,
    sectionName: fields.section.sectionName,
    sectionIndex: fields.section.index,
    chordPitchClasses: fields.bar.pitchClasses,
    chordLabel: fields.bar.chordLabel,
    isChordTone: fields.isChordTone,
    role: fields.role,
    transition: fields.transition,
    toleranceCents: ROLE_TOLERANCE_CENTS[fields.role],
  }
}

/* --------------------------------------------------------------- output --- */

/** Every note the song has to get right for the song to be in tune. */
export function anchorNotes(melody: TargetMelody): TargetNote[] {
  return melody.notes.filter((note) => STRUCTURAL_ROLES.includes(note.role))
}

/** Every sung note, which is everything except the breaths. */
export function sungNotes(melody: TargetMelody): TargetNote[] {
  return melody.notes.filter((note) => note.role !== 'rest')
}

/**
 * The melody as the Space receives it: a compact JSON payload.
 *
 * Sent alongside the request so the correction stage has the same reference the
 * planner wrote, rather than re-deriving it from a plan it does not have. Kept
 * to plain numbers deliberately — a four-minute song is a few hundred notes, and
 * this travels in an HTTP body next to a 4096-character lyric sheet.
 *
 * Six fields per note rather than the four the first version sent, and each of
 * the two new ones answers a specific question the correction stage could not
 * answer before:
 *
 *  - `phrase` — which sung line this note belongs to, so alignment can match a
 *    phrase of measured notes against a phrase of planned ones instead of
 *    matching every note independently and letting them cross.
 *  - `onsetMs` — how much of the note is consonant, so the measurement starts
 *    at the vowel and the shifter leaves the plosive alone.
 */
export interface MelodyPayload {
  bpm: number
  tonic: number
  scale: string
  rangeLow: number
  rangeHigh: number
  /** Chord per bar, as pitch-class lists, for the record and for diagnostics. */
  bars: number[][]
  /** [startSeconds, endSeconds, midi, roleCode, phrase, onsetMs] per note. */
  notes: [number, number, number, number, number, number][]
}

export function melodyPayload(melody: TargetMelody): MelodyPayload {
  return {
    bpm: melody.bpm,
    tonic: melody.tonic,
    scale: melody.scale,
    rangeLow: melody.range.low,
    rangeHigh: melody.range.high,
    bars: melody.harmony.bars.map((bar) => bar.pitchClasses),
    notes: melody.notes.map((note) => [
      Math.round(note.startSeconds * 1000) / 1000,
      Math.round(note.endSeconds * 1000) / 1000,
      note.midi,
      ROLE_CODES[note.role],
      note.phrase,
      Math.round(note.onsetSeconds * 1000),
    ]),
  }
}
