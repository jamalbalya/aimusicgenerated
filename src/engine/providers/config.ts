/**
 * Where the neural backend lives.
 *
 * Read once, from configuration rather than from anything that generates
 * music. A build for a public site can point at a hosted backend; a developer
 * running ACE-Step on their own machine points at localhost; a build with
 * neither is simply a studio with one engine, which still works.
 */

/** Vite replaces these at build time; absent in Node, hence the guards. */
function fromEnv(key: string): string | undefined {
  const env = (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env
  const value = env?.[key]
  return value && value.trim() ? value.trim() : undefined
}

export interface NeuralEngineConfig {
  /** Base URL of the ACE-Step API, without a trailing slash. */
  baseUrl: string
  apiKey?: string
  /** Whether a neural engine is configured at all. */
  configured: boolean
  /**
   * Set when the browser will refuse to reach this backend whatever it does,
   * so the studio can say why instead of probing an address it cannot use.
   */
  blockedReason?: string
}

/**
 * A page served over HTTPS cannot call an http:// backend — browsers block it
 * as mixed content before the request leaves. Probing anyway achieves nothing
 * except a console error on every page load of the deployed site, so detect it
 * and report the real reason instead.
 */
export function mixedContentReason(pageProtocol: string, baseUrl: string): string | undefined {
  if (pageProtocol !== 'https:') return undefined
  if (!/^http:\/\//i.test(baseUrl)) return undefined
  return 'This page is served over HTTPS, so the browser will not connect to an http:// backend. '
    + 'Serve ACE-Step over HTTPS, or run the studio locally.'
}

/** The address ACE-Step's own `run_api_server.sh` binds by default. */
export const DEFAULT_ACE_STEP_URL = 'http://127.0.0.1:8001'

export function neuralEngineConfig(): NeuralEngineConfig {
  const configured = (fromEnv('VITE_ACE_STEP_API_URL') ?? DEFAULT_ACE_STEP_URL).replace(/\/+$/, '')
  const apiKey = fromEnv('VITE_ACE_STEP_API_KEY')
  const protocol = typeof window !== 'undefined' ? window.location.protocol : 'http:'
  const blockedReason = mixedContentReason(protocol, configured)
  return {
    baseUrl: configured,
    ...(apiKey ? { apiKey } : {}),
    ...(blockedReason ? { blockedReason } : {}),
    // A public build with no address set still offers the engine, pointed at
    // localhost: someone running the backend on their own machine gets it
    // working with no configuration, and everyone else sees "not connected"
    // rather than a hidden feature.
    configured: true,
  }
}
