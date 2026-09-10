/**
 * A typed client for the ACE-Step 1.5 HTTP API.
 *
 * The shapes here are the ones the server actually sends, taken from
 * github.com/ACE-Step/ace-step-1.5 at commit ca1e85f — in particular
 * `acestep/api_server.py` for the response envelope and
 * `acestep/api/http/query_result_service.py` for the result payload. Two
 * details of that contract are easy to get wrong and are handled explicitly:
 *
 *   - every response is wrapped in `{data, code, error, timestamp}`;
 *   - `/query_result` returns `result` as a JSON-encoded *string*, not an
 *     object, so it has to be parsed a second time.
 *
 * The server exposes no cancellation endpoint. That is a fact about ACE-Step
 * rather than an omission here, and `AceStepProvider` says so to the user
 * instead of pretending a job stopped.
 */

import type { AceStepTaskBody } from './aceStepRequest'

/** Status codes ACE-Step uses; `queued` and `running` share 0. */
export const ACE_STATUS = { processing: 0, success: 1, failed: 2 } as const

export interface AceStepEnvelope<T> {
  data: T
  code: number
  error: string | null
  timestamp?: number
}

export interface AceStepHealth {
  status: string
  service: string
  version: string
  models_initialized: boolean
  llm_initialized: boolean
  loaded_model: string | null
  loaded_lm_model: string | null
}

export interface AceStepTaskCreated {
  task_id: string
  status: string
  queue_position?: number
}

/** One entry of the JSON-encoded `result` string. */
export interface AceStepResultItem {
  file?: string
  wave?: string
  status?: number
  create_time?: number
  prompt?: string
  lyrics?: string
  progress?: number
  stage?: string
  error?: string | null
  metas?: {
    bpm?: number | null
    duration?: number | null
    genres?: string
    keyscale?: string
    timesignature?: string
  }
}

export interface AceStepQueryItem {
  task_id: string
  result: string
  status: number
  progress_text?: string
}

export class AceStepApiError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message)
    this.name = 'AceStepApiError'
  }
}

export interface AceStepClientOptions {
  baseUrl: string
  /** Sent as `Authorization: Bearer` when the server sets ACESTEP_API_KEY. */
  apiKey?: string
  /** Injectable so tests can drive the client without a network. */
  fetchImpl?: typeof fetch
  /** How long any single request may take. */
  timeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 30_000

export class AceStepClient {
  private readonly baseUrl: string
  private readonly apiKey: string | undefined
  private readonly fetchImpl: typeof fetch
  private readonly timeoutMs: number

  constructor(options: AceStepClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '')
    this.apiKey = options.apiKey
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis)
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  /** Absolute URL for a path the server returned, which may be relative. */
  resolve(path: string): string {
    if (/^https?:\/\//i.test(path)) return path
    return `${this.baseUrl}${path.startsWith('/') ? '' : '/'}${path}`
  }

  private headers(json: boolean): Record<string, string> {
    const headers: Record<string, string> = {}
    if (json) headers['Content-Type'] = 'application/json'
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`
    return headers
  }

  private async request<T>(
    path: string, init: RequestInit, signal?: AbortSignal,
  ): Promise<T> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    const onAbort = () => controller.abort()
    signal?.addEventListener('abort', onAbort)
    try {
      const response = await this.fetchImpl(this.resolve(path), { ...init, signal: controller.signal })
      if (!response.ok) {
        throw new AceStepApiError(
          `ACE-Step returned ${response.status} for ${path}.`, response.status)
      }
      const envelope = await response.json() as AceStepEnvelope<T>
      if (envelope && typeof envelope === 'object' && 'data' in envelope) {
        if (envelope.error) throw new AceStepApiError(envelope.error)
        return envelope.data
      }
      // A response that is not wrapped is not this API.
      throw new AceStepApiError(`Unexpected response from ${path}.`)
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
  }

  health(signal?: AbortSignal): Promise<AceStepHealth> {
    return this.request<AceStepHealth>('/health', { method: 'GET', headers: this.headers(false) }, signal)
  }

  createTask(body: AceStepTaskBody, signal?: AbortSignal): Promise<AceStepTaskCreated> {
    return this.request<AceStepTaskCreated>('/release_task', {
      method: 'POST',
      headers: this.headers(true),
      body: JSON.stringify(body),
    }, signal)
  }

  async queryResult(taskId: string, signal?: AbortSignal): Promise<AceStepQueryItem | null> {
    const items = await this.request<AceStepQueryItem[]>('/query_result', {
      method: 'POST',
      headers: this.headers(true),
      body: JSON.stringify({ task_id_list: [taskId] }),
    }, signal)
    return items.find((item) => item.task_id === taskId) ?? items[0] ?? null
  }

  /** Downloads a finished file from the path `/query_result` handed back. */
  async fetchAudio(path: string, signal?: AbortSignal): Promise<Blob> {
    const response = await this.fetchImpl(this.resolve(path), {
      method: 'GET', headers: this.headers(false), ...(signal ? { signal } : {}),
    })
    if (!response.ok) {
      throw new AceStepApiError(`Could not download the generated audio (${response.status}).`, response.status)
    }
    return await response.blob()
  }
}

/**
 * Unpacks the doubly-encoded `result` field.
 *
 * Returns an empty list rather than throwing: a task that has only just been
 * queued legitimately carries `"[]"`, and that is not an error.
 */
export function parseResultItems(item: AceStepQueryItem | null): AceStepResultItem[] {
  if (!item?.result) return []
  try {
    const parsed = JSON.parse(item.result) as unknown
    return Array.isArray(parsed) ? parsed as AceStepResultItem[] : []
  } catch {
    return []
  }
}
