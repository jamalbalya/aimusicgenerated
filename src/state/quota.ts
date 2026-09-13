/**
 * The last thing Hugging Face said about the free GPU allowance.
 *
 * Module scope, like the sign-in: one copy of the truth, no storage API, and it
 * disappears with the page. That is not a limitation to work around — a quota
 * reading is only true for the moment it was taken, and one restored from disk
 * on the next visit would be stale in a way nobody could see.
 *
 * The same shape as `auth/hfOAuth` so `useSyncExternalStore` can read it, and
 * so there is one pattern in this codebase for "state that outlives a component
 * but not the tab".
 */

import { unknownQuota, type ZeroGpuQuota } from '../engine/providers/zeroGpuQuota'

let quota: ZeroGpuQuota = unknownQuota()

const listeners = new Set<(value: ZeroGpuQuota) => void>()

export function getQuota(): ZeroGpuQuota {
  return quota
}

export function subscribeToQuota(listener: (value: ZeroGpuQuota) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/**
 * Records a reading.
 *
 * Only called with something the provider actually said. A reading that learned
 * nothing is dropped rather than overwriting one that did: a later refusal with
 * unparseable wording must not erase a number that is still the best known.
 */
export function reportQuota(next: ZeroGpuQuota): void {
  if (next.source === 'unknown' && quota.source !== 'unknown') return
  quota = next
  for (const listener of listeners) listener(quota)
}

/** Forgets the reading. Used when a session ends, so nothing outlives it. */
export function clearQuota(): void {
  quota = unknownQuota()
  for (const listener of listeners) listener(quota)
}
