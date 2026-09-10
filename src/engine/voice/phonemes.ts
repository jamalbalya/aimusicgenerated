/**
 * English grapheme-to-phoneme conversion.
 *
 * A full pronunciation dictionary is far too large to ship, so this is a
 * rule-based letter-to-sound converter operating on one syllable at a time.
 * It is what lets the singer pronounce any word the lyric writer invents.
 */

export type Vowel =
  | 'IY' | 'IH' | 'EY' | 'EH' | 'AE' | 'AA' | 'AO' | 'OW' | 'UH' | 'UW'
  | 'AH' | 'ER' | 'AY' | 'OY' | 'AW'

export type Consonant =
  | 'P' | 'B' | 'T' | 'D' | 'K' | 'G' | 'F' | 'V' | 'TH' | 'DH' | 'S' | 'Z'
  | 'SH' | 'ZH' | 'CH' | 'JH' | 'M' | 'N' | 'NG' | 'L' | 'R' | 'W' | 'Y' | 'HH'

export type Phoneme = Vowel | Consonant

export const VOWELS: Vowel[] = ['IY', 'IH', 'EY', 'EH', 'AE', 'AA', 'AO', 'OW', 'UH', 'UW', 'AH', 'ER', 'AY', 'OY', 'AW']
const VOWEL_SET = new Set<string>(VOWELS)

export function isVowel(phoneme: Phoneme): phoneme is Vowel {
  return VOWEL_SET.has(phoneme)
}

export interface SyllablePhonemes {
  onset: Consonant[]
  vowel: Vowel
  coda: Consonant[]
}

const VOWEL_LETTERS = 'aeiouy'

/** Multi-letter consonant graphemes, longest first. */
const CONSONANT_DIGRAPHS: [string, Consonant[]][] = [
  ['tch', ['CH']], ['dge', ['JH']], ['sch', ['SH']],
  ['ch', ['CH']], ['sh', ['SH']], ['th', ['TH']], ['ph', ['F']],
  ['wh', ['W']], ['ck', ['K']], ['ng', ['NG']], ['qu', ['K', 'W']],
  ['gh', []], ['kn', ['N']], ['wr', ['R']], ['gn', ['N']], ['ps', ['S']],
  ['cc', ['K']], ['ll', ['L']], ['ss', ['S']], ['tt', ['T']], ['dd', ['D']],
  ['nn', ['N']], ['mm', ['M']], ['pp', ['P']], ['bb', ['B']], ['rr', ['R']],
  ['ff', ['F']], ['gg', ['G']], ['zz', ['Z']],
]

/** Vowel graphemes, longest first. */
const VOWEL_GRAPHEMES: [string, Vowel][] = [
  ['eigh', 'EY'], ['ough', 'AO'], ['augh', 'AO'],
  ['igh', 'AY'], ['air', 'EH'], ['ear', 'IY'], ['eer', 'IY'],
  ['oor', 'AO'], ['our', 'AW'], ['ure', 'ER'],
  ['ai', 'EY'], ['ay', 'EY'], ['ea', 'IY'], ['ee', 'IY'], ['ie', 'IY'],
  ['ei', 'EY'], ['ey', 'EY'], ['oa', 'OW'], ['oe', 'OW'], ['oo', 'UW'],
  ['ou', 'AW'], ['ow', 'OW'], ['oi', 'OY'], ['oy', 'OY'], ['au', 'AO'],
  ['aw', 'AO'], ['ue', 'UW'], ['ew', 'UW'], ['ui', 'UW'], ['eu', 'UW'],
  ['ar', 'AA'], ['er', 'ER'], ['ir', 'ER'], ['ur', 'ER'], ['or', 'AO'],
]

const SHORT_VOWELS: Record<string, Vowel> = {
  a: 'AE', e: 'EH', i: 'IH', o: 'AA', u: 'AH', y: 'IH',
}

const LONG_VOWELS: Record<string, Vowel> = {
  a: 'EY', e: 'IY', i: 'AY', o: 'OW', u: 'UW', y: 'AY',
}

function consonantAt(text: string, index: number): { phonemes: Consonant[]; length: number } | null {
  for (const [grapheme, phonemes] of CONSONANT_DIGRAPHS) {
    if (text.startsWith(grapheme, index)) return { phonemes, length: grapheme.length }
  }
  const letter = text[index]
  if (!letter || VOWEL_LETTERS.includes(letter)) return null

  const next = text[index + 1] ?? ''
  const softFollows = 'eiy'.includes(next)
  const map: Record<string, Consonant[]> = {
    b: ['B'], c: softFollows ? ['S'] : ['K'], d: ['D'], f: ['F'],
    g: softFollows ? ['JH'] : ['G'], h: ['HH'], j: ['JH'], k: ['K'],
    l: ['L'], m: ['M'], n: ['N'], p: ['P'], q: ['K'], r: ['R'],
    s: ['S'], t: ['T'], v: ['V'], w: ['W'], x: ['K', 'S'], z: ['Z'],
  }
  const phonemes = map[letter]
  return phonemes ? { phonemes, length: 1 } : null
}

function vowelAt(text: string, index: number): { vowel: Vowel; length: number } | null {
  for (const [grapheme, vowel] of VOWEL_GRAPHEMES) {
    if (text.startsWith(grapheme, index)) return { vowel, length: grapheme.length }
  }
  const letter = text[index]
  if (!letter || !VOWEL_LETTERS.includes(letter)) return null

  // Magic "e": a single consonant then a final "e" lengthens the vowel.
  const rest = text.slice(index + 1)
  if (/^[^aeiouy]e$/.test(rest)) {
    return { vowel: LONG_VOWELS[letter] ?? 'AH', length: 1 }
  }
  // An open final vowel is long ("go", "me", "hi").
  if (index === text.length - 1 && text.length > 1 && letter !== 'e') {
    return { vowel: LONG_VOWELS[letter] ?? 'AH', length: 1 }
  }
  return { vowel: SHORT_VOWELS[letter] ?? 'AH', length: 1 }
}

/**
 * Converts one written syllable into onset / vowel / coda phonemes.
 * A chunk with no vowel letters is given a schwa so it can still be sung.
 */
export function syllableToPhonemes(rawSyllable: string): SyllablePhonemes {
  const text = rawSyllable.toLowerCase().replace(/[^a-z]/g, '')
  if (!text) return { onset: [], vowel: 'AH', coda: [] }

  const onset: Consonant[] = []
  const coda: Consonant[] = []
  let vowel: Vowel | null = null
  let i = 0

  while (i < text.length) {
    if (vowel === null) {
      const found = vowelAt(text, i)
      if (found) {
        vowel = found.vowel
        i += found.length
        continue
      }
      const consonant = consonantAt(text, i)
      if (consonant) {
        onset.push(...consonant.phonemes)
        i += consonant.length
        continue
      }
      i++
    } else {
      // A silent terminal "e" contributes nothing.
      if (i === text.length - 1 && text[i] === 'e') break
      const consonant = consonantAt(text, i)
      if (consonant) {
        coda.push(...consonant.phonemes)
        i += consonant.length
        continue
      }
      // A second vowel group in the same chunk becomes a glide into the coda.
      const found = vowelAt(text, i)
      if (found) {
        i += found.length
        continue
      }
      i++
    }
  }

  return { onset, vowel: vowel ?? 'AH', coda: coda.slice(0, 3) }
}

/** Full phoneme sequence for a written syllable. */
export function syllablePhonemeList(syllable: string): Phoneme[] {
  const parts = syllableToPhonemes(syllable)
  return [...parts.onset, parts.vowel, ...parts.coda]
}
