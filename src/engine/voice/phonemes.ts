/**
 * The phoneme inventory, and the machinery that turns spelling into it.
 *
 * The set covers the sounds needed to pronounce the languages the studio
 * supports, not just English: pure mid vowels (Spanish, Indonesian, Italian),
 * front rounded vowels (German, French, Turkish), a schwa, nasal vowels
 * (French, Portuguese), and the consonants English lacks — a trilled and a
 * tapped R, palatal nasal and lateral, a velar fricative, affricates, a
 * glottal stop and a uvular R.
 *
 * Everything downstream — the singer, the speech synthesiser, syllable
 * placement — works on these symbols rather than on letters, which is what
 * makes one voice model able to pronounce every supported language.
 */

export type Vowel =
  // English lax and tense vowels
  | 'IY' | 'IH' | 'EY' | 'EH' | 'AE' | 'AA' | 'AO' | 'OW' | 'UH' | 'UW'
  | 'AH' | 'ER'
  // English diphthongs
  | 'AY' | 'OY' | 'AW'
  // Pure vowels of the Romance, Austronesian and Turkic languages
  | 'A' | 'E' | 'O' | 'AX'
  // Front rounded vowels: German ü/ö, French u/eu, Turkish ü/ö
  | 'UE' | 'OE'
  // Turkish dotless ı, Russian ы
  | 'IX'
  // Nasal vowels: French and Portuguese
  | 'AN' | 'EN' | 'ON' | 'UN'

export type Consonant =
  | 'P' | 'B' | 'T' | 'D' | 'K' | 'G'
  | 'F' | 'V' | 'TH' | 'DH' | 'S' | 'Z' | 'SH' | 'ZH'
  | 'CH' | 'JH' | 'TS' | 'DZ' | 'PF'
  | 'M' | 'N' | 'NG' | 'NY'
  | 'L' | 'LY' | 'R' | 'RR' | 'DX' | 'RU'
  | 'W' | 'Y' | 'HH'
  | 'X' | 'GX' | 'CX' | 'Q'

export type Phoneme = Vowel | Consonant

export const VOWELS: Vowel[] = [
  'IY', 'IH', 'EY', 'EH', 'AE', 'AA', 'AO', 'OW', 'UH', 'UW', 'AH', 'ER',
  'AY', 'OY', 'AW', 'A', 'E', 'O', 'AX', 'UE', 'OE', 'IX', 'AN', 'EN', 'ON', 'UN',
]

const VOWEL_SET = new Set<string>(VOWELS)

export function isVowel(phoneme: Phoneme): phoneme is Vowel {
  return VOWEL_SET.has(phoneme)
}

/** Vowels that are nasalised — the tract couples to the nasal cavity. */
export const NASAL_VOWELS = new Set<Vowel>(['AN', 'EN', 'ON', 'UN'])

/**
 * Sonority class, used to decide where a syllable can be cut.
 * Higher is more sonorous; a legal onset rises toward the vowel.
 */
const SONORITY: Record<Phoneme, number> = {
  // stops and affricates
  P: 1, B: 1, T: 1, D: 1, K: 1, G: 1, Q: 1, CH: 1, JH: 1, TS: 1, DZ: 1, PF: 1,
  // fricatives
  F: 2, V: 2, TH: 2, DH: 2, S: 2, Z: 2, SH: 2, ZH: 2, X: 2, GX: 2, CX: 2, HH: 2,
  // nasals
  M: 3, N: 3, NG: 3, NY: 3,
  // liquids
  L: 4, LY: 4, R: 4, RR: 4, DX: 4, RU: 4,
  // glides
  W: 5, Y: 5,
  // vowels
  IY: 6, IH: 6, EY: 6, EH: 6, AE: 6, AA: 6, AO: 6, OW: 6, UH: 6, UW: 6,
  AH: 6, ER: 6, AY: 6, OY: 6, AW: 6, A: 6, E: 6, O: 6, AX: 6, UE: 6, OE: 6,
  IX: 6, AN: 6, EN: 6, ON: 6, UN: 6,
}

export function sonority(phoneme: Phoneme): number {
  return SONORITY[phoneme] ?? 2
}

/** One sung or spoken syllable: what a single note carries. */
export interface Syllable {
  /** The written form, for display and for lyric sheets. */
  text: string
  onset: Consonant[]
  vowel: Vowel
  /** Second target of a diphthong the language writes as two letters. */
  glide?: Vowel
  coda: Consonant[]
}

/* ------------------------------------------------------------------ rules --- */

