/**
 * Whether the neural engine is actually there.
 *
 * "Configured" and "running" are different things, and the interface must never
 * present the first as the second: a dot that says Connected because a URL is
 * set would be a lie told on every page load. So this asks the backend, and
 * says `checking` until it answers.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { AceStepProvider } from '../engine/providers'

export type NeuralConnection = 'checking' | 'connected' | 'disconnected'

export interface NeuralEngineStatus {
  connection: NeuralConnection
  baseUrl: string
  loadedModel?: string
  loadedLmModel?: string
  /** Why the browser cannot reach this backend, when that is the reason. */
  blockedReason?: string
  recheck: () => void
}

/** Re-probed on this interval so a backend started later is picked up. */
const RECHECK_MS = 20_000

export function useNeuralEngine(): NeuralEngineStatus {
  // One provider for the life of the hook; created lazily so the constructor
  // does not run on every render.
  const [provider] = useState(() => new AceStepProvider())

  const [connection, setConnection] = useState<NeuralConnection>('checking')
  const [models, setModels] = useState<{
    loadedModel?: string; loadedLmModel?: string; blockedReason?: string
  }>({})
  const mounted = useRef(true)

  const probe = useCallback(async () => {
    const status = await provider.status()
    if (!mounted.current) return
    setConnection(status.connected ? 'connected' : 'disconnected')
    setModels({
      ...(status.loadedModel ? { loadedModel: status.loadedModel } : {}),
      ...(status.loadedLmModel ? { loadedLmModel: status.loadedLmModel } : {}),
      ...(status.blockedReason ? { blockedReason: status.blockedReason } : {}),
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

  return { connection, baseUrl: provider.baseUrl, ...models, recheck }
}
