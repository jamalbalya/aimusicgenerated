/**
 * Reading the one place Hugging Face ever states an allowance figure.
 *
 * These are written from the position that the wording will change. Every
 * pattern is optional, a message that matches nothing must produce a reading
 * that knows nothing rather than an exception, and no number may ever be
 * invented to fill a gap.
 */

import { describe, expect, it } from 'vitest'

import {
  formatCountdown, LOW_QUOTA_SECONDS, parseDuration, parseQuotaNotice,
  quotaSeverity, secondsUntil, unknownQuota, usagePercentage,
} from '../../src/engine/providers/zeroGpuQuota'

const NOW = Date.UTC(2026, 8, 13, 12, 0, 0)

/** The real message, as ZeroGPU writes it. */
const REAL = 'You have exceeded your free ZeroGPU quota. 120s requested vs. 116s left. '
  + 'Try again in 13:21:21.'

describe('reading a ZeroGPU refusal', () => {
  it('takes the figures the provider actually stated', () => {
    const quota = parseQuotaNotice(REAL, { now: NOW })
    expect(quota.requestedSeconds).toBe(120)
    expect(quota.remainingSeconds).toBe(116)
    expect(quota.retryAfterSeconds).toBe(13 * 3600 + 21 * 60 + 21)
    expect(quota.retryAt).toBe(NOW + (13 * 3600 + 21 * 60 + 21) * 1000)
    expect(quota.source).toBe('error-response')
    expect(quota.isExact).toBe(true)
  })

  it('leaves the daily total unknown, because the refusal does not state one', () => {
    const quota = parseQuotaNotice(REAL, { now: NOW })
    // The refusal says what is *left*. Nothing in it says what the day started
    // with, so "used" cannot be subtracted from anything.
    expect(quota.totalSeconds).toBeNull()
    expect(quota.usedSeconds).toBeNull()
    expect(usagePercentage(quota)).toBeNull()
  })

  it('derives used only when a deployment states the total', () => {
    const quota = parseQuotaNotice(REAL, { now: NOW, totalSeconds: 300 })
    expect(quota.totalSeconds).toBe(300)
    expect(quota.usedSeconds).toBe(184)
    expect(usagePercentage(quota)).toBeCloseTo((184 / 300) * 100)
  })

  it('takes each half on its own when only one is there', () => {
    const left = parseQuotaNotice('Only 42s left on your allowance.', { now: NOW })
    expect(left.remainingSeconds).toBe(42)
    expect(left.requestedSeconds).toBeNull()
    expect(left.isExact).toBe(true)

    const wait = parseQuotaNotice('Rate limited. Try again in 90s.', { now: NOW })
    expect(wait.retryAfterSeconds).toBe(90)
    expect(wait.remainingSeconds).toBeNull()
  })

  it('knows nothing, rather than guessing, when the wording is unfamiliar', () => {
    for (const text of ['', '   ', 'Something went wrong.', 'GPU task aborted']) {
      const quota = parseQuotaNotice(text, { now: NOW })
      expect(quota.source).toBe('unknown')
      expect(quota.isExact).toBe(false)
      expect(quota.remainingSeconds).toBeNull()
      expect(quota.retryAt).toBeNull()
    }
  })

  it('never throws, whatever it is handed', () => {
    const hostile = [
      'left left left', '999999999999999999999s left', 'Try again in :::',
      'Try again in 99:99:99', '-5s left', 'NaNs requested vs. NaNs left',
      String.fromCharCode(0) + 'left',
    ]
    for (const text of hostile) {
      expect(() => parseQuotaNotice(text, { now: NOW })).not.toThrow()
    }
    // And nothing it produces is a number the interface cannot render.
    for (const text of hostile) {
      const quota = parseQuotaNotice(text, { now: NOW })
      for (const value of [quota.remainingSeconds, quota.requestedSeconds, quota.retryAfterSeconds]) {
        if (value !== null) expect(Number.isFinite(value)).toBe(true)
      }
    }
  })

  it('reads a wait however it is punctuated', () => {
    expect(parseDuration('13:21:21')).toBe(13 * 3600 + 21 * 60 + 21)
    expect(parseDuration('1:23:45')).toBe(5025)
    expect(parseDuration('3:20')).toBe(200)
    expect(parseDuration('45s')).toBe(45)
    expect(parseDuration('nothing here')).toBeNull()
  })
})

