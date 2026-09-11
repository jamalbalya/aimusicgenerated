/**
 * Whether the neural engine is actually there.
 *
 * "Configured" and "running" are different things, and the interface must never
 * present the first as the second: a dot that says Connected because a URL is
 * set would be a lie told on every page load. So this asks the backend, and
 * says `checking` until it answers.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { authorizationHeader } from '../auth/hfOAuth'
import { createNeuralProvider, type NeuralBackend } from '../engine/providers'

export type NeuralConnection = 'checking' | 'connected' | 'disconnected'

export interface NeuralEngineStatus {
  connection: NeuralConnection
  /** Which neural backend this build talks to. */
  backend: NeuralBackend
  baseUrl: string
  /** The length Auto becomes, on a backend that has to be told one. */
  autoDuration?: number
  loadedModel?: string
  loadedLmModel?: string
  /** Why the browser cannot reach this backend, when that is the reason. */
  blockedReason?: string
  /** What went wrong on the last check, when the backend did not answer. */
  detail?: string
  /**
   * Whether the backend has answered at least once since the page opened. It
   * only ever goes from false to true, so the studio can adopt the neural
   * engine when it appears without dropping it when one check fails.
   */
  hasAnswered: boolean
  recheck: () => void
}

/** Re-probed on this interval so a backend started later is picked up. */
const RECHECK_MS = 20_000

export function useNeuralEngine(): NeuralEngineStatus {
  // One provider for the life of the hook, from the one factory that builds
  // them; created lazily so the constructor does not run on every render.
  // The provider borrows the bearer per request; signing out therefore stops
  // the next generation without the provider needing to be rebuilt.
  const [provider] = useState(() => createNeuralProvider(undefined, { authorization: authorizationHeader }))

  const [connection, setConnection] = useState<NeuralConnection>('checking')
  const [hasAnswered, setHasAnswered] = useState(false)
  const [facts, setFacts] = useState<{
    loadedModel?: string; loadedLmModel?: string; blockedReason?: string; detail?: string
  }>({})
  const mounted = useRef(true)

  const probe = useCallback(async () => {
    const status = await provider.status()
    if (!mounted.current) return
    setConnection(status.connected ? 'connected' : 'disconnected')
    setHasAnswered((answered) => answered || status.connected)
    setFacts({
      ...(status.loadedModel ? { loadedModel: status.loadedModel } : {}),
      ...(status.loadedLmModel ? { loadedLmModel: status.loadedLmModel } : {}),
      ...(status.blockedReason ? { blockedReason: status.blockedReason } : {}),
      ...(status.detail ? { detail: status.detail } : {}),
    })
  }, [provider])

  useEffect(() => {
    mounted.current = true
    void probe()
    const timer = setInterval(() => void probe(), RECHECK_MS)
    return () => {
      mounted.current = false
      clearInterval(timer)
    }
  }, [probe])

  const recheck = useCallback(() => {
    setConnection('checking')
    void probe()
  }, [probe])

  return {
    connection,
    hasAnswered,
    backend: provider.backend,
    baseUrl: provider.baseUrl,
    ...(provider.autoDuration !== undefined ? { autoDuration: provider.autoDuration } : {}),
    ...facts,
    recheck,
  }
}
