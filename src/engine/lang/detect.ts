/**
 * Working out what language a lyric is written in.
 *
 * Two signals, in order of how much they are worth. A non-Latin script settles
 * the question almost by itself — nothing but Korean is written in hangul. For
 * the Latin languages the giveaway is the small closed set of words that hold a
 * sentence together, backed up by the letters a language uses that its
 * neighbours do not.
 */

import type { LanguageId } from './types'

/** Code-point ranges that identify a script outright. */
const SCRIPT_RANGES: [number, number, LanguageId][] = [
  [0xac00, 0xd7a3, 'ko'],   // hangul syllables
  [0x1100, 0x11ff, 'ko'],   // hangul jamo
  [0x3040, 0x309f, 'ja'],   // hiragana
  [0x30a0, 0x30ff, 'ja'],   // katakana
  [0x0900, 0x097f, 'hi'],   // devanagari
  [0x0600, 0x06ff, 'ar'],   // arabic
  [0x0750, 0x077f, 'ar'],
  [0x0370, 0x03ff, 'el'],   // greek
  [0x1f00, 0x1fff, 'el'],
  [0x0400, 0x04ff, 'ru'],   // cyrillic, refined below
]

/** Letters only Ukrainian uses among the Cyrillic languages here. */
const UKRAINIAN_LETTERS = /[іїєґ]/

/**
 * Ukrainian words with no Ukrainian-only letter in them.
 *
 * A short Ukrainian line can be spelled entirely in letters Russian also uses,
 * so the letters alone are not enough to tell the two apart.
 */
const UKRAINIAN_WORDS = [
  'кохаю', 'тебе', 'назавжди', 'дуже', 'дякую', 'будь', 'ласка', 'так',
  'мене', 'моя', 'серце', 'завжди', 'ніколи', 'разом', 'вітаю', 'добре',
]

/**
 * The function words that hold each language together. Content words drift
 * between languages; these do not, which is what makes them worth counting.
 */
