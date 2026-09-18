/**
 * Reading a lyric sheet before it costs anyone a GPU.
 *
 * Everything here answers one question: is this sheet a song someone could
 * sing in the time asked for? That question is worth asking *here* because of
 * how ACE-Step behaves when the answer is no. A sheet too long for the length
 * requested is not sung faster — the decoder is barred from ending before the
 * token budget and forced to end at it, so the words run out of room and the
 * song stops mid-phrase. The person then waits for the queue, spends the GPU
 * slice, and gets a truncated song back. Refusing here costs nothing and says
 * why.
 *
 * The counts come from the project's own syllabifier, which knows the language
 * the words are in. That matters: Indonesian averages far more syllables per
 * word than English, and an English-shaped estimate would refuse perfectly
 * singable Indonesian sheets.
 */

import { countLineSyllables } from '../lang'
import type { LanguageId } from '../lang/types'
import { parseLyricStructure, type LyricBlock } from '../lyrics/structure'
import type { SectionKind } from '../compose/types'

/**
 * Syllables a singer can deliver per second, sustained across a whole song.
 *
 * The upper figure is the one that matters here and it is deliberately
 * generous: rapped delivery reaches 6–7 syllables a second in short bursts, and
 * this gate is not in the business of telling someone their rap is too fast. It
 * refuses sheets that could not be sung by anyone at any tempo.
 */
export const MAX_SUSTAINED_SYLLABLES_PER_SECOND = 7.0

/** Below this, the sheet is so sparse the model is mostly writing instrumental. */
export const SPARSE_SYLLABLES_PER_SECOND = 0.35

/**
 * The share of a song's length that is not sung even in a dense arrangement:
 * intro, fills between lines, an instrumental break, an outro.
 *
 * Used to convert a target duration into the seconds actually available for
 * words, so the density figure is measured against singing time rather than
 * wall-clock time.
 */
export const NON_SUNG_SHARE = 0.25

export type LyricProblemCode =
  | 'EMPTY'
  | 'NO_SUNG_LINES'
  | 'TOO_LONG_FOR_DURATION'
  | 'DENSITY_TOO_HIGH'
  | 'CONTROL_INSTRUCTION'
  | 'DUPLICATE_BLOCK'
  | 'LANGUAGE_MISMATCH'
  | 'SPARSE'
  | 'NO_CHORUS'
  | 'UNBALANCED_SECTION'

export interface LyricProblem {
  code: LyricProblemCode
  /** `error` stops the request. `warning` is shown and the request proceeds. */
  severity: 'error' | 'warning'
  message: string
  /** 1-based line in the sheet, when the problem is at one. */
  line?: number
}

export interface PlannedSection {
  kind: SectionKind
  label: string
  lines: number
  syllables: number
  /** Share of the sung syllables this section carries, 0..1. */
  share: number
}

export interface LyricPlan {
  /** The sheet as it will be sent, with line endings normalised. */
  text: string
  language: LanguageId
  /** The language actually detected in the sung lines. */
  detectedLanguage: LanguageId
  sungLines: number
  syllables: number
  sections: PlannedSection[]
  /** Syllables per second of *singing* time, at the target duration. */
  density: number
  /** The shortest duration this sheet could be sung in, in seconds. */
  minimumDurationSeconds: number
  hasChorus: boolean
  problems: LyricProblem[]
  /** True when no problem has severity `error`. */
  singable: boolean
}

/**
 * Bracketed lines that are directions rather than section names.
 *
 * ACE-Step sings what it is given. A line like `[slow down here]` is not a
 * section tag and not a control instruction the model understands — it is four
 * words the singer may well sing. Caught here rather than heard later.
 */
const KNOWN_TAG = /^(intro|verse|pre-?chorus|chorus|hook|bridge|solo|drop|breakdown|outro|interlude|instrumental|inst|refrain|final chorus|guitar solo|instrumental break|coda|ad-?lib|ad-?libs|post-?chorus)\b/i

function isDirection(tag: string): boolean {
  return !KNOWN_TAG.test(tag.trim())
}

/** Normalises line endings and drops a trailing blank run. Nothing else. */
export function normalizeSheet(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(/\s+$/, '')
}

const blockKey = (block: LyricBlock) =>
  block.lines.map((line) => line.trim().toLowerCase()).join('\n')

/**
 * Reads the sheet and says whether it can be sung in the time available.
 *
 * `targetSeconds` may be undefined, which is Auto: ACE-Step picks the length
 * from the words. Then there is no length to overflow, so the duration checks
 * do not run and the density figure is reported against the minimum singable
 * length instead.
 */
