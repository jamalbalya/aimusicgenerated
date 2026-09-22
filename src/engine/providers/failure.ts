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
import { Yue2Error } from './yue2Provider'

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
/**
 * Everything the thrown object knows, including what wrapped it.
 *
 * Reported from the live site: the interface said "The generation request
 * failed. Nothing was retried automatically." and nothing else. The stage and
 * code were on screen, but the HTTP status, the Space's own response and the
 * job's id were either folded into a sentence or thrown away entirely, and any
 * error that did not match one of the branches below became `UNKNOWN` with an
 * empty `details` — the original exception gone.
 *
 * An error nobody can look up is an error nobody can fix. So this walks the
 * `cause` chain and collects the fields that identify a failure wherever they
 * appear on it, and every branch merges the result. Nothing is invented: a
 * field absent from the chain is absent from the report.
 */
function diagnose(
  error: unknown, options: { includeName?: boolean } = {},
): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {}
  const seen = new Set<unknown>()
  let current: unknown = error
  let depth = 0
  while (current !== null && current !== undefined && !seen.has(current) && depth < 8) {
    seen.add(current)
    depth += 1
    if (current instanceof Error) {
      // Only where the code does not already name the class. On a branch that
      // reports QUOTA_EXCEEDED, "errorName: QuotaExceededError" is a second
      // copy of the same fact taking up a row in a panel someone reads while
      // something is broken. The innermost name is the most specific, so an
      // outer wrapper never overwrites it.
      if (options.includeName === true && out.errorName === undefined
          && current.name && current.name !== 'Error') {
        out.errorName = current.name
      }
      const record = current as unknown as Record<string, unknown>
      if (out.httpStatus === undefined && typeof record.status === 'number') {
        out.httpStatus = record.status
      }
      if (out.spaceResponse === undefined && typeof record.detail === 'string' && record.detail) {
        // Bounded: a Space that answers with an HTML error page should not push
        // the code and the status off the screen.
        out.spaceResponse = record.detail.slice(0, 400)
      }
      if (out.requestId === undefined && typeof record.requestId === 'string' && record.requestId) {
        out.requestId = record.requestId
      }
      if (out.cause === undefined && current.cause instanceof Error
          && current.cause.message && current.cause.message !== current.message) {
        out.cause = `${current.cause.name}: ${current.cause.message}`.slice(0, 300)
      }
      current = current.cause
      continue
    }
    break
  }
  return out
}

export function describeFailure(error: unknown): GenerationFailure {
  const message = error instanceof Error ? error.message : String(error)
  // The identifying fields — status, the Space's answer, the request id, the
  // cause — are worth having on every branch. The class name is only worth
  // having where nothing else names it, which is the unknown branch below.
  const found = diagnose(error)

  if (error instanceof GenerationCancelledError) {
    return { stage: 'cancelled', code: 'CANCELLED', message, details: found, retryable: true }
  }
  if (error instanceof QuotaExceededError) {
    const quota = error.quota
    return {
      stage: 'quota', code: 'QUOTA_EXCEEDED', message, retryable: false,
      // `null` in a quota reading means "the refusal did not say", which is a
      // different thing from a number and must not be shown as one.
      details: {
        ...found,
        ...(typeof quota?.remainingSeconds === 'number' ? { remainingSeconds: quota.remainingSeconds } : {}),
        ...(typeof quota?.requestedSeconds === 'number' ? { requestedSeconds: quota.requestedSeconds } : {}),
        ...(typeof quota?.retryAt === 'number' ? { retryAt: quota.retryAt } : {}),
      },
    }
  }
  if (error instanceof AuthenticationRequiredError) {
    return {
      stage: 'auth', code: 'AUTH_REQUIRED', message,
      details: { ...found, engine: error.engineId }, retryable: false,
    }
  }
  if (error instanceof AccountNotAllowedError) {
    return {
      stage: 'auth', code: 'ACCOUNT_NOT_ALLOWED', message,
      details: { ...found, engine: error.engineId }, retryable: false,
    }
  }
  if (error instanceof EngineUnavailableError) {
    // The Space not answering and the stream going quiet arrive as the same
    // class; the wording is what tells them apart, because that is what the
    // transport knew and this layer does not re-derive it.
    const lost = /went silent|result stream|heartbeat/i.test(message)
    return {
      stage: lost ? 'stream' : 'connect',
      code: lost ? 'SSE_CONNECTION_FAILED' : 'ENGINE_UNAVAILABLE',
      message, details: { ...found, engine: error.engineId }, retryable: true,
    }
  }
  if (error instanceof Yue2Error) {
    // Same shape as the ZeroGPU branch below, plus the one fact that branch
    // has no need of: whether the Space had begun generating. A quota refusal
    // arrives before the decorated function runs, and a report that loses that
    // distinction turns "nothing happened" into "your song failed".
    return {
      stage: error.stage ?? 'unknown',
      code: error.failureCode ?? 'UNKNOWN',
      message,
      details: {
        ...found,
        generationStarted: error.generationStarted,
        ...(error.details ?? {}),
      },
      // `ambiguous-outcome` may already be running on the Space, so a second
      // request would spend the allowance twice; `illegal-duration` is refused
      // by the scheduler for the duration the Space declares, which this side
      // does not vary, so the same request is refused the same way forever.
      // Neither is worth offering a retry for.
      retryable: error.code === 'ambiguous-outcome' || error.code === 'illegal-duration'
        ? false
        : error.stage !== 'request',
    }
  }
  if (error instanceof ZeroGpuError) {
    const mapped = ZERO_GPU_CODES[error.code]
    const stage = error.stage ?? mapped?.stage ?? 'unknown'
    const code = error.failureCode ?? mapped?.code ?? 'UNKNOWN'
    return {
      stage, code, message,
      details: { ...found, ...(error.details ?? {}) },
      retryable: mapped?.retryable ?? true,
    }
  }
  // The last resort, and the one the report came from. It keeps whatever the
  // chain knew rather than replacing it with a shrug.
  return {
    stage: 'unknown', code: 'UNKNOWN', message,
    details: diagnose(error, { includeName: true }), retryable: true,
  }
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
