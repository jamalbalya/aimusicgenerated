/**
 * Languages whose writing system is not the Latin alphabet.
 *
 * Cyrillic and Greek are alphabets and go through the same rule engine as the
 * Latin languages. The others are not: an abugida carries a vowel inside every
 * consonant sign, kana spell one syllable per character, and hangul packs a
 * whole syllable into a single code point by arithmetic. Each of those is read
 * by the code that matches how it is actually written, which is both shorter
 * and more accurate than pretending it is a string of letters.
 */

import {
  syllabify,
  type Consonant, type Phoneme, type PhonemeSpan, type SoundRule, type Syllable, type Vowel,
} from '../voice/phonemes'
import type { LanguageProfile } from './types'
import { letters, when } from './rules'

/* --------------------------------------------------------------- Cyrillic --- */

const RUSSIAN_HARD = 'аеёиоуыэюяъь'

const RUSSIAN: SoundRule[] = [
  ...letters({
    'ль': 'LY', 'нь': 'NY',
    'а': 'A', 'б': 'B', 'в': 'V', 'г': 'G', 'д': 'D', 'е': 'EH', 'ё': 'O',
    'ж': 'ZH', 'з': 'Z', 'и': 'IY', 'й': 'Y', 'к': 'K', 'л': 'L', 'м': 'M',
    'н': 'N', 'о': 'O', 'п': 'P', 'р': 'DX', 'с': 'S', 'т': 'T', 'у': 'UW',
    'ф': 'F', 'х': 'X', 'ц': 'TS', 'ч': 'CH', 'ш': 'SH', 'щ': 'SH',
    'ъ': '', 'ы': 'IX', 'ь': '', 'э': 'EH', 'ю': 'UW', 'я': 'A',
  }),
  // The iotated vowels carry a y-glide at the start of a word and after
  // another vowel, and only palatalise the consonant before them elsewhere.
  when('е', 'Y EH', { at: 'start' }),
  when('ё', 'Y O', { at: 'start' }),
  when('ю', 'Y UW', { at: 'start' }),
  when('я', 'Y A', { at: 'start' }),
  when('е', 'Y EH', { prev: RUSSIAN_HARD }),
  when('ё', 'Y O', { prev: RUSSIAN_HARD }),
  when('ю', 'Y UW', { prev: RUSSIAN_HARD }),
  when('я', 'Y A', { prev: RUSSIAN_HARD }),
  // и is backed after the always-hard consonants.
  when('и', 'IX', { prev: 'жшц' }),
]

const UKRAINIAN: SoundRule[] = [
  ...letters({
    'ль': 'LY', 'нь': 'NY',
    'а': 'A', 'б': 'B', 'в': 'V', 'г': 'GX', 'ґ': 'G', 'д': 'D', 'е': 'EH',
    'є': 'Y E', 'ж': 'ZH', 'з': 'Z', 'и': 'IX', 'і': 'IY', 'ї': 'Y IY',
    'й': 'Y', 'к': 'K', 'л': 'L', 'м': 'M', 'н': 'N', 'о': 'O', 'п': 'P',
    'р': 'DX', 'с': 'S', 'т': 'T', 'у': 'UW', 'ф': 'F', 'х': 'X', 'ц': 'TS',
    'ч': 'CH', 'ш': 'SH', 'щ': 'SH CH', 'ь': '', 'ю': 'UW', 'я': 'A', "'": '',
  }),
  when('ю', 'Y UW', { at: 'start' }),
  when('я', 'Y A', { at: 'start' }),
  when('ю', 'Y UW', { prev: 'аеиіоуюя' }),
  when('я', 'Y A', { prev: 'аеиіоуюя' }),
]

/* ------------------------------------------------------------------ Greek --- */

const GREEK_ACCENTS: Record<string, string> = {
  'ά': 'α', 'έ': 'ε', 'ή': 'η', 'ί': 'ι', 'ϊ': 'ι', 'ΐ': 'ι',
  'ό': 'ο', 'ύ': 'υ', 'ϋ': 'υ', 'ΰ': 'υ', 'ώ': 'ω', 'ς': 'σ',
}

