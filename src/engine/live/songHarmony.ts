/**
 * The chord progression under the song, decided before a single note is written.
 *
 * This module exists because of a defect in the first target-melody
 * implementation, and the defect is worth stating because it is the kind that
 * passes every test while being musically wrong. That version built one chord —
 * the tonic triad — and used it for the entire song. Every note's
 * `chordPitchClasses` was identical; "is this a chord tone" meant "is this one
 * of three notes"; and a chorus sitting over a bVI chord was told to resolve to
 * the tonic triad. The melody was therefore *consistent* and *wrong*, and
 * because the correction stage takes this file's output as its standard, it
 * would have corrected a correctly-sung vocal onto those wrong notes.
 *
 * So the order is harmony first, and it is not an ordering preference — it is
 * the only order in which the question "what note should this syllable sing?"
 * has an answer. A syllable does not have a pitch. A syllable over a G7 in the
 * eleventh bar of a chorus, two beats from a cadence, has a pitch.
 *
 *   key → progression per section kind → chord per bar → melody → syllables
 *
 * Nothing here is sent to ACE-Step. `constraints.ts` files chord progressions
 * under NOT_CONTROLLED_BY_ACE_STEP and that has not changed: text2music takes
 * no chord input. This is the reference the returned vocal is measured against,
 * and the thing that makes "correct vocal pitch" a question with an answer.
 *
 * The progression library, the mode filter and the roman-numeral reader are the
 * offline engine's own — the same code that composes an offline song, used here
 * as a planner. That is deliberate: they carry fixes (the mode filter, the
 * gapped-scale parent, `fitChordsToMode`) that took a long time to find, and
 * writing a second harmony engine for the live path would mean finding them
 * again.
 */

import { Rng } from '../core/rng'
import { chordName, chordPitchClasses, type Chord } from '../theory/chords'
import { harmonicScaleFor, planHarmony } from '../compose/harmony'
import { keyUsesFlats } from '../theory/chords'
import type { PitchClass, ScaleName } from '../theory/pitch'
import type { FormSlot } from '../compose/arrangement'
import type { SectionKind } from '../compose/types'
import type { LivePlan } from './plan'

/** Beats in a bar. ACE-Step's `timesignature` takes 2, 3, 4 or 6; we plan in 4. */
export const BEATS_PER_BAR = 4

/**
 * Bars a section gets at minimum.
 *
 * Two is the floor at which a progression is audible as a progression rather
 * than as a chord and then a different chord. Four is what most sections want,
 * and the allocator gives four wherever the song is long enough to afford it.
 */
const MIN_SECTION_BARS = 2

