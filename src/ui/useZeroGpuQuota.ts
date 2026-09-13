/**
 * The allowance, as React sees it, and the one second-hand that drives it.
 *
 * Two separate things, deliberately. The reading changes only when Hugging Face
 * says something; the countdown changes every second. Keeping them apart means
 * the ticker is the only thing re-rendering once a second, and it stops itself
 * the moment there is nothing left to count.
 */

import { useCallback, useSyncExternalStore } from 'react'

import type { ZeroGpuQuota } from '../engine/providers/zeroGpuQuota'
import { getQuota, subscribeToQuota } from '../state/quota'

/** The last reading, re-rendering the caller when a new one arrives. */
export function useZeroGpuQuota(): ZeroGpuQuota {
  return useSyncExternalStore(subscribeToQuota, getQuota, getQuota)
}

/**
 * Seconds until the allowance is expected back, recomputed every second.
 *
 * Always `retryAt − now` rather than a decremented counter, so a tab that was
 * backgrounded or a machine that slept comes back with the right number instead
 * of one that fell behind by however long it was away.
 *
 * `null` when there is nothing to wait for; `0` once the wait is over, which is
 * a state the caller shows rather than a reason to keep counting.
 */
/**
 * Seconds until the allowance is expected back, recomputed every second.
 *
 * A clock is what `useSyncExternalStore` is for: it changes outside React, it
 * must not be read as a side effect during render, and it needs one
 * subscription with one teardown. Every reading here is `deadline − now`
 * rather than a counter that decrements, so a tab that was backgrounded or a
 * machine that slept comes back with the right number instead of one that fell
 * behind by however long it was away.
 *
 * The interval lives inside `subscribe`, which is the only place allowed to
 * look at the clock. React tears it down on unmount and whenever the deadline
 * changes, so a second interval cannot appear beside the first, and the
 * interval clears itself once the deadline passes — a finished banner does no
 * work for the rest of the session.
 *
 * Returns `null` when there is nothing to wait for, and `0` once the wait is
 * over, which is a state to show rather than a reason to keep counting.
 */
export function useCountdown(retryAt: number | null): number | null {
  const deadline = retryAt === null ? null : Math.ceil(retryAt / 1000)

  const subscribe = useCallback((onChange: () => void) => {
    if (deadline === null) return () => { /* nothing to wait for, so no timer */ }
    if (Math.floor(Date.now() / 1000) >= deadline) {
      return () => { /* already over: nothing to count */ }
    }
    const id = setInterval(() => {
      onChange()
      if (Math.floor(Date.now() / 1000) >= deadline) clearInterval(id)
    }, 1000)
    return () => clearInterval(id)
  }, [deadline])

  const second = useSyncExternalStore(subscribe, () => Math.floor(Date.now() / 1000))
  if (deadline === null) return null
  return Math.max(0, deadline - second)
}
