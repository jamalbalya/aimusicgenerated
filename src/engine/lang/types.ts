/**
 * What the studio needs to know about a language in order to sing it.
 *
 * Every profile answers one question — given a written word, which sounds come
 * out, and where do the syllables break — and everything downstream (the
 * singer, the speech synthesiser, the melody fitter) works from that answer
 * rather than from the letters. Adding a language means adding a profile; no
 * other part of the engine changes.
 */

import type { Syllable, SoundRule, SyllableOptions } from '../voice/phonemes'

export type LanguageId =
  | 'en' | 'id' | 'ms' | 'es' | 'it' | 'pt' | 'fr' | 'de' | 'nl'
  | 'tr' | 'pl' | 'ro' | 'cs' | 'sv' | 'fi' | 'vi' | 'tl' | 'sw'
  | 'ru' | 'uk' | 'el' | 'hi' | 'ja' | 'ko' | 'ar'
  | 'latn'

export type ScriptId =
  | 'latin' | 'cyrillic' | 'greek' | 'devanagari' | 'kana' | 'hangul' | 'arabic'

export interface LanguageProfile {
  id: LanguageId
  /** English name, for the language picker. */
  label: string
  /** The language's own name for itself. */
  native: string
  script: ScriptId
  /**
   * BCP-47 tags, best first, for matching one of the browser's own speech
   * voices when the user would rather have a system voice than ours.
   */
  voiceTags: string[]
  /**
   * Whole words the rules get wrong. Every language has a handful of very
   * common words whose spelling predates its own rules — French "les", English
   * "one" — and a short table of them is worth more than any amount of extra
   * rule machinery. Values are space-separated phonemes.
   */
  exceptions?: Record<string, string>
  /** Letter-to-sound rules, for the rule-driven languages. */
  rules?: SoundRule[]
  syllable?: SyllableOptions
  /**
   * True when every written word is exactly one syllable. Vietnamese is
   * written that way by design — the spaces are syllable boundaries, not word
   * boundaries — so the sonority rules have nothing to decide.
   */
  oneSyllable?: boolean
  /**
   * Folds a written word to the form the rules expect: case, and any spelling
   * variant the table does not list separately.
   */
  normalize?: (word: string) => string
  /**
   * A language whose script encodes syllables directly — Korean hangul, the
   * Japanese kana — reads them straight off instead of running rules.
   */
  pronounceWord?: (word: string) => Syllable[]
}

/** A language the user can choose, plus the automatic option. */
export interface LanguageChoice {
  id: LanguageId | 'auto'
  label: string
  native: string
}
