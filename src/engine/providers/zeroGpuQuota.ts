/**
 * What is actually known about the free ZeroGPU allowance, and how it is known.
 *
 * ## Where the numbers come from
 *
 * Hugging Face publishes no endpoint for a visitor's remaining ZeroGPU
 * allowance. Nothing in a successful generation carries it either: the Space's
 * own metadata reports GPU timings, model names and durations, and says nothing
 * about the quota. The one place a real number appears is the refusal, when the
 * allowance has already run out — ZeroGPU answers with an app error whose text
 * reads like:
 *
 *     You have exceeded your free ZeroGPU quota. 120s requested vs. 116s left.
 *     Try again in 13:21:21.
 *
 * So this module reads that, and only that. It never estimates a number and
 * presents it as the provider's, and every value it produces says where it came
 * from and whether it was stated or worked out.
 *
 * ## What stays unknown
 *
 * The refusal gives what is *left* and how long until it is back. It does not
 * give the daily total, so "used" cannot be subtracted from anything unless a
 * deployment states the total itself. Both stay `null` in that case, and the
 * interface says so rather than filling in a plausible-looking figure.
 */

/** Where a quota reading came from. Never a guess presented as a fact. */
export type ZeroGpuQuotaSource = 'error-response' | 'configured' | 'unknown'

export interface ZeroGpuQuota {
  /** Seconds of allowance left, as the provider stated it. */
  remainingSeconds: number | null
  /** Seconds the refused request asked for, when the refusal said. */
  requestedSeconds: number | null
  /** The daily allowance, only when a deployment states it. Never guessed. */
  totalSeconds: number | null
  /** total − remaining. Only when both are known, and derived, not stated. */
  usedSeconds: number | null
  /** How long the provider said to wait. */
  retryAfterSeconds: number | null
  /**
   * When the allowance is expected back, in milliseconds since the epoch.
   *
   * Absolute on purpose: a countdown computed from a stored duration drifts
   * whenever the tab is backgrounded or the machine sleeps, and this one is
   * always `retryAt − now`. It is an *expected retry time* worked out from the
   * provider's "try again in", not a reset instant the provider published.
   */
  retryAt: number | null
  source: ZeroGpuQuotaSource
  /** True when the provider stated these numbers rather than anyone deriving them. */
  isExact: boolean
  /** When this reading was taken, milliseconds since the epoch. */
  updatedAt: number
}

/** A reading that knows nothing, which is the honest state before any refusal. */
export function unknownQuota(now: number = Date.now()): ZeroGpuQuota {
  return {
    remainingSeconds: null,
    requestedSeconds: null,
    totalSeconds: null,
    usedSeconds: null,
    retryAfterSeconds: null,
    retryAt: null,
    source: 'unknown',
    isExact: false,
    updatedAt: now,
  }
}

/** A finite, non-negative number, or nothing. Guards every parsed figure. */
function seconds(value: number): number | null {
  return Number.isFinite(value) && value >= 0 ? value : null
}

/**
 * "13:21:21", "1:23:45", "3:20" or "45" — however the provider writes a wait.
 *
 * Read right to left, so two parts are minutes and seconds and three are hours,
 * minutes and seconds. Anything else is not a duration and is refused.
 */
export function parseDuration(text: string): number | null {
  const match = /(?:^|\s)(\d{1,3}(?::\d{1,2}){0,2}(?:\.\d+)?)\s*(s|sec|secs|seconds)?(?=\W|$)/i.exec(text)
  if (!match) return null
  const parts = match[1]!.split(':').map(Number)
  if (parts.some((part) => !Number.isFinite(part))) return null
  const total = parts.reduce((sum, part) => sum * 60 + part, 0)
  return seconds(total)
}

/**
 * Reads whatever a ZeroGPU refusal happens to say.
 *
 * Every field is independent: a message with only a wait, or only a remaining
 * figure, yields exactly that and leaves the rest null. Nothing here assumes
 * the wording stays as it is today — each pattern either matches or is skipped,
 * and a message that matches none produces a reading that knows nothing rather
 * than an exception.
 */
