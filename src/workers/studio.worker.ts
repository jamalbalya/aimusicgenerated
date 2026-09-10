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
  // A job is asynchronous because a vocal renderer may not be local: a model
  // has to load, a service has to answer. Nothing about the transport changes.
  void handleRequest(payload, (progress, stage) => {
    post({ id, type: 'progress', progress, stage })
  })
    .then((result) => post({ id, type: 'done', result }, collectTransferables(result)))
    .catch((error: unknown) => {
      post({ id, type: 'error', message: error instanceof Error ? error.message : String(error) })
    })
}
