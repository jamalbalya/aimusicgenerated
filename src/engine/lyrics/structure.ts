/**
 * Reading the structure a lyricist wrote into their lyrics.
 *
 * People write `[Verse]`, `[Chorus]`, `[Bridge]` because that is how lyrics are
 * written, and a tag carries real intent: it says how many sections there are,
 * what order they come in, and which lines belong to each. Ignoring the tags
 * means singing the word "Chorus" out loud; honouring them means the song is
 * built to the shape its author had in mind.
 *
 * Tags also take a free-text qualifier after a comma — `[Chorus, Full Koplo]`,
 * `[Bridge, Emotional]` — which steers how hard that section is played.
 */

import type { SectionKind } from '../compose/types'

export interface LyricBlock {
  kind: SectionKind
  /** The tag exactly as written, for the lyric sheet. */
  label: string
  /** Free text after the comma inside the tag, lower case. */
  qualifier: string
  /** How hard to play it, 0..1, or undefined to use the section's own default. */
  intensity?: number
  lines: string[]
}

/** Tag words, and the section each one means. */
// The section word is not always the first word of the tag — "Kendang Break"
// and "Guitar Solo" name the instrument first — so these match anywhere in it.
// Order is what resolves the overlaps: "Pre-Chorus" must be tested before
// "Chorus", and "Instrumental Break" is a break before it is an instrumental.
const TAG_KINDS: [RegExp, SectionKind][] = [
  [/\bpre[\s-]?chorus\b|\bprechorus\b|\bbuild\b/, 'prechorus'],
  [/\bintro\b|\bprelude\b|\bintroduction\b/, 'intro'],
  [/\bbreak\b|\bbreakdown\b|\binterlude\b|\bdrum fill\b/, 'breakdown'],
  [/\bchorus\b|\bhook\b|\brefrain\b|\bch(ø|oe)urs\b/, 'chorus'],
  [/\bverse\b|\brap\b|\bbars?\b/, 'verse'],
  [/\bbridge\b|\bmiddle\b/, 'bridge'],
  [/\bdrop\b/, 'drop'],
  [/\bsolo\b|\binstrumental\b|\bensemble\b|\bimprovis/, 'solo'],
  [/\boutro\b|\bending\b|\bend\b|\bfade\b|\bcoda\b/, 'outro'],
]

/**
 * Words a lyricist puts in the qualifier to say how big a section is.
 * They are the vocabulary of a live arrangement rather than a fixed enum, so
 * the list is matched loosely and anything unrecognised simply has no effect.
 */
// Order matters: the quietest reading of a qualifier wins over the loudest,
// because "Dark Koplo" is a dark section in a koplo song, not a loud one. A
// genre name inside a tag is a label, never an energy marking, which is why
// "koplo" is absent from this list while "kendang break" is in it.
const QUALIFIER_INTENSITY: [RegExp, number][] = [
  [/fade|fading|outro|ending/, 0.3],
  [/emotional|soft|gentle|quiet|calm|tender|acoustic|stripped|intimate/, 0.35],
  [/dark|moody|tense|sparse|minimal|brooding/, 0.4],
  [/explosive|full|massive|huge|loud|anthem|max|final/, 1],
  // A kendang break is where the crowd dances hardest, not a lull.
  [/kendang|call and response|drum fill|percussion break/, 0.95],
  [/big|strong|powerful|driving|energetic/, 0.9],
]

const TAG_LINE = /^\s*[[(]\s*([^\])]+?)\s*[\])]\s*$/

/**
 * Words that sit in front of a section name without changing which section it
 * is. "Final Chorus" is a chorus; so is "Last Chorus" and "Double Chorus".
 */
const LEADING_MODIFIERS = /^(final|last|big|double|half|second|third|repeat|reprise|full|mini|short)\s+/

/** The section a tag names, or null when the word is not a structure tag. */
export function tagToKind(tag: string): SectionKind | null {
  let word = tag.trim().toLowerCase()
  while (LEADING_MODIFIERS.test(word)) word = word.replace(LEADING_MODIFIERS, '')
  for (const [pattern, kind] of TAG_KINDS) {
    if (pattern.test(word)) return kind
  }
  return null
}

function qualifierIntensity(qualifier: string): number | undefined {
  for (const [pattern, intensity] of QUALIFIER_INTENSITY) {
    if (pattern.test(qualifier)) return intensity
  }
  return undefined
}