const GREEK: SoundRule[] = [
  ...letters({
    'ου': 'UW', 'αι': 'E', 'ει': 'IY', 'οι': 'IY', 'υι': 'IY',
    'αυ': 'A F', 'ευ': 'E F', 'ηυ': 'IY F',
    'μπ': 'B', 'ντ': 'D', 'γκ': 'G', 'γγ': 'NG', 'τσ': 'TS', 'τζ': 'DZ',
    'α': 'A', 'β': 'V', 'γ': 'GX', 'δ': 'DH', 'ε': 'E', 'ζ': 'Z', 'η': 'IY',
    'θ': 'TH', 'ι': 'IY', 'κ': 'K', 'λ': 'L', 'μ': 'M', 'ν': 'N', 'ξ': 'K S',
    'ο': 'O', 'π': 'P', 'ρ': 'DX', 'σ': 'S', 'τ': 'T', 'υ': 'IY', 'φ': 'F',
    'χ': 'X', 'ψ': 'P S', 'ω': 'O',
  }),
  // αυ / ευ are voiced before a voiced sound and voiceless before a breath.
  when('αυ', 'A V', { next: 'αβγδεζηιλμνορυω' }),
  when('ευ', 'E V', { next: 'αβγδεζηιλμνορυω' }),
  when('γ', 'Y', { next: 'ειη' }),
  // An unstressed ι or υ before another vowel is a glide, not a syllable of
  // its own: καρδιά is two beats, not three.
  when('ι', 'Y', { prev: 'βγδζθκλμνξπρστφχψ', next: 'αεοωυ' }),
  when('υ', 'Y', { prev: 'βγδζθκλμνξπρστφχψ', next: 'αεοω' }),
]

/* ------------------------------------------ Devanagari: an abugida reader --- */

const DEVANAGARI_CONSONANTS: Record<string, Phoneme[]> = {
  'क': ['K'], 'ख': ['K'], 'ग': ['G'], 'घ': ['G'], 'ङ': ['NG'],
  'च': ['CH'], 'छ': ['CH'], 'ज': ['JH'], 'झ': ['JH'], 'ञ': ['NY'],
  'ट': ['T'], 'ठ': ['T'], 'ड': ['D'], 'ढ': ['D'], 'ण': ['N'],
  'त': ['T'], 'थ': ['T'], 'द': ['D'], 'ध': ['D'], 'न': ['N'],
  'प': ['P'], 'फ': ['F'], 'ब': ['B'], 'भ': ['B'], 'म': ['M'],
  'य': ['Y'], 'र': ['DX'], 'ल': ['L'], 'व': ['V'], 'ळ': ['L'],
  'श': ['SH'], 'ष': ['SH'], 'स': ['S'], 'ह': ['HH'],
  'क़': ['Q'], 'ख़': ['X'], 'ग़': ['GX'], 'ज़': ['Z'], 'ड़': ['DX'], 'ढ़': ['DX'], 'फ़': ['F'],
}

/** Independent vowel signs, used when a syllable begins with a vowel. */
const DEVANAGARI_VOWELS: Record<string, Vowel[]> = {
  'अ': ['AX'], 'आ': ['A'], 'इ': ['IH'], 'ई': ['IY'], 'उ': ['UH'], 'ऊ': ['UW'],
  'ऋ': ['IH'], 'ए': ['E'], 'ऐ': ['EH'], 'ओ': ['O'], 'औ': ['AO'],
}

/** Dependent vowel signs, which replace the consonant's built-in vowel. */
const DEVANAGARI_MATRAS: Record<string, Vowel[]> = {
  'ा': ['A'], 'ि': ['IH'], 'ी': ['IY'], 'ु': ['UH'], 'ू': ['UW'],
  'ृ': ['IH'], 'े': ['E'], 'ै': ['EH'], 'ो': ['O'], 'ौ': ['AO'],
}

const VIRAMA = '्'
const ANUSVARA = 'ं'
const CHANDRABINDU = 'ँ'
const VISARGA = 'ः'
const NUKTA = '़'

/**
 * Reads Devanagari.
 *
 * Every consonant sign carries an inherent "a" unless a vowel sign or a virama
 * says otherwise, and Hindi then drops that inherent vowel at the end of a
 * word — which is why "राम" is Raam and not Raama.
 */
