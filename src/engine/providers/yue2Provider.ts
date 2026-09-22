/**
 * Provider B: YuE2, hosted as a Hugging Face ZeroGPU Space.
 *
 * This adapter is a client and nothing else. The model, its weights and every
 * heavy dependency stay in the Space; Auralyn installs none of them. What
 * happens here is: take the request Auralyn already validated, hand it to one
 * Gradio endpoint, and turn what comes back into a `MusicGenerationResult`.
 *
 * **The Space's contract is not verified from this environment.** Every attempt
 * to reach `huggingface.co` and `*.hf.space` is refused by the egress proxy
 * ("gateway answered 403 to CONNECT"), so `/gradio_api/info` has never been
 * read for this Space. The endpoint name, the argument order and the two
 * outputs below are therefore *expectations*, taken from what the Space was
 * built to do. They are written down once, here, so that a single live check
 * can confirm or correct them in one place instead of across the codebase —
 * and `YUE2_CONTRACT_VERIFIED` says plainly which it is.
 *
 * What the adapter does NOT do, deliberately:
 *
 *   - It does not touch the style. Not trimmed, not summarised, not rewritten,
 *     no genre inferred, no hidden instruction appended. Whatever Auralyn
 *     hands over is what the Space receives.
 *   - It does not transform the lyrics. `[End]` is already consumed upstream
 *     (`lyricScript.payload` is "the original, minus anything at or after the
 *     end marker"), so stripping it again here would be a second, invisible
 *     transformation of someone's words. Instead the adapter *checks* that the
 *     contract held and refuses loudly if it did not.
 *   - It never sends a second generation. See `generate`.
 */

import {
  GradioAppError, GradioClient, GradioConnectionLostError, GradioHttpError,
  GradioNetworkError, GradioProtocolError, type GradioEndpoint, type GradioFileData,
  type GradioStatusMessage,
} from './gradioClient'
import type { GenerationErrorCode, GenerationStage } from './failure'
import {
  AccountNotAllowedError, AuthenticationRequiredError, EngineUnavailableError,
  GenerationCancelledError, QuotaExceededError,
  type GenerateOptions, type GenerationStatus, type MusicGenerationRequest,
  type MusicGenerationResult, type NeuralMusicProvider, type NeuralProviderStatus,
} from './types'
import { parseQuotaNotice } from './zeroGpuQuota'

/* -------------------------------------------------------------- contract -- */

export const YUE2_PROVIDER_ID = 'yue2'

/** The Space this provider talks to, `owner/name` as Hugging Face spells it. */
export const YUE2_SPACE = 'Jamalbalya/auralyn-yue2'

/**
 * The endpoint's name as it appears in the Space's `/config`.
 *
 * Without a leading slash, which is not a detail. Gradio stores the bare name
 * in `/config` and publishes the route with the slash prepended, and
 * `GradioClient.endpoint` matches against the stored form. Verified on Gradio
 * 6.2.0: `api_name="generate_song"` publishes `/generate_song`, while
 * `api_name="/generate_song"` publishes `//generate_song`.
 */
export const YUE2_API_NAME = 'generate_song'

/** The same endpoint as a caller sees it documented. Display only. */
export const YUE2_API_ROUTE = `/${YUE2_API_NAME}`

/**
 * Whether the contract above has been confirmed against the running Space.
 *
 * False, and it must stay false until someone reads `/gradio_api/info` from a
 * network that can reach Hugging Face. It exists so that "we expect this" and
 * "we checked this" cannot be confused by anything reading this module.
 */
export const YUE2_CONTRACT_VERIFIED = false

/** Argument order for the endpoint. The Space's signature is (style, lyrics). */
export const YUE2_INPUT_ORDER = ['style', 'lyrics'] as const

/** Output positions. The Space returns (mp3, flac). */
export const YUE2_OUTPUT_MP3 = 0
export const YUE2_OUTPUT_FLAC = 1

/** `https://jamalbalya-auralyn-yue2.hf.space` for `Jamalbalya/auralyn-yue2`. */
export function yue2SpaceUrl(space: string = YUE2_SPACE): string {
  const [owner, name] = space.split('/')
  if (!owner || !name) throw new Error(`Not an owner/name Space id: "${space}"`)
  const host = `${owner}-${name}`.toLowerCase().replace(/[^a-z0-9-]/g, '-')
  return `https://${host}.hf.space`
}

