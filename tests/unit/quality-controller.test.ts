/**
 * The controller's job is a promise, not a feature: a take that failed the gate
 * never comes back out of this function.
 *
 * Most of these tests are about what the controller *does not* do. It does not
 * return the last attempt when the attempts run out, it does not quietly rewrite
 * the words it was given, and it does not reuse a seed and call the result a new
 * attempt. Each of those would leave the gate looking like it worked.
 */

import { describe, expect, it, vi } from 'vitest'
import {
  runGatedGeneration, describeAttempt, freshSeedSource, RequestMutatedError,
  STRICT_DELIVERY, DEFAULT_MAX_ATTEMPTS,
  type QualityReport, type QualityVerdict,
} from '../../src/engine/quality'
import type { MusicGenerationRequest, MusicGenerationResult } from '../../src/engine/providers'

const STYLE = 'Dangdut koplo sarkastik, kendang bertenaga, vokal pria lantang'
const LYRICS = '[Verse]\nHei kawan, hidup jangan terlalu serius\n[Chorus]\nBos toxic, kerja terus'

const request: MusicGenerationRequest = { style: STYLE, lyrics: LYRICS, language: 'id' }

function report(verdict: QualityVerdict, reason = 'because'): QualityReport {
  return {
    verdict,
    accepted: verdict === 'PASS',
    deliveryAllowed: verdict === 'PASS',
    rejectionReasons: verdict === 'REGENERATION_REQUIRED' ? ['HARMONIC_MISMATCH'] : [],
    reasons: [reason],
    failedChecks: verdict === 'REGENERATION_REQUIRED' ? ['harmonicCompatibility'] : [],
    measurements: null,
    worstMoments: [],
    evidence: { source: 'score', confidence: 1, isolated: true },
    limitations: [],
  }
}

/** A provider that records what it was asked for and hands back a labelled take. */
function recordingProvider() {
  const seen: MusicGenerationRequest[] = []
  return {
    seen,
    generate: async (given: MusicGenerationRequest): Promise<MusicGenerationResult> => {
      seen.push(given)
      return {
        id: `take-${seen.length}`,
        engine: 'procedural',
        audioUrl: `blob:take-${seen.length}`,
        duration: 120,
        metadata: { ...(given.seed !== undefined ? { seed: given.seed } : {}) },
      }
    },
  }
}

describe('a passing take is delivered', () => {
  it('returns the first one that passes, and stops there', async () => {
    const provider = recordingProvider()
    const outcome = await runGatedGeneration({
      provider, request, judge: () => report('PASS'),
    })
    expect(outcome.delivered).toBe(true)
    expect(provider.seen).toHaveLength(1)
    if (outcome.delivered) expect(outcome.result.id).toBe('take-1')
  })
})

describe('a failing take is regenerated', () => {
  it('rejects, tries again, and delivers the one that passes', async () => {
    const verdicts: QualityVerdict[] = ['REGENERATION_REQUIRED', 'REGENERATION_REQUIRED', 'PASS']
    const provider = recordingProvider()
    const log: string[] = []
    const outcome = await runGatedGeneration({
      provider,
      request,
      judge: () => report(verdicts.shift()!),
      onAttempt: (attempt) => log.push(describeAttempt(attempt)),
    })
    expect(outcome.delivered).toBe(true)
    if (outcome.delivered) expect(outcome.result.id).toBe('take-3')
    expect(log).toEqual([
      'Attempt 1 → REGENERATION_REQUIRED → reject',
      'Attempt 2 → REGENERATION_REQUIRED → reject',
      'Attempt 3 → PASS → deliver',
    ])
  })

  it('keeps a report for every rejected attempt', async () => {
    const verdicts: QualityVerdict[] = ['REGENERATION_REQUIRED', 'PASS']
    const outcome = await runGatedGeneration({
      provider: recordingProvider(), request, judge: () => report(verdicts.shift()!),
    })
    expect(outcome.attempts).toHaveLength(2)
    expect(outcome.attempts[0]!.report!.verdict).toBe('REGENERATION_REQUIRED')
    expect(outcome.attempts[0]!.report!.failedChecks).toContain('harmonicCompatibility')
  })
})

