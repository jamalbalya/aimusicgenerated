/**
 * The parsed reading of a lyric sheet, kept strictly apart from the sheet.
 *
 * Two things exist here and they are never the same object. `original` is what
 * the person typed, byte for byte, and nothing in this module writes to it. The
 * rest is a *reading* of it — sections, directions, counts — built for the
 * generator and thrown away afterwards.
 *
 * That separation is the whole point. A system that edits someone's lyric sheet
 * to suit a model has quietly decided the model matters more than the writer,
 * and every such edit is invisible by the time anyone notices the song is
 * missing a verse. So the sheet is read, never rewritten, and everything the
 * reading decides to leave out of the request is reported rather than dropped.
 *
 * A header is `[Name]` or `[Name, direction]`:
 *
 *   [Intro, Delicate Piano and Soft Saxophone]
 *     sectionName      = "Intro"
 *     sectionDirection = "Delicate Piano and Soft Saxophone"
 *
 * The direction is an arrangement instruction, not words to sing. It travels to
 * ACE-Step inside the sheet — the lyric field is the only place a per-section
 * instruction can go, since the caption describes the whole song — and it is
 * also counted as a planned constraint so the interface can say whether it
 * arrived.
 *
 * `[End]` terminates the reading. Everything after it is preserved in
 * `afterEnd` and excluded from the song, because that is what the marker means.
 */

import { countLineSyllables } from '../lang'
import type { LanguageId } from '../lang/types'
import { tagToKind } from '../lyrics/structure'
import type { SectionKind } from '../compose/types'

/** `[anything]` or `(anything)` alone on a line. */
const HEADER_LINE = /^\s*[[(]\s*([^\])]+?)\s*[\])]\s*$/

/** The words that end a sheet. Matched on the whole tag, not inside one. */
const TERMINATOR = /^(end|the end|fin|finish|finished|stop)$/i

export interface ScriptSection {
  /** Position in the sheet, from 0. */
  index: number
  /** The header exactly as written, or null for words before any header. */
  rawHeader: string | null
  /** "Intro" from "[Intro, Delicate Piano and Soft Saxophone]". */
  sectionName: string
  /** "Delicate Piano and Soft Saxophone", or empty when the header has none. */
  sectionDirection: string
  /** Which of the engine's section kinds this is, for the form plan. */
  kind: SectionKind
  /** The sung lines, trimmed, in order. Never altered beyond trimming. */
  lines: string[]
  syllables: number
  /** 1-based line number of the header in the original sheet. */
  startLine: number
}

export interface LyricScript {
  /** What the person typed. Byte for byte. Never modified by anything here. */
  original: string
  sections: ScriptSection[]
  /** Every per-section arrangement direction found, in order. */
  directions: { section: string; direction: string }[]
  /** True when an end marker was found and stopped the reading. */
  terminated: boolean
  /** The marker that terminated it, as written. */
  terminator: string | null
  /** Lines after the terminator. Kept, shown, and not part of the song. */
  afterEnd: string[]
  /** Bracketed lines that name no section — words ACE-Step may well sing. */
  strayDirections: { line: number; text: string }[]
  sungLines: number
  syllables: number
  /**
   * The sheet as it will be sent: the original, minus anything at or after the
   * end marker. Nothing else is touched — every line, every header and every
   * direction the song contains travels exactly as written.
   */
  payload: string
}

/** Splits a header's inside into the section name and its direction. */
export function splitHeader(inside: string): { sectionName: string; sectionDirection: string } {
  const comma = inside.indexOf(',')
  if (comma === -1) return { sectionName: inside.trim(), sectionDirection: '' }
  return {
    sectionName: inside.slice(0, comma).trim(),
    sectionDirection: inside.slice(comma + 1).trim(),
  }
}

/** True when this tag ends the sheet rather than naming a section. */
export function isTerminator(inside: string): boolean {
  return TERMINATOR.test(inside.trim())
}

/**
 * Reads a sheet. Never throws, never edits, never drops anything silently.
 *
 * Lines written before the first header are kept as a verse, because words are
 * words whether or not somebody labelled them.
 */
export function parseLyricScript(original: string, language: LanguageId): LyricScript {
  // Line endings only. A sheet written on Windows must hash and count the same
  // as the same sheet written anywhere else, and nothing about a line changes.
  const normalised = original.replace(/\r\n?/g, '\n')
  const lines = normalised.split('\n')

  const sections: ScriptSection[] = []
  const strayDirections: { line: number; text: string }[] = []
  const afterEnd: string[] = []
  let terminated = false
  let terminator: string | null = null
  let current: ScriptSection | null = null
  let payloadLines: string[] = []

  for (let index = 0; index < lines.length; index++) {
    const raw = lines[index]!
    if (terminated) {
      if (raw.trim()) afterEnd.push(raw.trim())
      continue
    }

    const header = HEADER_LINE.exec(raw)
    if (header) {
      const inside = header[1]!
      if (isTerminator(inside)) {
        terminated = true
        terminator = raw.trim()
        continue
      }
      const kind = tagToKind(inside)
      if (kind) {
        const { sectionName, sectionDirection } = splitHeader(inside)
        current = {
          index: sections.length,
          rawHeader: raw.trim(),
          sectionName,
          sectionDirection,
          kind,
          lines: [],
          syllables: 0,
          startLine: index + 1,
        }
        sections.push(current)
        payloadLines.push(raw)
        continue
      }
      // A bracketed line naming no section. ACE-Step has no control
      // instructions, so this is words it may sing — recorded, and still sent,
      // because deleting somebody's line to protect them from it is worse.
      strayDirections.push({ line: index + 1, text: raw.trim() })
    }

    payloadLines.push(raw)
    const line = raw.trim()
    if (!line) continue
    if (!current) {
      current = {
        index: sections.length,
        rawHeader: null,
        sectionName: 'Verse',
        sectionDirection: '',
        kind: 'verse',
        lines: [],
        syllables: 0,
        startLine: index + 1,
      }
      sections.push(current)
    }
    current.lines.push(line)
    current.syllables += countLineSyllables(line, language)
  }

  // Trailing blank lines are not content and the payload does not carry them.
  while (payloadLines.length > 0 && !payloadLines[payloadLines.length - 1]!.trim()) {
    payloadLines = payloadLines.slice(0, -1)
  }

  const directions = sections
    .filter((section) => section.sectionDirection.length > 0)
    .map((section) => ({ section: section.sectionName, direction: section.sectionDirection }))

  return {
    original,
    sections,
    directions,
    terminated,
    terminator,
    afterEnd,
    strayDirections,
    sungLines: sections.reduce((total, section) => total + section.lines.length, 0),
    syllables: sections.reduce((total, section) => total + section.syllables, 0),
    payload: payloadLines.join('\n'),
  }
}