const STOPWORDS: Record<string, string[]> = {
  en: ['the', 'and', 'you', 'that', 'was', 'for', 'are', 'with', 'this', 'have', 'from', 'your', 'what', 'when', 'will', 'love', 'my', 'me', 'to', 'of', 'in', 'is', 'it', 'we', 'be', 'not', 'on', 'all', 'just', 'like', 'don', 'never', 'always', 'heart', 'night', 'know', 'time', 'away', 'about', 'could', 'would', 'every', 'there', 'again', 'still', 'baby'],
  id: ['yang', 'dan', 'dari', 'untuk', 'dengan', 'tidak', 'akan', 'ini', 'itu', 'saya', 'kamu', 'aku', 'adalah', 'pada', 'sudah', 'bisa', 'cinta', 'hati', 'kau', 'dalam', 'karena', 'tapi', 'lagi', 'hanya', 'selalu', 'semua', 'kita', 'juga', 'masih', 'jangan', 'kalau', 'rindu', 'hidup', 'waktu', 'tak'],
  es: ['que', 'de', 'la', 'el', 'en', 'los', 'las', 'por', 'con', 'para', 'no', 'mi', 'te', 'se', 'un', 'una', 'es', 'muy', 'amor', 'corazón', 'más', 'tú', 'yo', 'como', 'pero', 'todo', 'nada', 'siempre', 'nunca', 'quiero', 'vida', 'noche', 'cuando', 'sin', 'está', 'eres', 'tan'],
  it: ['che', 'di', 'il', 'la', 'non', 'per', 'con', 'un', 'una', 'sono', 'mi', 'ti', 'ci', 'del', 'nel', 'più', 'sei', 'amore', 'cuore', 'come', 'ma', 'anche', 'quando', 'niente', 'amo', 'tanto', 'sempre', 'ancora', 'questo', 'perché', 'vita', 'notte', 'cosa', 'solo'],
  pt: ['que', 'não', 'para', 'com', 'uma', 'você', 'meu', 'minha', 'mais', 'por', 'eu', 'coração', 'amor', 'quando', 'só', 'tudo', 'nós', 'mas', 'ser', 'tem', 'seu', 'amo', 'muito', 'sempre', 'nunca', 'vida', 'noite', 'agora', 'ainda', 'também', 'porque', 'está'],
  fr: ['le', 'la', 'les', 'de', 'des', 'et', 'est', 'je', 'tu', 'il', 'elle', 'nous', 'vous', 'que', 'qui', 'pas', 'pour', 'dans', 'mon', 'ma', 'mes', 'avec', 'plus', 'moi', 'toi', 'amour', 'cœur', 'très', 'une', 'sur', 'aime', 'toujours', 'jamais', 'quand', 'nuit', 'coeur', 'rien', 'encore', 'être', 'sans', 'comme'],
  de: ['der', 'die', 'das', 'und', 'ich', 'du', 'nicht', 'ist', 'ein', 'eine', 'mit', 'für', 'auf', 'wir', 'sie', 'mein', 'dein', 'aber', 'wenn', 'noch', 'liebe', 'herz', 'nur', 'auch', 'schon', 'dich', 'mich', 'immer', 'nacht', 'wieder', 'ohne', 'alles'],
  nl: ['het', 'een', 'ik', 'je', 'niet', 'van', 'met', 'voor', 'maar', 'wij', 'jij', 'mijn', 'jouw', 'liefde', 'hart', 'ook', 'weer', 'naar', 'zijn', 'heb', 'dat', 'als', 'nooit', 'altijd', 'nacht', 'meer', 'zonder'],
  tr: ['bir', 've', 'bu', 'için', 'ben', 'sen', 'ama', 'çok', 'ne', 'gibi', 'daha', 'var', 'yok', 'aşk', 'kalp', 'seni', 'beni', 'değil', 'her', 'kadar', 'bana', 'sana', 'seviyorum', 'gece', 'zaman', 'hiç', 'yine'],
  pl: ['nie', 'jest', 'się', 'że', 'do', 'jak', 'ale', 'mnie', 'ciebie', 'moje', 'tylko', 'miłość', 'serce', 'już', 'jeszcze', 'kiedy', 'jestem', 'wszystko', 'kocham', 'noc', 'zawsze', 'nigdy'],
  ro: ['și', 'la', 'în', 'cu', 'este', 'nu', 'pentru', 'mai', 'să', 'te', 'mă', 'iubire', 'inimă', 'care', 'când', 'sunt', 'doar', 'tot', 'iubesc', 'noapte', 'niciodată', 'mereu'],
  cs: ['se', 'na', 'je', 'že', 'ne', 'jak', 'ale', 'můj', 'tvoje', 'láska', 'srdce', 'jsem', 'jsi', 'který', 'když', 'jenom', 'ještě', 'všechno', 'miluji', 'noc', 'vždy', 'nikdy'],
  sv: ['och', 'att', 'det', 'som', 'en', 'är', 'jag', 'du', 'inte', 'för', 'med', 'på', 'min', 'din', 'kärlek', 'hjärta', 'vi', 'men', 'har', 'kan', 'aldrig', 'alltid', 'natt', 'älskar'],
  fi: ['ja', 'on', 'ei', 'se', 'että', 'minä', 'sinä', 'mutta', 'kuin', 'niin', 'olen', 'olet', 'rakkaus', 'sydän', 'vain', 'kun', 'sitä', 'nyt', 'rakastan', 'aina', 'koskaan'],
  vi: ['và', 'là', 'của', 'không', 'có', 'được', 'người', 'những', 'tôi', 'em', 'anh', 'yêu', 'tim', 'một', 'cho', 'này', 'như', 'với', 'trong', 'đêm', 'mãi', 'nhớ'],
  tl: ['ang', 'ng', 'sa', 'na', 'ay', 'mga', 'ako', 'ikaw', 'ito', 'hindi', 'para', 'kung', 'puso', 'mahal', 'mo', 'ko', 'nang', 'siya', 'kita', 'gabi', 'lagi', 'kailanman'],
  sw: ['na', 'ya', 'wa', 'kwa', 'ni', 'katika', 'moyo', 'upendo', 'sisi', 'wewe', 'mimi', 'hii', 'kama', 'lakini', 'nini', 'sana', 'nakupenda', 'usiku', 'daima'],
}

