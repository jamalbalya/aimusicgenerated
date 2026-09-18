/**
 * Generate, judge, reject, generate again — and never hand back a take that
 * failed.
 *
 * The analyser could already tell a good song from a bad one. What it could not
 * do was stop the bad one reaching a listener, because nothing sat between the
 * engine and the player. This does.
 *
 * The rule the whole file exists to enforce is the negative one: a take whose
 * verdict is REGENERATION_REQUIRED is never returned, never offered, and never
 * kept as a fallback for when the attempts run out. Falling back to the last
 * failure is the one behaviour that would make the gate worse than useless,
 * because it would deliver exactly the songs the gate was built to catch while
 * appearing to check them.
 *
 * What the user wrote is never touched. Style and lyrics are snapshotted on the
 * way in and compared on every attempt, so a regeneration loop cannot quietly
 * become a rewriting loop.
 */

import type {
  GenerateOptions, MusicGenerationProvider, MusicGenerationRequest, MusicGenerationResult,
} from '../providers/types'
import type { QualityReport, QualityVerdict } from './types'

/** Which verdicts do what. Strict by default; a caller changing one is making a decision. */
export interface DeliveryPolicy {
  /** Verdicts that may be delivered as verified. Only PASS. */
  deliverOn: QualityVerdict[]
  /**
   * Verdicts whose audio is kept and handed back *clearly marked unverified*,
   * for the user to decide about. Never presented as having passed.
   */
  offerUnverifiedOn: QualityVerdict[]
  /** Verdicts that spend another attempt. */
  regenerateOn: QualityVerdict[]
}

/**
 * The default policy.
 *
 * ANALYSIS_UNAVAILABLE deliberately does not trigger regeneration. Generating
 * the same song again does not make it analysable — the reason analysis failed
 * is a property of this machine, not of that take — so retrying would spend
 * five jobs on a free GPU to arrive at the same sentence. It stops, and says so.
 */
export const STRICT_DELIVERY: DeliveryPolicy = {
  deliverOn: ['PASS'],
  offerUnverifiedOn: ['REVIEW_REQUIRED', 'ANALYSIS_UNAVAILABLE'],
  regenerateOn: ['REGENERATION_REQUIRED'],
}

/** What happened on one attempt. Every attempt gets one, kept for the log. */
export interface GatedAttempt {
  /** 1-based, as a person counts them. */
  attempt: number
  seed?: number
  /** Absent when generation itself failed before there was anything to judge. */
  verdict?: QualityVerdict
  report: QualityReport | null
  /** The generation error, when the engine failed rather than the gate. */
  error?: string
  durationMs: number
}

export type GatedOutcome =
  | {
    delivered: true
    result: MusicGenerationResult
    report: QualityReport
    attempts: GatedAttempt[]
  }
  | {
    delivered: false
    /** One sentence, already fit to show a person. */
    reason: string
    attempts: GatedAttempt[]
    /**
     * A take that did not fail the gate but could not be verified either, kept
     * so the user can choose. Never set for REGENERATION_REQUIRED.
     */
    unverified?: { result: MusicGenerationResult; report: QualityReport }
  }

export interface GatedGenerationOptions extends GenerateOptions {
  provider: Pick<MusicGenerationProvider, 'generate'>
  request: MusicGenerationRequest
  /** Judges a finished take. Returns the report; never throws for a bad song. */
  judge: (result: MusicGenerationResult) => Promise<QualityReport> | QualityReport
  /** Default 5. Values below 1 are treated as 1: a gate still needs one take to judge. */
  maxAttempts?: number
  policy?: DeliveryPolicy
  /** A fresh seed per attempt. Injectable so tests are deterministic. */
  nextSeed?: (attempt: number) => number | undefined
  /** Called as each attempt finishes, for the log the user sees. */
  onAttempt?: (attempt: GatedAttempt) => void
}

/** Default seeds: a fresh 32-bit draw each time, never repeating within a run. */
export function freshSeedSource(): (attempt: number) => number {
  const used = new Set<number>()
  return () => {
    let seed: number
    do {
      seed = Math.floor(Math.random() * 0x7fffffff)
    } while (used.has(seed))
    used.add(seed)
    return seed
  }
}

/**
 * Attempts for an engine whose takes cost something.
 *
 * Five, because a neural take on a free GPU spends a share of an allowance that
 * resets on someone else's schedule, and ten attempts would exhaust it to save
 * one regeneration the person could have asked for themselves.
 */
export const DEFAULT_MAX_ATTEMPTS = 5

/**
 * Attempts for an engine whose takes cost local CPU time and nothing else.
 *
 * Ten. The offline engine's takes are free — no GPU, no account, no allowance —
 * so the only thing more attempts spend is a few more seconds of a machine that
 * is already running. It buys a lot: at the measured pass rate five attempts
 * leave about one run in six delivering nothing, which is a broken product even
 * though it is a safe one, and ten reaches a passing take on all twenty prompts
 * this was measured against.
 */
