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

import type { LanguageId } from '../lang/types'
import { parseLyricScript, type LyricScript, type ScriptSection } from './lyricScript'
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
  | 'DENSITY_CONFLICT'

export interface LyricProblem {
  code: LyricProblemCode
  /**
   * `error` stops the request. `warning` and `conflict` are shown and the
   * request proceeds.
   *
   * `conflict` is its own level because it is its own situation: the words and
   * the length asked for cannot both be honoured, the system has no business
   * choosing between them, and it must not resolve the conflict by editing
   * either. It says what will happen and lets the person decide.
   */
  severity: 'error' | 'warning' | 'conflict'
  message: string
  /** What the model is likely to do with it, for a conflict. */
  consequence?: string
  /** 1-based line in the sheet, when the problem is at one. */
  line?: number
}

export interface PlannedSection {
  kind: SectionKind
  label: string
  /** The section's own name, without its direction. */
  sectionName: string
  /** The arrangement direction written in its header, when there was one. */
  sectionDirection: string
  lines: number
  syllables: number
  /** Share of the sung syllables this section carries, 0..1. */
  share: number
}

export interface LyricPlan {
  /**
   * The sheet as it will be sent.
   *
   * The original, minus anything at or after an end marker. No line, header or
   * direction inside the song is altered, shortened or removed.
   */
  text: string
  /** The parsed reading. The original is on `script.original`, untouched. */
  script: LyricScript
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
 * Reads the sheet and reports what it will and will not fit.
 *
 * `targetSeconds` may be undefined, which is Auto: ACE-Step picks the length
 * from the words. Then there is no length to overflow, so the duration checks
 * do not run.
 *
 * Nothing here refuses a sheet for being long. A sheet that will not fit the
 * length asked for is a *conflict between two things the person asked for*, and
 * resolving it by refusing — or worse, by trimming — is the system deciding
 * which of their own requests matters less. It says what will happen and lets
 * them choose. The one exception is ACE-Step's own 4096-character ceiling,
 * which is not a judgement but an HTTP 400, and that is handled in `plan.ts`
 * where the other hard limits live.
 */
export function planLyrics(
  rawText: string,
  language: LanguageId,
  targetSeconds: number | undefined,
  detect: (text: string) => LanguageId,
): LyricPlan {
  const script = parseLyricScript(rawText, language)
  const problems: LyricProblem[] = []

  // Bracketed lines that name no section. Reported, never removed.
  for (const stray of script.strayDirections) {
    problems.push({
      code: 'CONTROL_INSTRUCTION', severity: 'warning', line: stray.line,
      message: `Line ${stray.line}: "${stray.text}" is not a section name. ACE-Step has no control `
        + 'instructions, so a bracketed line it does not recognise is words it may sing. '
        + 'It is being sent exactly as written — nothing was removed.',
    })
  }

  const sections: PlannedSection[] = script.sections.map((section: ScriptSection) => ({
    kind: section.kind,
    label: section.rawHeader ? section.rawHeader.replace(/^[[(]|[\])]$/g, '') : section.sectionName,
    sectionName: section.sectionName,
    sectionDirection: section.sectionDirection,
    lines: section.lines.length,
    syllables: section.syllables,
    share: 0,
  }))

  const syllables = script.syllables
  for (const section of sections) section.share = syllables > 0 ? section.syllables / syllables : 0
  const hasChorus = script.sections.some((section) => section.kind === 'chorus')
  const sungLines = script.sungLines

  // Consecutive identical blocks. A chorus returning later is the form working;
  // the same block twice in a row is a paste that slipped.
  for (let index = 1; index < script.sections.length; index++) {
    const previous = script.sections[index - 1]!
    const current = script.sections[index]!
    const key = (section: ScriptSection) =>
      section.lines.map((line) => line.trim().toLowerCase()).join('\n')
    if (current.lines.length > 0 && key(current) === key(previous)) {
      problems.push({
        code: 'DUPLICATE_BLOCK', severity: 'warning',
        message: `"${current.sectionName}" repeats the block immediately before it word for word. `
          + 'A chorus that returns later is normal; the same block twice in a row is usually a '
          + 'paste. Both are being sent — nothing was removed.',
      })
    }
  }

  if (script.terminated) {
    const after = script.afterEnd.length
    problems.push({
      code: 'CONTROL_INSTRUCTION', severity: 'warning',
      message: `"${script.terminator}" ends the sheet. It is a marker, not something to sing, so `
        + `it is not sent${after > 0 ? `, and neither are the ${after} line(s) after it` : ''}. `
        + 'Everything before it is sent in full, and your sheet is unchanged in the editor.',
    })
  }

  const minimumDurationSeconds = syllables > 0
    ? (syllables / MAX_SUSTAINED_SYLLABLES_PER_SECOND) / (1 - NON_SUNG_SHARE)
    : 0

  if (rawText.trim().length === 0) {
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
      // A conflict, not a refusal. Both halves were asked for by the same
      // person, and the system has no standing to decide which one they meant
      // less. It says what the model will do and generates if they say so.
      problems.push({
        code: 'DENSITY_CONFLICT', severity: 'conflict',
        message: `These lyrics and this length pull against each other. ${syllables} syllables in `
          + `${Math.round(targetSeconds)} seconds is ${density.toFixed(1)} a second, and `
          + `${MAX_SUSTAINED_SYLLABLES_PER_SECOND} is about the ceiling for a whole song. Your `
          + 'lyrics are being sent in full, exactly as written.',
        consequence: `ACE-Step will not sing them faster to fit. It is given a token budget of `
          + `length x 5 and must end at it, so the likely outcome is that the later sections are `
          + `rushed or the song stops mid-phrase. Asking for about `
          + `${Math.ceil(minimumDurationSeconds)} seconds, or leaving the length on Auto so the `
          + `model picks one from the words, would give them room. Generate anyway if you want to `
          + `hear what it does.`,
      })
    } else if (density < SPARSE_SYLLABLES_PER_SECOND && targetSeconds > 60) {
      problems.push({
        code: 'SPARSE', severity: 'warning',
        message: `${syllables} syllables across ${Math.round(targetSeconds)} seconds is `
          + `${density.toFixed(2)} a second. Most of this song will be instrumental.`,
      })
    }
  }

