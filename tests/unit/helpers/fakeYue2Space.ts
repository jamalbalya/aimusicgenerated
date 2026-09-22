/**
 * A fake YuE2 Space speaking Gradio 6.2.0's queue protocol.
 *
 * Nothing here reaches Hugging Face, so no test spends a second of ZeroGPU
 * quota. The framing follows the same protocol the ACE-Step fake already
 * speaks — `/config`, `queue/join`, `queue/data`, `file=` — because the client
 * under test is the same `GradioClient`.
 *
 * The endpoint signature is the contract `yue2Provider` expects and which has
 * NOT been verified against the running Space. Should a live check correct it,
 * this fake is one of the two places to change, the other being the constants
 * in `yue2Provider.ts`.
 */

import { Yue2Provider, YUE2_API_NAME, type Yue2ProviderOptions } from '../../../src/engine/providers'

export const YUE2_SPACE_URL = 'https://jamalbalya-auralyn-yue2.hf.space'
export const YUE2_API_PREFIX = '/gradio_api'
export const YUE2_EVENT_ID = 'yue2-event-1'

export const YUE2_CONFIG = {
  version: '6.2.0',
  protocol: 'sse_v3',
  api_prefix: YUE2_API_PREFIX,
  root: YUE2_SPACE_URL,
  dependencies: [{ id: 0, api_name: YUE2_API_NAME }],
}

const file = (name: string) => ({
  path: `/tmp/gradio/abc/${name}`,
  url: `${YUE2_SPACE_URL}${YUE2_API_PREFIX}/file=/tmp/gradio/abc/${name}`,
  size: 1234,
  orig_name: name,
  mime_type: null,
  meta: { _type: 'gradio.FileData' },
})

export const MP3_FILE = file('song.mp3')
export const FLAC_FILE = file('song.flac')

export const completed = (data: unknown[] = [MP3_FILE, FLAC_FILE]) => ({
  msg: 'process_completed', event_id: YUE2_EVENT_ID,
  output: { data, is_generating: false, duration: 180, average_duration: 180 },
  success: true, title: null,
})

/** `process_completed` for a handler that raised, as `error_payload()` builds it. */
export const failed = (title: string | null, error: string | null) => ({
  msg: 'process_completed', event_id: YUE2_EVENT_ID,
  output: { error, ...(title ? { title, duration: 1, visible: true } : {}) },
  success: false, title: title ?? 'Error',
})

export const STARTS = { msg: 'process_starts', event_id: YUE2_EVENT_ID, eta: 180 }
export const CLOSE = { msg: 'close_stream', event_id: null }

export const sse = (messages: unknown[]) =>
  messages.map((message) => `data: ${JSON.stringify(message)}\n\n`)

export const SUCCESS_STREAM = sse([
  { msg: 'estimation', event_id: YUE2_EVENT_ID, rank: 1, queue_size: 1, rank_eta: 20 },
  STARTS,
  completed(),
  CLOSE,
])

type Reply = Response | (() => Response)

export interface Yue2Script {
  config?: Reply
  join?: Reply
  stream?: string[]
  streamReply?: Reply
  /** Leave the stream open after the last chunk, as a dropped connection does. */
  hang?: boolean
  file?: Reply
}

export interface RecordedCall { method: string; url: string; body?: unknown }

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

const reply = (value: Reply | undefined, fallback: () => Response) =>
  value === undefined ? fallback() : typeof value === 'function' ? value() : value

/** A `fetch` that is the Space. Records every call, so a test can count them. */
export function fakeYue2Space(script: Yue2Script = {}) {
  const calls: RecordedCall[] = []
  const api = `${YUE2_SPACE_URL}${YUE2_API_PREFIX}`

  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as unknown : undefined
    calls.push({ method, url, ...(body !== undefined ? { body } : {}) })

    if (url === `${YUE2_SPACE_URL}/config`) return reply(script.config, () => json(YUE2_CONFIG))
    if (url === `${api}/queue/join`) return reply(script.join, () => json({ event_id: YUE2_EVENT_ID }))
    if (url.startsWith(`${api}/queue/data?session_hash=`)) {
      if (script.streamReply !== undefined) return reply(script.streamReply, () => json({}))
      const encoder = new TextEncoder()
      const chunks = script.stream ?? SUCCESS_STREAM
      const signal = init?.signal
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
          if (script.hang) {
            signal?.addEventListener('abort', () =>
              controller.error(new DOMException('The operation was aborted.', 'AbortError')))
          } else {
            controller.close()
          }
        },
      })
      return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
    }
    if (url.startsWith(`${api}/file=`)) {
      return reply(script.file, () => new Response(new Uint8Array([1, 2, 3, 4]), {
        status: 200, headers: { 'Content-Type': 'audio/mpeg' },
      }))
    }
    return new Response('not found', { status: 404 })
  }) as typeof fetch

  return {
    fetchImpl,
    calls,
    /** How many generation POSTs were made. The number this suite cares about. */
    joins: () => calls.filter((c) => c.url.endsWith('/queue/join') && c.method === 'POST').length,
    joinBody: () => calls.find((c) => c.url.endsWith('/queue/join'))?.body as
      { data?: unknown[] } | undefined,
    downloads: () => calls.filter((c) => c.url.includes('/file=')).length,
  }
}

/** A provider wired to the fake, with live generation permitted. */
export function yue2(script: Yue2Script = {}, options: Yue2ProviderOptions = {}) {
  const server = fakeYue2Space(script)
  const provider = new Yue2Provider({
    config: { spaceUrl: YUE2_SPACE_URL, jobTimeoutMs: 60_000, liveGeneration: true },
    fetchImpl: server.fetchImpl,
    sessionHash: () => 'yue2-session',
    toObjectUrl: (blob) => `blob:yue2/${blob.size}`,
    ...options,
  })
  return { server, provider }
}