export interface Yue2Config {
  /** The Space's host. Defaults to the one derived from `YUE2_SPACE`. */
  spaceUrl: string
  /** The outer bound on one generation: queue, cold start, download included. */
  jobTimeoutMs: number
  /**
   * Whether this build may actually ask the Space to generate.
   *
   * Off unless a build turns it on, exactly as the ACE-Step Space is gated. A
   * generation costs GPU seconds from someone's allowance, and a checkout on a
   * laptop or an automated run must not be able to spend them.
   */
  liveGeneration: boolean
}

export const YUE2_LIVE_GENERATION_DISABLED =
  'This build is not permitted to run YuE2 generations.'

export function yue2Config(overrides: Partial<Yue2Config> = {}): Yue2Config {
  return { spaceUrl: yue2SpaceUrl(), jobTimeoutMs: 900_000, liveGeneration: false, ...overrides }
}

/* -------------------------------------------------------------- capacity -- */

/**
 * What this provider knows about its own GPU allowance.
 *
 * Provider-specific on purpose: there is no global "remaining seconds" in
 * Auralyn and there must not be one, because two Spaces on two accounts have
 * two different allowances and a single number would be wrong for both.
 *
 * `unknown` is the honest default and currently the only state reachable
 * before a request: Hugging Face publishes no endpoint that reports a
 * remaining ZeroGPU allowance, so a provider that claimed to know would be
 * inventing it. `insufficient` is set only from a refusal the Space actually
 * sent, and carries that refusal's own numbers.
 */
export type Yue2CapacityState = 'unknown' | 'insufficient'

export interface Yue2Capacity {
  state: Yue2CapacityState
  /** Why it is in that state, in words. Never blank. */
  reason: string
  /** Only ever set from a refusal that stated it. Never estimated. */
  remainingSeconds?: number
  requestedSeconds?: number
}

export const YUE2_CAPACITY_UNKNOWN: Yue2Capacity = {
  state: 'unknown',
  reason: 'ZeroGPU publishes no way to read a remaining allowance before a '
    + 'request, so this is unknown rather than sufficient.',
}

/* --------------------------------------------------------------- errors --- */

export type Yue2ErrorCode =
  | 'contract-mismatch'
  | 'http-error'
  | 'illegal-duration'
  | 'generation-failed'
  | 'ambiguous-outcome'
  | 'bad-result'
  | 'missing-audio'
  | 'download-failed'
  | 'unexpected-error'

export interface Yue2ErrorContext {
  cause?: unknown
  stage?: GenerationStage
  failureCode?: GenerationErrorCode
  /**
   * Whether the Space had begun generating when this went wrong.
   *
   * The distinction the whole error surface exists for. A ZeroGPU quota
   * refusal happens *before* the decorated function runs, and calling that
   * "YuE2 generation failed" describes something that never started. False
   * means nothing was generated; true means it may have been, and a caller
   * must not assume the allowance was untouched.
   */
  generationStarted?: boolean
  details?: Record<string, string | number | boolean>
}

export class Yue2Error extends Error {
  readonly stage: GenerationStage | undefined
  readonly failureCode: GenerationErrorCode | undefined
  readonly generationStarted: boolean
  readonly details: Record<string, string | number | boolean> | undefined

  constructor(readonly code: Yue2ErrorCode, message: string, options: Yue2ErrorContext = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined)
    this.name = 'Yue2Error'
    this.stage = options.stage
    this.failureCode = options.failureCode
    this.generationStarted = options.generationStarted ?? false
    this.details = options.details
  }
}

/* ------------------------------------------------------------- the plan --- */

/** The two strings that go to the Space, and nothing else. */
export interface Yue2RequestPlan {
  style: string
  lyrics: string
  /** Positional arguments in the endpoint's declared order. */
  data: [string, string]
}

/** The end marker, which upstream has already consumed by the time we see it. */
const END_MARKER = /^\s*[[(]\s*end\s*[\])]\s*$/i

/**
 * Turns an Auralyn request into the Space's two arguments, changing neither.
 *
 * The only work here is refusing what must not be sent. In particular the
 * lyrics are checked for a surviving `[End]` rather than stripped: Auralyn's
 * lyric contract already removed it, so one arriving here means something
 * upstream broke, and quietly deleting it would hide that while also making
 * this the second place in the codebase that edits a person's words.
 */