export function parseQuotaNotice(
  text: string,
  options: { now?: number; totalSeconds?: number | null } = {},
): ZeroGpuQuota {
  const now = options.now ?? Date.now()
  const quota = unknownQuota(now)
  if (typeof text !== 'string' || !text.trim()) return quota

  // "120s requested vs. 116s left" — the pair, in the order ZeroGPU writes it.
  const pair = /(\d+(?:\.\d+)?)\s*s(?:econds?)?\s+requested\s+vs\.?\s*(\d+(?:\.\d+)?)\s*s(?:econds?)?\s+left/i.exec(text)
  if (pair) {
    quota.requestedSeconds = seconds(Number(pair[1]))
    quota.remainingSeconds = seconds(Number(pair[2]))
  } else {
    // Either half may appear on its own.
    const left = /(\d+(?:\.\d+)?)\s*s(?:econds?)?\s+(?:left|remaining)/i.exec(text)
    if (left) quota.remainingSeconds = seconds(Number(left[1]))
    const asked = /(\d+(?:\.\d+)?)\s*s(?:econds?)?\s+requested/i.exec(text)
    if (asked) quota.requestedSeconds = seconds(Number(asked[1]))
  }

  // "Try again in 13:21:21." / "retry after 90s"
  const wait = /(?:try\s+again\s+in|retry(?:\s+after)?|available\s+again\s+in)\s*:?\s*([^.,;]+)/i.exec(text)
  if (wait) {
    const after = parseDuration(wait[1]!)
    if (after !== null) {
      quota.retryAfterSeconds = after
      quota.retryAt = now + after * 1000
    }
  }

  const total = options.totalSeconds ?? null
  if (total !== null && Number.isFinite(total) && total > 0) {
    quota.totalSeconds = total
    if (quota.remainingSeconds !== null) {
      // Derived, and the interface labels it as such: only `remaining` and the
      // wait were stated by the provider.
      quota.usedSeconds = Math.max(0, Math.round(total - quota.remainingSeconds))
    }
  }

  const learned = quota.remainingSeconds !== null
    || quota.requestedSeconds !== null
    || quota.retryAt !== null
  quota.source = learned ? 'error-response' : 'unknown'
  quota.isExact = learned
  return quota
}

/** Whole seconds left on a countdown, floored at zero. Never negative. */
export function secondsUntil(retryAt: number | null, now: number): number | null {
  if (retryAt === null || !Number.isFinite(retryAt)) return null
  return Math.max(0, Math.ceil((retryAt - now) / 1000))
}

/** "13h 21m 10s", "21m 10s", "10s" — only the parts that carry information. */
export function formatCountdown(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return '0s'
  const whole = Math.floor(totalSeconds)
  const hours = Math.floor(whole / 3600)
  const minutes = Math.floor((whole % 3600) / 60)
  const secs = whole % 60
  if (hours > 0) return `${hours}h ${minutes}m ${secs}s`
  if (minutes > 0) return `${minutes}m ${secs}s`
  return `${secs}s`
}

/** How much of the allowance is spent, 0–100, or nothing when unknowable. */
export function usagePercentage(quota: ZeroGpuQuota): number | null {
  const { totalSeconds, usedSeconds } = quota
  if (totalSeconds === null || usedSeconds === null || totalSeconds <= 0) return null
  return Math.min(100, Math.max(0, (usedSeconds / totalSeconds) * 100))
}

/** How alarming the reading is. Drives the banner's colour and nothing else. */
export type QuotaSeverity = 'unknown' | 'ok' | 'low' | 'exhausted'

/** Below this many seconds left, the allowance is worth warning about. */
export const LOW_QUOTA_SECONDS = 60

export function quotaSeverity(quota: ZeroGpuQuota): QuotaSeverity {
  const { remainingSeconds } = quota
  if (remainingSeconds === null) return 'unknown'
  if (remainingSeconds <= 0) return 'exhausted'
  if (remainingSeconds < LOW_QUOTA_SECONDS) return 'low'
  return 'ok'
}
