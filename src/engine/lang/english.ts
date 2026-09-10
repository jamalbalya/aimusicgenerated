/**
 * English grapheme-to-phoneme conversion.
 *
 * English keeps its own reader rather than a rule table because its spelling
 * is not a rule system: the same letters take a different sound depending on
 * what is at the far end of the word (the "magic e"), and the syllable split
 * follows the spelling rather than the sounds. These rules get ordinary lyric
 * vocabulary right without shipping a megabyte-sized dictionary.
 */

import { VOWELS, type Consonant, type Syllable, type Vowel } from '../voice/phonemes'
import { splitSyllables } from '../lyrics/syllables'
import type { LanguageProfile } from './types'

const VOWEL_LETTERS = 'aeiouy'

/** Multi-letter consonant graphemes, longest first. */
const CONSONANT_DIGRAPHS: [string, Consonant[]][] = [
  ['tch', ['CH']], ['dge', ['JH']], ['sch', ['SH']],
  ['ch', ['CH']], ['sh', ['SH']], ['th', ['TH']], ['ph', ['F']],
  ['wh', ['W']], ['ck', ['K']], ['ng', ['NG']], ['qu', ['K', 'W']], ['rh', ['R']],
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
 * Words whose spelling predates the rules.
 *
 * English keeps a few hundred of these; the ones here are the ones that turn up
 * in lyrics, where getting "love" wrong is not a rounding error — the rules
 * would lengthen it to rhyme with "stove".
 */
const ENGLISH_WORDS: Record<string, string> = {
  love: 'L AH V', loves: 'L AH V Z', loved: 'L AH V D', loving: 'L AH V IH NG',
  one: 'W AH N', once: 'W AH N S', none: 'N AH N', done: 'D AH N',
  come: 'K AH M', comes: 'K AH M Z', coming: 'K AH M IH NG', some: 'S AH M',
  gone: 'G AO N', move: 'M UW V', moves: 'M UW V Z', prove: 'P R UW V',
  two: 'T UW', who: 'HH UW', whose: 'HH UW Z', to: 'T UW', do: 'D UW',
  of: 'AH V', was: 'W AH Z', are: 'AA R', were: 'W ER', been: 'B IH N',
  said: 'S EH D', says: 'S EH Z', does: 'D AH Z', again: 'AH G EH N',
  heart: 'HH AA R T', hearts: 'HH AA R T S', earth: 'ER TH',
  learn: 'L ER N', heard: 'HH ER D', search: 'S ER CH', earn: 'ER N',
  pearl: 'P ER L', world: 'W ER L D', word: 'W ER D', work: 'W ER K',
  eye: 'AY', eyes: 'AY Z', sure: 'SH UH R', put: 'P UH T',
  could: 'K UH D', would: 'W UH D', should: 'SH UH D',
  laugh: 'L AE F', though: 'DH OW', through: 'TH R UW', thought: 'TH AO T',
  friend: 'F R EH N D', great: 'G R EY T', break: 'B R EY K',
  bread: 'B R EH D', head: 'HH EH D', dead: 'D EH D', death: 'D EH TH',
  breath: 'B R EH TH', breathe: 'B R IY DH', health: 'HH EH L TH',
  blood: 'B L AH D', flood: 'F L AH D', touch: 'T AH CH', young: 'Y AH NG',
  soul: 'S OW L', both: 'B OW TH', most: 'M OW S T', want: 'W AA N T',
  what: 'W AH T', where: 'W EH R', there: 'DH EH R', here: 'HH IY R',
  live: 'L IH V', give: 'G IH V', have: 'HH AE V', gave: 'G EY V',
  fire: 'F AY R', hour: 'AW R', our: 'AW R', your: 'Y AO R',
  night: 'N AY T', light: 'L AY T', right: 'R AY T', sight: 'S AY T',
}

/**
 * Converts one written English syllable into onset / vowel / coda phonemes.
 * A chunk with no vowel letters is given a schwa so it can still be sung.
 */
export function englishSyllable(rawSyllable: string): Syllable {
  const text = rawSyllable.toLowerCase().replace(/[^a-z]/g, '')
  if (!text) return { text: rawSyllable, onset: [], vowel: 'AH', coda: [] }

  const known = ENGLISH_WORDS[text]
  if (known) return fromPhonemeList(rawSyllable, known)

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

  return { text: rawSyllable, onset, vowel: vowel ?? 'AH', coda: coda.slice(0, 3) }
}

/** Turns an entry from the word table back into a syllable. */
function fromPhonemeList(text: string, spec: string): Syllable {
  const phonemes = spec.split(' ')
  const onset: Consonant[] = []
  const coda: Consonant[] = []
  let vowel: Vowel | null = null
  for (const phoneme of phonemes) {
    if (VOWEL_PHONEMES.has(phoneme)) {
      if (vowel === null) vowel = phoneme as Vowel
    } else if (vowel === null) onset.push(phoneme as Consonant)
    else coda.push(phoneme as Consonant)
  }
  return { text, onset, vowel: vowel ?? 'AH', coda }
}

const VOWEL_PHONEMES = new Set<string>(VOWELS)

function pronounceEnglish(word: string): Syllable[] {
  const whole = ENGLISH_WORDS[word.toLowerCase().replace(/[^a-z]/g, '')]
  if (whole) return [fromPhonemeList(word, whole)]
  return splitSyllables(word).map(englishSyllable)
}

export const ENGLISH_PROFILE: LanguageProfile = {
  id: 'en',
  label: 'English',
  native: 'English',
  script: 'latin',
  voiceTags: ['en-US', 'en-GB', 'en'],
  pronounceWord: pronounceEnglish,
}
