/**
 * ACE-Step 1.5 on a Hugging Face ZeroGPU Space, as a music generation provider.
 *
 * The Space (`poc/zerogpu-space/app.py`) is the one place that turns a request
 * into ACE-Step settings: it appends the vocal gender to the caption, swaps the
 * lyric sheet for the instrumental marker, turns on the language model, and
 * refuses to run on a substituted model. This provider does none of that. It
 * sends the six inputs the Space's `/generate_music` endpoint declares, exactly
 * as the studio holds them, and then checks the answer against what was asked.
 *
 * The contract, as the live Space reports it at `/gradio_api/info`:
 *
 *   style: str, lyrics: str, language: str,
 *   vocal_gender: "male" | "female" | "mixed", instrumental: bool, duration: int
 *     -> (audio file, metadata JSON)
 *
 * Two durations are involved and they are not the same thing. `duration` here
 * is the length of the song. The Space's `@spaces.GPU(duration=80)` is how many
 * seconds of GPU one request may occupy. The validated 271-second song took
 * about 45 of them.
 *
 * `seed`, `model` and `lmModel` are not inputs of the endpoint. The Space draws
 * its own seed — the one it used comes back in the result's metadata — and runs
 * the models it was deployed with, which is why the models are checked in the
 * answer rather than requested.
 */

import {
  GradioAppError, GradioCancelledError, GradioClient, GradioConnectionLostError,
  GradioHttpError, GradioNetworkError, GradioProtocolError, GradioUnexpectedError,
  type GradioEndpoint, type GradioFileData, type GradioStatusMessage,
} from './gradioClient'
import { describeAudio } from './audioCheck'
import {
  ACE_STEP_DURATION_RANGE, DEFAULT_MODELS, DEFAULT_VOCAL_LANGUAGE, lyricLines, normalizeLyrics,
} from './aceStepRequest'
import { spaceUrlProblem, zeroGpuConfig, type ZeroGpuConfig } from './config'
import {
  EngineUnavailableError, GenerationCancelledError, QuotaExceededError,
  type GenerateOptions, type GenerationStatus, type MusicGenerationRequest,
  type MusicGenerationResult, type NeuralMusicProvider, type NeuralProviderStatus,
} from './types'

export const ZEROGPU_PROVIDER_ID = 'ace-step-zerogpu'

/** The endpoint the Space declares; ours to name, so it is not guessed. */
export const ZEROGPU_API_NAME = 'generate_music'

export const ZEROGPU_UNAVAILABLE_MESSAGE =
  'Neural music engine is unavailable. The ZeroGPU Space on Hugging Face did not answer — '
  + 'it may be asleep or restarting. Try again in a minute, or switch to Offline Procedural Mode.'

/**
 * Why a ZeroGPU generation produced no song, for the failures that are neither
 * "the engine is not there" (`EngineUnavailableError`), "the quota is spent"
 * (`QuotaExceededError`) nor "the caller stopped" (`GenerationCancelledError`).
 */
export type ZeroGpuErrorCode =
  | 'illegal-duration'
  | 'generation-failed'
  | 'unexpected-error'
  | 'http-error'
  | 'bad-result'
  | 'missing-audio'
  | 'timeout'

export class ZeroGpuError extends Error {
  constructor(readonly code: ZeroGpuErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'ZeroGpuError'
  }
}

/** The Space's `vocal_gender` values, from its `gr.Dropdown` choices. */
export type ZeroGpuVocalGender = 'male' | 'female' | 'mixed'

/** `/generate_music`'s inputs, in the order the Space declares them. */
export type ZeroGpuInputs = [
  style: string,
  lyrics: string,
  language: string,
  vocalGender: ZeroGpuVocalGender,
  instrumental: boolean,
  duration: number,
]

/** What was sent, kept so the answer can be checked against it. */
export interface ZeroGpuRequestPlan {
  data: ZeroGpuInputs
  duration: number
  language: string
  instrumental: boolean
  /** Sung lines in the sheet, section tags excluded — what the Space counts too. */
  lyricLineCount: number
  model: string
  lmModel: string
}