function readDevanagari(word: string): PhonemeSpan[] {
  const spans: PhonemeSpan[] = []
  let index = 0

  while (index < word.length) {
    const start = index
    let character = word[index]!

    // A nukta modifies the preceding consonant into a different one.
    if (word[index + 1] === NUKTA && DEVANAGARI_CONSONANTS[character + NUKTA]) {
      character += NUKTA
      index += 1
    }

    const consonant = DEVANAGARI_CONSONANTS[character]
    if (consonant) {
      index += 1
      for (const phoneme of consonant) spans.push({ phoneme, start, end: index })

      if (word[index] === VIRAMA) {
        // Explicitly no vowel: the next consonant joins this one in a cluster.
        index += 1
        continue
      }
      const matra = word[index] !== undefined ? DEVANAGARI_MATRAS[word[index]!] : undefined
      if (matra) {
        index += 1
        for (const vowel of matra) spans.push({ phoneme: vowel, start, end: index })
      } else if (!isFinalConsonant(word, index)) {
        spans.push({ phoneme: 'AX', start, end: index })
      }
      index = readNasalMarks(word, index, spans, start)
      continue
    }

    const vowel = DEVANAGARI_VOWELS[character]
    if (vowel) {
      index += 1
      for (const phoneme of vowel) spans.push({ phoneme, start, end: index })
      index = readNasalMarks(word, index, spans, start)
      continue
    }

    index += 1
  }

  return spans
}

function readNasalMarks(word: string, index: number, spans: PhonemeSpan[], start: number): number {
  let cursor = index
  while (cursor < word.length) {
    const mark = word[cursor]!
    if (mark === ANUSVARA || mark === CHANDRABINDU) {
      spans.push({ phoneme: 'N', start, end: cursor + 1 })
      cursor += 1
    } else if (mark === VISARGA) {
      spans.push({ phoneme: 'HH', start, end: cursor + 1 })
      cursor += 1
    } else break
  }
  return cursor
}

/** True at the end of the word, where Hindi drops the inherent vowel. */
function isFinalConsonant(word: string, index: number): boolean {
  for (let i = index; i < word.length; i++) {
    const character = word[i]!
    if (character === ANUSVARA || character === CHANDRABINDU || character === VISARGA) continue
    return false
  }
  return true
}

/* -------------------------------------------------------- Japanese: kana --- */

/** Each kana is one mora; the table is the syllabary itself. */
const KANA: Record<string, [Consonant[], Vowel]> = {
  'あ': [[], 'A'], 'い': [[], 'IY'], 'う': [[], 'UW'], 'え': [[], 'E'], 'お': [[], 'O'],
  'か': [['K'], 'A'], 'き': [['K'], 'IY'], 'く': [['K'], 'UW'], 'け': [['K'], 'E'], 'こ': [['K'], 'O'],
  'が': [['G'], 'A'], 'ぎ': [['G'], 'IY'], 'ぐ': [['G'], 'UW'], 'げ': [['G'], 'E'], 'ご': [['G'], 'O'],
  'さ': [['S'], 'A'], 'し': [['SH'], 'IY'], 'す': [['S'], 'UW'], 'せ': [['S'], 'E'], 'そ': [['S'], 'O'],
  'ざ': [['Z'], 'A'], 'じ': [['JH'], 'IY'], 'ず': [['Z'], 'UW'], 'ぜ': [['Z'], 'E'], 'ぞ': [['Z'], 'O'],
  'た': [['T'], 'A'], 'ち': [['CH'], 'IY'], 'つ': [['TS'], 'UW'], 'て': [['T'], 'E'], 'と': [['T'], 'O'],
  'だ': [['D'], 'A'], 'ぢ': [['JH'], 'IY'], 'づ': [['Z'], 'UW'], 'で': [['D'], 'E'], 'ど': [['D'], 'O'],
  'な': [['N'], 'A'], 'に': [['NY'], 'IY'], 'ぬ': [['N'], 'UW'], 'ね': [['N'], 'E'], 'の': [['N'], 'O'],
  'は': [['HH'], 'A'], 'ひ': [['CX'], 'IY'], 'ふ': [['F'], 'UW'], 'へ': [['HH'], 'E'], 'ほ': [['HH'], 'O'],
  'ば': [['B'], 'A'], 'び': [['B'], 'IY'], 'ぶ': [['B'], 'UW'], 'べ': [['B'], 'E'], 'ぼ': [['B'], 'O'],
  'ぱ': [['P'], 'A'], 'ぴ': [['P'], 'IY'], 'ぷ': [['P'], 'UW'], 'ぺ': [['P'], 'E'], 'ぽ': [['P'], 'O'],
  'ま': [['M'], 'A'], 'み': [['M'], 'IY'], 'む': [['M'], 'UW'], 'め': [['M'], 'E'], 'も': [['M'], 'O'],
  'や': [['Y'], 'A'], 'ゆ': [['Y'], 'UW'], 'よ': [['Y'], 'O'],
  'ら': [['DX'], 'A'], 'り': [['DX'], 'IY'], 'る': [['DX'], 'UW'], 'れ': [['DX'], 'E'], 'ろ': [['DX'], 'O'],
  'わ': [['W'], 'A'], 'を': [[], 'O'],
}

