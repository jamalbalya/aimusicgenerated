/**
 * Lyric writer.
 *
 * Lines come from grammatical templates filled with vocabulary from one image
 * family. The rhyme word is chosen first, then a template whose ending part of
 * speech matches it — that ordering is what keeps the lines grammatical while
 * still landing the rhyme scheme. Choruses are written once and repeated,
 * which is what makes the result read as a song rather than a list of lines.
 */

import { Rng } from '../core/rng'
import { rhymeKey } from './rhyme'
import { gerund, isCountable, pluralize, thirdPerson } from './inflect'
import { lineSyllables, syllablesInLine, tokenizeWords } from './syllables'
import {
  BRIDGE_TEMPLATES, CHORUS_TEMPLATES, COMMON, FAMILY_WORDS, OPENER_TEMPLATES,
  RAP_TEMPLATES, RHYME_WORDS, VERSE_TEMPLATES,
  type EndPos, type ImageFamily, type RhymeWord, type Template, type WordBank,
} from './vocab'
import type { LyricLine, SectionKind, SongLyrics } from '../compose/types'
import type { Mood } from '../compose/prompt'

export type RhymeScheme = 'AABB' | 'ABAB' | 'AABA' | 'ABCB' | 'AAAA'

export const RHYME_SCHEMES: RhymeScheme[] = ['AABB', 'ABAB', 'AABA', 'ABCB', 'AAAA']

export interface LyricSectionRequest {
  kind: SectionKind
  lines: number
  /** Target syllables per line; the writer fits lines to these. */
  syllableTargets?: number[]
}

export interface LyricsRequest {
  theme: string
  mood: Mood
  style: 'sung' | 'rap'
  seed: string
  structure: LyricSectionRequest[]
  rhymeScheme?: RhymeScheme
  title?: string
}

const MOOD_FAMILIES: Record<Mood, ImageFamily[]> = {
  happy: ['light', 'season', 'home', 'city'],
  sad: ['night', 'ocean', 'ghost', 'heart'],
  dark: ['night', 'ghost', 'storm', 'machine'],
  epic: ['fire', 'sky', 'storm', 'gold'],
  chill: ['ocean', 'season', 'home', 'light'],
  energetic: ['fire', 'city', 'road', 'gold'],
  romantic: ['heart', 'light', 'home', 'season'],
  angry: ['fire', 'storm', 'city', 'machine'],
  dreamy: ['sky', 'ocean', 'night', 'light'],
  nostalgic: ['season', 'home', 'road', 'ghost'],
  tense: ['storm', 'machine', 'ghost', 'city'],
  hopeful: ['light', 'sky', 'road', 'season'],
}

const STOP_WORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'of', 'in', 'on', 'at', 'to', 'for',
  'with', 'about', 'song', 'track', 'music', 'beat', 'make', 'write', 'me',
  'my', 'i', 'you', 'your', 'is', 'are', 'was', 'were', 'it', 'that', 'this',
  'be', 'been', 'as', 'by', 'from', 'like', 'into', 'over', 'under', 'we',
  'generate', 'create', 'want', 'please', 'sounding', 'style', 'vibe',
  'someone', 'something', 'anything', 'everything', 'anyone', 'everyone',
  'nothing', 'nobody', 'somebody', 'him', 'her', 'them', 'they', 'she', 'he',
  'who', 'what', 'when', 'where', 'why', 'how', 'again', 'very', 'much',
  'never', 'always', 'still', 'just', 'only', 'really', 'almost', 'ever',
  'more', 'less', 'most', 'least', 'some', 'any', 'all', 'both', 'each',
  'get', 'got', 'has', 'had', 'will', 'would', 'can', 'could', 'should',
])

/**
 * Theme words that can stand in for a noun. Verb-ish and adverbial forms are
 * dropped: "a driving" or "the sleeping" would break the templates.
 */
export function themeKeywords(theme: string): string[] {
  return tokenizeWords(theme)
    .map((w) => w.toLowerCase())
    .filter((w) =>
      w.length > 2 &&
      !STOP_WORDS.has(w) &&
      !/(ing|ed|ly|est)$/.test(w) &&
      /^[a-z]+$/.test(w))
    .slice(0, 8)
}

