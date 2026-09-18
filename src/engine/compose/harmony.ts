/** Chooses the chord sequence for each section of the form. */

import { Rng } from '../core/rng'
import {
  CHORD_INTERVALS, chordPitchClasses, diatonicQuality, parseRoman, type Chord,
} from '../theory/chords'
import { getProgression, PROGRESSIONS } from '../theory/progressions'
import { isMinorScale, SCALES, type PitchClass, type ScaleName } from '../theory/pitch'
import type { GenreDef } from './genres'
import type { FormSlot } from './arrangement'
import type { SectionKind } from './types'

export interface HarmonyPlan {
  /** One chord per bar, indexed by section. */
  perSection: Chord[][]
  /** The progression template ids actually used, for display. */
  progressionIds: string[]
}

/**
 * The progressions this genre offers that are actually written in this key's
 * mode.
 *
 * The mode filter is the fix for a defect the quality gate found: a genre's
 * list is a list of idioms, not a list of keys, and a major-key idiom carrying
 * explicit chord qualities does not survive transposition into a minor key. The
 * lofi turnaround `iim7 - V7 - iiim7 - vim7` in C minor becomes Dm7, G7, Ebm7,
 * Abm7 — chords built on A, B, Gb, Db and Cb, none of them in C minor — while
 * the melody writer goes on using the scale. The song then spends most of its
 * length with the singer a semitone from the chord underneath.
 *
 * So a genre in a minor key gets its minor progressions, and falls back to the
 * library's minor idioms rather than to a major template that will not fit.
 */
/**
 * The scale a key's chords are built from.
 *
 * A gapped scale is a melodic device, not a harmonic one. The minor pentatonic
 * has five notes, and on some of its degrees no triad exists at all: build on
 * the fifth degree of C minor pentatonic and every third, fifth and suspension
 * you can name reaches for a note the scale does not have. That is not a defect
 * to be fixed by choosing a better chord — it is what a pentatonic scale is.
 *
 * Real music in these scales harmonises from the parent: a pentatonic melody
 * over ordinary minor chords, a blues line over dominant sevenths. Every note
 * of the child scale is in the parent, so the melody still fits, and the band
 * gets a harmony it can actually voice. Whole tone has no parent and is left
 * alone; nothing in the library selects it as a song key.
 */
export function harmonicScaleFor(scale: ScaleName): ScaleName {
  switch (scale) {
    case 'majorPentatonic': return 'major'
    case 'minorPentatonic': return 'minor'
    case 'blues': return 'minor'
    case 'japanese': return 'phrygian'
    default: return scale
  }
}

function resolveProgressionPool(genre: GenreDef, scale: ScaleName): string[] {
  // Asked of the scale the chords are built from. `isMinorScale` reads the
  // third step, and the minor pentatonic's third step is a fourth, so asking it
  // directly reports a minor key as major and hands it major templates.
  const minor = isMinorScale(harmonicScaleFor(scale))
  const wanted = minor ? 'minor' : 'major'
  const fits = (id: string) => {
    const template = getProgression(id)
    return template !== undefined && (template.mode === wanted || template.mode === 'either')
  }

  const pool = genre.progressions.filter(fits)
  if (pool.length > 0) return pool
  // The genre has nothing in this mode. Library idioms in the right mode beat
  // a genre-appropriate one in the wrong one: a listener hears the wrong notes
  // long before they hear the wrong sub-genre.
  const library = PROGRESSIONS.filter((p) => p.mode === wanted || p.mode === 'either')
  const byMood = library.filter((p) => p.moods.includes(minor ? 'dark' : 'bright'))
  return (byMood.length > 0 ? byMood : library).map((p) => p.id)
}

/**
 * Expands (or truncates) a progression to exactly `bars` chords by repeating
 * it. When the progression does not divide evenly, the tail is taken from the
 * start so the section still resolves on a strong chord.
 */
function fitToBars(bars: string[], target: number): string[] {
  if (bars.length === 0) return new Array(target).fill('I')
  const out: string[] = []
  for (let i = 0; i < target; i++) out.push(bars[i % bars.length]!)
  return out
}

/**
 * Sections that share a kind share a progression, which is what makes a song
 * feel like one song: every chorus lands on the same harmony.
 */