/** The small kana that glide onto the mora before them. */
const KANA_SMALL: Record<string, Vowel> = { 'ゃ': 'A', 'ゅ': 'UW', 'ょ': 'O' }
const KANA_SMALL_VOWELS: Record<string, Vowel> = {
  'ぁ': 'A', 'ぃ': 'IY', 'ぅ': 'UW', 'ぇ': 'E', 'ぉ': 'O',
}

/** Katakana sit one block above hiragana, so the two share one table. */
function toHiragana(word: string): string {
  let out = ''
  for (const character of word) {
    const code = character.codePointAt(0)!
    out += code >= 0x30a1 && code <= 0x30f6 ? String.fromCodePoint(code - 0x60) : character
  }
  return out
}

function readKana(rawWord: string): Syllable[] {
  const word = toHiragana(rawWord)
  const syllables: Syllable[] = []
  let pendingGeminate = false

  for (let i = 0; i < word.length; i++) {
    const character = word[i]!

    if (character === 'っ') { pendingGeminate = true; continue }

    // The moraic n is its own beat, but a note of its own would sound like a
    // stutter, so it closes the syllable before it.
    if (character === 'ん') {
      const previous = syllables[syllables.length - 1]
      if (previous) { previous.coda.push('N'); previous.text += character }
      else syllables.push({ text: character, onset: [], vowel: 'AX', coda: ['N'] })
      continue
    }

    // A long-vowel mark holds the vowel before it rather than adding a beat.
    if (character === 'ー') {
      const previous = syllables[syllables.length - 1]
      if (previous) previous.text += character
      continue
    }

    const mora = KANA[character]
    if (!mora) continue
    const [onset, vowel] = mora

    const next = word[i + 1]
    const small = next !== undefined ? KANA_SMALL[next] : undefined
    if (small && vowel === 'IY' && onset.length > 0) {
      // きゃ and its siblings: the i is a glide onto the following vowel.
      syllables.push({
        text: character + next,
        onset: [...onset, 'Y'],
        vowel: small,
        coda: [],
      })
      i += 1
    } else {
      const smallVowel = next !== undefined ? KANA_SMALL_VOWELS[next] : undefined
      const syllable: Syllable = {
        text: character + (smallVowel ? next! : ''),
        onset: [...onset],
        vowel,
        coda: [],
      }
      if (smallVowel) { syllable.vowel = smallVowel; i += 1 }
      syllables.push(syllable)
    }

    if (pendingGeminate) {
      const created = syllables[syllables.length - 1]!
      const previous = syllables[syllables.length - 2]
      const first = created.onset[0]
      if (previous && first) previous.coda.push(first)
      pendingGeminate = false
    }
  }

  return syllables
}

/* ---------------------------------------------------- Korean: hangul math --- */

const HANGUL_BASE = 0xac00
const HANGUL_COUNT = 11172

const JAMO_INITIAL: Consonant[][] = [
  ['K'], ['K'], ['N'], ['T'], ['T'], ['DX'], ['M'], ['P'], ['P'], ['S'],
  ['S'], [], ['JH'], ['JH'], ['CH'], ['K'], ['T'], ['P'], ['HH'],
]

/** Each medial is a vowel, sometimes with a glide in front of it. */
const JAMO_MEDIAL: [Consonant[], Vowel][] = [
  [[], 'A'], [[], 'EH'], [['Y'], 'A'], [['Y'], 'EH'], [[], 'AH'], [[], 'E'],
  [['Y'], 'AH'], [['Y'], 'E'], [[], 'O'], [['W'], 'A'], [['W'], 'EH'], [['W'], 'E'],
  [['Y'], 'O'], [[], 'UW'], [['W'], 'AH'], [['W'], 'E'], [['W'], 'IY'], [['Y'], 'UW'],
  [[], 'IX'], [[], 'IX'], [[], 'IY'],
]