export function planLyrics(
  rawText: string,
  language: LanguageId,
  targetSeconds: number | undefined,
  detect: (text: string) => LanguageId,
): LyricPlan {
  const text = normalizeSheet(rawText)
  const problems: LyricProblem[] = []
  const blocks = parseLyricStructure(text)

  const sungLineTexts: string[] = []
  const sections: PlannedSection[] = []
  let hasChorus = false

  // Directions left among the words, reported against the line they sit on.
  const lines = text.split('\n')
  lines.forEach((raw, index) => {
    const line = raw.trim()
    const tag = /^\[([^\]]+)\]$/.exec(line)
    if (tag && isDirection(tag[1]!)) {
      problems.push({
        code: 'CONTROL_INSTRUCTION', severity: 'warning', line: index + 1,
        message: `Line ${index + 1}: "${line}" is not a section name. ACE-Step has no control `
          + 'instructions — a bracketed line it does not recognise is words it may sing.',
      })
    }
  })

  for (const block of blocks) {
    const syllables = block.lines.reduce((total, line) => total + countLineSyllables(line, language), 0)
    if (block.kind === 'chorus') hasChorus = true
    sungLineTexts.push(...block.lines)
    sections.push({
      kind: block.kind, label: block.label, lines: block.lines.length, syllables, share: 0,
    })
  }

  const syllables = sections.reduce((total, section) => total + section.syllables, 0)
  for (const section of sections) section.share = syllables > 0 ? section.syllables / syllables : 0

  // Consecutive identical blocks. A chorus repeating later in the song is the
  // form working; the same block twice in a row is a paste that slipped.
  for (let index = 1; index < blocks.length; index++) {
    const previous = blocks[index - 1]!
    const current = blocks[index]!
    if (current.lines.length > 0 && blockKey(current) === blockKey(previous)) {
      problems.push({
        code: 'DUPLICATE_BLOCK', severity: 'warning',
        message: `"${current.label}" repeats the block immediately before it word for word. `
          + 'A chorus that returns later is normal; the same block twice in a row is usually a paste.',
      })
    }
  }

  const sungLines = sungLineTexts.length
  const minimumDurationSeconds = syllables > 0
    ? (syllables / MAX_SUSTAINED_SYLLABLES_PER_SECOND) / (1 - NON_SUNG_SHARE)
    : 0

  if (text.trim().length === 0) {
    problems.push({
      code: 'EMPTY', severity: 'error',
      message: 'The lyric sheet is empty. ACE-Step sings the words it is given; '
        + 'switch on Instrumental if the song should have none.',
    })
  } else if (sungLines === 0) {
    problems.push({
      code: 'NO_SUNG_LINES', severity: 'error',
      message: 'The sheet has section tags but no words under them, so there is nothing to sing.',
    })
  }

  const singingSeconds = targetSeconds !== undefined ? targetSeconds * (1 - NON_SUNG_SHARE) : 0
  const density = singingSeconds > 0 ? syllables / singingSeconds
    : minimumDurationSeconds > 0 ? MAX_SUSTAINED_SYLLABLES_PER_SECOND : 0

  if (targetSeconds !== undefined && syllables > 0) {
    if (density > MAX_SUSTAINED_SYLLABLES_PER_SECOND) {
      problems.push({
        code: 'TOO_LONG_FOR_DURATION', severity: 'error',
        message: `${syllables} syllables cannot be sung in ${Math.round(targetSeconds)} seconds: it `
          + `would need ${density.toFixed(1)} syllables a second, and ${MAX_SUSTAINED_SYLLABLES_PER_SECOND} `
          + `is the ceiling for a whole song. Ask for at least ${Math.ceil(minimumDurationSeconds)} `
          + 'seconds, or shorten the sheet. ACE-Step would not sing this faster — it would stop mid-phrase '
          + 'when the length ran out.',
      })
    } else if (density < SPARSE_SYLLABLES_PER_SECOND && targetSeconds > 60) {
      problems.push({
        code: 'SPARSE', severity: 'warning',
        message: `${syllables} syllables across ${Math.round(targetSeconds)} seconds is `
          + `${density.toFixed(2)} a second. Most of this song will be instrumental.`,
      })
    }
  }

  const detectedLanguage = sungLines > 0 ? detect(sungLineTexts.join('\n')) : language
  if (sungLines > 0 && detectedLanguage !== language) {
    problems.push({
      code: 'LANGUAGE_MISMATCH', severity: 'warning',
      message: `The lyrics read as ${detectedLanguage} but the request says ${language}. `
        + 'ACE-Step pronounces the sheet in the language it is told, so the words may come out '
        + 'with the wrong accent or the wrong vowels.',
    })
  }

  if (sungLines >= 8 && !hasChorus && blocks.some((block) => block.kind !== 'verse')) {
    problems.push({
      code: 'NO_CHORUS', severity: 'warning',
      message: 'No section is tagged as a chorus, so nothing in the sheet is marked to return. '
        + 'ACE-Step uses the tags to shape the form.',
    })
  }

  // A single section carrying almost the whole sheet is a sheet with no form.
  const dominant = sections.find((section) => section.share > 0.8 && sections.length > 1)
  if (dominant) {
    problems.push({
      code: 'UNBALANCED_SECTION', severity: 'warning',
      message: `"${dominant.label}" holds ${Math.round(dominant.share * 100)}% of the words. `
        + 'The other sections will be near-empty.',
    })
  }

  return {
    text,
    language,
    detectedLanguage,
    sungLines,
    syllables,
    sections,
    density,
    minimumDurationSeconds,
    hasChorus,
    problems,
    singable: !problems.some((problem) => problem.severity === 'error'),
  }
}
