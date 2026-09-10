/**
 * English syllable counting and splitting.
 *
 * The singing synthesiser needs to know how many syllables a line has (to fit
 * it to a melody) and where they break (to place each one on a note). A full
 * pronunciation dictionary would be megabytes; these rules get within one
 * syllable on ordinary English lyric vocabulary, which is what matters here.
 */

const VOWELS = 'aeiouy'

/** Words whose count the vowel-group rules get wrong. */
const EXCEPTIONS: Record<string, number> = {
  the: 1, a: 1, i: 1, are: 1, were: 1, our: 1, hour: 1, fire: 2, hire: 1,
  every: 3, everything: 4, everyone: 3, evening: 2, business: 2, beautiful: 3,
  people: 2, little: 2, simple: 2, purple: 2, table: 2, trouble: 2, double: 2,
  quiet: 2, science: 2, ocean: 2, radio: 3, video: 3, area: 3, idea: 3,
  create: 2, creates: 2, real: 1, really: 3, being: 2, seeing: 2, doing: 2,
  going: 2, nothing: 2, something: 2, anything: 3, someone: 2, anyone: 3,
  forever: 3, never: 2, over: 2, under: 2, other: 2, another: 3, whatever: 4,
  higher: 2, fired: 1, tired: 1, wired: 1, hired: 1, choir: 1, prayer: 1,
  poem: 2, poet: 2, lion: 2, lions: 2, giant: 2, riot: 2, dial: 2, trial: 2,
  heaven: 2, seven: 2, eleven: 3, given: 2, driven: 2, risen: 2, listen: 2,
  chocolate: 3, family: 3, memory: 3, gravity: 3, honestly: 3,
  // Syllabic consonants: the vowel is not written.
  rhythm: 2, rhythms: 2, prism: 2, chasm: 2, realism: 4, sarcasm: 3,
}

/** Strips punctuation and lowercases a token for analysis. */
export function normalizeWord(word: string): string {
  return word.toLowerCase().replace(/[^a-z']/g, '')
}

/** Counts syllables in a single word. Always returns at least 1. */
export function syllablesInWord(rawWord: string): number {
  const word = normalizeWord(rawWord)
  if (!word) return 0

  const exception = EXCEPTIONS[word]
  if (exception !== undefined) return exception

  let count = 0
  let previousWasVowel = false
  for (let i = 0; i < word.length; i++) {
    const isVowel = VOWELS.includes(word[i]!)
    if (isVowel && !previousWasVowel) count++
    previousWasVowel = isVowel
  }

  // Silent terminal "e" ("make" is one syllable, "the" is handled above).
  if (word.endsWith('e') && !word.endsWith('le') && count > 1) {
    const beforeE = word[word.length - 2]
    if (beforeE && !VOWELS.includes(beforeE)) count--
  }
  // "-le" after a consonant is its own syllable ("table", "little").
  if (word.endsWith('le') && word.length > 2) {
    const beforeLe = word[word.length - 3]
    if (beforeLe && !VOWELS.includes(beforeLe)) count++
  }
  // "-ed" is usually silent unless preceded by t or d ("wanted", "faded").
  if (word.endsWith('ed') && word.length > 3) {
    const beforeEd = word[word.length - 3]!
    if (beforeEd !== 't' && beforeEd !== 'd' && !VOWELS.includes(beforeEd)) count--
  }
  // "-es" after a sibilant is a syllable ("watches"); otherwise silent.
  if (word.endsWith('es') && word.length > 3 && !/(s|z|x|ch|sh|ge|ce)es$/.test(word)) {
    const beforeEs = word[word.length - 3]!
    if (!VOWELS.includes(beforeEs)) count--
  }

  return Math.max(1, count)
}

/** Counts syllables across a whole line. */
export function syllablesInLine(line: string): number {
  return tokenizeWords(line).reduce((sum, word) => sum + syllablesInWord(word), 0)
}

export function tokenizeWords(line: string): string[] {
  return line.split(/[^A-Za-z']+/).filter((w) => normalizeWord(w).length > 0)
}

/**
 * Splits a word into syllable-sized chunks for singing. The chunks are
 * spelling-based, not phonetic, but each one carries exactly one vowel nucleus
 * so the singer lands one note per chunk.
 */
export function splitSyllables(rawWord: string): string[] {
  const word = normalizeWord(rawWord)
  if (!word) return []
  const target = syllablesInWord(word)
  if (target <= 1) return [word]

  // Find vowel-group nuclei, then cut between them at the consonant boundary.
  const nuclei: { start: number; end: number }[] = []
  let i = 0
  while (i < word.length) {
    if (VOWELS.includes(word[i]!)) {
      const start = i
      while (i < word.length && VOWELS.includes(word[i]!)) i++
      nuclei.push({ start, end: i })
    } else {
      i++
    }
  }
  if (nuclei.length <= 1) return [word]

  const cuts: number[] = []
  for (let n = 0; n < nuclei.length - 1; n++) {
    const gapStart = nuclei[n]!.end
    const gapEnd = nuclei[n + 1]!.start
    const consonants = gapEnd - gapStart
    // One consonant goes with the following syllable; two or more split.
    const cut = consonants <= 1 ? gapEnd : gapStart + Math.floor(consonants / 2)
    if (cut > 0 && cut < word.length) cuts.push(cut)
  }

  const parts: string[] = []
  let previous = 0
  for (const cut of cuts) {
    if (cut <= previous) continue
    parts.push(word.slice(previous, cut))
    previous = cut
  }
  parts.push(word.slice(previous))

  const cleaned = parts.filter((p) => p.length > 0)
  // Reconcile with the counted target so melody alignment stays exact.
  while (cleaned.length > target && cleaned.length > 1) {
    const last = cleaned.pop()!
    cleaned[cleaned.length - 1] += last
  }
  return cleaned.length > 0 ? cleaned : [word]
}

/** Splits a full line into singable syllable chunks, in order. */
export function lineSyllables(line: string): string[] {
  const out: string[] = []
  for (const word of tokenizeWords(line)) out.push(...splitSyllables(word))
  return out
}
