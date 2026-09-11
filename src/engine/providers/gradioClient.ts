/**
 * A client for the queue protocol a Gradio app serves its event handlers over.
 *
 * Transport only. Nothing here knows what the app does — no model names, no
 * lyrics, no idea that the result is a song. It turns "call this endpoint with
 * these inputs" into Gradio's own request sequence, reports what the queue says
 * while it waits, and hands back the outputs or a typed reason there are none.
 *
 * The protocol is `sse_v3`, read from Gradio 6.2.0's source rather than
 * inferred from traffic:
 *
 *   GET  /config                              the app's endpoints, by name
 *   POST {api_prefix}/queue/join              {data, fn_index, session_hash} -> {event_id}
 *   GET  {api_prefix}/queue/data?session_hash=...   an SSE stream of `data: {json}`
 *
 * The simpler `/call/{api_name}` route exists too and is deliberately not used.
 * On failure it sends `event: error` with `data: null`: `error_payload()` puts
 * the message under `error`, and the route forwards only `output.data`. For a
 * hosted GPU that is fatal to usability, because "your free quota is spent, try
 * again in 1:23:45" is exactly the kind of failure that arrives that way.
 */

/** The protocol this client speaks; any other is refused rather than misread. */
export const GRADIO_PROTOCOL = 'sse_v3'

/**
 * Gradio sends a heartbeat after 15 seconds of silence (`heartbeat_rate = 15`
 * in `routes.py`), so a stream that has said nothing for four times that long
 * is not slow — it is gone.
 */
export const DEFAULT_HEARTBEAT_TIMEOUT_MS = 60_000

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000

/* ------------------------------------------------------------ errors --- */

/** The app answered a request with an HTTP error. */
export class GradioHttpError extends Error {
  constructor(message: string, readonly status: number, readonly detail?: string) {
    super(message)
    this.name = 'GradioHttpError'
  }
}

/** A request never got an answer: the host is unreachable, or refused the browser. */
export class GradioNetworkError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'GradioNetworkError'
  }
}

/** Something arrived that does not fit the protocol. */
export class GradioProtocolError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GradioProtocolError'
  }
}

/**
 * The event handler itself raised. `title` and `appMessage` are what Gradio's
 * `error_payload()` put in the message, verbatim; `appMessage` is null when the
 * app raised something other than `gr.Error` without `show_error` enabled.
 */
export class GradioAppError extends Error {
  constructor(message: string, readonly title: string | null, readonly appMessage: string | null) {
    super(message)
    this.name = 'GradioAppError'
  }
}

/** The queue itself failed, outside the handler. */
export class GradioUnexpectedError extends Error {
  constructor(message: string, readonly sessionNotFound: boolean) {
    super(message)
    this.name = 'GradioUnexpectedError'
  }
}

/** The result stream went quiet or ended before the job finished. */
export class GradioConnectionLostError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'GradioConnectionLostError'
  }
}

/** The caller aborted. The job may still run on the app; there is no way to know. */
export class GradioCancelledError extends Error {
  constructor() {
    super('The Gradio request was cancelled.')
    this.name = 'GradioCancelledError'
  }
}

/* ------------------------------------------------------------ shapes --- */

export interface GradioDependency {
  id: number
  api_name?: string | false | null
}

export interface GradioAppConfig {
  version?: string
  protocol?: string
  api_prefix?: string
  dependencies?: GradioDependency[]
}

/** Where to send a call, resolved from `/config`. */
export interface GradioEndpoint {
  apiName: string
  fnIndex: number
  apiPrefix: string
  version: string
}

/** A file output. Gradio fills `url` itself; `path` is what it falls back on. */
export interface GradioFileData {
  path?: string
  url?: string | null
  size?: number | null
  orig_name?: string | null
  mime_type?: string | null
}

export interface GradioProgressUnit {
  index?: number | null
  length?: number | null
  unit?: string | null
  progress?: number | null
  desc?: string | null
}

/**
 * Every message `/queue/data` can send before the one that ends the job, as
 * Gradio 6.2.0's `server_messages.py` defines them.
 */
export type GradioStatusMessage =
  | { msg: 'estimation'; event_id?: string; rank?: number | null; queue_size?: number; rank_eta?: number | null }
  | { msg: 'process_starts'; event_id?: string; eta?: number | null }
  | { msg: 'progress'; event_id?: string; progress_data?: GradioProgressUnit[] }
  | { msg: 'log'; event_id?: string; log: string; level?: string; title?: string }
  | { msg: 'process_generating' | 'process_streaming'; event_id?: string }

export interface GradioSubmission {
  eventId: string
  /** The handler's outputs, in the order the app declared them. */
  data: unknown[]
}

