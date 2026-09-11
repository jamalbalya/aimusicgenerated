/**
 * ACE-Step 1.5 as a music generation provider.
 *
 * The job is asynchronous on the server: `/release_task` queues it and returns
 * an id, and `/query_result` is polled until the status turns terminal. What
 * this provider reports back is what the server said — the queue position it
 * gave, the stage name it is in, the progress fraction if it published one —
 * and nothing else. There is no timer-driven bar here, because the one thing
 * worse than not knowing how long a wait is, is being told wrongly.
 *
 * ACE-Step has no cancellation endpoint. Aborting therefore stops the polling
 * and settles this promise; it does not stop the server, and `cancel` is left
 * off this provider rather than implemented as a lie.
 */

import {
  AceStepClient, ACE_STATUS, parseResultItems,
  type AceStepHealth, type AceStepResultItem,
} from './aceStepClient'
import { describeAudio, type AudioCheck } from './audioCheck'
import { buildAceStepTask, DEFAULT_MODELS, type AceStepModelChoice } from './aceStepRequest'
import { neuralEngineConfig } from './config'
import {
  EngineUnavailableError, GenerationCancelledError,
  type GenerateOptions, type MusicGenerationProvider,
  type MusicGenerationRequest, type MusicGenerationResult,
} from './types'

export const ACE_STEP_PROVIDER_ID = 'ace-step'

const POLL_INTERVAL_MS = 1500
/** Consecutive failed polls tolerated before a job is given up on. */
const MAX_POLL_FAILURES = 5
/** Long, because a full song on modest hardware genuinely takes minutes. */
const DEFAULT_JOB_TIMEOUT_MS = 30 * 60_000

export interface AceStepProviderOptions {
  baseUrl?: string
  apiKey?: string
  fetchImpl?: typeof fetch
  models?: AceStepModelChoice
  pollIntervalMs?: number
  jobTimeoutMs?: number
  /** Injectable so tests do not wait in real time. */
  sleep?: (ms: number) => Promise<void>
  /** Injectable so a result can be turned into a URL outside a browser. */
  toObjectUrl?: (blob: Blob) => string
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

export class AceStepProvider implements MusicGenerationProvider {
  readonly id = ACE_STEP_PROVIDER_ID
  readonly name = 'ACE-Step 1.5'
  readonly type = 'neural' as const
  readonly description = 'Neural full-song generation. Needs the ACE-Step backend running.'

  private readonly client: AceStepClient
  private readonly models: AceStepModelChoice
  private readonly pollIntervalMs: number
  private readonly jobTimeoutMs: number
  private readonly sleep: (ms: number) => Promise<void>
  private readonly toObjectUrl: (blob: Blob) => string
  readonly baseUrl: string
  /** Set when the browser cannot reach this backend at all; see the config. */
  readonly blockedReason: string | undefined

  constructor(options: AceStepProviderOptions = {}) {
    const config = neuralEngineConfig()
    this.baseUrl = options.baseUrl ?? config.baseUrl
    this.blockedReason = options.baseUrl ? undefined : config.blockedReason
    const apiKey = options.apiKey ?? config.apiKey
    this.client = new AceStepClient({
      baseUrl: this.baseUrl,
      ...(apiKey ? { apiKey } : {}),
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    })
    // A build may pin the models; otherwise the documented defaults apply.
    this.models = options.models ?? {
      model: config.model ?? DEFAULT_MODELS.model,
      lmModel: config.lmModel ?? DEFAULT_MODELS.lmModel,
    }
    this.pollIntervalMs = options.pollIntervalMs ?? POLL_INTERVAL_MS
    this.jobTimeoutMs = options.jobTimeoutMs ?? DEFAULT_JOB_TIMEOUT_MS
    this.sleep = options.sleep ?? wait
    this.toObjectUrl = options.toObjectUrl ?? ((blob) => URL.createObjectURL(blob))
  }

  /** A real round trip to the server, not a look at the configuration. */
  async isAvailable(): Promise<boolean> {
    if (this.blockedReason) return false
    try {
      const health = await this.client.health()
      return typeof health?.status === 'string' && health.status.toLowerCase() === 'ok'
    } catch {
      return false
    }
  }

