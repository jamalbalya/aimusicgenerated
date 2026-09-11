/**
 * Turning a studio request into an ACE-Step one, without losing anything.
 *
 * ACE-Step takes a free-text caption and a free-text lyric sheet. That is
 * fortunate, because the two things most easily destroyed on the way to a
 * neural model are exactly those: a style reduced to a genre tag, and a lyric
 * sheet quietly trimmed, translated or re-spelled to suit a synthesiser.
 *
 * Everything here is deterministic and content-preserving. The style is passed
 * through whole. The lyrics are passed through byte for byte, section tags and
 * their qualifiers included, so that `[Chorus, Full Koplo]` still says
 * "full koplo" to the model. `verifyLyricsPreserved` exists so a test can prove
 * that rather than trust it.
 */

import type { MusicGenerationRequest } from './types'

/** The literal ACE-Step accepts in place of a lyric sheet for a backing track. */
export const INSTRUMENTAL_MARKER = '[inst]'

/** Fields of ACE-Step's `/release_task` body that this adapter sets. */
export interface AceStepTaskBody {
  prompt: string
  lyrics: string
  vocal_language: string
  audio_format: 'wav' | 'mp3' | 'flac'
  /** Use the 5 Hz language model to generate audio codes; needed for singing. */
  thinking: boolean
  /** Never true here: letting the LM rewrite the caption would rewrite lyrics. */
  use_format: boolean
  batch_size: number
  model?: string
  lm_model_path?: string
  audio_duration?: number
  seed?: number
  use_random_seed?: boolean
  inference_steps?: number
  guidance_scale?: number
}

const GENDER_STATED =
  /\b(male|female|man|woman|men|women|boy|girl|baritone|tenor|bass|soprano|alto|mezzo|falsetto|pria|wanita|cowok|cewek)\b/i

/**
 * A gender hint, appended only when the style does not already carry one.
 *
 * ACE-Step has no vocal-gender parameter — the caption is where a voice is
 * described. Appending is additive: it never removes or rewrites a word the
 * user wrote, and it stays out of the way entirely when they have already said
 * what they want.
 */
function withVocalGender(style: string, gender: MusicGenerationRequest['vocalGender']): string {
  if (!gender || gender === 'mixed') return style
  if (GENDER_STATED.test(style)) return style
  const trimmed = style.trimEnd().replace(/[,;]$/, '')
  return `${trimmed}, ${gender} lead vocal`
}

/**
 * Normalises line endings and strips a trailing blank run.
 *
 * This is the only change made to the lyric text, and it changes no character
 * of any line: CRLF becomes LF so the sheet is compared and hashed the same way
 * everywhere, and trailing blank lines go because they are not content.
 */
export function normalizeLyrics(lyrics: string): string {
  return lyrics.replace(/\r\n?/g, '\n').replace(/\s+$/, '')
}

/** Every `[...]` tag in a sheet, in order, with its qualifiers intact. */
export function structureTags(lyrics: string): string[] {
  return [...normalizeLyrics(lyrics).matchAll(/^\[([^\]]+)\]\s*$/gm)].map((match) => match[1]!.trim())
}

/** The sung lines of a sheet: everything that is not a section tag. */
export function lyricLines(lyrics: string): string[] {
  return normalizeLyrics(lyrics)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !/^\[[^\]]+\]$/.test(line))
}

export interface LyricPreservation {
  preserved: boolean
  /** Lines in the source that are missing from the adapted sheet. */
  missingLines: string[]
  /** Section tags in the source that are missing from the adapted sheet. */
  missingTags: string[]
}

/**
 * Proves the adapted sheet still contains every written line and tag.
 *
 * Used by the tests, and cheap enough to be worth running before a request
 * leaves the machine: silently dropping a verse is the kind of failure nobody
 * notices until they listen to the whole song.
 */
export function verifyLyricsPreserved(source: string, adapted: string): LyricPreservation {
  const sourceLines = lyricLines(source)
  const adaptedLines = new Set(lyricLines(adapted))
  const adaptedTags = new Set(structureTags(adapted))
  const missingLines = sourceLines.filter((line) => !adaptedLines.has(line))
  const missingTags = structureTags(source).filter((tag) => !adaptedTags.has(tag))
  return { preserved: missingLines.length === 0 && missingTags.length === 0, missingLines, missingTags }
}

export interface AceStepModelChoice {
  /** DiT checkpoint, e.g. `acestep-v15-turbo`. */
  model: string
  /** 5 Hz language model, e.g. `acestep-5Hz-lm-0.6B`. */
  lmModel: string
}

/** What the first milestone runs on; both are overridable per request. */
export const DEFAULT_MODELS: AceStepModelChoice = {
  model: 'acestep-v15-turbo',
  lmModel: 'acestep-5Hz-lm-0.6B',
}

/** The language a request with none is sung in, on every ACE-Step backend. */
export const DEFAULT_VOCAL_LANGUAGE = 'en'

/**
 * The song lengths ACE-Step 1.5 accepts in one request, in seconds.
 *
 * From ACE-Step's own `docs/en/API.md`: `audio_duration`, "range 10-600". What
 * a given host can afford to generate inside that range is a separate question,
 * answered by that host's configuration rather than here.
 */
export const ACE_STEP_DURATION_RANGE = { min: 10, max: 600 } as const

/**
 * Builds the `/release_task` body for one take.
 *
 * `thinking` is on because it is what puts the 5 Hz language model in the
 * chain, and that is what produces singing rather than a backing track.
 * `use_format` is off because it asks the model to rewrite the caption and the
 * lyrics, and the lyrics are the user's.
 */
export function buildAceStepTask(
  request: MusicGenerationRequest, models: AceStepModelChoice = DEFAULT_MODELS,
): AceStepTaskBody {
  const instrumental = request.instrumental === true
  const lyrics = instrumental ? INSTRUMENTAL_MARKER : normalizeLyrics(request.lyrics)

  const body: AceStepTaskBody = {
    prompt: instrumental ? request.style : withVocalGender(request.style, request.vocalGender),
    lyrics,
    vocal_language: request.language ?? DEFAULT_VOCAL_LANGUAGE,
    audio_format: 'wav',
    thinking: !instrumental,
    use_format: false,
    batch_size: 1,
    model: request.model ?? models.model,
    lm_model_path: request.lmModel ?? models.lmModel,
  }

  if (request.duration && request.duration > 0) body.audio_duration = request.duration
  if (request.seed !== undefined && request.seed >= 0) {
    body.seed = request.seed
    body.use_random_seed = false
  }
  return body
}