export function planYue2Request(request: MusicGenerationRequest): Yue2RequestPlan {
  const style = request.style ?? ''
  const lyrics = request.lyrics ?? ''

  if (!style.trim()) {
    throw new Yue2Error('contract-mismatch', 'The style is empty; YuE2 needs one.',
      { stage: 'request', failureCode: 'UNKNOWN' })
  }
  if (!lyrics.trim()) {
    throw new Yue2Error('contract-mismatch', 'The lyrics are empty; YuE2 needs them.',
      { stage: 'request', failureCode: 'UNKNOWN' })
  }

  const stray = lyrics.split('\n').findIndex((line) => END_MARKER.test(line))
  if (stray >= 0) {
    throw new Yue2Error('contract-mismatch',
      `The lyrics still contain an end marker on line ${stray + 1}. Auralyn removes it `
      + 'before a provider sees them, so this request did not come through the lyric '
      + 'plan. Refusing rather than editing the words here.',
      { stage: 'request', failureCode: 'UNKNOWN', details: { line: stray + 1 } })
  }

  return { style, lyrics, data: [style, lyrics] }
}

/* ------------------------------------------------------------- provider --- */

export interface Yue2ProviderOptions {
  config?: Partial<Yue2Config>
  fetchImpl?: typeof fetch
  requestTimeoutMs?: number
  heartbeatTimeoutMs?: number
  sessionHash?: () => string
  authorization?: () => string | undefined
  toObjectUrl?: (blob: Blob) => string
}

export class Yue2Provider implements NeuralMusicProvider {
  readonly id = YUE2_PROVIDER_ID
  readonly name = 'YuE2'
  readonly type = 'neural' as const
  readonly backend = 'zerogpu' as const
  readonly description = 'Neural full-song generation on the YuE2 Hugging Face ZeroGPU Space.'

  readonly baseUrl: string
  readonly blockedReason: string | undefined
  /** YuE2 chooses its own length from the lyrics; nothing is pinned here. */
  readonly autoDuration: undefined

  private readonly config: Yue2Config
  private readonly client: GradioClient | undefined
  private readonly toObjectUrl: (blob: Blob) => string

  constructor(options: Yue2ProviderOptions = {}) {
    this.config = yue2Config(options.config ?? {})
    this.baseUrl = this.config.spaceUrl
    this.blockedReason = this.config.spaceUrl ? undefined : 'No YuE2 Space address is configured.'
    this.autoDuration = undefined
    this.client = this.blockedReason ? undefined : new GradioClient({
      baseUrl: this.config.spaceUrl,
      ...(options.authorization ? { authorization: options.authorization } : {}),
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      ...(options.requestTimeoutMs !== undefined ? { requestTimeoutMs: options.requestTimeoutMs } : {}),
      ...(options.heartbeatTimeoutMs !== undefined ? { heartbeatTimeoutMs: options.heartbeatTimeoutMs } : {}),
      ...(options.sessionHash ? { sessionHash: options.sessionHash } : {}),
    })
    this.toObjectUrl = options.toObjectUrl ?? ((blob) => URL.createObjectURL(blob))
  }

  async isAvailable(): Promise<boolean> {
    return (await this.status()).connected
  }

  /**
   * Whether the Space answers and declares the endpoint this provider calls.
   *
   * Reads `/config`, which costs no GPU. A `connected: false` here is always
   * accompanied by what went wrong, because "unavailable" on its own is the
   * least useful thing an interface can say.
   */
  async status(): Promise<NeuralProviderStatus> {
    if (!this.client) {
      return { connected: false, ...(this.blockedReason ? { blockedReason: this.blockedReason } : {}) }
    }
    try {
      await this.client.endpoint(YUE2_API_NAME)
      return { connected: true }
    } catch (error) {
      return { connected: false, detail: this.describe(error) }
    }
  }

  /**
   * What is known about the GPU allowance, which before a request is nothing.
   *
   * Deliberately not a guess and deliberately not global. See `Yue2Capacity`.
   */
  async capacity(): Promise<Yue2Capacity> {
    return YUE2_CAPACITY_UNKNOWN
  }

