/**
 * What went wrong, in a shape a person can act on.
 *
 * The engine already tells failures apart carefully — a spent allowance is not
 * a dead Space, a refused sign-in is not a refused account, a GPU that ran out
 * of time is not a model that crashed. Until now all of that reached the screen
 * as one sentence, so a report of "generation failed" could not be placed at any
 * stage of the request and the code the provider had already chosen was thrown
 * away. Diagnosing anything from the outside meant guessing.
 *
 * So every error the engine raises is turned into the same four things: the
 * stage it happened at, a stable code, the sentence to show, and whatever
 * details were known at the time. Nothing here invents information — a failure
 * this module cannot place says so, with `stage: 'unknown'`, rather than
 * picking the nearest-looking code.
 */

import {
  AccountNotAllowedError, AuthenticationRequiredError, EngineUnavailableError,
  GenerationCancelledError, QuotaExceededError,
} from './types'
import { ZeroGpuError } from './zeroGpuProvider'

/** Where in one request a failure happened. */
export type GenerationStage =
  | 'request'      // building and checking the request, before anything is sent
  | 'connect'      // reaching the Space and reading its endpoint
  | 'queue'        // submitting the job and joining the queue
  | 'stream'       // the result stream, from submission to the final message
  | 'inference'    // the Space's own code, or the model, failing
  | 'result'       // what came back, checked against what was asked
  | 'download'     // fetching the finished file
  | 'auth'         // who the caller is, and whether they are served
  | 'quota'        // an allowance that is spent
  | 'cancelled'    // the caller stopped it
  | 'unknown'

/** A stable code for a failure, safe to match on and safe to quote in a report. */
export type GenerationErrorCode =
  | 'STYLE_TOO_LONG'
  | 'LYRICS_TOO_LONG'
  | 'UNSUPPORTED_DURATION'
  | 'ENGINE_UNAVAILABLE'
  | 'QUEUE_SUBMISSION_FAILED'
  | 'SSE_CONNECTION_FAILED'
  | 'INFERENCE_FAILED'
  | 'GENERATION_TIMED_OUT'
  | 'LYRICS_LINE_COUNT_MISMATCH'
  | 'RESULT_MISMATCH'
  | 'AUDIO_RESULT_FAILED'
  | 'DOWNLOAD_FAILED'
  | 'AUTH_REQUIRED'
  | 'ACCOUNT_NOT_ALLOWED'
  | 'QUOTA_EXCEEDED'
  | 'CANCELLED'
  | 'UNKNOWN'

export interface GenerationFailure {
  stage: GenerationStage
  code: GenerationErrorCode
  /** The sentence to show. Always the engine's own words. */
  message: string
  /** Whatever was known when it was raised. Never guessed, often empty. */
  details: Record<string, string | number | boolean>
  /**
   * Whether asking again, unchanged, could plausibly work.
   *
   * False for everything the request itself causes: a style that is too long is
   * too long however many times it is sent, and offering a retry there wastes
   * the person's time and the GPU's.
   */
  retryable: boolean
}

/** Maps the provider's own codes onto the stage and code shown to a person. */
const ZERO_GPU_CODES: Record<string, { stage: GenerationStage; code: GenerationErrorCode; retryable: boolean }> = {
  'oversized-request': { stage: 'request', code: 'STYLE_TOO_LONG', retryable: false },
  'illegal-duration': { stage: 'request', code: 'UNSUPPORTED_DURATION', retryable: false },
  'generation-failed': { stage: 'inference', code: 'INFERENCE_FAILED', retryable: true },
  'timeout': { stage: 'stream', code: 'GENERATION_TIMED_OUT', retryable: true },
  'http-error': { stage: 'queue', code: 'QUEUE_SUBMISSION_FAILED', retryable: true },
  'unexpected-error': { stage: 'stream', code: 'SSE_CONNECTION_FAILED', retryable: true },
  'bad-result': { stage: 'result', code: 'RESULT_MISMATCH', retryable: true },
  'missing-audio': { stage: 'result', code: 'AUDIO_RESULT_FAILED', retryable: true },
}

/**
 * The one place an error becomes something to show.
 *
 * A `ZeroGpuError` carries a stage and details when the provider knew them, and
 * those win over the table above: the same `http-error` means a queue that
 * refused the job or a file that would not download, and only the thrower knows
 * which.
 */
export function describeFailure(error: unknown): GenerationFailure {
  const message = error instanceof Error ? error.message : String(error)

  if (error instanceof GenerationCancelledError) {
    return { stage: 'cancelled', code: 'CANCELLED', message, details: {}, retryable: true }
  }
  if (error instanceof QuotaExceededError) {
    const quota = error.quota
    return {
      stage: 'quota', code: 'QUOTA_EXCEEDED', message, retryable: false,
      // `null` in a quota reading means "the refusal did not say", which is a
      // different thing from a number and must not be shown as one.
      details: {
        ...(typeof quota?.remainingSeconds === 'number' ? { remainingSeconds: quota.remainingSeconds } : {}),
        ...(typeof quota?.requestedSeconds === 'number' ? { requestedSeconds: quota.requestedSeconds } : {}),
        ...(typeof quota?.retryAt === 'number' ? { retryAt: quota.retryAt } : {}),
      },
    }
  }
  if (error instanceof AuthenticationRequiredError) {
    return { stage: 'auth', code: 'AUTH_REQUIRED', message, details: { engine: error.engineId }, retryable: false }
  }
  if (error instanceof AccountNotAllowedError) {
    return { stage: 'auth', code: 'ACCOUNT_NOT_ALLOWED', message, details: { engine: error.engineId }, retryable: false }
  }
  if (error instanceof EngineUnavailableError) {
    // The Space not answering and the stream going quiet arrive as the same
    // class; the wording is what tells them apart, because that is what the
    // transport knew and this layer does not re-derive it.
    const lost = /went silent|result stream|heartbeat/i.test(message)
    return {
      stage: lost ? 'stream' : 'connect',
      code: lost ? 'SSE_CONNECTION_FAILED' : 'ENGINE_UNAVAILABLE',
      message, details: { engine: error.engineId }, retryable: true,
    }
  }
  if (error instanceof ZeroGpuError) {
    const mapped = ZERO_GPU_CODES[error.code]
    const stage = error.stage ?? mapped?.stage ?? 'unknown'
    const code = error.failureCode ?? mapped?.code ?? 'UNKNOWN'
    return {
      stage, code, message,
      details: error.details ?? {},
      retryable: mapped?.retryable ?? true,
    }
  }
  return { stage: 'unknown', code: 'UNKNOWN', message, details: {}, retryable: true }
}

/** What each stage is called on screen. Short, because it sits beside the code. */
export const STAGE_LABELS: Record<GenerationStage, string> = {
  request: 'Checking the request',
  connect: 'Reaching the Space',
  queue: 'Submitting to the queue',
  stream: 'Waiting for the result',
  inference: 'Generating',
  result: 'Checking the result',
  download: 'Downloading the song',
  auth: 'Signing in',
  quota: 'GPU allowance',
  cancelled: 'Stopped',
  unknown: 'Unknown stage',
}
