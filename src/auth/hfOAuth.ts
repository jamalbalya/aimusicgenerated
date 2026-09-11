/**
 * Signing in with Hugging Face, without storing anything.
 *
 * The access token lives in one place: a module-level variable in this tab's
 * JavaScript heap. Not `localStorage`, not `sessionStorage`, not IndexedDB, not
 * a cookie, not the URL, not the store. Closing the tab or reloading the page
 * ends the session, and that is the intended behaviour rather than a gap to
 * paper over — a token that survives a reload is a token that survives an
 * attacker reading whatever it survived in.
 *
 * ## Why a popup, and not a redirect
 *
 * Authorization Code with PKCE needs the `code_verifier` that started the
 * exchange to still be around when the authorization code comes back. A
 * same-tab redirect to Hugging Face destroys this tab's heap, so the verifier
 * would have to be written somewhere durable to survive — which is exactly what
 * is not allowed here.
 *
 * So the authorization request goes to a popup instead. This page is never
 * navigated away from, so it keeps the verifier and the state in memory the
 * whole time. The popup comes back to a callback route on this same origin,
 * hands over only the `code` and the `state`, and closes. The token exchange
 * happens here, in the opener.
 *
 * The cost is that signing in needs a real click and a popup that is not
 * blocked. There is deliberately no fallback: every fallback would need
 * durable storage.
 *
 * ## What is trusted
 *
 * Nothing here is a security boundary. The Space verifies the token against
 * Hugging Face on every request and decides for itself who may generate. This
 * module only gets a token and keeps it carefully; if it were bypassed
 * entirely, the Space would still refuse.
 */

const CONFIG = {
  clientId: readEnv('VITE_HF_CLIENT_ID'),
  provider: (readEnv('VITE_HF_PROVIDER_URL') || 'https://huggingface.co').replace(/\/+$/, ''),
} as const

/** Where the popup lands. Same origin, and a route this app answers. */
export const CALLBACK_PATH = '/auth/callback'

/** Least privilege: who you are, and nothing about your repositories. */
const SCOPES = 'openid profile'

function readEnv(key: string): string {
  const env = (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env
  const value = env?.[key]
  return typeof value === 'string' ? value.trim() : ''
}

export interface AuthIdentity {
  username: string
}

export type AuthStatus = 'signed-out' | 'signing-in' | 'signed-in'

export interface AuthState {
  status: AuthStatus
  identity?: AuthIdentity
  /** Why the last attempt failed, for the interface to show. Never a token. */
  problem?: string
}

/** True when this build was given the public client id it needs. */
export function isConfigured(): boolean {
  return CONFIG.clientId !== ''
}

/* --------------------------------------------------------- in-memory only --- */

// The whole of the session. Module scope, so it dies with the page. Nothing in
// this file writes to any storage API, and `tests/unit/auth-storage.test.ts`
// fails the build if that ever stops being true.
let accessToken: string | null = null
let identity: AuthIdentity | null = null
let state: AuthState = { status: 'signed-out' }

const listeners = new Set<(state: AuthState) => void>()

function publish(next: AuthState): void {
  state = next
  for (const listener of listeners) listener(state)
}

export function getAuthState(): AuthState {
  return state
}

export function subscribe(listener: (state: AuthState) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/**
 * The `Authorization` header for a request to the Space, when there is one.
 *
 * The token is handed out only as a finished header value, and only to the
 * caller that is about to send it, so it does not get copied into state,
 * logged, or serialised by accident.
 */
export function authorizationHeader(): string | undefined {
  return accessToken ? `Bearer ${accessToken}` : undefined
}

/**
 * Ends the session here and now.
 *
 * Drops the token, the identity and any half-finished sign-in. It does not
 * touch a running generation: the Space already accepted that request, the
 * result is still coming, and throwing it away would punish the wrong thing.
 * What logging out prevents is the *next* request, which is what it should.
 */
export function signOut(): void {
  accessToken = null
  identity = null
  pending = null
  publish({ status: 'signed-out' })
}

/* ------------------------------------------------------------------ PKCE --- */

const base64url = (bytes: Uint8Array): string => {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** 32 bytes from the platform CSPRNG, URL-safe. Used for verifier and state. */
function randomToken(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(32)))
}

async function challengeFor(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  return base64url(new Uint8Array(digest))
}

/* ------------------------------------------------------- provider lookup --- */

interface Endpoints {
  authorization: string
  token: string
  userinfo: string
}

let endpoints: Endpoints | null = null

/**
 * Where to send people, and where to exchange the code.
 *
 * Discovered from the provider rather than written down here, so a build does
 * not carry a guess about somebody else's URLs. The documented paths are the
 * fallback for a provider that serves no discovery document.
 */
async function discover(): Promise<Endpoints> {
  if (endpoints) return endpoints
  const fallback: Endpoints = {
    authorization: `${CONFIG.provider}/oauth/authorize`,
    token: `${CONFIG.provider}/oauth/token`,
    userinfo: `${CONFIG.provider}/oauth/userinfo`,
  }
  try {
    const response = await fetch(`${CONFIG.provider}/.well-known/openid-configuration`)
    if (response.ok) {
      const document = await response.json() as Record<string, unknown>
      const pick = (key: string, fall: string) =>
        typeof document[key] === 'string' && (document[key] as string).startsWith('https://')
          ? document[key] as string
          : fall
      endpoints = {
        authorization: pick('authorization_endpoint', fallback.authorization),
        token: pick('token_endpoint', fallback.token),
        userinfo: pick('userinfo_endpoint', fallback.userinfo),
      }
      return endpoints
    }
  } catch {
    // A provider that will not describe itself still has documented paths.
  }
  endpoints = fallback
  return endpoints
}

/* ------------------------------------------------------------ the flow ----- */

interface Pending {
  verifier: string
  state: string
}

/** The live transaction. Memory only, and cleared the moment it is finished. */
let pending: Pending | null = null

/** What the callback route sends back to this page. */
export interface CallbackMessage {
  source: 'resonant-hf-oauth'
  code: string
  state: string
}

function isCallbackMessage(value: unknown): value is CallbackMessage {
  if (typeof value !== 'object' || value === null) return false
  const message = value as Record<string, unknown>
  return message.source === 'resonant-hf-oauth'
    && typeof message.code === 'string'
    && typeof message.state === 'string'
}

/**
 * Runs the callback route, inside the popup.
 *
 * The popup's only job is to carry the code and the state back to the window
 * that started the sign-in. It holds no verifier and exchanges nothing, so
 * there is nothing here worth stealing, and it closes immediately.
 */
export function completeCallbackInPopup(search: string): boolean {
  if (typeof window === 'undefined' || !window.opener) return false
  const params = new URLSearchParams(search)
  const code = params.get('code')
  const returned = params.get('state')
  if (code && returned) {
    const message: CallbackMessage = { source: 'resonant-hf-oauth', code, state: returned }
    // Addressed to this exact origin, so the code cannot be posted anywhere else.
    window.opener.postMessage(message, window.location.origin)
  }
  window.close()
  return true
}

/** Waits for the popup to report back, or gives up. */
function awaitCallback(popup: Window, expected: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const finish = (fn: () => void) => {
      window.removeEventListener('message', onMessage)
      clearInterval(closedCheck)
      fn()
    }

    const onMessage = (event: MessageEvent) => {
      // Only this origin, only this window, only this transaction.
      if (event.origin !== window.location.origin) return
      if (event.source !== popup) return
      if (!isCallbackMessage(event.data)) return
      if (event.data.state !== expected) {
        finish(() => reject(new Error('The sign-in did not come back the way it went out.')))
        return
      }
      finish(() => resolve(event.data.code))
    }

    const closedCheck = setInterval(() => {
      if (popup.closed) finish(() => reject(new Error('The sign-in window was closed.')))
    }, 400)

    window.addEventListener('message', onMessage)
  })
}

