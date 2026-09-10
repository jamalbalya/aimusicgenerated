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

import { AceStepClient, ACE_STATUS, parseResultItems, type AceStepResultItem } from './aceStepClient'
import { buildAceStepTask, DEFAULT_MODELS, type AceStepModelChoice } from './aceStepRequest'
import { neuralEngineConfig } from './config'
import {
  EngineUnavailableError, GenerationCancelledError,
  type GenerateOptions, type MusicGenerationProvider,
  type MusicGenerationRequest, type MusicGenerationResult,
} from './types'

export const ACE_STEP_PROVIDER_ID = 'ace-step'

const POLL_INTERVAL_MS = 1500
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
    this.models = options.models ?? DEFAULT_MODELS
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
    connected: boolean; loadedModel?: string; loadedLmModel?: string; blockedReason?: string
  }> {
    if (this.blockedReason) return { connected: false, blockedReason: this.blockedReason }
    try {
      const health = await this.client.health()
      const connected = health.status?.toLowerCase() === 'ok'
      return {
        connected,
        ...(health.loaded_model ? { loadedModel: health.loaded_model } : {}),
        ...(health.loaded_lm_model ? { loadedLmModel: health.loaded_lm_model } : {}),
      }
    } catch {
      return { connected: false }
    }
  }

  async generate(
    request: MusicGenerationRequest, options: GenerateOptions = {},
  ): Promise<MusicGenerationResult> {
    const { onStatus, signal } = options
    const report = (status: Parameters<NonNullable<GenerateOptions['onStatus']>>[0]) => onStatus?.(status)

    report({ state: 'initializing', detail: 'Reaching the neural music engine' })
    if (!(await this.isAvailable())) {
      throw new EngineUnavailableError(
        this.id,
        this.blockedReason
          ? `Neural music engine is unavailable. ${this.blockedReason}`
          : 'Neural music engine is unavailable. You can start the ACE-Step backend or switch to Offline Procedural Mode.',
      )
    }

    const body = buildAceStepTask(request, this.models)
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

    const duration = Number(item.metas?.duration ?? request.duration ?? 0)
    report({ state: 'completed', detail: 'Song generated' })
    return {
      id: created.task_id,
      engine: 'ace-step',
      audioUrl: this.toObjectUrl(blob),
      duration,
      metadata: {
        model: body.model ?? this.models.model,
        lmModel: body.lm_model_path ?? this.models.lmModel,
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

    for (;;) {
      if (signal?.aborted) throw new GenerationCancelledError()
      if (Date.now() > deadline) {
        throw new Error('ACE-Step did not finish within the time allowed for a job.')
      }

      const query = await this.client.queryResult(taskId, signal)
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
