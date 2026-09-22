/**
 * A failure says what happened, not that something happened.
 *
 * Reported from the live site: the interface showed "The generation request
 * failed. Nothing was retried automatically." and nothing a person could act
 * on. Two things were wrong. Any error that matched none of the branches in
 * `describeFailure` became `UNKNOWN` with an empty `details` — the original
 * exception discarded at the one place whose job is to explain it. And where
 * the transport did know the HTTP status and the Space's own answer, those
 * were folded into an English sentence rather than kept as fields.
 *
 * So `describeFailure` now walks the `cause` chain and keeps what it finds,
 * and every branch carries it. Nothing here invents a value: a field the chain
 * does not have is a field the report does not show.
 */

import { describe, expect, it } from 'vitest'
import { describeFailure } from '../../src/engine/providers/failure'
import { GradioHttpError } from '../../src/engine/providers/gradioClient'
import { ZeroGpuError } from '../../src/engine/providers/zeroGpuProvider'
import {
  AuthenticationRequiredError, AccountNotAllowedError,
} from '../../src/engine/providers/types'

describe('the original exception is never discarded', () => {
  it('an unrecognised error keeps its name and message', () => {
    class OddError extends Error { constructor() { super('something specific broke'); this.name = 'OddError' } }
    const failure = describeFailure(new OddError())
    expect(failure.code).toBe('UNKNOWN')
    expect(failure.message).toBe('something specific broke')
    expect(failure.details.errorName).toBe('OddError')
  })

  it('an HTTP failure keeps the status, the response and the request id', () => {
    const http = new GradioHttpError('The app returned HTTP 503.', 503, 'upstream is warming up', 'evt-abc123')
    const failure = describeFailure(http)
    expect(failure.details.httpStatus).toBe(503)
    expect(failure.details.spaceResponse).toBe('upstream is warming up')
    expect(failure.details.requestId).toBe('evt-abc123')
  })

  it('and finds them through a wrapper', () => {
    // The provider wraps transport errors. The status must survive the wrap,
    // because that is the shape a real failure arrives in.
    const inner = new GradioHttpError('HTTP 429', 429, 'too many requests', 'evt-42')
    const wrapped = new ZeroGpuError('http-error', 'The Space refused the request (HTTP 429).', {
      cause: inner, stage: 'queue', failureCode: 'QUEUE_SUBMISSION_FAILED',
    })
    const failure = describeFailure(wrapped)
    expect(failure.code).toBe('QUEUE_SUBMISSION_FAILED')
    expect(failure.details.httpStatus).toBe(429)
    expect(failure.details.spaceResponse).toBe('too many requests')
    expect(failure.details.requestId).toBe('evt-42')
    expect(String(failure.details.cause)).toContain('HTTP 429')
  })

  it('a sign-in refusal still reports the engine and the exception', () => {
    const failure = describeFailure(new AuthenticationRequiredError('zerogpu', 'Sign in again. (HTTP 401 from the Space.)'))
    expect(failure.code).toBe('AUTH_REQUIRED')
    expect(failure.retryable).toBe(false)
    expect(failure.details.engine).toBe('zerogpu')
    expect(failure.message).toContain('401')
  })

  it('an account the Space will not serve is told apart from a bad sign-in', () => {
    const failure = describeFailure(new AccountNotAllowedError('zerogpu', 'Not served. (HTTP 403 from the Space.)'))
    expect(failure.code).toBe('ACCOUNT_NOT_ALLOWED')
    expect(failure.retryable).toBe(false)
  })

  it('a provider detail is never overwritten by the chain walk', () => {
    // The provider knows more than the walk does; where both have a field, the
    // provider's wins.
    const inner = new GradioHttpError('HTTP 500', 500, 'boom')
    const wrapped = new ZeroGpuError('http-error', 'refused', {
      cause: inner, stage: 'queue', failureCode: 'QUEUE_SUBMISSION_FAILED',
      details: { httpStatus: 502 },
    })
    expect(describeFailure(wrapped).details.httpStatus).toBe(502)
  })

  it('a cause cycle does not hang the report', () => {
    const a = new Error('a')
    const b = new Error('b', { cause: a })
    ;(a as Error & { cause?: unknown }).cause = b
    expect(() => describeFailure(b)).not.toThrow()
  })

  it('a very long Space response is bounded, not dropped', () => {
    const failure = describeFailure(new GradioHttpError('HTTP 500', 500, 'x'.repeat(5000)))
    const shown = String(failure.details.spaceResponse)
    expect(shown.length).toBeGreaterThan(100)
    expect(shown.length).toBeLessThanOrEqual(400)
  })

  it('every failure says whether pressing Generate again is safe', () => {
    for (const error of [
      new GradioHttpError('HTTP 503', 503),
      new AuthenticationRequiredError('zerogpu', 'sign in'),
      new Error('anything at all'),
    ]) {
      expect(typeof describeFailure(error).retryable).toBe('boolean')
    }
  })
})
