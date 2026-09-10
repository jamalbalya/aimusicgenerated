/// <reference lib="webworker" />
/**
 * The studio worker: a thin transport around the job handler.
 *
 * All of the actual work lives in `handler.ts`, which has no worker
 * dependencies, so the same code can run on the main thread when a worker is
 * unavailable.
 */

import { handleRequest } from './handler'
import { collectTransferables, type WorkerMessage, type WorkerResponse } from './protocol'

const scope = self as unknown as DedicatedWorkerGlobalScope

function post(response: WorkerResponse, transfer: Transferable[] = []): void {
  scope.postMessage(response, transfer)
}

scope.onmessage = (event: MessageEvent<WorkerMessage>) => {
  const { id, payload } = event.data
  try {
    const result = handleRequest(payload, (progress, stage) => {
      post({ id, type: 'progress', progress, stage })
    })
    post({ id, type: 'done', result }, collectTransferables(result))
  } catch (error) {
    post({ id, type: 'error', message: error instanceof Error ? error.message : String(error) })
  }
}