function pickFamily(theme: string, mood: Mood, rng: Rng): ImageFamily {
  const keywords = themeKeywords(theme)
  let best: ImageFamily | null = null
  let bestScore = 0
  for (const family of Object.keys(FAMILY_WORDS) as ImageFamily[]) {
    const bank = FAMILY_WORDS[family]
    const words = [...bank.nouns, ...bank.motionVerbs, ...bank.feelVerbs, ...bank.adjectives, family]
    let score = 0
    for (const keyword of keywords) {
      for (const word of words) {
        if (word === keyword) score += 3
        else if (word.length > 3 && (word.includes(keyword) || keyword.includes(word))) score += 1
      }
    }
    if (score > bestScore) {
      bestScore = score
      best = family
    }
  }
  return best ?? rng.pick(MOOD_FAMILIES[mood])
}

function dedupe(words: string[]): string[] {
  return [...new Set(words.filter((w) => w.length > 0))]
}

function buildBank(family: ImageFamily, theme: string, rng: Rng): WordBank {
  const base = FAMILY_WORDS[family]
  // Theme keywords enter the noun pool twice so they surface often without
  // crowding out the family's imagery.
  const keywords = themeKeywords(theme).filter((w) => /^[a-z]+$/.test(w))
  const secondary = FAMILY_WORDS[rng.pick(Object.keys(FAMILY_WORDS) as ImageFamily[])]
  return {
    nouns: dedupe([...base.nouns, ...COMMON.nouns, ...keywords, ...keywords]),
    motionVerbs: dedupe([...base.motionVerbs, ...COMMON.motionVerbs]),
    feelVerbs: dedupe([...base.feelVerbs, ...COMMON.feelVerbs]),
    adjectives: dedupe([...base.adjectives, ...COMMON.adjectives, ...secondary.adjectives.slice(0, 3)]),
    places: dedupe([...base.places, ...COMMON.places]),
  }
}

const SCHEMES: Record<SectionKind, RhymeScheme[]> = {
  intro: ['AABB', 'ABAB'],
  verse: ['ABAB', 'AABB', 'ABCB'],
  prechorus: ['AABB', 'AAAA'],
  chorus: ['AABB', 'ABAB', 'AABA'],
  bridge: ['AABB', 'ABCB'],
  solo: ['AABB'],
  drop: ['AAAA', 'AABB'],
  breakdown: ['ABCB', 'AABB'],
  outro: ['AABB', 'AAAA'],
}

/** Expands a scheme to `lines` labels; each repeat gets fresh rhyme sounds. */
export function schemeLabels(scheme: RhymeScheme, lines: number): string[] {
  const base = scheme.split('')
  const out: string[] = []
  for (let i = 0; i < lines; i++) {
    const label = base[i % base.length]!
    const cycle = Math.floor(i / base.length)
    // "C" in ABCB is the unrhymed slot — give it a unique label.
    out.push(label === 'C' ? `X${i}` : `${label}${cycle}`)
  }
  return out
}

/** Rhyme groups, each holding words tagged with the parts of speech they fill. */
function buildRhymeGroups(rng: Rng): RhymeWord[][] {
  const byKey = new Map<string, RhymeWord[]>()
  for (const entry of RHYME_WORDS) {
    const key = rhymeKey(entry.word)
    if (!key) continue
    const list = byKey.get(key)
    if (list) list.push(entry)
    else byKey.set(key, [entry])
  }
  const groups = [...byKey.values()].filter((g) => g.length >= 2).map((g) => rng.shuffle(g))
  return rng.shuffle(groups)
}

function templatesFor(kind: SectionKind, style: 'sung' | 'rap', isFirstLine: boolean): Template[] {
  if (style === 'rap' && kind !== 'chorus' && kind !== 'drop') return RAP_TEMPLATES
  switch (kind) {
    case 'chorus':
    case 'drop':
      return CHORUS_TEMPLATES
    case 'bridge':
      return BRIDGE_TEMPLATES
    case 'prechorus':
      return [...CHORUS_TEMPLATES.slice(0, 8), ...BRIDGE_TEMPLATES]
    case 'intro':
      return isFirstLine ? OPENER_TEMPLATES : VERSE_TEMPLATES
    default:
      return VERSE_TEMPLATES
  }
}