export function planHarmony(
  slots: FormSlot[],
  tonic: PitchClass,
  scale: ScaleName,
  genre: GenreDef,
  rng: Rng,
  forcedProgressionId?: string,
): HarmonyPlan {
  const pool = resolveProgressionPool(genre, scale)
  const chosen = new Map<SectionKind, string>()

  const primary = forcedProgressionId && getProgression(forcedProgressionId)
    ? forcedProgressionId
    : rng.pick(pool)

  // The chorus (or drop) owns the primary progression; verses get a variant.
  const secondary = pool.length > 1 ? rng.pick(pool.filter((id) => id !== primary)) : primary

  const kindProgression = (kind: SectionKind): string => {
    const existing = chosen.get(kind)
    if (existing) return existing
    let id: string
    switch (kind) {
      case 'chorus':
      case 'drop':
        id = primary
        break
      case 'verse':
      case 'breakdown':
        id = secondary
        break
      case 'bridge':
        id = pool.length > 2 ? rng.pick(pool.filter((p) => p !== primary && p !== secondary)) : secondary
        break
      default:
        id = primary
    }
    chosen.set(kind, id)
    return id
  }

  const perSection: Chord[][] = []
  const progressionIds: string[] = []

  for (const slot of slots) {
    const id = kindProgression(slot.kind)
    progressionIds.push(id)
    const template = getProgression(id)!
    let romans = fitToBars(template.bars, slot.bars)

    // Pre-chorus builds tension: end on the dominant.
    if (slot.kind === 'prechorus' && romans.length > 0) {
      romans = romans.slice()
      romans[romans.length - 1] = isMinorScale(scale) ? 'V' : 'V'
      if (romans.length > 1) romans[romans.length - 2] = isMinorScale(scale) ? 'iv' : 'IV'
    }
    // Intros and outros sit on the tonic so the song opens and closes settled.
    if ((slot.kind === 'intro' || slot.kind === 'outro') && romans.length > 1) {
      romans = romans.slice()
      romans[romans.length - 1] = isMinorScale(scale) ? 'i' : 'I'
    }

    // Roman numerals are read in the harmonic parent: a numeral names a scale
    // degree, and a gapped scale does not have the degrees the numerals mean.
    const chords = romans.map((symbol) => parseRoman(symbol, tonic, harmonicScaleFor(scale)))
    fitChordsToMode(chords, tonic, scale)
    addColour(chords, slot.kind, genre, rng)
    // Again, because `addColour` upgrades triads to sevenths and an added
    // seventh can be exactly the note the mode does not have — a fitted
    // melodic-minor tonic triad becomes Am7 and the G natural is back.
    fitChordsToMode(chords, tonic, scale)
    perSection.push(chords)
  }

  return { perSection, progressionIds }
}

/**
 * Pulls chords back into the key, for the modes the numerals were not written
 * for.
 *
 * Roman numerals carry two assumptions that only hold in major and natural
 * minor: a numeral's case implies a quality, and an accidental measures from
 * the parallel major, so `bVI` means "six semitones and a bit below the octave"
 * rather than "the sixth degree of this mode". Both assumptions break the
 * moment the key is dorian, locrian, melodic or harmonic minor.
 *
 * In C dorian the sixth degree is A natural, but `bVI` builds on A flat — so
 * the band plays an A flat chord while the melody writer, working from the
 * scale, sings A natural over it. In C locrian a `bVII` chord is B flat major,
 * containing a D natural the scale does not have, against a melody full of D
 * flats. In A melodic minor the tonic seventh comes out as Am7 with a G
 * natural, while the scale's seventh degree is G sharp. Every one of those is a
 * semitone, sustained, between the singer and the chord underneath them — and
 * all three were failing the quality gate on every seed.
 *
 * So in those modes a chord that contains a note the key does not have is
 * replaced by the mode's own chord on the same degree. Major and natural minor
 * are left completely alone, because there the numerals mean what they say and
 * the notes outside the scale are deliberate: the raised leading tone of a
 * minor-key V, the borrowed flat sixth, the gospel minor four. Fitting those to
 * the scale would not repair a defect, it would delete four hundred years of
 * cadence.
 */
