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
}

let worker: Worker | null = null
let nextId = 1
const pending = new Map<number, Pending>()

function ensureWorker(): Worker {
  if (worker) return worker
  worker = new Worker(new URL('./studio.worker.ts', import.meta.url), { type: 'module' })
  worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
    const message = event.data
    const entry = pending.get(message.id)
    if (!entry) return
    if (message.type === 'progress') {
      entry.onProgress?.(message.progress, message.stage)
      return
    }
    pending.delete(message.id)
    if (message.type === 'done') entry.resolve(message.result)
    else entry.reject(new Error(message.message))
  }
  worker.onerror = (event) => {
    const error = new Error(event.message || 'The studio engine stopped unexpectedly.')
    for (const entry of pending.values()) entry.reject(error)
    pending.clear()
    // A crashed worker cannot be reused; the next job starts a fresh one.
    worker?.terminate()
    worker = null
  }
  return worker
}

/** Cancels every in-flight job and tears the worker down. */
export function resetWorker(): void {
  for (const entry of pending.values()) entry.reject(new Error('Cancelled'))
  pending.clear()
  worker?.terminate()
  worker = null
}

export function runJob<T extends WorkerResult>(
  request: WorkerRequest,
  options: JobOptions = {},
): Promise<T> {
  const instance = ensureWorker()
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

    instance.postMessage({ id, payload: request })
  })
}

/** True when the browser can run the studio at all. */
export function isSupported(): boolean {
  return typeof Worker !== 'undefined' && typeof Float32Array !== 'undefined'
}