function fillTemplate(template: Template, bank: WordBank, rng: Rng): string {
  let text = template.text
  let guard = 0
  while (/\{[a-zA-Z]+\}/.test(text) && guard++ < 24) {
    text = text.replace(/\{(nouns|noun|adj|vMoveIng|vMoves|vMove|vFeel|place)\}/, (_m, slot: string) => {
      switch (slot) {
        case 'noun': return rng.pick(bank.nouns)
        case 'nouns': return pluralize(pickCountable(bank.nouns, rng))
        case 'adj': return rng.pick(bank.adjectives)
        case 'vMove': return rng.pick(bank.motionVerbs)
        case 'vMoveIng': return gerund(rng.pick(bank.motionVerbs))
        case 'vMoves': return thirdPerson(rng.pick(bank.motionVerbs))
        case 'vFeel': return rng.pick(bank.feelVerbs)
        default: return rng.pick(bank.places)
      }
    })
  }
  return text
}

const ALL_TEMPLATES: Template[] = [
  ...VERSE_TEMPLATES, ...CHORUS_TEMPLATES, ...BRIDGE_TEMPLATES,
  ...RAP_TEMPLATES, ...OPENER_TEMPLATES,
]

/** Picks a noun that can take a plural; mass nouns break "{nouns}" slots. */
function pickCountable(nouns: string[], rng: Rng): string {
  for (let attempt = 0; attempt < 8; attempt++) {
    const candidate = rng.pick(nouns)
    if (isCountable(candidate)) return candidate
  }
  return nouns.find(isCountable) ?? 'moment'
}

const PADDING = ['oh', 'and', 'so', 'now', 'yeah', 'still', 'but', 'well']

/** Nudges a line toward a syllable target without breaking its grammar. */
function fitSyllables(line: string, target: number | undefined, rng: Rng): string {
  if (!target || target < 3) return line
  let text = line
  let guard = 0

  while (syllablesInLine(text) > target + 1 && guard++ < 8) {
    const trimmed = text
      .replace(/^(Oh|And|So|Now|Yeah|Still|But|Well),?\s+/i, '')
      .replace(/\bvery\s+/i, '')
      .replace(/\breally\s+/i, '')
      .replace(/\bjust\s+/i, '')
      .replace(/\bever\s+/i, '')
      .replace(/\bstill\s+/i, '')
    if (trimmed === text) break
    text = trimmed
  }

  guard = 0
  while (syllablesInLine(text) < target - 1 && guard++ < 4) {
    // Do not stack fillers on a line that already opens with a connective.
    const candidates = PADDING.filter((w) => !new RegExp(`^${w}\\b`, 'i').test(text))
    if (candidates.length === 0) break
    const word = rng.pick(candidates)
    const capitalized = word.charAt(0).toUpperCase() + word.slice(1)
    text = `${capitalized}, ${text.charAt(0).toLowerCase()}${text.slice(1)}`
    if (/^(And|But|So),/i.test(text)) break
  }

  return text
}

function tidy(text: string): string {
  return text
    .replace(/\ba ([aeiou])/gi, 'an $1')
    .replace(/\bthe the\b/gi, 'the')
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.!?])/g, '$1')
    .trim()
}

function capitalize(line: string): string {
  const trimmed = line.trim()
  return trimmed ? trimmed.charAt(0).toUpperCase() + trimmed.slice(1) : trimmed
}

interface WriteOptions {
  kind: SectionKind
  lines: number
  syllableTargets?: number[]
  bank: WordBank
  groups: RhymeWord[][]
  style: 'sung' | 'rap'
  rng: Rng
  scheme?: RhymeScheme
}

/** A rhyme group is usable only if it can supply the parts of speech needed. */
function groupSupports(group: RhymeWord[], needed: number): boolean {
  return group.length >= needed
}