  /**
   * One Auralyn request, one Space generation. Never two.
   *
   * The guarantees, in the order they are enforced:
   *
   *   1. The ticket is spent before anything else, so a request refused later
   *      still consumes the press that authorised it and a caller holding one
   *      ticket cannot loop.
   *   2. There is exactly one `queue/join`. Nothing in this method or in
   *      `GradioClient` re-POSTs it, and no failure path leads back to it.
   *   3. An outcome that cannot be read — a stream that dies after the job
   *      started — raises `ambiguous-outcome` with `generationStarted: true`
   *      rather than trying again. Asking again would be the one thing that
   *      turns an uncertain charge into a certain double charge.
   */
  async generate(request: MusicGenerationRequest, options: GenerateOptions = {}): Promise<MusicGenerationResult> {
    const { onStatus, signal, ticket } = options
    const report = (status: GenerationStatus) => onStatus?.(status)

    if (!ticket) {
      throw new Yue2Error('contract-mismatch',
        'A YuE2 generation needs the request ticket minted by one press of Generate.',
        { stage: 'request', failureCode: 'UNKNOWN' })
    }
    ticket.spend()

    const client = this.client
    if (!client) {
      throw new EngineUnavailableError(this.id, `YuE2 is unavailable. ${this.blockedReason ?? ''}`.trim())
    }
    if (signal?.aborted) throw new GenerationCancelledError()
    if (!this.config.liveGeneration) {
      throw new EngineUnavailableError(this.id, YUE2_LIVE_GENERATION_DISABLED)
    }

    // Everything wrong with the request is found before a byte leaves.
    const plan = planYue2Request(request)

    const job = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; job.abort() }, this.config.jobTimeoutMs)
    const onAbort = () => job.abort()
    signal?.addEventListener('abort', onAbort)

    // Tracks whether the Space got as far as running the function, which is
    // what separates a quota refusal from a generation that failed.
    let started = false
    let eventId: string | undefined

    try {
      report({ state: 'initializing', detail: 'Reaching the YuE2 Space' })
      let endpoint: GradioEndpoint
      try {
        endpoint = await client.endpoint(YUE2_API_NAME, job.signal)
      } catch (error) {
        throw this.failure(error, { stage: 'connect', started, timedOut })
      }

      report({ state: 'queued', detail: 'Submitting to the YuE2 Space' })
      let submission
      try {
        submission = await client.submit(endpoint, plan.data, {
          signal: job.signal,
          onMessage: (message: GradioStatusMessage) => {
            if (message.msg === 'process_starts') started = true
            if ('event_id' in message && typeof message.event_id === 'string') {
              eventId = message.event_id
            }
            report(this.statusFor(message, started))
          },
        })
      } catch (error) {
        throw this.failure(error, { stage: started ? 'inference' : 'queue', started, timedOut, eventId })
      }

      const files = this.readOutputs(submission.data)

      report({ state: 'generating', detail: 'Downloading the song' })
      const urls: { format: string; url: string }[] = []
      for (const [format, file] of files) {
        let blob: Blob
        try {
          blob = await client.download(client.fileUrl(file, endpoint), job.signal)
        } catch (error) {
          throw this.failure(error, { stage: 'download', started: true, timedOut, eventId })
        }
        urls.push({ format, url: this.toObjectUrl(blob) })
      }

      const mp3 = urls.find((entry) => entry.format === 'mp3')
      if (!mp3) {
        throw new Yue2Error('missing-audio', 'The Space returned no MP3 to play.',
          { stage: 'result', failureCode: 'AUDIO_RESULT_FAILED', generationStarted: true })
      }
      const alternates = urls.filter((entry) => entry !== mp3)

      report({ state: 'completed', detail: 'Done' })
      return {
        id: submission.eventId || eventId || `${this.id}-${Date.now()}`,
        ticketId: ticket.id,
        engine: 'yue2',
        ...(submission.eventId ? { providerRequestId: submission.eventId } : {}),
        audioUrl: mp3.url,
        ...(alternates.length > 0 ? { alternateFormats: alternates } : {}),
        // Not measured here. YuE2 chooses the length and this adapter does not
        // decode the audio to find out what it chose; a number invented at this
        // layer would be worse than none.
        duration: 0,
        metadata: { style: plan.style, ...(request.language ? { language: request.language } : {}) },
      }
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
  }

  /** Gradio's queue messages, in the states the interface understands. */
  private statusFor(message: GradioStatusMessage, started: boolean): GenerationStatus {
    switch (message.msg) {
      case 'estimation':
        return {
          state: 'queued', detail: 'Waiting for a GPU',
          ...(typeof message.rank === 'number' ? { queuePosition: message.rank } : {}),
        }
      case 'process_starts':
        return { state: 'generating', detail: 'YuE2 is generating' }
      case 'log':
        return { state: started ? 'generating' : 'queued', detail: message.log }
      default:
        return { state: started ? 'generating' : 'queued' }
    }
  }

  /**
   * The Space's outputs, as (format, file) pairs in the declared order.
   *
   * Positional, because Gradio's outputs are. The positions live in
   * `YUE2_OUTPUT_MP3`/`YUE2_OUTPUT_FLAC` so that a live check which finds them
   * the other way round is a one-line correction.
   */
  private readOutputs(data: unknown[]): [string, GradioFileData][] {
    const expected = 2
    if (data.length < expected) {
      throw new Yue2Error('bad-result',
        `The Space returned ${data.length} output(s); this adapter expects ${expected} `
        + `(MP3 at ${YUE2_OUTPUT_MP3}, FLAC at ${YUE2_OUTPUT_FLAC}). `
        + 'That contract has not been verified against the running Space.',
        { stage: 'result', failureCode: 'RESULT_MISMATCH', generationStarted: true })
    }
    const out: [string, GradioFileData][] = []
    for (const [index, format] of [[YUE2_OUTPUT_MP3, 'mp3'], [YUE2_OUTPUT_FLAC, 'flac']] as const) {
      const file = this.asFile(data[index], format)
      if (file) out.push([format, file])
    }
    if (out.length === 0) {
      throw new Yue2Error('missing-audio', 'The Space finished but returned no audio file.',
        { stage: 'result', failureCode: 'AUDIO_RESULT_FAILED', generationStarted: true })
    }
    return out
  }

  private asFile(value: unknown, format: string): GradioFileData | undefined {
    if (value === null || value === undefined) return undefined
    if (typeof value !== 'object' || Array.isArray(value)) {
      throw new Yue2Error('bad-result', `The Space returned a ${format} output that is not a file.`,
        { stage: 'result', failureCode: 'RESULT_MISMATCH', generationStarted: true })
    }
    const record = value as Record<string, unknown>
    const url = typeof record.url === 'string' ? record.url : undefined
    const path = typeof record.path === 'string' ? record.path : undefined
    if (!url && !path) {
      throw new Yue2Error('missing-audio', `The Space returned a ${format} output with no file in it.`,
        { stage: 'result', failureCode: 'AUDIO_RESULT_FAILED', generationStarted: true })
    }
    return { ...(url ? { url } : {}), ...(path ? { path } : {}) }
  }

  /**
   * Turns a transport or Space failure into one this project can report.
   *
   * Everything the failure knew is kept: the HTTP status, the Space's own
   * words, the event id, and whether generation had started. A quota refusal
   * becomes a `QuotaExceededError` carrying ZeroGPU's own sentence, because
   * that sentence says what nothing here could work out — how much allowance
   * is left and when it returns.
   */
  private failure(
    error: unknown,
    context: { stage: 'connect' | 'queue' | 'inference' | 'download'; started: boolean; timedOut: boolean; eventId?: string },
  ): Error {
    const base = {
      generationStarted: context.started,
      details: {
        generationStarted: context.started,
        ...(context.eventId ? { requestId: context.eventId } : {}),
      },
    }

    if (error instanceof GenerationCancelledError) return error
    if (context.timedOut) {
      return new Yue2Error('ambiguous-outcome',
        'The YuE2 job passed this build\'s time limit before an outcome arrived. '
        + (context.started
          ? 'It had started generating, so it may still finish on the Space; nothing is sent again from here.'
          : 'It had not started generating.'),
        { ...base, cause: error, stage: 'stream', failureCode: 'GENERATION_TIMED_OUT' })
    }

    if (error instanceof GradioAppError) {
      const text = (error.appMessage ?? '').trim()
      // Keyed on ZeroGPU's own error titles, exactly as the ACE-Step provider
      // reads them. A quota refusal is raised *before* the decorated function
      // runs, so it is neither a generation that failed nor evidence that any
      // GPU time was spent: `generationStarted` stays false and the error type
      // says "allowance", not "failure".
      if (error.title === 'ZeroGPU quota exceeded'
          || error.title === 'ZeroGPU pending credits exceeded') {
        return new QuotaExceededError(this.id,
          `The free GPU allowance on Hugging Face is used up for now. ${text || 'Try again later.'}`,
          parseQuotaNotice(text))
      }
      if (error.title === 'ZeroGPU illegal duration') {
        // Not a generation that failed, and not an allowance that ran out.
        // `spaces` raises both from the same branch of `client.schedule()` and
        // tells them apart by the sign of the scheduler's `wait`: a negative
        // wait means no reset will ever cover this request, so the Space asked
        // for more GPU time than the visitor's tier can ever be granted. The
        // call is refused before a worker is spawned, so nothing ran.
        //
        // `generationStarted` is forced false rather than carried from
        // `context`. Gradio emits `process_starts` when it dequeues the event,
        // and `client.schedule()` is the first thing the decorated function
        // does — so `started` is true here while no GPU was ever allocated.
        // Reporting that as a started generation is exactly the lie the flag
        // exists to prevent.
        //
        // Sending the same request again cannot work; the stage says `request`
        // so that no retry is offered for it.
        return new Yue2Error('illegal-duration',
          `Hugging Face would not give this request enough GPU time. ${text}`.trim(),
          { ...base, cause: error, stage: 'request',
            failureCode: 'UNSUPPORTED_DURATION',
            generationStarted: false,
            details: {
              ...base.details,
              generationStarted: false,
              ...(error.title ? { spaceResponse: error.title } : {}),
            } })
      }
      return new Yue2Error('generation-failed',
        [error.title, text].filter(Boolean).join(': ') || 'The Space reported a failure.',
        { ...base, cause: error, stage: context.started ? 'inference' : 'queue',
          failureCode: 'INFERENCE_FAILED',
          details: { ...base.details, ...(error.title ? { spaceResponse: error.title } : {}) } })
    }

    if (error instanceof GradioHttpError) {
      if (error.status === 401) {
        return new AuthenticationRequiredError(this.id,
          `${error.detail || 'The Space would not accept this sign-in.'} (HTTP 401 from the Space.)`)
      }
      if (error.status === 403) {
        return new AccountNotAllowedError(this.id,
          `${error.detail || 'The Space does not serve this account.'} (HTTP 403 from the Space.)`)
      }
      const verb = context.stage === 'download' ? 'Could not download the song' : 'The Space refused the request'
      return new Yue2Error(context.stage === 'download' ? 'download-failed' : 'http-error',
        `${verb} (HTTP ${error.status}${error.detail ? `: ${error.detail}` : ''}).`,
        {
          ...base, cause: error,
          stage: context.stage === 'download' ? 'download' : 'queue',
          failureCode: context.stage === 'download' ? 'DOWNLOAD_FAILED' : 'QUEUE_SUBMISSION_FAILED',
          details: { ...base.details, httpStatus: error.status, ...(error.detail ? { spaceResponse: error.detail } : {}) },
        })
    }

    if (error instanceof GradioConnectionLostError) {
      // The job may be running on the Space with nobody listening. This is the
      // case that must never be answered by generating again.
      return new Yue2Error('ambiguous-outcome',
        `The connection to the Space was lost${context.started ? ' after generation started' : ''}. `
        + `${error.message} Nothing is sent again from here.`,
        { ...base, cause: error, stage: 'stream', failureCode: 'SSE_CONNECTION_FAILED' })
    }

    if (error instanceof GradioNetworkError) {
      return context.stage === 'download'
        ? new Yue2Error('download-failed', `Could not download the song. ${error.message}`,
            { ...base, cause: error, stage: 'download', failureCode: 'DOWNLOAD_FAILED' })
        : new EngineUnavailableError(this.id, `YuE2 is unavailable. ${error.message}`)
    }

    if (error instanceof GradioProtocolError) {
      return new Yue2Error('bad-result',
        `The Space answered in a way this adapter does not understand: ${error.message}`,
        { ...base, cause: error, stage: 'result', failureCode: 'RESULT_MISMATCH' })
    }

    return new Yue2Error('unexpected-error',
      error instanceof Error ? error.message : String(error),
      { ...base, cause: error, stage: 'unknown', failureCode: 'UNKNOWN' })
  }

  /** A short factual note for the connection indicator. Never a guess. */
  private describe(error: unknown): string {
    if (error instanceof GradioHttpError) {
      return `HTTP ${error.status}${error.detail ? `: ${error.detail}` : ''}`
    }
    if (error instanceof GradioProtocolError) return error.message
    return error instanceof Error ? error.message : String(error)
  }
}