describe('what the banner shows', () => {
  it('counts down from an absolute instant, so sleeping does not skew it', () => {
    const retryAt = NOW + 90_000
    expect(secondsUntil(retryAt, NOW)).toBe(90)
    expect(secondsUntil(retryAt, NOW + 30_000)).toBe(60)
    // Away for an hour: the answer is zero, not "still 90".
    expect(secondsUntil(retryAt, NOW + 3_600_000)).toBe(0)
    expect(secondsUntil(null, NOW)).toBeNull()
  })

  it('never counts below zero', () => {
    expect(secondsUntil(NOW - 10_000, NOW)).toBe(0)
  })

  it('writes only the parts that carry information', () => {
    expect(formatCountdown(13 * 3600 + 21 * 60 + 10)).toBe('13h 21m 10s')
    expect(formatCountdown(70)).toBe('1m 10s')
    expect(formatCountdown(9)).toBe('9s')
    expect(formatCountdown(0)).toBe('0s')
    expect(formatCountdown(-1)).toBe('0s')
  })

  it('clamps the bar to 0-100 whatever the arithmetic says', () => {
    const over = { ...unknownQuota(NOW), totalSeconds: 300, usedSeconds: 900 }
    expect(usagePercentage(over)).toBe(100)
    const under = { ...unknownQuota(NOW), totalSeconds: 300, usedSeconds: -50 }
    expect(usagePercentage(under)).toBe(0)
    const nonsense = { ...unknownQuota(NOW), totalSeconds: 0, usedSeconds: 10 }
    expect(usagePercentage(nonsense)).toBeNull()
  })

  it('warns when the allowance is nearly gone and says so when it is', () => {
    const at = (remainingSeconds: number | null) => quotaSeverity({ ...unknownQuota(NOW), remainingSeconds })
    expect(at(null)).toBe('unknown')
    expect(at(300)).toBe('ok')
    expect(at(LOW_QUOTA_SECONDS)).toBe('ok')
    expect(at(LOW_QUOTA_SECONDS - 1)).toBe('low')
    expect(at(0)).toBe('exhausted')
  })
})

describe('the reading that is kept', () => {
  it('publishes to subscribers and forgets on clear', async () => {
    const { clearQuota, getQuota, reportQuota, subscribeToQuota } = await import('../../src/state/quota')
    clearQuota()
    const seen: number[] = []
    const stop = subscribeToQuota((value) => seen.push(value.remainingSeconds ?? -1))

    reportQuota(parseQuotaNotice(REAL, { now: NOW }))
    expect(getQuota().remainingSeconds).toBe(116)
    expect(seen).toEqual([116])

    clearQuota()
    expect(getQuota().source).toBe('unknown')
    stop()
    // Unsubscribed: a later reading reaches nobody.
    reportQuota(parseQuotaNotice(REAL, { now: NOW }))
    expect(seen).toEqual([116, -1])
  })

  it('does not let an unreadable refusal erase a figure that is still the best known', async () => {
    const { clearQuota, getQuota, reportQuota } = await import('../../src/state/quota')
    clearQuota()
    reportQuota(parseQuotaNotice(REAL, { now: NOW }))
    // A later refusal whose wording nothing recognises must not blank the one
    // real number anybody has.
    reportQuota(parseQuotaNotice('Something went wrong.', { now: NOW + 1000 }))
    expect(getQuota().remainingSeconds).toBe(116)
    clearQuota()
  })

  it('keeps no token and nothing token-shaped', async () => {
    const { clearQuota, getQuota, reportQuota } = await import('../../src/state/quota')
    clearQuota()
    reportQuota(parseQuotaNotice(`${REAL} hf_averyrealisticlookingtokenvalue`, { now: NOW }))
    const serialised = JSON.stringify(getQuota())
    expect(serialised).not.toMatch(/hf_[A-Za-z0-9]{10,}/)
    expect(serialised).not.toContain('Authorization')
    // Only numbers, a source and a timestamp — no free text at all.
    expect(Object.keys(getQuota()).sort()).toEqual([
      'isExact', 'remainingSeconds', 'requestedSeconds', 'retryAfterSeconds',
      'retryAt', 'source', 'totalSeconds', 'updatedAt', 'usedSeconds',
    ])
    clearQuota()
  })
})
