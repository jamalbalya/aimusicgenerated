/**
 * A fake ZeroGPU Space that speaks Gradio 6.2.0's queue protocol.
 *
 * Nothing here reaches Hugging Face, so no test spends GPU quota. The shapes
 * are the real ones: `/config` and the endpoint signature are trimmed copies of
 * what the live Space returned (`fixtures/zerogpu/`), and the stream framing,
 * message types and error payloads follow Gradio 6.2.0's `routes.py`,
 * `queueing.py`, `server_messages.py` and `utils.error_payload`.
 */

import { readFileSync } from 'node:fs'
import { ZeroGpuProvider, type ZeroGpuConfig, type ZeroGpuProviderOptions } from '../../../src/engine/providers'

export const SPACE_CONFIG = JSON.parse(readFileSync(
  new URL('../fixtures/zerogpu/space-config.json', import.meta.url), 'utf8')) as {
    version: string; protocol: string; api_prefix: string; root: string
    dependencies: { id: number; api_name: string }[]
  }

export const SPACE_INFO = JSON.parse(readFileSync(
  new URL('../fixtures/zerogpu/space-info.json', import.meta.url), 'utf8')) as {
    named_endpoints: Record<string, {
      parameters: { parameter_name: string; component: string; type: { type: string; enum?: string[] } }[]
      returns: { label: string; component: string; properties: string[] | null; required: string[] | null }[]
    }>
  }

/** The Space's own host, taken from the snapshot rather than typed out here. */
export const SPACE = SPACE_CONFIG.root
export const EVENT_ID = 'event-1'
export const SESSION = 'session-1'

export const TEST_CONFIG: ZeroGpuConfig = { spaceUrl: SPACE, autoDuration: 271, jobTimeoutMs: 60_000 }

/**
 * A real, playable, non-silent 16-bit mono WAV.
 *
 * A low sample rate keeps a full-length song small: 271 seconds at 1 kHz is
 * about half a megabyte, and the duration read from its header is still 271.
 */
export function wav(seconds: number, options: { rate?: number; amplitude?: number } = {}): ArrayBuffer {
  const rate = options.rate ?? 1000
  const amplitude = options.amplitude ?? 0.4
  const frames = Math.round(rate * seconds)
  const buffer = new ArrayBuffer(44 + frames * 2)
  const view = new DataView(buffer)
  const ascii = (at: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(at + i, text.charCodeAt(i))
  }
  ascii(0, 'RIFF'); view.setUint32(4, 36 + frames * 2, true); ascii(8, 'WAVE')
  ascii(12, 'fmt '); view.setUint32(16, 16, true)
  view.setUint16(20, 1, true); view.setUint16(22, 1, true)
  view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true)
  view.setUint16(32, 2, true); view.setUint16(34, 16, true)
  ascii(36, 'data'); view.setUint32(40, frames * 2, true)
  for (let i = 0; i < frames; i++) {
    view.setInt16(44 + i * 2, Math.round(Math.sin(i / 3) * amplitude * 32767), true)
  }
  return buffer
}

const SONG = wav(271)

/** The file record Gradio sends for the audio output. */
export const FILE_DATA = {
  path: '/tmp/gradio/0f3c/bos-toxic.wav',
  url: `${SPACE}${SPACE_CONFIG.api_prefix}/file=/tmp/gradio/0f3c/bos-toxic.wav`,
  size: 52_035_628,
  orig_name: 'bos-toxic.wav',
  mime_type: null,
  is_stream: false,
  meta: { _type: 'gradio.FileData' },
}

/** The metadata `poc/zerogpu-space/app.py` emits, for the validated run's shape. */
export const METADATA = {
  poc_version: '1',
  declared_gpu_duration_s: 80,
  zerogpu_size: 'large',
  gpu_name: 'NVIDIA RTX PRO 6000 Blackwell Server Edition MIG 2g.48gb',
  requested_model: 'acestep-v15-turbo',
  requested_lm_model: 'acestep-5Hz-lm-0.6B',
  loaded_model: 'acestep-v15-turbo',
  loaded_lm_model: 'acestep-5Hz-lm-0.6B',
  loaded_lm_path: '/home/user/app/checkpoints/acestep-5Hz-lm-0.6B',
  lm_backend: 'pt',
  total_generation_time_s: 44.7,
  requested_audio_duration_s: 271,
  audio_duration_s: 271,
  wav_sample_rate: 48000,
  wav_channels: 2,
  lyric_lines_sent: 68,
  instrumental: false,
  vocal_language: 'id',
  seed: 3141592,
  status_message: 'Generation completed successfully',
}