export interface GradioClientOptions {
  /** The app's own origin, e.g. `https://owner-space.hf.space`. */
  baseUrl: string
  fetchImpl?: typeof fetch
  /** For `/config` and `/queue/join`, which answer quickly or not at all. */
  requestTimeoutMs?: number
  /** How long the result stream may stay completely silent. */
  heartbeatTimeoutMs?: number
  /** Injectable so tests can see which session a stream belongs to. */
  sessionHash?: () => string
}

/* ----------------------------------------------------------- helpers --- */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function newSessionHash(): string {
  const cryptoApi = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
  if (cryptoApi?.randomUUID) return cryptoApi.randomUUID().replace(/-/g, '')
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`
}

/** What a FastAPI error body says, in one line. */
async function readDetail(response: Response): Promise<string | undefined> {
  const text = await response.text()
  if (!text) return undefined
  try {
    const body = JSON.parse(text) as unknown
    if (isRecord(body) && 'detail' in body) {
      return typeof body.detail === 'string' ? body.detail : JSON.stringify(body.detail)
    }
  } catch {
    // Not JSON: an HTML error page from the host rather than the app. Its
    // first line is still more useful than nothing, so fall through to it.
  }
  return text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200) || undefined
}

/**
 * An incremental Server-Sent Events parser.
 *
 * Follows the WHATWG framing rules — lines end in LF, CRLF or CR; `data:` lines
 * accumulate; a blank line dispatches — because a chunk boundary can fall
 * anywhere, including between the CR and LF of one line ending.
 */
export class SseParser {
  private buffer = ''
  private data: string[] = []
  private pendingCr = false

  /** Feeds one decoded chunk; returns the payloads it completed. */
  push(chunk: string): string[] {
    const events: string[] = []
    let text = chunk
    if (this.pendingCr && text.startsWith('\n')) text = text.slice(1)
    this.pendingCr = false
    this.buffer += text

    for (;;) {
      const match = /\r\n|\r|\n/.exec(this.buffer)
      if (!match) break
      // A CR at the very end may be the first half of a CRLF split across chunks.
      if (match[0] === '\r' && match.index === this.buffer.length - 1) {
        this.pendingCr = true
      }
      const line = this.buffer.slice(0, match.index)
      this.buffer = this.buffer.slice(match.index + match[0].length)
      this.line(line, events)
    }
    return events
  }

  /** Flushes an event the stream ended in the middle of. */
  end(): string[] {
    const events: string[] = []
    if (this.buffer) this.line(this.buffer, events)
    this.buffer = ''
    if (this.data.length > 0) {
      events.push(this.data.join('\n'))
      this.data = []
    }
    return events
  }

  private line(line: string, events: string[]): void {
    if (line === '') {
      if (this.data.length > 0) events.push(this.data.join('\n'))
      this.data = []
      return
    }
    if (line.startsWith(':')) return
    const colon = line.indexOf(':')
    const field = colon < 0 ? line : line.slice(0, colon)
    let value = colon < 0 ? '' : line.slice(colon + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    if (field === 'data') this.data.push(value)
  }
}

/* ------------------------------------------------------------ client --- */

export class GradioClient {
  readonly baseUrl: string
  private readonly fetchImpl: typeof fetch
  private readonly requestTimeoutMs: number
  private readonly heartbeatTimeoutMs: number
  private readonly sessionHash: () => string

  constructor(options: GradioClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '')
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis)
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    this.heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS
    this.sessionHash = options.sessionHash ?? newSessionHash
  }

  /**
   * One request with its own timeout, linked to the caller's signal.
   *
   * Tells the three ways it can end apart — the caller gave up, the request
   * timed out, the network failed — because each means something different to
   * the person waiting.
   */
  private async fetchWithTimeout(url: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
    if (signal?.aborted) throw new GradioCancelledError()
    const controller = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; controller.abort() }, this.requestTimeoutMs)
    const onAbort = () => controller.abort()
    signal?.addEventListener('abort', onAbort)
    try {
      return await this.fetchImpl(url, { ...init, signal: controller.signal })
    } catch (error) {
      if (signal?.aborted) throw new GradioCancelledError()
      if (timedOut) {
        throw new GradioNetworkError(
          `${url} did not answer within ${Math.round(this.requestTimeoutMs / 1000)} seconds.`, { cause: error })
      }
      throw new GradioNetworkError(
        `Could not reach ${new URL(url).host}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error })
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
  }

  /** Resolves a named endpoint from the app's live configuration. */
  async endpoint(apiName: string, signal?: AbortSignal): Promise<GradioEndpoint> {
    const response = await this.fetchWithTimeout(`${this.baseUrl}/config`, { method: 'GET' }, signal)
    if (!response.ok) {
      throw new GradioHttpError(
        `The app returned HTTP ${response.status} for its configuration.`,
        response.status, await readDetail(response))
    }
    let config: unknown
    try {
      config = await response.json()
    } catch {
      throw new GradioProtocolError(
        `The app did not return a Gradio configuration (got ${response.headers.get('content-type') ?? 'no content type'}).`)
    }
    if (!isRecord(config)) throw new GradioProtocolError('The app returned a configuration that is not an object.')
    const app = config as GradioAppConfig
    if (app.protocol !== GRADIO_PROTOCOL) {
      throw new GradioProtocolError(
        `The app speaks Gradio protocol "${String(app.protocol)}", and this client speaks "${GRADIO_PROTOCOL}".`)
    }
    const dependency = (Array.isArray(app.dependencies) ? app.dependencies : [])
      .find((candidate) => isRecord(candidate) && candidate.api_name === apiName)
    if (!dependency || typeof dependency.id !== 'number') {
      throw new GradioProtocolError(`The app has no endpoint named "${apiName}".`)
    }
    return {
      apiName,
      fnIndex: dependency.id,
      apiPrefix: typeof app.api_prefix === 'string' ? app.api_prefix.replace(/\/+$/, '') : '',
      version: typeof app.version === 'string' ? app.version : 'unknown',
    }
  }

  /**
   * Submits one call and waits for its outputs.
   *
   * Exactly one `/queue/join` per call. Nothing here retries: a job that was
   * queued once and failed was a job, and joining again would be a second one.
   */
  async submit(
    endpoint: GradioEndpoint,
    data: readonly unknown[],
    options: { onMessage?: (message: GradioStatusMessage) => void; signal?: AbortSignal } = {},
  ): Promise<GradioSubmission> {
    const { onMessage, signal } = options
    const sessionHash = this.sessionHash()
    const api = `${this.baseUrl}${endpoint.apiPrefix}`

    const joined = await this.fetchWithTimeout(`${api}/queue/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        data, event_data: null, fn_index: endpoint.fnIndex, trigger_id: null, session_hash: sessionHash,
      }),
    }, signal)
    if (!joined.ok) {
      const detail = await readDetail(joined)
      throw new GradioHttpError(
        `The app refused the call with HTTP ${joined.status}${detail ? `: ${detail}` : '.'}`, joined.status, detail)
    }
    let eventId: unknown
    try {
      const body = await joined.json() as unknown
      eventId = isRecord(body) ? body.event_id : undefined
    } catch {
      throw new GradioProtocolError('The app accepted the call but did not say which job it became.')
    }
    if (typeof eventId !== 'string' || !eventId) {
      throw new GradioProtocolError('The app accepted the call but did not say which job it became.')
    }

    const outputs = await this.stream(
      `${api}/queue/data?session_hash=${encodeURIComponent(sessionHash)}`, eventId, onMessage, signal)
    return { eventId, data: outputs }
  }

  /**
   * Reads the result stream until the job ends.
   *
   * Two timers watch it and mean different things: the caller's signal (a
   * person or an overall budget giving up) and the heartbeat watchdog (the
   * connection itself dying). Only the second is decided here.
   */
  private async stream(
    url: string,
    eventId: string,
    onMessage: ((message: GradioStatusMessage) => void) | undefined,
    signal: AbortSignal | undefined,
  ): Promise<unknown[]> {
    if (signal?.aborted) throw new GradioCancelledError()
    const controller = new AbortController()
    let silent = false
    let watchdog: ReturnType<typeof setTimeout> | undefined
    const arm = () => {
      if (watchdog !== undefined) clearTimeout(watchdog)
      watchdog = setTimeout(() => { silent = true; controller.abort() }, this.heartbeatTimeoutMs)
    }
    const onAbort = () => controller.abort()
    signal?.addEventListener('abort', onAbort)

    const lost = (cause?: unknown) => new GradioConnectionLostError(
      `The connection to the app went silent for ${Math.round(this.heartbeatTimeoutMs / 1000)} seconds `
      + '(no heartbeat), so it is treated as lost. The job may still finish on the app, but this page '
      + 'can no longer receive it.', { cause })

    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
    try {
      arm()
      let response: Response
      try {
        response = await this.fetchImpl(url, {
          method: 'GET', headers: { Accept: 'text/event-stream' }, signal: controller.signal,
        })
      } catch (error) {
        if (signal?.aborted) throw new GradioCancelledError()
        if (silent) throw lost(error)
        throw new GradioConnectionLostError(
          `Could not open the result stream: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error })
      }
      if (!response.ok) {
        throw new GradioHttpError(
          `The app returned HTTP ${response.status} for the result stream.`,
          response.status, await readDetail(response))
      }
      if (!response.body) throw new GradioProtocolError('The result stream had no body.')

      reader = response.body.getReader()
      const decoder = new TextDecoder()
      const parser = new SseParser()

      for (;;) {
        let chunk: ReadableStreamReadResult<Uint8Array>
        try {
          chunk = await reader.read()
        } catch (error) {
          if (signal?.aborted) throw new GradioCancelledError()
          if (silent) throw lost(error)
          throw new GradioConnectionLostError(
            `The result stream broke: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
        }
        arm()
        const payloads = chunk.done
          ? parser.end()
          : parser.push(decoder.decode(chunk.value, { stream: true }))

        for (const payload of payloads) {
          const outputs = this.handle(payload, eventId, onMessage)
          if (outputs) return outputs
        }
        if (chunk.done) {
          throw new GradioConnectionLostError('The result stream ended before the job finished.')
        }
      }
    } finally {
      if (watchdog !== undefined) clearTimeout(watchdog)
      signal?.removeEventListener('abort', onAbort)
      // Release the connection once the answer is in; all that is left on it is
      // `close_stream`. By the time this runs the outcome has already been
      // decided and returned or thrown above, so a stream that refuses to be
      // cancelled — because it already broke — has nothing left to report.
      if (reader) void reader.cancel().catch(() => { /* outcome already settled; see above */ })
    }
  }

  /**
   * One message. Returns the outputs when it ends the job successfully, throws
   * when it ends it otherwise, and returns undefined for everything else.
   */
  private handle(
    payload: string,
    eventId: string,
    onMessage: ((message: GradioStatusMessage) => void) | undefined,
  ): unknown[] | undefined {
    let message: unknown
    try {
      message = JSON.parse(payload)
    } catch {
      throw new GradioProtocolError('A message on the result stream was not JSON.')
    }
    if (!isRecord(message) || typeof message.msg !== 'string') {
      throw new GradioProtocolError('A message on the result stream had no type.')
    }
    // This session only ever holds this one job, but the protocol allows more.
    if (typeof message.event_id === 'string' && message.event_id !== eventId) return undefined

    switch (message.msg) {
      case 'heartbeat':
        return undefined
      case 'process_completed': {
        const output = isRecord(message.output) ? message.output : {}
        if (message.success === true) {
          if (!Array.isArray(output.data)) {
            throw new GradioProtocolError('The app finished the job but sent no outputs.')
          }
          return output.data
        }
        const title = typeof message.title === 'string' ? message.title : null
        const appMessage = typeof output.error === 'string' ? output.error : null
        throw new GradioAppError(
          appMessage ?? (title ? `${title}.` : 'The app reported an error without details.'), title, appMessage)
      }
      case 'unexpected_error':
        throw new GradioUnexpectedError(
          typeof message.message === 'string' ? message.message : 'The app\'s queue failed.',
          message.session_not_found === true)
      case 'Server stopped unexpectedly.':
        throw new GradioUnexpectedError('The app stopped unexpectedly.', false)
      case 'close_stream':
        throw new GradioConnectionLostError('The app closed the result stream before the job finished.')
      case 'estimation':
      case 'process_starts':
      case 'progress':
      case 'log':
      case 'process_generating':
      case 'process_streaming':
        onMessage?.(message as GradioStatusMessage)
        return undefined
      default:
        // A message type newer than this client. It cannot end the job — those
        // are all handled above — so it is informational, and ignoring it is
        // the protocol's own forward-compatibility rule.
        return undefined
    }
  }

  /**
   * The address of a file output.
   *
   * Gradio fills `url` itself as `{root}{api_prefix}/file={path}`; when a
   * payload carries only `path`, the same address is built the same way.
   */
  fileUrl(file: GradioFileData, endpoint: GradioEndpoint): string {
    if (typeof file.url === 'string' && file.url) return new URL(file.url, `${this.baseUrl}/`).href
    if (typeof file.path === 'string' && file.path) return `${this.baseUrl}${endpoint.apiPrefix}/file=${file.path}`
    throw new GradioProtocolError('The file output had neither a url nor a path.')
  }

  /**
   * Downloads a file output — only from this app.
   *
   * The address comes from the app's response, so it is checked before it is
   * fetched: a result pointing anywhere else is not this app's output.
   */
  async download(url: string, signal?: AbortSignal): Promise<Blob> {
    if (new URL(url).origin !== new URL(this.baseUrl).origin) {
      throw new GradioProtocolError(`The app pointed at a file on another site (${new URL(url).host}).`)
    }
    if (signal?.aborted) throw new GradioCancelledError()
    let response: Response
    try {
      response = await this.fetchImpl(url, { method: 'GET', ...(signal ? { signal } : {}) })
    } catch (error) {
      if (signal?.aborted) throw new GradioCancelledError()
      throw new GradioNetworkError(
        `Could not download the file: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
    }
    if (!response.ok) {
      throw new GradioHttpError(
        `The app returned HTTP ${response.status} for the file.`, response.status, await readDetail(response))
    }
    return await response.blob()
  }
}
