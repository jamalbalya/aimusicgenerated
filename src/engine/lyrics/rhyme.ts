/**
 * Rhyme matching without a pronunciation dictionary.
 *
 * A word's rhyme key is built from its final vowel nucleus plus the consonants
 * that follow it, normalised so that spellings which sound alike collapse
 * together ("night"/"light"/"bite", "day"/"grey"/"weigh").
 */

import { normalizeWord } from './syllables'

const VOWELS = 'aeiouy'

/**
 * Words whose spelling lies about their sound. Respelled phonetically before
 * the rules run, so "heart" rhymes with "start" and "love" with "above".
 */
const IRREGULAR: Record<string, string> = {
  heart: 'hart', hearts: 'harts', hearth: 'harth',
  are: 'ar', one: 'wun', once: 'wuns', done: 'dun', gone: 'gon',
  some: 'sum', come: 'cum', become: 'becum', none: 'nun',
  love: 'luv', above: 'abuv', glove: 'gluv', dove: 'duv', shove: 'shuv',
  move: 'moov', prove: 'proov', lose: 'looz', whose: 'hooz', shoe: 'shoo',
  said: 'sed', again: 'agen', says: 'sez', eye: 'i', eyes: 'ize',
  buy: 'bi', bye: 'bi', guy: 'gi', why: 'wi', high: 'hi', sigh: 'si',
  though: 'tho', through: 'throo', laugh: 'laf', cough: 'cof',
  tough: 'tuf', rough: 'ruf', enough: 'enuf', touch: 'tuch', much: 'much',
  women: 'wimin', busy: 'bizy', build: 'bild', friend: 'frend',
  blood: 'blud', flood: 'flud', foot: 'fut', good: 'gud', stood: 'stud',
  four: 'for', your: 'yor', pour: 'por', front: 'frunt', month: 'munth',
  iron: 'iern', choir: 'kwire', colonel: 'kernel', island: 'iland',
  young: 'yung', tongue: 'tung', among: 'amung', worry: 'wurry',
  water: 'wauter', soul: 'sole', whole: 'hole', ocean: 'oshun',
  season: 'seezun', reason: 'reezun', motion: 'moshun', devotion: 'devoshun',
}

/** Spelling patterns that map onto the same rhyming sound. */
const SOUND_RULES: [RegExp, string][] = [
  [/ight$/, 'ite'], [/ite$/, 'ite'], [/yte$/, 'ite'], [/ide$/, 'ide'], [/ied$/, 'ide'],
  [/eigh$/, 'ay'], [/ay$/, 'ay'], [/ey$/, 'ay'], [/ai(n|l|d|t)$/, 'a$1'],
  [/ough$/, 'uff'], [/augh$/, 'aff'],
  [/tion$/, 'shun'], [/sion$/, 'shun'], [/cian$/, 'shun'],
  [/ph/, 'f'], [/ck$/, 'k'], [/que$/, 'k'], [/c(e|i)/, 's$1'],
  [/ee$/, 'e'], [/ea$/, 'e'], [/ie$/, 'e'], [/y$/, 'e'],
  [/oa/, 'o'], [/ow$/, 'o'], [/oe$/, 'o'], [/ough$/, 'o'],
  [/ue$/, 'oo'], [/ew$/, 'oo'], [/oo/, 'oo'], [/ou/, 'ou'],
  [/wr/, 'r'], [/kn/, 'n'], [/mb$/, 'm'], [/gh/, ''],
  [/([^aeiou])e$/, '$1'],
]

function toSoundForm(word: string): string {
  let sound = word
  for (const [pattern, replacement] of SOUND_RULES) {
    sound = sound.replace(pattern, replacement)
  }
  return sound
}

/**
 * The rhyme key: everything from the last vowel nucleus onwards. Words with
 * the same key rhyme.
 */
export function rhymeKey(rawWord: string): string {
  const word = normalizeWord(rawWord)
  if (!word) return ''
  const sound = toSoundForm(IRREGULAR[word] ?? word)

  let lastVowel = -1
  for (let i = sound.length - 1; i >= 0; i--) {
    if (VOWELS.includes(sound[i]!)) {
      lastVowel = i
      break
    }
  }
  if (lastVowel < 0) return sound.slice(-2)

  // Include the whole final vowel group so "ai" and "a" do not collide.
  let start = lastVowel
  while (start > 0 && VOWELS.includes(sound[start - 1]!)) start--
  const key = sound.slice(start)
  // Collapse doubled consonants: "runner" and "stunner" rhyme.
  return key.replace(/([^aeiou])\1+/g, '$1')
}

/** True when two words rhyme. Identical words are not treated as a rhyme. */
export function rhymes(a: string, b: string): boolean {
  const wa = normalizeWord(a)
  const wb = normalizeWord(b)
  if (!wa || !wb || wa === wb) return false
  const ka = rhymeKey(wa)
  const kb = rhymeKey(wb)
  if (!ka || !kb) return false
  return ka === kb
}

/** Groups words by rhyme key. Groups of one are dropped. */
export function groupByRhyme(words: readonly string[]): Map<string, string[]> {
  const groups = new Map<string, string[]>()
  for (const word of words) {
    const key = rhymeKey(word)
    if (!key) continue
    const list = groups.get(key)
    if (list) {
      if (!list.includes(word)) list.push(word)
    } else {
      groups.set(key, [word])
    }
  }
  for (const [key, list] of groups) {
    if (list.length < 2) groups.delete(key)
  }
  return groups
}

/** Words from `pool` that rhyme with `word`, excluding the word itself. */
export function findRhymes(word: string, pool: readonly string[]): string[] {
  const key = rhymeKey(word)
  if (!key) return []
  const target = normalizeWord(word)
  return pool.filter((candidate) => {
    const normalized = normalizeWord(candidate)
    return normalized !== target && rhymeKey(normalized) === key
  })
}