  /** Health detail, for the connection indicator. */
  async status(): Promise<{
    connected: boolean
    loadedModel?: string
    loadedLmModel?: string
    lmInitialized?: boolean
    blockedReason?: string
  }> {
    if (this.blockedReason) return { connected: false, blockedReason: this.blockedReason }
    try {
      const health = await this.client.health()
      const connected = health.status?.toLowerCase() === 'ok'
      return {
        connected,
        lmInitialized: Boolean(health.llm_initialized),
        ...(health.loaded_model ? { loadedModel: health.loaded_model } : {}),
        ...(health.loaded_lm_model ? { loadedLmModel: health.loaded_lm_model } : {}),
      }
    } catch {
      return { connected: false }
    }
  }

  /**
   * Refuses a run whose models are not the ones that were asked for.
   *
   * ACE-Step substitutes on its own: `acestep/api/startup_llm_init.py` falls
   * back to a GPU-tier "recommended" language model when the requested one is
   * judged unsupported, and carries on with the LM unloaded when it fails to
   * initialise. Both are printed to the server's console and neither reaches
   * the client, so a run asked for on the 0.6B model can quietly come back
   * from the 1.7B one -- or from no language model at all, which for a request
   * with `thinking` set means the part that sings was never in the chain.
   *
   * The server publishes what it actually loaded, so this compares the two and
   * stops rather than accepting a song made by something else.
   */
  private verifyModels(health: AceStepHealth, body: ReturnType<typeof buildAceStepTask>): void {
    const wantedLm = body.lm_model_path
    const loadedLm = health.loaded_lm_model
    if (wantedLm && loadedLm && loadedLm !== wantedLm) {
      throw new Error(
        `ACE-Step loaded a different language model than the one requested: `
        + `asked for ${wantedLm}, the backend is running ${loadedLm}. `
        + `Start it with ACESTEP_LM_MODEL_PATH=${wantedLm} (./scripts/start-ace-step-macos.sh does this), `
        + `or set ACE_STEP_LM_MODEL to the model you actually want.`)
    }
    const wantedDit = body.model
    const loadedDit = health.loaded_model
    if (wantedDit && loadedDit && loadedDit !== wantedDit) {
      throw new Error(
        `ACE-Step loaded a different generation model than the one requested: `
        + `asked for ${wantedDit}, the backend is running ${loadedDit}.`)
    }
    if (body.thinking && health.models_initialized && !health.llm_initialized) {
      throw new Error(
        'ACE-Step has no language model loaded, so it cannot sing the lyrics: a request '
        + 'made with thinking enabled would come back instrumental. Check the backend log '
        + 'for why the LM failed to load.')
    }
  }