export const OFFLINE_MAX_ATTEMPTS = 10

/** Thrown when a provider hands back a request whose words are not the user's. */
export class RequestMutatedError extends Error {
  constructor(field: 'style' | 'lyrics') {
    super(`The ${field} changed during generation. The user's text is passed through unaltered; `
      + 'a regeneration loop must never become a rewriting loop.')
    this.name = 'RequestMutatedError'
  }
}

/**
 * Runs the loop.
 *
 * Cancellation and engine failures are not the gate's business and are not
 * swallowed: a cancelled run throws, and a run where every attempt failed to
 * generate reports that rather than pretending the gate rejected them.
 */
export async function runGatedGeneration(options: GatedGenerationOptions): Promise<GatedOutcome> {
  const {
    provider, request, judge, onAttempt, signal, onStatus,
    policy = STRICT_DELIVERY,
    nextSeed = freshSeedSource(),
  } = options
  const maxAttempts = Math.max(1, Math.floor(options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS))

  // The user's words, as given. Compared on every attempt rather than trusted.
  const style = request.style
  const lyrics = request.lyrics

  const attempts: GatedAttempt[] = []
  let unverified: { result: MusicGenerationResult; report: QualityReport } | undefined
  let lastError: string | undefined

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const startedAt = Date.now()
    const seed = nextSeed(attempt)
    const attemptRequest: MusicGenerationRequest = {
      ...request, style, lyrics, ...(seed !== undefined ? { seed } : {}),
    }
    if (attemptRequest.style !== style) throw new RequestMutatedError('style')
    if (attemptRequest.lyrics !== lyrics) throw new RequestMutatedError('lyrics')

    let result: MusicGenerationResult
    try {
      result = await provider.generate(attemptRequest, {
        ...(signal ? { signal } : {}),
        ...(onStatus ? { onStatus } : {}),
      })
    } catch (error) {
      // A cancellation is the user's decision and ends the run as itself.
      if (error instanceof Error && error.name === 'GenerationCancelledError') throw error
      lastError = error instanceof Error ? error.message : String(error)
      const record: GatedAttempt = {
        attempt, ...(seed !== undefined ? { seed } : {}), report: null,
        error: lastError, durationMs: Date.now() - startedAt,
      }
      attempts.push(record)
      onAttempt?.(record)
      // An engine that is down, out of quota or refusing the request will
      // refuse the next one too. Only the gate's own rejections are worth
      // another attempt.
      throw error
    }

    const report = await judge(result)
    const record: GatedAttempt = {
      attempt, ...(seed !== undefined ? { seed } : {}),
      verdict: report.verdict, report, durationMs: Date.now() - startedAt,
    }
    attempts.push(record)
    onAttempt?.(record)

    if (policy.deliverOn.includes(report.verdict)) {
      return { delivered: true, result, report, attempts }
    }

    if (policy.offerUnverifiedOn.includes(report.verdict)) {
      // Keep the first one rather than the last: they are equivalent, and
      // holding the first means a later attempt cannot quietly replace a
      // better-reasoned report with a worse one.
      unverified ??= { result, report }
    }

    if (!policy.regenerateOn.includes(report.verdict)) {
      // Nothing about trying again would change this answer.
      return {
        delivered: false,
        reason: unverified
          ? `The quality gate could not verify this song: ${report.reasons[0] ?? report.verdict}`
          : `Generation stopped with ${report.verdict}: ${report.reasons[0] ?? 'no reason given.'}`,
        attempts,
        ...(unverified ? { unverified } : {}),
      }
    }
  }

  const rejected = attempts.filter((a) => a.verdict === 'REGENERATION_REQUIRED').length
  return {
    delivered: false,
    reason: rejected > 0
      ? `Generation failed the musical quality gate after ${attempts.length} attempt(s). `
        + 'No incorrect audio was delivered.'
      : `Generation produced nothing usable after ${attempts.length} attempt(s).`
        + (lastError ? ` Last error: ${lastError}` : ''),
    attempts,
    ...(unverified ? { unverified } : {}),
  }
}

/** A one-line log entry per attempt, in the words the studio shows. */
export function describeAttempt(attempt: GatedAttempt): string {
  if (attempt.error) return `Attempt ${attempt.attempt} → generation failed → ${attempt.error}`
  const verdict = attempt.verdict ?? 'ANALYSIS_UNAVAILABLE'
  const action = verdict === 'PASS' ? 'deliver'
    : verdict === 'REGENERATION_REQUIRED' ? 'reject'
      : 'held back'
  return `Attempt ${attempt.attempt} → ${verdict} → ${action}`
}