/** Only seven sounds can close a Korean syllable, however it is spelled. */
const JAMO_FINAL: Consonant[][] = [
  [], ['K'], ['K'], ['K'], ['N'], ['N'], ['N'], ['T'], ['L'], ['K'],
  ['M'], ['L'], ['L'], ['L'], ['P'], ['L'], ['M'], ['P'], ['P'], ['T'],
  ['T'], ['NG'], ['T'], ['T'], ['K'], ['T'], ['P'], ['T'],
]

/** The plain stops, and what they become between two voiced sounds. */
const HANGUL_VOICING: Partial<Record<Consonant, Consonant>> = {
  K: 'G', T: 'D', P: 'B', JH: 'JH', CH: 'JH',
}

/** Codas that leave the voice running into the next syllable. */
const VOICED_CODA = new Set<Consonant>(['N', 'M', 'NG', 'L'])

function readHangul(word: string): Syllable[] {
  const syllables: Syllable[] = []
  for (const character of word) {
    const offset = character.codePointAt(0)! - HANGUL_BASE
    if (offset < 0 || offset >= HANGUL_COUNT) continue

    const initial = Math.floor(offset / 588)
    const medial = Math.floor((offset % 588) / 28)
    const final = offset % 28
    const [glide, vowel] = JAMO_MEDIAL[medial]!
    const onset = [...JAMO_INITIAL[initial]!, ...glide]

    // Korean writes one letter for a sound that is voiceless at the start of a
    // word and voiced inside it: 한국 is spelled with the k of "kim" but said
    // with the g of "go". Only the plain series does this — the tense and
    // aspirated jamo, which share a phoneme with it here, do not, so the rule
    // is limited to the plain rows of the initial table.
    const plain = initial === 0 || initial === 3 || initial === 7 || initial === 12
    const previous = syllables[syllables.length - 1]
    if (plain && previous && onset[0]) {
      const lastCoda = previous.coda[previous.coda.length - 1]
      const voicedBefore = lastCoda === undefined || VOICED_CODA.has(lastCoda)
      const voiced = HANGUL_VOICING[onset[0]]
      if (voicedBefore && voiced) onset[0] = voiced
    }

    syllables.push({ text: character, onset, vowel, coda: [...JAMO_FINAL[final]!] })
  }
  return syllables
}

/* ----------------------------------------------------------------- Arabic --- */

const ARABIC_CONSONANTS: Record<string, Phoneme[]> = {
  'ب': ['B'], 'ت': ['T'], 'ث': ['TH'], 'ج': ['JH'], 'ح': ['HH'], 'خ': ['X'],
  'د': ['D'], 'ذ': ['DH'], 'ر': ['DX'], 'ز': ['Z'], 'س': ['S'], 'ش': ['SH'],
  'ص': ['S'], 'ض': ['D'], 'ط': ['T'], 'ظ': ['DH'], 'ع': ['Q'], 'غ': ['GX'],
  'ف': ['F'], 'ق': ['Q'], 'ك': ['K'], 'ل': ['L'], 'م': ['M'], 'ن': ['N'],
  'ه': ['HH'], 'ة': ['HH'], 'ء': ['Q'], 'أ': ['Q'], 'إ': ['Q'], 'آ': ['Q'],
  'ئ': ['Q'], 'ؤ': ['Q'], 'پ': ['P'], 'چ': ['CH'], 'ژ': ['ZH'], 'گ': ['G'],
}

// The tanwin marks are a short vowel plus an n, which is why the table holds
// phonemes rather than vowels.
const ARABIC_HARAKAT: Record<string, Phoneme[]> = {
  'َ': ['A'], 'ِ': ['IH'], 'ُ': ['UH'],
  'ً': ['A', 'N'], 'ٍ': ['IH', 'N'], 'ٌ': ['UH', 'N'],
}
const ARABIC_SUKUN = 'ْ'
const ARABIC_SHADDA = 'ّ'

/**
 * Reads Arabic.
 *
 * Vowels are optional in Arabic writing. When the short-vowel marks are there
 * the reading is exact; when they are not, an "a" is supplied between
 * consonants, which is the same guess a reader makes before they know the word.
 */