  const sungText = script.sections.flatMap((section) => section.lines).join('\n')
  const detectedLanguage = sungLines > 0 ? detect(sungText) : language
  if (sungLines > 0 && detectedLanguage !== language) {
    problems.push({
      code: 'LANGUAGE_MISMATCH', severity: 'warning',
      message: `The lyrics read as ${detectedLanguage} but the request says ${language}. `
        + 'ACE-Step pronounces the sheet in the language it is told, so the words may come out '
        + 'with the wrong accent or the wrong vowels.',
    })
  }

  if (sungLines >= 8 && !hasChorus && script.sections.some((section) => section.kind !== 'verse')) {
    problems.push({
      code: 'NO_CHORUS', severity: 'warning',
      message: 'No section is tagged as a chorus, so nothing in the sheet is marked to return. '
        + 'ACE-Step uses the tags to shape the form.',
    })
  }

  const dominant = sections.find((section) => section.share > 0.8 && sections.length > 1)
  if (dominant) {
    problems.push({
      code: 'UNBALANCED_SECTION', severity: 'warning',
      message: `"${dominant.label}" holds ${Math.round(dominant.share * 100)}% of the words. `
        + 'The other sections will be near-empty.',
    })
  }

  return {
    text: script.payload,
    script,
    language,
    detectedLanguage,
    sungLines,
    syllables,
    sections,
    density,
    minimumDurationSeconds,
    hasChorus,
    problems,
    // A conflict is not an error. The request is still sendable and the person
    // decides whether to send it.
    singable: !problems.some((problem) => problem.severity === 'error'),
  }
}