/**
 * One letter-to-sound rule.
 *
 * Rules are tried longest match first, and the first whose context matches
 * wins — the classic arrangement for a rule-based pronunciation engine, and
 * enough to pronounce any language whose spelling is broadly regular.
 */
export interface SoundRule {
  /** Letters to match at the cursor, lower case. */
  match: string
  /** Sounds produced. An empty list consumes the letters silently. */
  phonemes: Phoneme[]
  /** Only when the next letter is one of these. */
  next?: string
  /** Only when the next letter is NOT one of these. */
  notNext?: string
  /** Only when the previous letter is one of these. */
  prev?: string
  /** Only when the previous letter is NOT one of these. */
  notPrev?: string
  /** Only at the start of a word, at the end, or strictly inside it. */
  at?: 'start' | 'end' | 'inner'
  /** Only when what follows matches this pattern (anchored at the cursor). */
  followedBy?: RegExp
}

export interface PhonemeSpan {
  phoneme: Phoneme
  /** Index range in the source word that produced this phoneme. */
  start: number
  end: number
}

function contextMatches(rule: SoundRule, word: string, index: number): boolean {
  const end = index + rule.match.length
  const previous = index > 0 ? word[index - 1]! : ''
  const following = end < word.length ? word[end]! : ''

  if (rule.at === 'start' && index !== 0) return false
  if (rule.at === 'end' && end !== word.length) return false
  if (rule.at === 'inner' && (index === 0 || end === word.length)) return false
  if (rule.next !== undefined && (following === '' || !rule.next.includes(following))) return false
  if (rule.notNext !== undefined && following !== '' && rule.notNext.includes(following)) return false
  if (rule.prev !== undefined && (previous === '' || !rule.prev.includes(previous))) return false
  if (rule.notPrev !== undefined && previous !== '' && rule.notPrev.includes(previous)) return false
  if (rule.followedBy !== undefined && !rule.followedBy.test(word.slice(end))) return false
  return true
}

/**
 * Applies a rule set to one word.
 *
 * Rules are indexed by their first letter so a long table costs no more per
 * character than a short one, and each match records the letters it came from
 * so a syllable can later be cut at a real grapheme boundary.
 */
export function applySoundRules(word: string, rules: SoundRule[]): PhonemeSpan[] {
  const byFirstLetter = ruleIndex(rules)
  const out: PhonemeSpan[] = []
  let index = 0

  while (index < word.length) {
    const candidates = byFirstLetter.get(word[index]!) ?? []
    let matched: SoundRule | null = null
    for (const rule of candidates) {
      if (!word.startsWith(rule.match, index)) continue
      if (!contextMatches(rule, word, index)) continue
      matched = rule
      break
    }

    if (!matched) {
      // An unknown letter is skipped rather than guessed at: a wrong sound is
      // worse than a missing one, and the syllable around it still lands.
      index += 1
      continue
    }

    const end = index + matched.match.length
    for (const phoneme of matched.phonemes) {
      out.push({ phoneme, start: index, end })
    }
    index = end
  }

  return out
}

const ruleIndexCache = new WeakMap<SoundRule[], Map<string, SoundRule[]>>()

function ruleIndex(rules: SoundRule[]): Map<string, SoundRule[]> {
  const cached = ruleIndexCache.get(rules)
  if (cached) return cached

  const index = new Map<string, SoundRule[]>()
  // Longest match first; among equal lengths, the more constrained rule first,
  // so a contextual rule is never shadowed by its unconditional sibling.
  const ordered = rules.slice().sort((a, b) => {
    if (b.match.length !== a.match.length) return b.match.length - a.match.length
    return constraintCount(b) - constraintCount(a)
  })
  for (const rule of ordered) {
    const key = rule.match[0]!
    const list = index.get(key)
    if (list) list.push(rule)
    else index.set(key, [rule])
  }
  ruleIndexCache.set(rules, index)
  return index
}

function constraintCount(rule: SoundRule): number {
  let count = 0
  for (const key of ['next', 'notNext', 'prev', 'notPrev', 'at', 'followedBy'] as const) {
    if (rule[key] !== undefined) count++
  }
  return count
}

/* ---------------------------------------------------------- syllabifying --- */

export interface SyllableOptions {
  /** Most consonants the language allows before a vowel. */
  maxOnset: number
  /** Vowel pairs the language pronounces as one gliding syllable. */
  diphthongs?: Set<string>
  /** True when two adjacent vowels are always separate syllables. */
  hiatus?: boolean
}

/**
 * Splits a phoneme sequence into syllables.
 *
 * Consonants between two vowels go to the following syllable as far as the
 * language's onset limit and rising sonority allow — the maximum onset
 * principle, which is what every language's own syllable count follows.
 */