function readArabic(word: string): PhonemeSpan[] {
  const spans: PhonemeSpan[] = []
  let index = 0
  // With no vowel marks the reading alternates: the first consonant of each
  // pair takes a vowel and the second closes the syllable, which is what turns
  // q-l-b into "qalb" rather than "qalab".
  let unmarkedConsonants = 0

  while (index < word.length) {
    const start = index
    const character = word[index]!

    // Long vowels: alef, waw and ya carry a vowel unless they open a syllable.
    if (character === 'ا' || character === 'ٰ') {
      index += 1
      spans.push({ phoneme: 'A', start, end: index })
      continue
    }
    if ((character === 'و' || character === 'ي' || character === 'ى')) {
      index += 1
      const previous = spans[spans.length - 1]
      const opensSyllable = previous === undefined || isArabicVowel(previous.phoneme)
      const phoneme: Phoneme = opensSyllable
        ? (character === 'و' ? 'W' : 'Y')
        : (character === 'و' ? 'UW' : 'IY')
      spans.push({ phoneme, start, end: index })
      if (opensSyllable) index = readArabicVowel(word, index, spans, start, true)
      else unmarkedConsonants = 0
      continue
    }

    const consonant = ARABIC_CONSONANTS[character]
    if (!consonant) { index += 1; continue }

    index += 1
    for (const phoneme of consonant) spans.push({ phoneme, start, end: index })
    if (word[index] === ARABIC_SHADDA) {
      index += 1
      for (const phoneme of consonant) spans.push({ phoneme, start, end: index })
    }
    index = readArabicVowel(word, index, spans, start, unmarkedConsonants % 2 === 0)
    unmarkedConsonants += 1
  }

  return spans
}

function readArabicVowel(
  word: string, index: number, spans: PhonemeSpan[], start: number, wantsVowel: boolean,
): number {
  const mark = word[index]
  const marked = mark !== undefined ? ARABIC_HARAKAT[mark] : undefined
  if (marked) {
    for (const phoneme of marked) spans.push({ phoneme, start, end: index + 1 })
    return index + 1
  }
  if (mark === ARABIC_SUKUN) return index + 1
  // Unmarked, and never on the last consonant of the word.
  if (wantsVowel && index < word.length) spans.push({ phoneme: 'A', start, end: index })
  return index
}

function isArabicVowel(phoneme: Phoneme): boolean {
  return phoneme === 'A' || phoneme === 'IY' || phoneme === 'UW'
    || phoneme === 'IH' || phoneme === 'UH'
}

/* -------------------------------------------------------- reader adapters --- */

function fromSpans(read: (word: string) => PhonemeSpan[], maxOnset: number) {
  return (word: string): Syllable[] => syllabify(read(word), word, { maxOnset })
}

/* --------------------------------------------------------------- profiles --- */

export const SCRIPT_PROFILES: LanguageProfile[] = [
  {
    id: 'ru', label: 'Russian', native: 'Русский', script: 'cyrillic',
    voiceTags: ['ru-RU', 'ru'], rules: RUSSIAN, syllable: { maxOnset: 3, hiatus: true },
  },
  {
    id: 'uk', label: 'Ukrainian', native: 'Українська', script: 'cyrillic',
    voiceTags: ['uk-UA', 'uk'], rules: UKRAINIAN, syllable: { maxOnset: 3, hiatus: true },
  },
  {
    id: 'el', label: 'Greek', native: 'Ελληνικά', script: 'greek',
    voiceTags: ['el-GR', 'el'], rules: GREEK, syllable: { maxOnset: 2 },
    normalize: (word) => word.replace(/[άέήίϊΐόύϋΰώς]/g, (c) => GREEK_ACCENTS[c] ?? c),
  },
  {
    id: 'hi', label: 'Hindi', native: 'हिन्दी', script: 'devanagari',
    voiceTags: ['hi-IN', 'hi'], pronounceWord: fromSpans(readDevanagari, 2),
  },
  {
    id: 'ja', label: 'Japanese', native: '日本語', script: 'kana',
    voiceTags: ['ja-JP', 'ja'], pronounceWord: readKana,
  },
  {
    id: 'ko', label: 'Korean', native: '한국어', script: 'hangul',
    voiceTags: ['ko-KR', 'ko'], pronounceWord: readHangul,
  },
  {
    id: 'ar', label: 'Arabic', native: 'العربية', script: 'arabic',
    voiceTags: ['ar-SA', 'ar-EG', 'ar'], pronounceWord: fromSpans(readArabic, 2),
    normalize: (word) => word.replace(/[ـ]/g, ''),
  },
]

export { readDevanagari, readHangul, readKana, readArabic }