/**
 * Signs in. Must be called straight from a click, or the popup is blocked.
 */
export async function signIn(): Promise<void> {
  if (!isConfigured()) {
    publish({ status: 'signed-out', problem: 'This build has no Hugging Face client id, so signing in is not set up.' })
    return
  }
  if (state.status === 'signing-in') return

  const verifier = randomToken()
  const transaction = randomToken()
  pending = { verifier, state: transaction }
  publish({ status: 'signing-in' })

  // Opened first, synchronously, so the browser still counts it as the click's
  // doing. Anything awaited before this and the popup is blocked.
  const popup = window.open('', 'hf-oauth', 'width=560,height=760,noopener=no,noreferrer=no')
  if (!popup) {
    pending = null
    publish({ status: 'signed-out', problem: 'Allow pop-ups for this site to sign in with Hugging Face.' })
    return
  }

  try {
    const where = await discover()
    const query = new URLSearchParams({
      client_id: CONFIG.clientId,
      response_type: 'code',
      redirect_uri: `${window.location.origin}${import.meta.env.BASE_URL.replace(/\/$/, '')}${CALLBACK_PATH}`,
      scope: SCOPES,
      state: transaction,
      code_challenge: await challengeFor(verifier),
      code_challenge_method: 'S256',
    })
    popup.location.replace(`${where.authorization}?${query.toString()}`)

    const code = await awaitCallback(popup, transaction)
    if (!pending || pending.state !== transaction) {
      throw new Error('That sign-in is no longer the one in progress.')
    }

    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      // A public client: there is no secret, which is the whole point of PKCE.
      client_id: CONFIG.clientId,
      redirect_uri: `${window.location.origin}${import.meta.env.BASE_URL.replace(/\/$/, '')}${CALLBACK_PATH}`,
      code_verifier: pending.verifier,
    })
    // The verifier and the code have both done their job by the time this
    // resolves; neither is kept.
    pending = null

    const response = await fetch(where.token, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: body.toString(),
    })
    if (!response.ok) {
      throw new Error('Hugging Face would not complete the sign-in.')
    }
    const granted = await response.json() as { access_token?: unknown }
    if (typeof granted.access_token !== 'string' || !granted.access_token) {
      throw new Error('Hugging Face did not return a usable sign-in.')
    }

    const who = await fetch(where.userinfo, {
      headers: { Authorization: `Bearer ${granted.access_token}`, Accept: 'application/json' },
    })
    if (!who.ok) throw new Error('Hugging Face would not say who signed in.')
    const profile = await who.json() as Record<string, unknown>
    const username = typeof profile.preferred_username === 'string' ? profile.preferred_username
      : typeof profile.name === 'string' ? profile.name : ''
    if (!username) throw new Error('Hugging Face did not return a username.')

    accessToken = granted.access_token
    identity = { username }
    publish({ status: 'signed-in', identity })
  } catch (error) {
    pending = null
    accessToken = null
    identity = null
    if (!popup.closed) popup.close()
    // The message is the interface's, and is never allowed to carry a token:
    // only messages written above reach here, never a response body.
    const problem = error instanceof Error && error.message ? error.message : 'Signing in did not work.'
    publish({ status: 'signed-out', problem })
  }
}