function writeSection(options: WriteOptions): string[] {
  const { kind, lines, syllableTargets, bank, groups, style, rng } = options
  if (lines <= 0 || groups.length === 0) return []

  const scheme = options.scheme ?? rng.pick(SCHEMES[kind] ?? ['AABB'])
  const labels = schemeLabels(scheme, lines)

  const counts = new Map<string, number>()
  for (const label of labels) counts.set(label, (counts.get(label) ?? 0) + 1)

  const assigned = new Map<string, RhymeWord[]>()
  const cursor = new Map<string, number>()
  const usedGroups = new Set<number>()

  for (const [label, needed] of counts) {
    const candidates = groups
      .map((group, index) => ({ group, index }))
      .filter(({ group, index }) => !usedGroups.has(index) && groupSupports(group, needed))
    const chosen = candidates.length > 0
      ? rng.pick(candidates)
      : { group: rng.pick(groups), index: -1 }
    if (chosen.index >= 0) usedGroups.add(chosen.index)
    assigned.set(label, chosen.group)
    cursor.set(label, 0)
  }

  const out: string[] = []
  const usedTemplates = new Set<string>()

  for (let i = 0; i < lines; i++) {
    const label = labels[i]!
    const group = assigned.get(label)!
    const at = cursor.get(label)!
    cursor.set(label, at + 1)
    const endWord = group[at % group.length]!

    const pool = templatesFor(kind, style, i === 0)
    const line = composeLine(endWord, pool, bank, usedTemplates, rng, syllableTargets?.[i])
    const fitted = capitalize(tidy(fitSyllables(line, syllableTargets?.[i], rng)))
    out.push(fitted)
  }

  return out
}

/**
 * Builds one line ending on `endWord`. Templates are filtered to those whose
 * ending part of speech the word can fill; if none are free, an unused
 * template of any matching part of speech is reused.
 */
function composeLine(
  endWord: RhymeWord,
  pool: Template[],
  bank: WordBank,
  usedTemplates: Set<string>,
  rng: Rng,
  syllableTarget?: number,
): string {
  let matching = pool.filter((t) => endWord.pos.includes(t.end))
  if (matching.length === 0) {
    // This pool has no line ending on that part of speech — borrow from the
    // others rather than dropping the rhyme.
    matching = ALL_TEMPLATES.filter((t) => endWord.pos.includes(t.end))
  }
  const usable = matching.filter((t) => !usedTemplates.has(t.text))
  const candidates = usable.length > 0 ? usable : matching
  if (candidates.length === 0) {
    return `And it all comes back to the ${endWord.word}`
  }
  // Try a handful of fillings and keep whichever lands closest to the target
  // syllable count — cheaper and far more effective than trying to pad or trim
  // a line that was the wrong length to begin with.
  const attempts = syllableTarget ? 5 : 2
  let bestTemplate = candidates[0]!
  let bestFilled = ''
  let bestCost = Infinity

  for (let attempt = 0; attempt < attempts; attempt++) {
    const template = rng.pick(candidates)
    const filled = fillTemplate(template, bank, rng)
    if (bodyContains(filled, endWord.word)) continue
    const length = syllablesInLine(filled.replace('%END', endWord.word))
    const cost = syllableTarget ? Math.abs(length - syllableTarget) : 0
    if (cost < bestCost) {
      bestCost = cost
      bestTemplate = template
      bestFilled = filled
      if (cost === 0) break
    }
  }

  if (!bestFilled) bestFilled = fillTemplate(bestTemplate, bank, rng)
  usedTemplates.add(bestTemplate.text)
  return bestFilled.replace('%END', endWord.word)
}

function bodyContains(templateText: string, word: string): boolean {
  const body = templateText.replace('%END', '')
  return new RegExp(`\\b${word}\\b`, 'i').test(body)
}

/** Words a title must not start or end on. */
const TITLE_EDGE_WORDS = new Set([
  'a', 'an', 'the', 'and', 'but', 'so', 'or', 'to', 'of', 'in', 'on', 'at',
  'for', 'with', 'is', 'are', 'was', 'were', 'we', 'i', 'you', 'it', 'that',
  'oh', 'yeah', 'now', 'still', 'well', 'my', 'your', 'this', 'as', 'by',
  'until', 'while', 'when', 'before', 'after', 'than', 'from', 'into',
  'about', 'like', 'through', 'without', 'where', 'how', 'if', 'can', 'will',
])

