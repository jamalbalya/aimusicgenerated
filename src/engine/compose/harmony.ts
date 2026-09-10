/** Chooses the chord sequence for each section of the form. */

import { Rng } from '../core/rng'
import { parseRoman, type Chord } from '../theory/chords'
import { getProgression, PROGRESSIONS } from '../theory/progressions'
import { isMinorScale, type PitchClass, type ScaleName } from '../theory/pitch'
import type { GenreDef } from './genres'
import type { FormSlot } from './arrangement'
import type { SectionKind } from './types'

export interface HarmonyPlan {
  /** One chord per bar, indexed by section. */
  perSection: Chord[][]
  /** The progression template ids actually used, for display. */
  progressionIds: string[]
}

function resolveProgressionPool(genre: GenreDef, scale: ScaleName): string[] {
  const pool = genre.progressions.filter((id) => getProgression(id))
  if (pool.length > 0) return pool
  // Fallback keeps generation working even for an unknown genre id.
  const minor = isMinorScale(scale)
  return PROGRESSIONS.filter((p) => p.moods.includes(minor ? 'dark' : 'bright')).map((p) => p.id)
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

    const chords = romans.map((symbol) => parseRoman(symbol, tonic, scale))
    addColour(chords, slot.kind, genre, rng)
    perSection.push(chords)
  }

  return { perSection, progressionIds }
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
    if (i % 2 === 1 && rng.chance(inversionChance)) {
      const tones = [3, 4, 7]
      chord.bass = (chord.root + rng.pick(tones)) % 12
    }
  }

  // A chorus should land squarely; strip the inversion from its final bar.
  if (kind === 'chorus' || kind === 'drop') {
    const last = chords[chords.length - 1]
    if (last) delete last.bass
  }
}