export function syllabify(
  spans: PhonemeSpan[],
  source: string,
  options: SyllableOptions,
): Syllable[] {
  const nuclei: number[] = []
  for (let i = 0; i < spans.length; i++) {
    if (isVowel(spans[i]!.phoneme)) nuclei.push(i)
  }

  if (nuclei.length === 0) {
    if (spans.length === 0) return []
    // A word with no vowel still has to be sung: give it a schwa.
    return [{
      text: source,
      onset: spans.map((s) => s.phoneme as Consonant),
      vowel: 'AX',
      coda: [],
    }]
  }

  // Merge vowel pairs the language treats as one gliding nucleus.
  const groups: { nucleus: number; glide?: number }[] = []
  for (let n = 0; n < nuclei.length; n++) {
    const index = nuclei[n]!
    const nextIndex = nuclei[n + 1]
    const adjacent = nextIndex !== undefined && nextIndex === index + 1
    if (adjacent && !options.hiatus) {
      const pair = `${spans[index]!.phoneme}${spans[nextIndex]!.phoneme}`
      if (options.diphthongs?.has(pair)) {
        groups.push({ nucleus: index, glide: nextIndex })
        n++
        continue
      }
    }
    groups.push({ nucleus: index })
  }

  const syllables: Syllable[] = []
  // Where each emitted syllable's text begins, as an index into `spans`. Kept
  // beside the syllables rather than on them so extending a coda can re-slice
  // the previous syllable's written form without inventing a field for it.
  const textStarts: number[] = []

  for (let g = 0; g < groups.length; g++) {
    const group = groups[g]!
    const nucleusEnd = group.glide ?? group.nucleus
    const previousEnd = g === 0 ? -1 : (groups[g - 1]!.glide ?? groups[g - 1]!.nucleus)

    // Consonants sitting between the previous nucleus and this one.
    const between: number[] = []
    for (let i = previousEnd + 1; i < group.nucleus; i++) between.push(i)

    const onsetCount = chooseOnset(
      between.map((i) => spans[i]!.phoneme as Consonant),
      options.maxOnset,
      g === 0,
    )
    const codaOfPrevious = between.slice(0, between.length - onsetCount)
    const onset = between.slice(between.length - onsetCount)

    if (g > 0 && codaOfPrevious.length > 0) {
      const previous = syllables[syllables.length - 1]!
      previous.coda.push(...codaOfPrevious.map((i) => spans[i]!.phoneme as Consonant))
      const from = spans[textStarts[textStarts.length - 1]!]!.start
      const to = spans[codaOfPrevious[codaOfPrevious.length - 1]!]!.end
      previous.text = source.slice(from, to)
    }

    // The last syllable also takes every consonant after the final nucleus.
    const trailing: number[] = []
    if (g === groups.length - 1) {
      for (let i = nucleusEnd + 1; i < spans.length; i++) trailing.push(i)
    }

    const firstIndex = onset[0] ?? group.nucleus
    const lastIndex = trailing[trailing.length - 1] ?? nucleusEnd
    textStarts.push(firstIndex)
    syllables.push({
      text: source.slice(spans[firstIndex]!.start, spans[lastIndex]!.end),
      onset: onset.map((i) => spans[i]!.phoneme as Consonant),
      vowel: spans[group.nucleus]!.phoneme as Vowel,
      ...(group.glide !== undefined ? { glide: spans[group.glide]!.phoneme as Vowel } : {}),
      coda: trailing.map((i) => spans[i]!.phoneme as Consonant),
    })
  }

  return syllables
}

/**
 * How many of the consonants between two vowels belong to the second one.
 *
 * A single consonant always goes forward. Longer runs go forward only while
 * sonority keeps rising toward the vowel, which is what stops "ak-tor" being
 * cut as "a-ktor".
 */
function chooseOnset(consonants: Consonant[], maxOnset: number, wordInitial: boolean): number {
  if (consonants.length === 0) return 0
  if (wordInitial) return consonants.length
  if (consonants.length === 1) return 1

  const limit = Math.min(maxOnset, consonants.length - 1)
  let take = 0
  for (let count = 1; count <= limit; count++) {
    const candidate = consonants.slice(consonants.length - count)
    if (isRisingOnset(candidate)) take = count
    else break
  }
  return Math.max(1, take)
}

function isRisingOnset(consonants: Consonant[]): boolean {
  for (let i = 1; i < consonants.length; i++) {
    if (sonority(consonants[i]!) <= sonority(consonants[i - 1]!)) return false
  }
  return true
}