export function fitChordsToMode(chords: Chord[], tonic: PitchClass, rawScale: ScaleName): void {
  const scale = harmonicScaleFor(rawScale)
  if (scale === 'major' || scale === 'minor') return
  const steps = SCALES[scale] as readonly number[]
  const scalePitchClasses = steps.map((step) => ((tonic + step) % 12) as PitchClass)
  const inScale = new Set<number>(scalePitchClasses)

  for (const chord of chords) {
    if (chordPitchClasses(chord).every((pc) => inScale.has(pc))) continue

    // Keep the root where it is if the key has it; a progression's shape is in
    // its roots, and moving those would be writing a different song.
    let degree = scalePitchClasses.indexOf(chord.root)
    if (degree < 0) {
      // The root itself is foreign. Take the nearest degree, preferring the one
      // below, so a flattened borrowing lands on the scale tone it was reaching
      // for rather than a semitone past it.
      let best = 0
      let bestDistance = Infinity
      for (let i = 0; i < scalePitchClasses.length; i++) {
        const raw = (scalePitchClasses[i]! - chord.root + 12) % 12
        const distance = Math.min(raw, 12 - raw) * 2 + (raw <= 6 ? 1 : 0)
        if (distance < bestDistance) { bestDistance = distance; best = i }
      }
      degree = best
      chord.root = scalePitchClasses[degree]!
    }

    const seventh = CHORD_INTERVALS[chord.quality].length >= 4
    // Preferences in order, and the first one that actually fits the key wins.
    //
    // The diatonic quality is the right answer and usually available, but a
    // named quality carries fixed intervals and a scale is not obliged to
    // supply them. Two ways that bites. A melodic-minor tonic is min-maj7 —
    // A C E G# — which no name in this library spells, and the nearest, min7,
    // swaps that G# for the G natural the key does not have. And a gapped scale
    // like the minor pentatonic has degrees whose stacked thirds are not a
    // triad at all, so `sus4`'s assumed fifth lands on a note the scale skips.
    //
    // Dropping a note is a voicing choice; keeping a wrong one is the defect
    // this pass exists to remove. So: the diatonic seventh, then the diatonic
    // triad, then plain triads and suspensions, and whichever first sits
    // entirely inside the key is the chord.
    const candidates: Chord['quality'][] = [
      ...(seventh ? [diatonicQuality(scale, degree, true)] : []),
      diatonicQuality(scale, degree, false),
      'min', 'maj', 'sus4', 'sus2', 'min7', 'maj7', 'dom7', 'dim',
    ]
    const fits = candidates.find((quality) => CHORD_INTERVALS[quality]
      .every((iv) => inScale.has((chord.root + iv) % 12)))
    chord.quality = fits ?? diatonicQuality(scale, degree, false)
    chord.degree = degree
    // Against the chord's own tones, not `chordPitchClasses`, which folds the
    // bass back in and would make this check unable to ever fire. An inversion
    // chosen before the quality was corrected can be left holding a note the
    // new chord does not contain — G#dim/F#, where the F# belonged to the
    // min7b5 this used to be.
    const tones = new Set(CHORD_INTERVALS[chord.quality].map((iv) => (chord.root + iv) % 12))
    if (chord.bass !== undefined && !tones.has(chord.bass)) delete chord.bass
  }
}

/**
 * Adds occasional extensions and inversions so repeated bars do not sound
 * identical. Jazz-leaning genres get sevenths far more often than punk does.
 */
function addColour(chords: Chord[], kind: SectionKind, genre: GenreDef, rng: Rng): void {
  const jazzy = ['jazz', 'bossa', 'lofi', 'rnb', 'gospel', 'house', 'disco'].includes(genre.id)
  const raw = ['punk', 'metal', 'rock', 'chiptune'].includes(genre.id)
  const seventhChance = jazzy ? 0.75 : raw ? 0.02 : 0.18
  const inversionChance = raw ? 0.04 : 0.16

  const upgrade: Partial<Record<Chord['quality'], Chord['quality']>> = {
    maj: 'maj7', min: 'min7', dim: 'min7b5', sus4: 'sus4', sus2: 'sus2',
  }

  for (let i = 0; i < chords.length; i++) {
    const chord = chords[i]!
    if (rng.chance(seventhChance)) {
      const next = upgrade[chord.quality]
      if (next) chord.quality = next
    }
    // Inversions on weak bars smooth the bass line.
    //
    // The bass has to come from the chord's own notes, which is what makes it
    // an inversion rather than a different chord. A fixed [3, 4, 7] list put a
    // major third under a minor chord — G#m7/C, a C natural a semitone under
    // the chord's own B — and it landed in the bass, which is the most exposed
    // voice there is. Found by the quality gate.
    if (i % 2 === 1 && rng.chance(inversionChance)) {
      const tones = chordPitchClasses(chord).filter((pc) => pc !== chord.root)
      if (tones.length > 0) chord.bass = rng.pick(tones)
    }
  }

  // A chorus should land squarely; strip the inversion from its final bar.
  if (kind === 'chorus' || kind === 'drop') {
    const last = chords[chords.length - 1]
    if (last) delete last.bass
  }
}