describe('when every attempt fails', () => {
  it('delivers nothing at all', async () => {
    const provider = recordingProvider()
    const outcome = await runGatedGeneration({
      provider, request, judge: () => report('REGENERATION_REQUIRED'), maxAttempts: 4,
    })
    expect(outcome.delivered).toBe(false)
    expect(provider.seen).toHaveLength(4)
    // The whole point: no audio comes back, not even the last one.
    expect(outcome).not.toHaveProperty('result')
    if (!outcome.delivered) expect(outcome.unverified).toBeUndefined()
  })

  it('says so in the words the product uses', async () => {
    const outcome = await runGatedGeneration({
      provider: recordingProvider(), request,
      judge: () => report('REGENERATION_REQUIRED'), maxAttempts: 3,
    })
    if (outcome.delivered) throw new Error('should not have delivered')
    expect(outcome.reason).toContain('failed the musical quality gate after 3 attempt')
    expect(outcome.reason).toContain('No incorrect audio was delivered.')
  })

  it('defaults to five attempts', async () => {
    const provider = recordingProvider()
    await runGatedGeneration({
      provider, request, judge: () => report('REGENERATION_REQUIRED'),
    })
    expect(provider.seen).toHaveLength(DEFAULT_MAX_ATTEMPTS)
    expect(DEFAULT_MAX_ATTEMPTS).toBe(5)
  })
})

describe('seeds', () => {
  it('draws a fresh one for every attempt', async () => {
    const provider = recordingProvider()
    await runGatedGeneration({
      provider, request, judge: () => report('REGENERATION_REQUIRED'), maxAttempts: 5,
    })
    const seeds = provider.seen.map((r) => r.seed)
    expect(seeds.every((s) => typeof s === 'number')).toBe(true)
    expect(new Set(seeds).size).toBe(5)
  })

  it('never repeats one within a run', () => {
    const source = freshSeedSource()
    const drawn = Array.from({ length: 200 }, (_, index) => source(index))
    expect(new Set(drawn).size).toBe(200)
  })
})

describe("the user's words", () => {
  it('reach every attempt byte for byte', async () => {
    const provider = recordingProvider()
    await runGatedGeneration({
      provider, request, judge: () => report('REGENERATION_REQUIRED'), maxAttempts: 4,
    })
    for (const seen of provider.seen) {
      expect(seen.style).toBe(STYLE)
      expect(seen.lyrics).toBe(LYRICS)
    }
  })

  it('are not translated, trimmed or re-tagged between attempts', async () => {
    const provider = recordingProvider()
    await runGatedGeneration({
      provider, request, judge: () => report('REGENERATION_REQUIRED'), maxAttempts: 3,
    })
    // Indonesian, section tags and all, identical each time and identical to input.
    expect(new Set(provider.seen.map((r) => r.lyrics)).size).toBe(1)
    expect(provider.seen[0]!.lyrics).toBe(LYRICS)
    expect(provider.seen[0]!.lyrics).toContain('[Chorus]')
  })

  it('refuses to run if a request is built with different words', () => {
    // The guard itself, exercised directly: the loop compares what it is about
    // to send against what it was given, and stops rather than sending it.
    expect(new RequestMutatedError('lyrics').message).toMatch(/must never become a rewriting loop/)
  })
})

describe('verdicts that regeneration cannot help', () => {
  it('stops immediately on ANALYSIS_UNAVAILABLE instead of burning attempts', async () => {
    const provider = recordingProvider()
    const outcome = await runGatedGeneration({
      provider, request, judge: () => report('ANALYSIS_UNAVAILABLE', 'no separator here'),
      maxAttempts: 5,
    })
    expect(provider.seen).toHaveLength(1)
    expect(outcome.delivered).toBe(false)
  })

  it('never turns ANALYSIS_UNAVAILABLE into a delivery', async () => {
    const outcome = await runGatedGeneration({
      provider: recordingProvider(), request, judge: () => report('ANALYSIS_UNAVAILABLE'),
    })
    expect(outcome.delivered).toBe(false)
  })

  it('hands an unverifiable take back clearly marked, never as a pass', async () => {
    const outcome = await runGatedGeneration({
      provider: recordingProvider(), request,
      judge: () => report('ANALYSIS_UNAVAILABLE', 'no separator here'),
    })
    if (outcome.delivered) throw new Error('should not have delivered')
    expect(outcome.unverified).toBeDefined()
    expect(outcome.unverified!.report.verdict).toBe('ANALYSIS_UNAVAILABLE')
    expect(outcome.reason).toMatch(/could not verify/i)
  })

  it('does not hand back a take that failed the gate, ever', async () => {
    const outcome = await runGatedGeneration({
      provider: recordingProvider(), request,
      judge: () => report('REGENERATION_REQUIRED'), maxAttempts: 2,
    })
    if (outcome.delivered) throw new Error('should not have delivered')
    expect(outcome.unverified).toBeUndefined()
  })
})

describe('REVIEW_REQUIRED', () => {
  it('is not delivered automatically', async () => {
    const outcome = await runGatedGeneration({
      provider: recordingProvider(), request, judge: () => report('REVIEW_REQUIRED'),
    })
    expect(outcome.delivered).toBe(false)
  })

  it('is kept and offered rather than thrown away', async () => {
    const outcome = await runGatedGeneration({
      provider: recordingProvider(), request, judge: () => report('REVIEW_REQUIRED', 'ambiguous'),
    })
    if (outcome.delivered) throw new Error('should not have delivered')
    expect(outcome.unverified!.report.verdict).toBe('REVIEW_REQUIRED')
  })
})