/**
 * Pulls a title out of the hook. Leading filler and trailing function words
 * are trimmed, because "But, take me where the" is not a song title.
 */
function deriveTitle(candidateLines: string[], theme: string, rng: Rng): string {
  for (const line of candidateLines) {
    const title = titleFromLine(line)
    if (title) return title
  }
  const keywords = themeKeywords(theme)
  if (keywords.length > 0) {
    return keywords.slice(0, 3).map(capitalize).join(' ')
  }
  return rng.pick(['Golden Hour', 'Static Light', 'Long Way Home', 'Afterglow'])
}

function titleFromLine(line: string): string | null {
  let words = line.replace(/[.,!?;:]+/g, '').split(/\s+/).filter(Boolean)
  while (words.length > 2 && TITLE_EDGE_WORDS.has(words[0]!.toLowerCase())) words = words.slice(1)
  if (words.length > 5) words = words.slice(0, 5)
  while (words.length > 2 && TITLE_EDGE_WORDS.has(words[words.length - 1]!.toLowerCase())) words.pop()
  if (words.length < 2) return null
  const title = words.join(' ')
  if (title.length < 4 || title.length > 44) return null
  return capitalize(title)
}

export const SECTION_LABEL: Record<SectionKind, string> = {
  intro: 'Intro', verse: 'Verse', prechorus: 'Pre-Chorus', chorus: 'Chorus',
  bridge: 'Bridge', solo: 'Solo', drop: 'Drop', breakdown: 'Breakdown', outro: 'Outro',
}

export function generateLyrics(request: LyricsRequest): SongLyrics {
  const rng = new Rng(`${request.seed}|lyrics`)
  const family = pickFamily(request.theme, request.mood, rng)
  const bank = buildBank(family, request.theme, rng)
  const groups = buildRhymeGroups(rng)

  // Repeated sections of the same kind reuse their text — that is the hook.
  const cache = new Map<string, string[]>()
  const lines: LyricLine[] = []

  request.structure.forEach((section, sectionIndex) => {
    const repeatable = section.kind === 'chorus' || section.kind === 'drop' || section.kind === 'prechorus'
    const cacheKey = `${section.kind}:${section.lines}`
    let text = repeatable ? cache.get(cacheKey) : undefined

    if (!text) {
      text = writeSection({
        kind: section.kind,
        lines: section.lines,
        syllableTargets: section.syllableTargets,
        bank,
        groups,
        style: request.style,
        rng,
        scheme: request.rhymeScheme,
      })
      if (repeatable) cache.set(cacheKey, text)
    } else if (section.syllableTargets) {
      // A repeated chorus still has to fit this section's melody.
      text = text.map((line, i) => capitalize(tidy(fitSyllables(line, section.syllableTargets?.[i], rng))))
    }

    for (const line of text) {
      lines.push({ text: line, section: section.kind, sectionIndex })
    }
  })

  const hookLines = lines.filter((l) => l.section === 'chorus' || l.section === 'drop').map((l) => l.text)
  const title = request.title?.trim()
    || deriveTitle(hookLines.length > 0 ? hookLines : lines.map((l) => l.text), request.theme, rng)

  return { title, lines, formatted: formatLyrics(title, lines) }
}

/** Renders lyrics with section headers, for display and .txt download. */
export function formatLyrics(title: string, lines: LyricLine[]): string {
  const parts: string[] = [title, '']
  let currentSection = -1
  const counts = new Map<SectionKind, number>()

  for (const line of lines) {
    if (line.sectionIndex !== currentSection) {
      currentSection = line.sectionIndex
      const n = (counts.get(line.section) ?? 0) + 1
      counts.set(line.section, n)
      if (parts.length > 2) parts.push('')
      parts.push(`[${SECTION_LABEL[line.section]}${n > 1 ? ` ${n}` : ''}]`)
    }
    parts.push(line.text)
  }
  return parts.join('\n')
}

/** Syllable chunks for each lyric line, used to place words on notes. */
export function lyricSyllables(lines: LyricLine[]): string[][] {
  return lines.map((line) => lineSyllables(line.text))
}

export type { EndPos }