const minutes = (seconds: number) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`

/**
 * The song length to ask the Space for, in whole seconds.
 *
 * Auto — no duration, or the studio's 0 — becomes the configured Auto length
 * rather than a request for the Space to choose: that path has never been run
 * on the Space, and a hosted GPU is no place to find out what it does. Every
 * other value is checked before anything is sent, so a request that cannot be
 * served costs no quota.
 */
export function resolveZeroGpuDuration(
  requested: number | undefined,
  config: Pick<ZeroGpuConfig, 'autoDuration' | 'maxDuration'>,
): number {
  if (requested !== undefined && (!Number.isFinite(requested) || requested < 0)) {
    throw new ZeroGpuError('illegal-duration', `A song length of ${requested} seconds is not a length.`)
  }
  const wanted = requested && requested > 0 ? Math.round(requested) : config.autoDuration
  const { min, max } = ACE_STEP_DURATION_RANGE
  if (wanted < min || wanted > max) {
    throw new ZeroGpuError('illegal-duration',
      `ACE-Step makes songs from ${min} to ${max} seconds long; ${wanted} seconds is outside that.`)
  }
  if (config.maxDuration !== undefined && wanted > config.maxDuration) {
    throw new ZeroGpuError('illegal-duration',
      `Songs on the ZeroGPU backend are limited to ${minutes(config.maxDuration)} on this site; `
      + `${minutes(wanted)} was asked for.`)
  }
  return wanted
}

/**
 * The studio's vocal gender, as the Space's dropdown spells it.
 *
 * The Space appends "<gender> lead vocal" to the caption for `male` and
 * `female`, and nothing for `mixed`. So Auto travels as `mixed`: it adds
 * nothing, and the style's own words decide, which is what Auto means.
 */
export function zeroGpuVocalGender(gender: MusicGenerationRequest['vocalGender']): ZeroGpuVocalGender {
  return gender === 'male' || gender === 'female' ? gender : 'mixed'
}

/**
 * The style to send, so that the voice asked for is the voice the caption asks for.
 *
 * The Space adds "<gender> lead vocal" unless the caption already contains
 * that gender — but it checks with Python's substring `in`
 * (`if vocal_gender not in caption.lower()` in `app.py`). "male" is a substring
 * of "female" and of "malevolent", so a Male choice on "soft female vocal" or
 * "malevolent trap" would be dropped without a word. The Space is not ours to
 * change here, so the correct check is made on this side: when the gender is
 * present only inside another word, the Space's own hint is appended now, in
 * the Space's own format, and its substring check then finds it and adds
 * nothing. In every other case the style goes exactly as written.
 */
export function zeroGpuStyle(style: string, gender: ZeroGpuVocalGender, instrumental: boolean): string {
  if (instrumental || gender === 'mixed') return style
  const onlyInsideAnotherWord = style.toLowerCase().includes(gender)
    && !new RegExp(`\\b${gender}\\b`, 'i').test(style)
  if (!onlyInsideAnotherWord) return style
  // `caption.rstrip(',; ')` then `f"{caption}, {vocal_gender} lead vocal"` in the Space.
  return `${style.trim().replace(/[,; ]+$/, '')}, ${gender} lead vocal`
}

/** Builds the six inputs, and the record of them the result is checked against. */
export function planZeroGpuRequest(
  request: MusicGenerationRequest,
  config: Pick<ZeroGpuConfig, 'autoDuration' | 'maxDuration' | 'model' | 'lmModel'>,
): ZeroGpuRequestPlan {
  const duration = resolveZeroGpuDuration(request.duration, config)
  // The same normalisation the Space applies on arrival — line endings to LF,
  // trailing blank run dropped — so what it counts is what was counted here.
  // No line, tag or character within a line is touched.
  const lyrics = normalizeLyrics(request.lyrics)
  const language = request.language ?? DEFAULT_VOCAL_LANGUAGE
  const instrumental = request.instrumental === true
  const vocalGender = zeroGpuVocalGender(request.vocalGender)
  return {
    data: [zeroGpuStyle(request.style, vocalGender, instrumental), lyrics, language, vocalGender, instrumental, duration],
    duration,
    language,
    instrumental,
    lyricLineCount: lyricLines(lyrics).length,
    model: request.model ?? config.model ?? DEFAULT_MODELS.model,
    lmModel: request.lmModel ?? config.lmModel ?? DEFAULT_MODELS.lmModel,
  }
}

/** The metadata fields the Space reports that the result is checked against. */
interface SpaceMetadata {
  loaded_model?: unknown
  loaded_lm_model?: unknown
  lyric_lines_sent?: unknown
  vocal_language?: unknown
  instrumental?: unknown
  requested_audio_duration_s?: unknown
  seed?: unknown
}

/** Readable text from a message that may carry HTML, as ZeroGPU's can. */
const plain = (text: string | null | undefined) =>
  (text ?? '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()

/**
 * How far short of the requested length a song may come and still be the song
 * that was asked for. A few seconds, or two percent: ACE-Step hit 271 exactly
 * in the validation run, so this allows for rounding, not for a clip.
 */
const durationTolerance = (seconds: number) => Math.max(2, seconds * 0.02)

export interface ZeroGpuProviderOptions {
  config?: ZeroGpuConfig
  fetchImpl?: typeof fetch
  requestTimeoutMs?: number
  heartbeatTimeoutMs?: number
  /** Injectable so tests can see which session a stream belongs to. */
  sessionHash?: () => string
  /** Injectable so a result can be turned into a URL outside a browser. */
  toObjectUrl?: (blob: Blob) => string
}

export class ZeroGpuProvider implements NeuralMusicProvider {
  readonly id = ZEROGPU_PROVIDER_ID
  readonly name = 'ACE-Step 1.5 (ZeroGPU)'
  readonly type = 'neural' as const
  readonly backend = 'zerogpu' as const
  readonly description = 'Neural full-song generation on a free Hugging Face ZeroGPU Space.'

  readonly baseUrl: string
  readonly blockedReason: string | undefined
  readonly autoDuration: number

  private readonly config: ZeroGpuConfig
  /** Absent exactly when `blockedReason` is set: a Space that cannot be called gets no client. */
  private readonly client: GradioClient | undefined
  private readonly toObjectUrl: (blob: Blob) => string

  constructor(options: ZeroGpuProviderOptions = {}) {
    this.config = options.config ?? zeroGpuConfig()
    this.baseUrl = this.config.spaceUrl
    // A configuration built by hand (in a test, say) can omit the address
    // without saying so; the parser never lets that through unexplained.
    this.blockedReason = this.config.blockedReason
      ?? (this.config.spaceUrl ? undefined : spaceUrlProblem(undefined, 'https:'))
    this.autoDuration = this.config.autoDuration
    this.client = this.blockedReason ? undefined : new GradioClient({
      baseUrl: this.config.spaceUrl,
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      ...(options.requestTimeoutMs !== undefined ? { requestTimeoutMs: options.requestTimeoutMs } : {}),
      ...(options.heartbeatTimeoutMs !== undefined ? { heartbeatTimeoutMs: options.heartbeatTimeoutMs } : {}),
      ...(options.sessionHash ? { sessionHash: options.sessionHash } : {}),
    })
    this.toObjectUrl = options.toObjectUrl ?? ((blob) => URL.createObjectURL(blob))
  }

  /** A real round trip to the Space's configuration, which costs no GPU. */
  async isAvailable(): Promise<boolean> {
    return (await this.status()).connected
  }

  /**
   * Whether the Space answers and still has the endpoint this provider calls.
   * When it does not, `detail` says what went wrong instead of dropping it.
   */
  async status(): Promise<NeuralProviderStatus> {
    if (!this.client) return { connected: false, ...(this.blockedReason ? { blockedReason: this.blockedReason } : {}) }
    try {
      await this.client.endpoint(ZEROGPU_API_NAME)
      return { connected: true }
    } catch (error) {
      return { connected: false, detail: this.unreachable(error) }
    }
  }

  async generate(request: MusicGenerationRequest, options: GenerateOptions = {}): Promise<MusicGenerationResult> {
    const { onStatus, signal } = options
    const report = (status: GenerationStatus) => onStatus?.(status)

    const client = this.client
    if (!client) {
      throw new EngineUnavailableError(this.id, `Neural music engine is unavailable. ${this.blockedReason ?? ''}`.trim())
    }
    if (signal?.aborted) throw new GenerationCancelledError()

    // Everything that can be wrong with the request is found here, before a
    // single byte goes to the Space or a second of anyone's GPU quota is spent.
    const plan = planZeroGpuRequest(request, this.config)

    // One budget for the whole job — queue, cold start, generation, download —
    // kept apart from the caller's own signal so the two can be told apart.
    const job = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; job.abort() }, this.config.jobTimeoutMs)
    const onAbort = () => job.abort()
    signal?.addEventListener('abort', onAbort)

    try {
      report({ state: 'initializing', detail: 'Reaching the ZeroGPU Space' })
      let endpoint: GradioEndpoint
      try {
        endpoint = await client.endpoint(ZEROGPU_API_NAME, job.signal)
      } catch (error) {
        throw this.failure(error, { timedOut, stage: 'connect' })
      }

      report({ state: 'queued', detail: 'Submitting to the ZeroGPU Space' })
      let started = false
      let submission
      try {
        submission = await client.submit(endpoint, plan.data, {
          signal: job.signal,
          onMessage: (message) => {
            const status = this.statusFor(message, started)
            if (status.state === 'generating') started = true
            report(status)
          },
        })
      } catch (error) {
        throw this.failure(error, { timedOut, stage: 'generate' })
      }

      const { file, metadata } = this.readOutputs(submission.data)
      this.check(metadata, plan)

      report({ state: 'generating', detail: 'Downloading the song' })
      let blob: Blob
      try {
        blob = await client.download(client.fileUrl(file, endpoint), job.signal)
      } catch (error) {
        throw this.failure(error, { timedOut, stage: 'download' })
      }

      // A response body is not a song. This says whether what came back is a
      // readable, non-empty, non-silent audio file of the length asked for —
      // and nothing about whether it is any good, which only listening says.
      const audio = await describeAudio(blob)
      if (!audio.valid) {
        throw new ZeroGpuError('bad-result', `The Space returned something that is not usable audio: ${audio.problem}.`)
      }
      // The Space writes WAV (`soundfile` in its app.py). `describeAudio` lets a
      // container it cannot parse through as "unmeasured", which suits a backend
      // that might send MP3 — but from this one it means the bytes are not its
      // song, however long the metadata says the song is. So the length that
      // counts is the one measured from the file's own header, and a file with
      // no readable header is refused.
      if (!(audio.durationSeconds > 0)) {
        throw new ZeroGpuError('bad-result',
          'The Space returned a file that is not a readable WAV, so it cannot be shown as the song.')
      }
      const duration = audio.durationSeconds
      if (duration < plan.duration - durationTolerance(plan.duration)) {
        throw new ZeroGpuError('bad-result',
          `Asked for a ${minutes(plan.duration)} song and received ${minutes(Math.round(duration))}. `
          + 'A shortened song is not the song that was asked for.')
      }

      const seed = typeof metadata.seed === 'number' ? metadata.seed
        : typeof metadata.seed === 'string' && /^\d+$/.test(metadata.seed) ? Number(metadata.seed) : undefined

      report({ state: 'completed', detail: 'Song generated' })
      return {
        id: submission.eventId,
        engine: 'ace-step',
        audioUrl: this.toObjectUrl(blob),
        duration,
        ...(audio.sampleRate ? { sampleRate: audio.sampleRate } : {}),
        metadata: {
          model: plan.model,
          lmModel: plan.lmModel,
          ...(seed !== undefined ? { seed } : {}),
          language: plan.language,
          style: request.style,
        },
      }
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
  }

  /** A queue message, in the words the Space actually used. */
  private statusFor(message: GradioStatusMessage, started: boolean): GenerationStatus {
    const state: GenerationStatus['state'] = started ? 'generating' : 'queued'
    switch (message.msg) {
      case 'estimation':
        return {
          state: 'queued',
          detail: 'Waiting in the Space\'s queue',
          // Gradio's rank is zero-based: rank 0 is next in line.
          ...(typeof message.rank === 'number' ? { queuePosition: message.rank + 1 } : {}),
        }
      case 'process_starts':
        return { state: 'generating', detail: 'Generating on the GPU' }
      case 'log': {
        const text = plain(message.log)
        return { state, ...(text ? { detail: text } : {}) }
      }
      case 'progress': {
        const unit = message.progress_data?.[0]
        const fraction = typeof unit?.progress === 'number' ? unit.progress
          : typeof unit?.index === 'number' && typeof unit.length === 'number' && unit.length > 0
            ? unit.index / unit.length : undefined
        return {
          state: 'generating',
          ...(unit?.desc ? { detail: plain(unit.desc) } : {}),
          ...(fraction !== undefined && fraction > 0 ? { progress: Math.min(1, fraction) } : {}),
        }
      }
      case 'process_generating':
      case 'process_streaming':
        return { state: 'generating' }
    }
  }

  /** The two outputs, or the reason they are not usable. */
  private readOutputs(data: unknown[]): { file: GradioFileData; metadata: SpaceMetadata } {
    if (data.length < 2) {
      throw new ZeroGpuError('bad-result', `The Space returned ${data.length} output(s); its endpoint declares two.`)
    }
    const [file, metadataText] = data
    if (file === null || file === undefined) {
      throw new ZeroGpuError('missing-audio', 'The Space finished but returned no audio file.')
    }
    if (typeof file !== 'object' || Array.isArray(file)) {
      throw new ZeroGpuError('bad-result', 'The Space returned an audio output that is not a file.')
    }
    const record = file as Record<string, unknown>
    const url = typeof record.url === 'string' ? record.url : undefined
    const path = typeof record.path === 'string' ? record.path : undefined
    if (!url && !path) throw new ZeroGpuError('missing-audio', 'The Space returned an audio output with no file in it.')

    if (typeof metadataText !== 'string') {
      throw new ZeroGpuError('bad-result', 'The Space returned no generation metadata.')
    }
    let metadata: unknown
    try {
      metadata = JSON.parse(metadataText)
    } catch (error) {
      throw new ZeroGpuError('bad-result', 'The Space returned generation metadata that is not JSON.', { cause: error })
    }
    if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) {
      throw new ZeroGpuError('bad-result', 'The Space returned generation metadata that is not an object.')
    }
    return { file: { ...(url ? { url } : {}), ...(path ? { path } : {}) }, metadata: metadata as SpaceMetadata }
  }

  /**
   * The Space's account of what it did, checked against what was asked.
   *
   * The Space already refuses to run on a substituted model; this is the same
   * rule enforced a second time, at the other end, from what it reports — plus
   * proof that the whole lyric sheet, the language, the instrumental choice and
   * the length arrived as sent.
   */
  private check(metadata: SpaceMetadata, plan: ZeroGpuRequestPlan): void {
    const wrong = (what: string) => new ZeroGpuError('bad-result', what)
    if (typeof metadata.loaded_model !== 'string' || typeof metadata.loaded_lm_model !== 'string') {
      throw wrong('The Space did not report which models made the song, so it cannot be shown as theirs.')
    }
    if (metadata.loaded_model !== plan.model) {
      throw wrong(`The Space ran a different generation model than the one asked for: asked for ${plan.model}, `
        + `it ran ${metadata.loaded_model}.`)
    }
    if (metadata.loaded_lm_model !== plan.lmModel) {
      throw wrong(`The Space ran a different language model than the one asked for: asked for ${plan.lmModel}, `
        + `it ran ${metadata.loaded_lm_model}.`)
    }
    if (metadata.lyric_lines_sent !== plan.lyricLineCount) {
      throw wrong(`The Space received ${String(metadata.lyric_lines_sent)} lyric lines; ${plan.lyricLineCount} were sent.`)
    }
    if (metadata.vocal_language !== plan.language) {
      throw wrong(`The Space sang in "${String(metadata.vocal_language)}"; "${plan.language}" was asked for.`)
    }
    if (metadata.instrumental !== plan.instrumental) {
      throw wrong(plan.instrumental
        ? 'An instrumental was asked for, and the Space made a sung song.'
        : 'A sung song was asked for, and the Space made an instrumental.')
    }
    if (metadata.requested_audio_duration_s !== plan.duration) {
      throw wrong(`The Space was asked for ${String(metadata.requested_audio_duration_s)} seconds; `
        + `${plan.duration} were sent.`)
    }
  }

  /** A failure from the transport, as the error the studio knows how to show. */
  private failure(error: unknown, context: { timedOut: boolean; stage: 'connect' | 'generate' | 'download' }): Error {
    if (error instanceof GradioCancelledError) {
      if (context.timedOut) {
        return new ZeroGpuError('timeout',
          `The ZeroGPU Space did not finish within ${Math.round(this.config.jobTimeoutMs / 60_000)} minutes, `
          + 'so this page stopped waiting. The song may still finish on the Space.')
      }
      return new GenerationCancelledError()
    }
    if (error instanceof GradioAppError) return this.appFailure(error)
    if (error instanceof GradioUnexpectedError) {
      return new ZeroGpuError('unexpected-error', `The Space's queue failed: ${plain(error.message)}`, { cause: error })
    }
    if (context.stage === 'connect') {
      return new EngineUnavailableError(this.id, `${ZEROGPU_UNAVAILABLE_MESSAGE} (${this.unreachable(error)})`)
    }
    if (error instanceof GradioConnectionLostError) {
      return new EngineUnavailableError(this.id, `Neural music engine is unavailable. ${error.message}`)
    }
    if (error instanceof GradioHttpError) {
      const verb = context.stage === 'download' ? 'Could not download the song' : 'The Space refused the request'
      const hint = error.status === 422 ? ' Its inputs no longer match what this site sends.' : ''
      return new ZeroGpuError('http-error',
        `${verb} (HTTP ${error.status}${error.detail ? `: ${error.detail}` : ''}).${hint}`, { cause: error })
    }
    if (error instanceof GradioNetworkError) {
      return context.stage === 'download'
        ? new ZeroGpuError('http-error', `Could not download the song. ${error.message}`, { cause: error })
        : new EngineUnavailableError(this.id, `Neural music engine is unavailable. ${error.message}`)
    }
    if (error instanceof GradioProtocolError) {
      return new ZeroGpuError('bad-result', `The Space answered in a way this site does not understand: ${error.message}`,
        { cause: error })
    }
    return error instanceof Error ? error : new Error(String(error))
  }

  /**
   * An error the Space's own code raised, sorted by the title ZeroGPU gives it.
   *
   * The titles are the ones `spaces` 0.51.3 passes to its `error()` helper. The
   * message is passed on as the Space wrote it, because ZeroGPU's own wording —
   * "60s requested vs. 30s left. Try again in 1:23:45." — says exactly what a
   * person needs to know and nothing here could improve on it.
   */
  private appFailure(error: GradioAppError): Error {
    const text = plain(error.appMessage)
    switch (error.title) {
      case 'ZeroGPU quota exceeded':
      case 'ZeroGPU pending credits exceeded':
        return new QuotaExceededError(this.id,
          `The free GPU allowance on Hugging Face is used up for now. ${text || 'Try again later.'}`)
      case 'ZeroGPU illegal duration':
        return new ZeroGpuError('illegal-duration',
          `Hugging Face would not give this request enough GPU time. ${text}`.trim())
      case 'ZeroGPU worker error':
        if (/GPU task aborted/i.test(text)) {
          return new ZeroGpuError('illegal-duration',
            'ZeroGPU stopped the generation because it ran past the GPU time the Space allows one request. '
            + 'A shorter song is more likely to fit.')
        }
        return new ZeroGpuError('generation-failed', `ZeroGPU could not run the generation: ${text}`)
      case 'ZeroGPU queue timeout':
        return new ZeroGpuError('timeout', `Waited too long for a free GPU on Hugging Face. ${text}`.trim())
      default:
        return new ZeroGpuError('generation-failed', text
          ? `The Space could not generate the song: ${text}`
          : 'The Space reported that the generation failed, without saying why.')
    }
  }

  /** Why the Space could not be reached, in one line. */
  private unreachable(error: unknown): string {
    if (error instanceof GradioHttpError) {
      return `the Space answered HTTP ${error.status}${error.detail ? `: ${error.detail}` : ''}`
    }
    if (error instanceof Error) return error.message
    return String(error)
  }
}
