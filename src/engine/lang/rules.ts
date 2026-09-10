/**
 * Helpers for writing letter-to-sound tables compactly.
 *
 * A rule table is data, and it is read far more often than it is written, so
 * these keep the tables looking like the pronunciation guides they are rather
 * than like nested object literals.
 */

import type { Phoneme, SoundRule } from '../voice/phonemes'

type Context = Omit<SoundRule, 'match' | 'phonemes'>

function parse(spec: string): Phoneme[] {
  if (spec === '') return []
  return spec.split(' ') as Phoneme[]
}

/**
 * Unconditional spellings: `{ 'ng': 'NG', x: 'K S', h: '' }`.
 * An empty string means the letters are silent.
 */
export function letters(map: Record<string, string>): SoundRule[] {
  return Object.entries(map).map(([match, spec]) => ({ match, phonemes: parse(spec) }))
}

/** One spelling that only applies in a particular context. */
export function when(match: string, spec: string, context: Context): SoundRule {
  return { match, phonemes: parse(spec), ...context }
}

/** The five-vowel system shared by most of the world's Latin orthographies. */
export const FIVE_VOWELS = { a: 'A', e: 'E', i: 'IY', o: 'O', u: 'UW' } as const

/**
 * Builds the diphthong key set the syllabifier wants from written vowel pairs.
 * Written pairs are what a pronunciation guide lists; the syllabifier compares
 * phonemes, so the mapping has to be applied first.
 */
export function diphthongSet(pairs: string[][]): Set<string> {
  return new Set(pairs.map(([first, second]) => `${first}${second}`))
}