/** Letters that point at one language without naming it outright. */
const MARKER_LETTERS: [RegExp, LanguageId, number][] = [
  [/[ñ¿¡]/, 'es', 4],
  [/[ãõ]/, 'pt', 4],
  [/[ğışİ]/, 'tr', 4],
  [/[ąćęłńśźż]/, 'pl', 4],
  [/[ěščřžůň]/, 'cs', 4],
  [/[ăîșțş]/, 'ro', 4],
  [/[åø]/, 'sv', 3],
  [/[ß]/, 'de', 4],
  [/[œ]/, 'fr', 4],
  [/[ươăâđ]/, 'vi', 4],
  [/[äöy]/, 'fi', 1],
  [/[àèìòù]/, 'it', 2],
  [/[éèêç]/, 'fr', 1],
  [/[äöü]/, 'de', 1],
  [/[áéíóúü]/, 'es', 1],
  [/[ç]/, 'pt', 1],
  [/[ij]/, 'nl', 0.5],
]

const WORD_PATTERN = /[\p{L}\p{M}'’-]+/gu

/**
 * Best guess at the language of a piece of text.
 *
 * Returns `latn` when the text is in the Latin alphabet but matches nothing —
 * a language the studio has no table for still gets read letter by letter,
 * which is far closer than reading it as English.
 */
export function detectLanguage(text: string): LanguageId {
  const trimmed = text.trim()
  if (!trimmed) return 'en'

  const scriptVotes = new Map<LanguageId, number>()
  for (const character of trimmed) {
    const code = character.codePointAt(0)!
    for (const [low, high, id] of SCRIPT_RANGES) {
      if (code >= low && code <= high) {
        scriptVotes.set(id, (scriptVotes.get(id) ?? 0) + 1)
        break
      }
    }
  }

  let bestScript: LanguageId | null = null
  let bestScriptCount = 0
  for (const [id, count] of scriptVotes) {
    if (count > bestScriptCount) { bestScript = id; bestScriptCount = count }
  }
  // Japanese mixes kana with Chinese characters, so even a light sprinkle of
  // kana is decisive; the other scripts need to actually carry the text.
  if (bestScript === 'ja' && bestScriptCount > 0) return 'ja'
  if (bestScript && bestScriptCount >= Math.max(2, countLetters(trimmed) * 0.3)) {
    if (bestScript === 'ru') {
      if (UKRAINIAN_LETTERS.test(trimmed)) return 'uk'
      const words = trimmed.toLowerCase().match(WORD_PATTERN) ?? []
      if (words.filter((word) => UKRAINIAN_WORDS.includes(word)).length >= 2) return 'uk'
    }
    return bestScript
  }

  const lower = trimmed.toLowerCase()
  const words = lower.match(WORD_PATTERN) ?? []
  const scores = new Map<LanguageId, number>()

  // An elided word carries its own signal on the far side of the apostrophe:
  // "t'aime" is French because of "aime", not because of "t".
  const candidates = words.flatMap((word) => (word.includes("'") ? [word, ...word.split("'")] : [word]))

  for (const word of candidates) {
    for (const [id, list] of Object.entries(STOPWORDS)) {
      if (!list.includes(word)) continue
      // A longer function word is a stronger signal: "the" is shared with
      // nothing, but "de" belongs to half of Europe.
      const weight = word.length >= 4 ? 3 : word.length >= 3 ? 2 : 1
      scores.set(id as LanguageId, (scores.get(id as LanguageId) ?? 0) + weight)
    }
  }

  for (const [pattern, id, weight] of MARKER_LETTERS) {
    if (pattern.test(lower)) scores.set(id, (scores.get(id) ?? 0) + weight)
  }

  let best: LanguageId = 'latn'
  let bestScore = 0
  for (const [id, score] of scores) {
    if (score > bestScore) { best = id; bestScore = score }
  }
  if (bestScore < 2) return /^[\x20-\x7e\n\r\t]*$/.test(trimmed) ? 'en' : 'latn'
  return best
}

function countLetters(text: string): number {
  let count = 0
  for (const character of text) {
    if (/\p{L}/u.test(character)) count++
  }
  return count
}