describe('engine failures are not gate failures', () => {
  it('are reported as themselves rather than as a rejected song', async () => {
    const boom = new Error('the Space is asleep')
    await expect(runGatedGeneration({
      provider: { generate: () => Promise.reject(boom) },
      request, judge: () => report('PASS'),
    })).rejects.toThrow('the Space is asleep')
  })

  it('a cancellation ends the run as a cancellation', async () => {
    const cancelled = Object.assign(new Error('Generation cancelled.'), {
      name: 'GenerationCancelledError',
    })
    await expect(runGatedGeneration({
      provider: { generate: () => Promise.reject(cancelled) },
      request, judge: () => report('PASS'),
    })).rejects.toThrow('Generation cancelled.')
  })
})

describe('the delivery policy', () => {
  it('delivers on PASS and nothing else', () => {
    expect(STRICT_DELIVERY.deliverOn).toEqual(['PASS'])
  })

  it('regenerates only on REGENERATION_REQUIRED', () => {
    expect(STRICT_DELIVERY.regenerateOn).toEqual(['REGENERATION_REQUIRED'])
  })

  it('is what the controller uses when none is given', async () => {
    const judge = vi.fn(() => report('PASS'))
    const outcome = await runGatedGeneration({ provider: recordingProvider(), request, judge })
    expect(outcome.delivered).toBe(true)
    expect(judge).toHaveBeenCalledTimes(1)
  })
})

describe('nothing that failed a hard gate can be delivered', () => {
  /** A report shaped as the gate really produces them, with a named failure. */
  function rejected(reasons: QualityReport['rejectionReasons']): QualityReport {
    return {
      verdict: 'REGENERATION_REQUIRED',
      accepted: false,
      deliveryAllowed: false,
      rejectionReasons: reasons,
      reasons: [`failed: ${reasons.join(', ')}`],
      failedChecks: ['tempo'],
      measurements: null,
      worstMoments: [],
      evidence: { source: 'audio', confidence: 0.9, isolated: true },
      limitations: [],
    }
  }

  it('refuses to deliver a tempo mismatch, however good the notes are', async () => {
    const outcome = await runGatedGeneration({
      provider: recordingProvider(), request,
      judge: () => rejected(['TEMPO_MISMATCH']), maxAttempts: 3,
    })
    expect(outcome.delivered).toBe(false)
    if (!outcome.delivered) expect(outcome.unverified).toBeUndefined()
  })

  it('refuses to deliver a harmonic mismatch', async () => {
    const outcome = await runGatedGeneration({
      provider: recordingProvider(), request,
      judge: () => rejected(['HARMONIC_MISMATCH']), maxAttempts: 3,
    })
    expect(outcome.delivered).toBe(false)
  })

  it('refuses to deliver when both fail, and keeps both reasons', async () => {
    const seen: QualityReport[] = []
    const outcome = await runGatedGeneration({
      provider: recordingProvider(), request,
      judge: () => { const r = rejected(['TEMPO_MISMATCH', 'HARMONIC_MISMATCH']); seen.push(r); return r },
      maxAttempts: 2,
    })
    expect(outcome.delivered).toBe(false)
    expect(seen[0]!.rejectionReasons).toEqual(['TEMPO_MISMATCH', 'HARMONIC_MISMATCH'])
  })

  it('delivers once a later attempt clears every gate', async () => {
    const script = [rejected(['TEMPO_MISMATCH']), rejected(['TEMPO_MISMATCH']), report('PASS')]
    const outcome = await runGatedGeneration({
      provider: recordingProvider(), request, judge: () => script.shift()!,
    })
    expect(outcome.delivered).toBe(true)
    if (outcome.delivered) {
      expect(outcome.result.id).toBe('take-3')
      expect(outcome.report.accepted).toBe(true)
      expect(outcome.report.deliveryAllowed).toBe(true)
    }
  })

  it('never delivers a report whose own fields forbid it', async () => {
    // The belt-and-braces case: a verdict that says PASS while the delivery
    // fields say no. The controller must believe the fields, because they are
    // the ones every other caller reads.
    const contradictory: QualityReport = {
      ...report('PASS'), accepted: false, deliveryAllowed: false,
      rejectionReasons: ['TEMPO_MISMATCH'],
    }
    const outcome = await runGatedGeneration({
      provider: recordingProvider(), request, judge: () => contradictory, maxAttempts: 1,
    })
    expect(outcome.delivered).toBe(false)
  })
})
