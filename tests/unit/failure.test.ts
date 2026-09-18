/**
 * Turning an error into something a person can act on.
 *
 * The engine has always told these apart; until now the screen saw one string.
 * These tests pin the mapping, and above all that nothing is invented: an error
 * this layer cannot place says so, rather than picking the nearest code.
 */

import { describe, expect, it } from 'vitest'
import {
  describeFailure, STAGE_LABELS, planZeroGpuRequest,
  AccountNotAllowedError, AuthenticationRequiredError, EngineUnavailableError,
  GenerationCancelledError, QuotaExceededError, ZeroGpuError,
  type GenerationStage,
} from '../../src/engine/providers'

describe('every failure says where it happened and what it was', () => {
  it('places a style that is too long at the request, before anything is sent', () => {
    let failure
    try {
      planZeroGpuRequest({ style: 'a'.repeat(1457), lyrics: 'x', language: 'id' } as never, {} as never)
    } catch (error) { failure = describeFailure(error) }
    expect(failure).toMatchObject({
      stage: 'request', code: 'STYLE_TOO_LONG', retryable: false,
      details: { field: 'style', characters: 1457, limit: 512 },
    })
  })

  it('tells a too-long sheet from a too-long style', () => {
    let failure
    try {
      planZeroGpuRequest(
        { style: 'ok', lyrics: 'la\n'.repeat(2000), language: 'id' } as never, {} as never)
    } catch (error) { failure = describeFailure(error) }
    expect(failure?.code).toBe('LYRICS_TOO_LONG')
    expect(failure?.details).toMatchObject({ field: 'lyrics', limit: 4096 })
  })

  it('carries both counts when the two sides disagree about lyric lines', () => {
    const failure = describeFailure(new ZeroGpuError('bad-result',
      'The Space received 9 lyric lines; 10 were sent.',
      { stage: 'result', failureCode: 'LYRICS_LINE_COUNT_MISMATCH',
        details: { spaceCounted: 9, studioSent: 10 } }))
    expect(failure).toMatchObject({
      stage: 'result', code: 'LYRICS_LINE_COUNT_MISMATCH',
      details: { spaceCounted: 9, studioSent: 10 },
    })
  })

  it('separates a queue refusal from a download refusal, though both are HTTP', () => {
    const queued = describeFailure(new ZeroGpuError('http-error', 'refused',
      { stage: 'queue', failureCode: 'QUEUE_SUBMISSION_FAILED', details: { httpStatus: 500 } }))
    const downloaded = describeFailure(new ZeroGpuError('http-error', 'gone',
      { stage: 'download', failureCode: 'DOWNLOAD_FAILED', details: { httpStatus: 404 } }))
    expect(queued.code).toBe('QUEUE_SUBMISSION_FAILED')
    expect(downloaded.code).toBe('DOWNLOAD_FAILED')
    expect(queued.stage).not.toBe(downloaded.stage)
  })

  it('does not offer a retry for anything the request itself causes', () => {
    const wontChange = ['STYLE_TOO_LONG', 'UNSUPPORTED_DURATION', 'QUOTA_EXCEEDED',
      'AUTH_REQUIRED', 'ACCOUNT_NOT_ALLOWED']
    const cases = [
      new ZeroGpuError('oversized-request', 'too long', { stage: 'request', failureCode: 'STYLE_TOO_LONG' }),
      new ZeroGpuError('illegal-duration', 'no', { stage: 'request', failureCode: 'UNSUPPORTED_DURATION' }),
      new QuotaExceededError('e', 'spent'),
      new AuthenticationRequiredError('e', 'sign in'),
      new AccountNotAllowedError('e', 'not you'),
    ]
    for (const error of cases) {
      const failure = describeFailure(error)
      expect(wontChange, failure.code).toContain(failure.code)
      expect(failure.retryable, `${failure.code} must not offer a retry`).toBe(false)
    }
  })

  it('offers a retry for the failures that are worth retrying', () => {
    for (const error of [
      new ZeroGpuError('generation-failed', 'crashed', { stage: 'inference', failureCode: 'INFERENCE_FAILED' }),
      new ZeroGpuError('timeout', 'slow', { stage: 'stream', failureCode: 'GENERATION_TIMED_OUT' }),
      new EngineUnavailableError('e', 'asleep'),
    ]) {
      expect(describeFailure(error).retryable, describeFailure(error).code).toBe(true)
    }
  })

  it('tells a Space that never answered from a stream that went quiet', () => {
    expect(describeFailure(new EngineUnavailableError('e', 'Space did not answer')))
      .toMatchObject({ stage: 'connect', code: 'ENGINE_UNAVAILABLE' })
    expect(describeFailure(new EngineUnavailableError('e',
      'Neural music engine is unavailable. The connection to the app went silent for 60 seconds (no heartbeat).')))
      .toMatchObject({ stage: 'stream', code: 'SSE_CONNECTION_FAILED' })
  })

  it('reads the allowance out of a quota refusal, and never fills a gap', () => {
    const known = describeFailure(new QuotaExceededError('e', 'spent',
      { remainingSeconds: 116, requestedSeconds: 120, retryAt: 1_700_000_000_000, totalSeconds: null, source: 'refusal' } as never))
    expect(known.details).toMatchObject({ remainingSeconds: 116, requestedSeconds: 120 })
    // A reading that says "not published" is null, and null is not a number to show.
    const unknown = describeFailure(new QuotaExceededError('e', 'spent',
      { remainingSeconds: null, requestedSeconds: null, retryAt: null, totalSeconds: null, source: 'unknown' } as never))
    expect(unknown.details).toEqual({})
  })

  it('says it does not know rather than guessing', () => {
    expect(describeFailure(new Error('something nobody classified')))
      .toMatchObject({ stage: 'unknown', code: 'UNKNOWN' })
    expect(describeFailure('not even an error'))
      .toMatchObject({ stage: 'unknown', code: 'UNKNOWN', message: 'not even an error' })
  })

  it('keeps a cancellation out of the failure codes entirely', () => {
    expect(describeFailure(new GenerationCancelledError()).stage).toBe('cancelled')
  })

  it('has a label for every stage, so none can render blank', () => {
    const stages: GenerationStage[] = ['request', 'connect', 'queue', 'stream', 'inference',
      'result', 'download', 'auth', 'quota', 'cancelled', 'unknown']
    for (const stage of stages) expect(STAGE_LABELS[stage]?.length).toBeGreaterThan(0)
  })
})