  async generate(
    request: MusicGenerationRequest, options: GenerateOptions = {},
  ): Promise<MusicGenerationResult> {
    const { onStatus, signal } = options
    const report = (status: Parameters<NonNullable<GenerateOptions['onStatus']>>[0]) => onStatus?.(status)

    report({ state: 'initializing', detail: 'Reaching the neural music engine' })
    let health: AceStepHealth
    try {
      if (this.blockedReason) throw new Error(this.blockedReason)
      health = await this.client.health()
      if (health.status?.toLowerCase() !== 'ok') throw new Error(`status "${health.status}"`)
    } catch {
      throw new EngineUnavailableError(
        this.id,
        this.blockedReason
          ? `Neural music engine is unavailable. ${this.blockedReason}`
          : 'Neural music engine is unavailable. You can start the ACE-Step backend or switch to Offline Procedural Mode.',
      )
    }

    const body = buildAceStepTask(request, this.models)
    // Before anything is queued: the models that will run must be the ones
    // that were asked for. A substituted model is a different result.
    this.verifyModels(health, body)
    const created = await this.client.createTask(body, signal)
    report({
      state: 'queued',
      detail: 'Waiting for the neural music engine',
      ...(created.queue_position ? { queuePosition: created.queue_position } : {}),
    })

    const item = await this.poll(created.task_id, report, signal)
    const file = item.file
    if (!file) throw new Error('ACE-Step finished but returned no audio file.')

    report({ state: 'generating', detail: 'Finalizing audio' })
    const blob = await this.client.fetchAudio(file, signal)

    // A response body is not a song. This says whether what came back is a
    // readable, non-empty, non-silent audio file -- and nothing whatever about
    // whether it is any good, which only listening establishes.
    const audio: AudioCheck = await describeAudio(blob)
    if (!audio.valid) {
      throw new Error(`ACE-Step returned something that is not usable audio: ${audio.problem}`)
    }

    const reported = Number(item.metas?.duration ?? 0)
    const duration = reported > 0 ? reported : audio.durationSeconds
    if (!(duration > 0)) {
      throw new Error('ACE-Step returned audio with no duration.')
    }

    report({ state: 'completed', detail: 'Song generated' })
    return {
      id: created.task_id,
      engine: 'ace-step',
      audioUrl: this.toObjectUrl(blob),
      duration,
      ...(audio.sampleRate ? { sampleRate: audio.sampleRate } : {}),
      metadata: {
        // What the backend said it loaded, falling back to what was asked for.
        model: health.loaded_model ?? body.model ?? this.models.model,
        lmModel: health.loaded_lm_model ?? body.lm_model_path ?? this.models.lmModel,
        ...(body.seed !== undefined ? { seed: body.seed } : {}),
        language: body.vocal_language,
        style: request.style,
        ...(item.metas?.bpm ? { bpm: Number(item.metas.bpm) } : {}),
        ...(item.metas?.keyscale ? { keyScale: item.metas.keyscale } : {}),
      },
    }
  }

  /**
   * Polls until the task reaches a terminal state.
   *
   * The stage and progress reported here come out of the task record; when the
   * server publishes neither, the caller is told the state and nothing more.
   */
  private async poll(
    taskId: string,
    report: (status: Parameters<NonNullable<GenerateOptions['onStatus']>>[0]) => void,
    signal?: AbortSignal,
  ): Promise<AceStepResultItem> {
    const deadline = Date.now() + this.jobTimeoutMs
    let announcedGenerating = false
    let consecutiveErrors = 0

    for (;;) {
      if (signal?.aborted) throw new GenerationCancelledError()
      if (Date.now() > deadline) {
        throw new Error('ACE-Step did not finish within the time allowed for a job.')
      }

      // A song takes minutes, and a dropped poll in the middle of one is not a
      // reason to abandon work the server is still doing. Transient failures
      // are retried; a backend that has genuinely gone away stops being
      // retried once it has failed several times in a row. Polling is a read,
      // so retrying it cannot start a second generation.
      let query
      try {
        query = await this.client.queryResult(taskId, signal)
        consecutiveErrors = 0
      } catch (error) {
        if (signal?.aborted) throw new GenerationCancelledError()
        consecutiveErrors++
        if (consecutiveErrors >= MAX_POLL_FAILURES) {
          const reason = error instanceof Error ? error.message : String(error)
          throw new Error(
            `Lost contact with ACE-Step while it was generating (${reason}). `
            + `The job may still be running on the backend as task ${taskId}.`,
            { cause: error })
        }
        report({ state: announcedGenerating ? 'generating' : 'queued', detail: 'Reconnecting to the backend' })
        await this.sleep(this.pollIntervalMs)
        continue
      }

      const items = parseResultItems(query)
      const first = items[0] ?? {}

      if (query?.status === ACE_STATUS.failed) {
        throw new Error(first.error || query.progress_text || 'ACE-Step failed to generate the song.')
      }
      if (query?.status === ACE_STATUS.success) return first

      const stage = first.stage ?? query?.progress_text
      const state = stage && stage !== 'queued' ? 'generating' : 'queued'
      if (state === 'generating') announcedGenerating = true
      report({
        state: announcedGenerating ? 'generating' : state,
        ...(stage ? { detail: stage } : {}),
        ...(typeof first.progress === 'number' && first.progress > 0
          ? { progress: Math.min(1, first.progress) }
          : {}),
      })

      await this.sleep(this.pollIntervalMs)
    }
  }
}
