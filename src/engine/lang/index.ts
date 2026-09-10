/**
 * The pronunciation front door.
 *
 * Give it a line of lyric and a language and it gives back the syllables, each
 * one carrying the sounds it is made of. Everything that sings, speaks or fits
 * words to notes goes through here, so a language added to the registry is
 * immediately singable everywhere in the studio.
 */

import {
  applySoundRules, isVowel as isVowelPhoneme, syllabify,
  type Consonant, type Phoneme, type Syllable, type Vowel,
} from '../voice/phonemes'
import { ENGLISH_PROFILE } from './english'
import { LATIN_PROFILES } from './latin'
import { SCRIPT_PROFILES } from './scripts'
import { detectLanguage } from './detect'
import type { LanguageChoice, LanguageId, LanguageProfile } from './types'

export type { LanguageChoice, LanguageId, LanguageProfile, ScriptId } from './types'
export { detectLanguage } from './detect'
export { englishSyllable } from './english'

const PROFILES: LanguageProfile[] = [ENGLISH_PROFILE, ...LATIN_PROFILES, ...SCRIPT_PROFILES]

const BY_ID = new Map<LanguageId, LanguageProfile>(PROFILES.map((p) => [p.id, p]))

/** Every language the studio can pronounce, in the order the picker shows them. */
export const LANGUAGES: LanguageProfile[] = PROFILES

/** The picker's options: automatic detection first, then the languages. */
export const LANGUAGE_CHOICES: LanguageChoice[] = [
  { id: 'auto', label: 'Detect automatically', native: 'Auto' },
  ...PROFILES.map((profile) => ({
    id: profile.id, label: profile.label, native: profile.native,
  })),
]

export function languageProfile(id: LanguageId): LanguageProfile {
  return BY_ID.get(id) ?? ENGLISH_PROFILE
}

/** Resolves the `auto` option against the text it will be applied to. */
export function resolveLanguage(id: LanguageId | 'auto', text: string): LanguageId {
  return id === 'auto' ? detectLanguage(text) : id
}

/** Splits a line into words, keeping letters of every script. */
const WORD_PATTERN = /[\p{L}\p{M}'’-]+/gu

export function tokenize(line: string): string[] {
  return line.match(WORD_PATTERN) ?? []
}

/**
 * The syllables of one word, with the sounds each of them carries.
 *
 * A language either brings its own reader (English spelling, the syllabic
 * scripts) or a rule table, which is run over the word and then cut into
 * syllables by sonority.
 */
export function pronounceWord(rawWord: string, id: LanguageId): Syllable[] {
  const profile = languageProfile(id)
  const normalized = (profile.normalize ?? defaultNormalize)(rawWord)
  if (!normalized) return []

  const exception = profile.exceptions?.[normalized]
  if (exception !== undefined) {
    return syllabifyPhonemes(exception.split(' ') as Phoneme[], rawWord, profile)
  }

  if (profile.pronounceWord) return profile.pronounceWord(normalized).map(retext(rawWord))
  if (!profile.rules) return []

  const spans = applySoundRules(normalized, profile.rules)
  if (profile.oneSyllable) {
    return spans.length > 0 ? [collapse(spans.map((span) => span.phoneme), rawWord)] : []
  }
  return syllabify(spans, normalized, profile.syllable ?? { maxOnset: 2 })
}

/**
 * Folds a phoneme run into a single syllable: the consonants before the first
 * vowel are the onset, the first two vowels are the nucleus and its glide, and
 * everything after is the coda.
 */
function collapse(phonemes: Phoneme[], text: string): Syllable {
  const onset: Consonant[] = []
  const coda: Consonant[] = []
  let vowel: Vowel | null = null
  let glide: Vowel | undefined
  for (const phoneme of phonemes) {
    if (isVowelPhoneme(phoneme)) {
      if (vowel === null) vowel = phoneme
      else if (glide === undefined && coda.length === 0) glide = phoneme
    } else if (vowel === null) onset.push(phoneme)
    else coda.push(phoneme)
  }
  return { text, onset, vowel: vowel ?? 'AX', coda, ...(glide ? { glide } : {}) }
}

/**
 * A one-syllable word keeps its written form for the lyric sheet; a word the
 * reader split by sound would otherwise show its normalised spelling.
 */
function retext(rawWord: string): (syllable: Syllable, index: number, all: Syllable[]) => Syllable {
  return (syllable, _index, all) => (all.length === 1 ? { ...syllable, text: rawWord } : syllable)
}

function defaultNormalize(word: string): string {
  return word.toLowerCase().replace(/[’]/g, "'")
}

/** Wraps a bare phoneme list from an exceptions table back into syllables. */
function syllabifyPhonemes(
  phonemes: Phoneme[], text: string, profile: LanguageProfile,
): Syllable[] {
  const spans = phonemes.map((phoneme, index) => ({ phoneme, start: index, end: index + 1 }))
  const syllables = syllabify(spans, text, profile.syllable ?? { maxOnset: 2 })
  // The spans index a phoneme list rather than the written word, so the text
  // has to be put back: a short function word is one syllable in practice.
  if (syllables.length === 1) return [{ ...syllables[0]!, text }]
  return syllables.map((syllable, index) => ({
    ...syllable,
    text: index === 0 ? text : '',
  }))
}

/** Every syllable of a line, in order, across all of its words. */
export function pronounceLine(line: string, id: LanguageId): Syllable[] {
  const out: Syllable[] = []
  for (const word of tokenize(line)) out.push(...pronounceWord(word, id))
  return out
}

/** How many notes a line needs. */
export function countLineSyllables(line: string, id: LanguageId): number {
  return pronounceLine(line, id).length
}

/** A silent syllable, for a note with nothing to sing. */
export function restSyllable(): Syllable {
  return { text: '', onset: [], vowel: 'AH', coda: [] }
}

/** The written syllables of a line, for lyric sheets and the note editor. */
export function lineSyllableTexts(line: string, id: LanguageId): string[] {
  return pronounceLine(line, id).map((syllable) => syllable.text)
}

export type { Consonant, Phoneme, Syllable, Vowel }