/** How busy each section is, which decides both its length and its register. */
export const SECTION_INTENSITY: Record<SectionKind, number> = {
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

export interface HarmonyBar {
  /** Bar number from the top of the song, from 0. */
  index: number
  startBeat: number
  beats: number
  startSeconds: number
  endSeconds: number
  sectionIndex: number
  section: SectionKind
  sectionName: string
  /** Position of this bar inside its section, from 0. */
  barInSection: number
  barsInSection: number
  chord: Chord
  /** Spelled in the key's own accidentals: B♭ in C minor, never A♯. */
  chordLabel: string
  root: PitchClass
  pitchClasses: PitchClass[]
  /**
   * True on a section's last bar.
   *
   * The cadence bar is where a phrase has to land somewhere the ear accepts as
   * an ending, and it is the one bar where the melody writer is not free.
   */
  isCadence: boolean
  /** True when this chord is the dominant — the bar that wants to resolve. */
  isDominant: boolean
}

export interface HarmonySection {
  index: number
  kind: SectionKind
  sectionName: string
  label: string
  /** First bar of this section, as an index into `bars`. */
  startBar: number
  bars: number
  /** The sung lines this section carries, exactly as written. */
  lines: string[]
  intensity: number
  /** The progression template this section was built from. */
  progressionId: string
}

export interface SongHarmony {
  bars: HarmonyBar[]
  sections: HarmonySection[]
  beatsPerBar: number
  bpm: number
  tonic: PitchClass
  /** The scale the chords are built from: the harmonic parent of the key. */
  scale: ScaleName
  /** The scale the melody may draw from, which may be gapped. */
  melodicScale: ScaleName
  progressionIds: string[]
  /** Total length of the harmony in seconds, at the planned tempo. */
  seconds: number
}

/**
 * How many bars the whole song gets.
 *
 * When a duration was asked for, that is the answer: the harmony has to fit the
 * song, not the other way round. When it was not — Auto, where ACE-Step picks
 * the length — the words decide, at a rate that leaves room for an intro, fills
 * and an outro rather than packing the bars wall to wall with singing.
 */
function totalBars(plan: LivePlan, bpm: number): number {
  const barSeconds = (BEATS_PER_BAR * 60) / bpm
  const requested = plan.music.targetDurationSeconds
  if (requested !== undefined && requested > 0) {
    return Math.max(4, Math.round(requested / barSeconds))
  }
  // Auto. Roughly four syllables a bar is an unhurried sung line; the sheet's
  // own minimum duration is the floor, because a sheet that cannot be sung in
  // the bars allocated is a sheet whose notes will overlap.
  const fromSyllables = Math.ceil(Math.max(1, plan.lyrics.syllables) / 4)
  const fromMinimum = Math.ceil(plan.lyrics.minimumDurationSeconds / barSeconds)
  return Math.max(8, fromSyllables, fromMinimum)
}

/**
 * Splits the song's bars across its sections.
 *
 * Weighted by how many syllables each section carries, because a section with
 * twice the words needs roughly twice the room, then floored at
 * `MIN_SECTION_BARS` and rounded to an even number of bars so a four-chord
 * progression is not cut in half. Sections with no words at all — an intro, an
 * instrumental break — get the floor: they still need harmony, they just have
 * nothing to sing over it.
 */
function barsPerSection(plan: LivePlan, total: number): number[] {
  const sections = plan.lyrics.sections
  if (sections.length === 0) return [total]

  const weights = sections.map((section) => Math.max(0.25, section.syllables))
  const sum = weights.reduce((a, b) => a + b, 0)
  const raw = weights.map((weight) => (weight / sum) * total)

  const allocated = raw.map((bars) => {
    const even = Math.round(bars / 2) * 2
    return Math.max(MIN_SECTION_BARS, even)
  })

  // The rounding above almost never sums to `total`. Correct the difference on
  // the section best able to absorb it — the longest one — rather than spreading
  // a one-bar error across every section and breaking all of their progressions.
  //
  // In pairs of bars, and only while a whole pair is owed. An odd remainder is
  // left deliberately: every allocation here is even, so a single bar of drift
  // cannot be placed without making one section odd, and a section whose bar
  // count does not divide its progression is a worse outcome than a song one bar
  // from the requested length. `seconds` reports the length actually built
  // rather than the length asked for, so nothing downstream is misled.
  //
  // The bound is not decoration. The first version of this loop ran
  // `while (drift !== 0)` in steps of two, which for any odd drift oscillates
  // between +1 and -1 forever. It hung the first time it was run, on the first
  // sheet it was given.
  let drift = allocated.reduce((a, b) => a + b, 0) - total
  for (let guard = 0; Math.abs(drift) >= 2 && guard < 4 * allocated.length + 8; guard++) {
    let target = 0
    for (let index = 1; index < allocated.length; index++) {
      if (drift > 0 ? allocated[index]! > allocated[target]! : allocated[index]! < allocated[target]!) {
        target = index
      }
    }
    const step = drift > 0 ? -2 : 2
    if (drift > 0 && allocated[target]! + step < MIN_SECTION_BARS) break
    allocated[target] = allocated[target]! + step
    drift += step
  }
  return allocated
}

/** True when a chord is the key's dominant: the one that has to resolve. */
function isDominantChord(chord: Chord, tonic: PitchClass): boolean {
  const interval = ((chord.root - tonic) % 12 + 12) % 12
  if (interval !== 7) return false
  return chord.quality === 'maj' || chord.quality === 'dom7' || chord.quality === 'dom9'
}

/**
 * Builds the harmony for a planned song.
 *
 * Deterministic: the RNG is seeded from the plan's own seed, so pressing
 * Generate twice with the same words produces the same progression, the same
 * melody and therefore the same correction targets.
 */
export function planSongHarmony(plan: LivePlan): SongHarmony {
  const bpm = plan.music.targetBpm
  const tonic = (((plan.music.tonic % 12) + 12) % 12) as PitchClass
  const melodicScale = plan.music.scale as ScaleName
  const scale = harmonicScaleFor(melodicScale)
  const secondsPerBeat = 60 / bpm
  const flats = keyUsesFlats(tonic, scale)

  const total = totalBars(plan, bpm)
  const counts = barsPerSection(plan, total)

  const planned = plan.lyrics.sections.length > 0
    ? plan.lyrics.sections
    : [{
        kind: 'verse' as SectionKind, label: 'Section', sectionName: 'Section',
        sectionDirection: '', lines: 0, syllables: 0, share: 1,
      }]

  const slots: FormSlot[] = planned.map((section, index) => ({
    kind: section.kind,
    bars: counts[index] ?? MIN_SECTION_BARS,
    intensity: SECTION_INTENSITY[section.kind] ?? 0.5,
  }))

  const harmony = planHarmony(slots, tonic, melodicScale, plan.spec.genre,
    new Rng(`${plan.spec.seed}-harmony`), plan.spec.progressionId)

  const scriptSections = plan.lyrics.script.sections
  const bars: HarmonyBar[] = []
  const sections: HarmonySection[] = []
  let barIndex = 0

  for (let index = 0; index < planned.length; index++) {
    const section = planned[index]!
    const chords = harmony.perSection[index] ?? []
    const barsInSection = slots[index]!.bars
    sections.push({
      index,
      kind: section.kind,
      sectionName: section.sectionName,
      label: section.label,
      startBar: barIndex,
      bars: barsInSection,
      lines: scriptSections[index]?.lines ?? [],
      intensity: SECTION_INTENSITY[section.kind] ?? 0.5,
      progressionId: harmony.progressionIds[index] ?? '',
    })

    for (let bar = 0; bar < barsInSection; bar++) {
      // `planHarmony` returns one chord per bar of the slot it was given, so
      // this indexes rather than cycles. The modulo is a guard, not a design.
      const chord = chords[bar % Math.max(1, chords.length)]
        ?? { root: tonic, quality: 'maj' as const, degree: 0 }
      const startBeat = barIndex * BEATS_PER_BAR
      bars.push({
        index: barIndex,
        startBeat,
        beats: BEATS_PER_BAR,
        startSeconds: startBeat * secondsPerBeat,
        endSeconds: (startBeat + BEATS_PER_BAR) * secondsPerBeat,
        sectionIndex: index,
        section: section.kind,
        sectionName: section.sectionName,
        barInSection: bar,
        barsInSection,
        chord,
        chordLabel: chordName(chord, flats),
        root: chord.root,
        pitchClasses: chordPitchClasses(chord),
        isCadence: bar === barsInSection - 1,
        isDominant: isDominantChord(chord, tonic),
      })
      barIndex++
    }
  }

  return {
    bars,
    sections,
    beatsPerBar: BEATS_PER_BAR,
    bpm,
    tonic,
    scale,
    melodicScale,
    progressionIds: harmony.progressionIds,
    seconds: barIndex * BEATS_PER_BAR * secondsPerBeat,
  }
}

/** The bar sounding at a given beat, or the last one for a beat past the end. */
export function barAtBeat(harmony: SongHarmony, beat: number): HarmonyBar {
  const index = Math.floor(beat / harmony.beatsPerBar)
  return harmony.bars[Math.max(0, Math.min(harmony.bars.length - 1, index))]!
}
