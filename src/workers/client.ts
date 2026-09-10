/**
 * Typed client for the studio worker: one promise per job, with progress.
 *
 * A single worker instance is shared and jobs are queued, so a phone with two
 * cores does not try to render three songs at once.
 */

import type { WorkerRequest, WorkerResponse, WorkerResult } from './protocol'

export interface JobHandle<T extends WorkerResult> {
  promise: Promise<T>
  cancel: () => void
}

export interface JobOptions {
  onProgress?: (progress: number, stage: string) => void
  signal?: AbortSignal
}

interface Pending {
  resolve: (result: WorkerResult) => void
  reject: (error: Error) => void
  onProgress?: (progress: number, stage: string) => void
  /** Cleared as soon as the worker shows any sign of life. */
  watchdog?: ReturnType<typeof setTimeout>
}

/**
 * How long the first job waits for the worker to say anything at all.
 *
 * A worker can fail to start without ever raising an error — a blocked blob
 * URL is the usual cause — and the symptom is a job that simply never
 * finishes. Rather than leave the interface spinning forever, give up on the
 * worker and run the job here instead.
 */
const FIRST_RESPONSE_TIMEOUT_MS = 5000

let worker: Worker | null = null
let workerUnavailable = false
let nextId = 1
const pending = new Map<number, Pending>()

/**
 * True once a worker has failed to start. Some environments — strict content
 * policies, a few embedded browsers, a single-file build with no separate
 * worker script — cannot create one, and the studio has to keep working there.
 */
export function isRunningOnMainThread(): boolean {
  return workerUnavailable
}

/**
 * A document opened straight from disk has an opaque origin, and the blob URL
 * a bundled worker needs cannot be loaded from one. Rather than start a worker
 * that will fail, skip it and use the main thread from the outset.
 */
function workersAreUsable(): boolean {
  if (typeof Worker === 'undefined') return false
  if (typeof window !== 'undefined' && window.location.protocol === 'file:') return false
  return true
}

async function ensureWorker(): Promise<Worker | null> {
  if (worker) return worker
  if (workerUnavailable || !workersAreUsable()) {
    workerUnavailable = true
    return null
  }
  try {
    if (import.meta.env.VITE_INLINE_WORKER) {
      // Single-file builds carry the worker inside the document, so there is
      // no separate script for the URL form to fetch.
      const { default: InlineWorker } = await import('./studio.worker?worker&inline')
      worker = new InlineWorker()
    } else {
      worker = new Worker(new URL('./studio.worker.ts', import.meta.url), { type: 'module' })
    }
  } catch {
    workerUnavailable = true
    return null
  }
  if (!worker) {
    workerUnavailable = true
    return null
  }
  worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
    const message = event.data
    const entry = pending.get(message.id)
    if (!entry) return
    if (entry.watchdog !== undefined) {
      clearTimeout(entry.watchdog)
      entry.watchdog = undefined
    }
    if (message.type === 'progress') {
      entry.onProgress?.(message.progress, message.stage)
      return
    }
    pending.delete(message.id)
    if (message.type === 'done') {
      workerHasCompleted = true
      entry.resolve(message.result)
    } else {
      entry.reject(new Error(message.message))
    }
  }
  worker.onerror = (event) => {
    for (const entry of pending.values()) {
      if (entry.watchdog !== undefined) clearTimeout(entry.watchdog)
    }
    // A worker that fails before it has ever completed a job is a sign the
    // environment cannot run one at all — fall back rather than fail forever.
    const neverSucceeded = !workerHasCompleted
    const error = new Error(event.message || 'The studio engine stopped unexpectedly.')
    for (const entry of pending.values()) entry.reject(error)
    pending.clear()
    worker?.terminate()
    worker = null
    if (neverSucceeded) workerUnavailable = true
  }
  return worker
}

let workerHasCompleted = false

/** Cancels every in-flight job and tears the worker down. */
export function resetWorker(): void {
  for (const entry of pending.values()) {
    if (entry.watchdog !== undefined) clearTimeout(entry.watchdog)
    entry.reject(new Error('Cancelled'))
  }
  pending.clear()
  worker?.terminate()
  worker = null
}

export async function runJob<T extends WorkerResult>(
  request: WorkerRequest,
  options: JobOptions = {},
): Promise<T> {
  const instance = await ensureWorker()
  if (!instance) return runOnMainThread<T>(request, options)
  const id = nextId++

  return new Promise<T>((resolve, reject) => {
    pending.set(id, {
      resolve: (result) => resolve(result as T),
      reject,
      onProgress: options.onProgress,
    })

    if (options.signal) {
      if (options.signal.aborted) {
        pending.delete(id)
        reject(new Error('Cancelled'))
        return
      }
      options.signal.addEventListener('abort', () => {
        if (!pending.has(id)) return
        pending.delete(id)
        reject(new Error('Cancelled'))
        // The worker has no way to interrupt a running job, so it is replaced.
        resetWorker()
      }, { once: true })
    }

    // Until a worker has completed something, treat silence as failure.
    if (!workerHasCompleted) {
      const entry = pending.get(id)
      if (entry) {
        entry.watchdog = setTimeout(() => {
          if (!pending.has(id)) return
          pending.delete(id)
          workerUnavailable = true
          worker?.terminate()
          worker = null
          runOnMainThread<T>(request, options).then(resolve, reject)
        }, FIRST_RESPONSE_TIMEOUT_MS)
      }
    }

    instance.postMessage({ id, payload: request })
  })
}

/**
 * Fallback path: run the job here, on the main thread.
 *
 * The interface cannot repaint while a job runs this way, so progress is
 * reported before and after rather than during, and the handler is loaded on
 * demand so its cost is only paid where it is actually needed.
 */
async function runOnMainThread<T extends WorkerResult>(
  request: WorkerRequest,
  options: JobOptions,
): Promise<T> {
  if (options.signal?.aborted) throw new Error('Cancelled')
  const { handleRequest } = await import('./handler')
  options.onProgress?.(0, 'Working')
  // Yield once so the browser can paint the pending state first.
  await new Promise((resolve) => setTimeout(resolve, 16))
  if (options.signal?.aborted) throw new Error('Cancelled')
  const result = handleRequest(request, (progress, stage) => options.onProgress?.(progress, stage)) as T
  options.onProgress?.(1, 'Done')
  return result
}

/** True when this browser can run the studio at all. */
export function isSupported(): boolean {
  return typeof Float32Array !== 'undefined' && typeof OfflineAudioContext !== 'undefined'
}