/** True when the lyric carries at least one structure tag of its own. */
export function hasStructureTags(text: string): boolean {
  return text.split(/\r?\n/).some((line) => {
    const match = TAG_LINE.exec(line)
    return match !== null && tagToKind(match[1]!) !== null
  })
}

/**
 * Splits a lyric into its tagged sections.
 *
 * Lines written before the first tag are kept as a verse, because words are
 * words whether or not somebody labelled them. A tag with nothing under it —
 * `[End]`, or an instrumental break — still becomes a section; it simply has no
 * line to sing.
 */
export function parseLyricStructure(text: string): LyricBlock[] {
  const blocks: LyricBlock[] = []
  let current: LyricBlock | null = null

  for (const raw of text.split(/\r?\n/)) {
    const match = TAG_LINE.exec(raw)
    const kind = match ? tagToKind(match[1]!) : null

    if (match && kind) {
      const inside = match[1]!
      const comma = inside.indexOf(',')
      // The words before the comma can carry emphasis too — "Final Chorus" is
      // a bigger chorus than the ones before it.
      const qualifier = (comma === -1 ? inside : inside.slice(comma + 1)).trim().toLowerCase()
      current = {
        kind,
        label: inside.trim(),
        qualifier,
        ...(qualifierIntensity(qualifier) !== undefined
          ? { intensity: qualifierIntensity(qualifier)! }
          : {}),
        lines: [],
      }
      blocks.push(current)
      continue
    }

    const line = raw.trim()
    if (!line) continue
    if (!current) {
      current = { kind: 'verse', label: 'Verse', qualifier: '', lines: [] }
      blocks.push(current)
    }
    current.lines.push(line)
  }

  return blocks
}

/**
 * The structure tags the insert button offers.
 *
 * Plain section names only. A tag saying how a section should be played is
 * still understood if somebody writes one, but it is not suggested: how the
 * music sounds belongs in the style description, and a lyric sheet reads
 * better without production notes in it.
 */
export const STRUCTURE_TAGS: { group: string; tags: string[] }[] = [
  { group: 'Basic', tags: ['Intro', 'Verse 1', 'Verse 2', 'Pre-Chorus', 'Chorus', 'Bridge', 'Outro'] },
  { group: 'More', tags: ['Hook', 'Final Chorus', 'Instrumental Break', 'Drop', 'Interlude', 'Guitar Solo'] },
]

/* ------------------------------------------------------ singability check --- */

export interface LyricWarning {
  line: number
  text: string
  reason: string
}

/**
 * Reads a lyric the way a singer would, and says where it will not work.
 *
 * These are the things that go wrong when words meet a melody: a line too long
 * to fit a phrase, a line so short it leaves the phrase empty, production notes
 * left in among the words, and a chorus that never repeats. None of them stop
 * the song being made — they are warnings, not errors — but every one of them
 * is audible.
 */
export function checkSingability(text: string, syllablesOf: (line: string) => number): LyricWarning[] {
  const warnings: LyricWarning[] = []
  const lines = text.split(/\r?\n/)

  let sungLines = 0
  const seen = new Map<string, number>()
  let hasChorus = false

  lines.forEach((raw, index) => {
    const line = raw.trim()
    if (!line) return

    const tag = /^\s*[[(]\s*([^\])]+?)\s*[\])]\s*$/.exec(line)
    if (tag) {
      if (tagToKind(tag[1]!) === 'chorus') hasChorus = true
      // A bracketed line that is not a section is a production note, and a
      // production note in the lyric box is a line the singer will try to sing.
      if (tagToKind(tag[1]!) === null) {
        warnings.push({ line: index + 1, text: line, reason: 'Not a section name — it will be sung as words.' })
      }
      return
    }

    sungLines++
    const syllables = syllablesOf(line)
    if (syllables > 20) {
      warnings.push({ line: index + 1, text: line, reason: `${syllables} syllables is more than a phrase holds — split it.` })
    }
    if (line.length > 4 && syllables < 2) {
      warnings.push({ line: index + 1, text: line, reason: 'Too short to carry a phrase.' })
    }
    const key = line.toLowerCase()
    seen.set(key, (seen.get(key) ?? 0) + 1)
  })

  if (sungLines === 0) {
    warnings.push({ line: 0, text: '', reason: 'There are no words to sing — only section markers.' })
  } else if (hasChorus && ![...seen.values()].some((count) => count > 1)) {
    warnings.push({ line: 0, text: '', reason: 'Nothing repeats — a chorus people can sing back needs a line that comes round again.' })
  }

  return warnings
}