/** `process_completed` for a job that worked. */
export function completed(data: unknown[] = [FILE_DATA, JSON.stringify(METADATA)]) {
  return {
    msg: 'process_completed', event_id: EVENT_ID,
    output: { data, is_generating: false, duration: 44.7, average_duration: 44.7 },
    success: true, title: null,
  }
}

/** `process_completed` for a job whose handler raised, as `error_payload()` builds it. */
export function failed(title: string | null, error: string | null) {
  return {
    msg: 'process_completed', event_id: EVENT_ID,
    output: { error, ...(title ? { title, duration: 10, visible: true } : {}) },
    success: false, title: title ?? 'Error',
  }
}

/** The stream of a job that queued, ran and finished. */
export const SUCCESS_STREAM = [
  { msg: 'estimation', event_id: EVENT_ID, rank: 1, queue_size: 2, rank_eta: 30 },
  { msg: 'process_starts', event_id: EVENT_ID, eta: 45 },
  { msg: 'log', event_id: EVENT_ID, log: 'Waiting for a GPU to become available', level: 'info', title: 'ZeroGPU queue' },
  { msg: 'heartbeat', event_id: null },
  completed(),
  { msg: 'close_stream', event_id: null },
]

/** Frames messages the way Gradio's `/queue/data` does: `data: {json}\n\n`. */
export const sse = (messages: unknown[]) => messages.map((message) => `data: ${JSON.stringify(message)}\n\n`)

type Reply = Response | (() => Response)

export interface SpaceScript {
  config?: Reply
  join?: Reply
  /** Raw stream chunks; defaults to the successful job. */
  stream?: string[]
  /** Leave the stream open after the last chunk, as a stalled connection does. */
  hang?: boolean
  file?: Reply
}

export interface RecordedCall {
  method: string
  url: string
  body?: unknown
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

const reply = (value: Reply | undefined, fallback: () => Response) =>
  value === undefined ? fallback() : typeof value === 'function' ? value() : value

/** A `fetch` that is the Space. Records every request, so tests can count them. */
export function fakeSpace(script: SpaceScript = {}) {
  const calls: RecordedCall[] = []
  const api = `${SPACE}${SPACE_CONFIG.api_prefix}`

  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as unknown : undefined
    calls.push({ method, url, ...(body !== undefined ? { body } : {}) })

    if (url === `${SPACE}/config`) return reply(script.config, () => json(SPACE_CONFIG))
    if (url === `${api}/queue/join`) return reply(script.join, () => json({ event_id: EVENT_ID }))
    if (url.startsWith(`${api}/queue/data?session_hash=`)) {
      const encoder = new TextEncoder()
      const chunks = script.stream ?? sse(SUCCESS_STREAM)
      const signal = init?.signal
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
          // A real fetch errors its body when its signal aborts; an open stream
          // here does the same, so a stalled connection can be abandoned.
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
      return reply(script.file, () => new Response(SONG.slice(0), {
        status: 200, headers: { 'Content-Type': 'audio/wav' },
      }))
    }
    return new Response('not found', { status: 404 })
  }) as typeof fetch

  const count = (suffix: string) => calls.filter((call) => call.url.includes(suffix)).length
  return {
    fetchImpl,
    calls,
    /** How many jobs were submitted — the number that costs quota. */
    joins: () => count('/queue/join'),
    joinBody: () => calls.find((call) => call.url.endsWith('/queue/join'))?.body as {
      data: unknown[]; event_data: unknown; fn_index: number; trigger_id: unknown; session_hash: string
    } | undefined,
  }
}

/** A provider wired to a fake Space. */
export function zeroGpu(
  script: SpaceScript = {},
  config: Partial<ZeroGpuConfig> = {},
  options: Partial<ZeroGpuProviderOptions> = {},
) {
  const server = fakeSpace(script)
  const provider = new ZeroGpuProvider({
    config: { ...TEST_CONFIG, ...config },
    fetchImpl: server.fetchImpl,
    sessionHash: () => SESSION,
    toObjectUrl: () => 'blob:zerogpu',
    ...options,
  })
  return { server, provider }
}

export { json }
