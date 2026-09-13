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
  /**
   * Which accounts this build shows the application to. Same shape as the
   * Space's `ALLOWED_HF_USERS`, and deliberately the same names.
   *
   * This is not where the decision is made — the Space checks the allowlist
   * itself, on every request, against a token it verifies with Hugging Face,
   * and a browser cannot argue with it. This copy exists so a person who is
   * not the owner is told plainly instead of being handed an application that
   * refuses everything they touch. A username is not a secret; it is on the
   * account's public page.
   *
   * Unset means any verified account may see the application, which is what a
   * local build wants. The deployed build sets it.
   */
  allowed: readEnv('VITE_HF_ALLOWED_USERS'),
} as const

/**
 * Where the popup lands, and it is not a choice.
 *
 * An OAuth provider will only send a code to a URI registered against the
 * client id, character for character. The one registered for this application
 * is the site root *with its trailing slash* — checked against Hugging Face,
 * which rejects every other spelling of it, including the same path without
 * the slash:
 *
 *     https://jamalbalya.github.io/aimusicgenerated/   accepted
 *     https://jamalbalya.github.io/aimusicgenerated    Invalid redirect_uri
 *     https://jamalbalya.github.io/aimusicgenerated/auth/callback
 *                                                     Invalid redirect_uri
 *
 * So this is built from Vite's own base path — the same value the site is
 * served under — and always ends in exactly one slash. It must be sent
 * identically to the authorize endpoint and to the token endpoint, because the
 * provider compares the two.
 *
 * The consequence for the popup: it comes back to the application's own root
 * carrying `?code=`, rather than to a route of its own. `main.tsx` recognises
 * that and finishes the handshake before React starts.
 */
export function buildRedirectUri(origin: string, base: string): string {
  const path = base || '/'
  return `${origin}${path.endsWith('/') ? path : `${path}/`}`
}

export function redirectUri(): string {
  return buildRedirectUri(window.location.origin, import.meta.env.BASE_URL || '/')
}

/**
 * The same-origin channel the returning window answers on.
 *
 * `window.opener` is the obvious way back to the window that started the
 * sign-in, and it is not dependable. A provider serving
 * `Cross-Origin-Opener-Policy: same-origin` — Hugging Face does — moves the
 * popup into another browsing context group the moment it navigates there, and
 * coming back to our own origin does not undo it: `window.opener` is null in
 * the popup, and the handle the opener still holds reports `closed` while the
 * window is plainly on screen. That is the whole of the bug this replaces —
 * the popup sat there rendering the login page again, and the opener gave up
 * with "The sign-in window was closed."
 *
 * A BroadcastChannel needs no relationship between the windows. It is
 * same-origin by construction, so only our own pages can hear it; it keeps
 * nothing, so the no-storage rule is untouched; and it works whether or not the
 * opener survived.
 */
const CALLBACK_CHANNEL = 'resonant-hf-oauth'

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

/** Reads an allowlist in the Space's own format: comma or space separated. */
export function parseAllowedAccounts(raw: string): string[] {
  return raw.replace(/,/g, ' ').split(/\s+/).filter(Boolean).map((name) => name.toLowerCase())
}

/** The accounts this build admits, lowercased. Empty means "any verified one". */
export function allowedAccounts(): string[] {
  return parseAllowedAccounts(CONFIG.allowed)
}

/**
 * Whether a verified username may see the application.
 *
 * Case-insensitive, because Hugging Face keeps the capitalisation its owner
 * chose — `whoami` answers `Jamalbalya` for an allowlist that says
 * `jamalbalya` — and an account is not a different account for being written
 * differently. Matched whole: a name that merely contains an allowed one is
 * somebody else.
 */
export function accountAllowed(username: string | undefined, allowed: string[]): boolean {
  if (typeof username !== 'string' || !username.trim()) return false
  return allowed.length === 0 || allowed.includes(username.trim().toLowerCase())
}

export function mayEnter(username: string | undefined): boolean {
  return accountAllowed(username, allowedAccounts())
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
export function signOut(reason?: string): void {
  accessToken = null
  identity = null
  pending = null
  // A session ended by something other than the person — a token the Space
  // refused, most often — carries the reason out with it. Signing out closes
  // the whole application, so without this the visitor would land back on the
  // login page with no idea why they were sent there.
  publish(reason ? { status: 'signed-out', problem: reason } : { status: 'signed-out' })
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

/**
 * What a returning window passes to the window that started the sign-in.
 *
 * Either an authorization code or the provider's refusal, never both. The
 * `state` travels with it so the receiver can tell its own transaction from
 * anybody else's, which is the whole job that parameter exists to do.
 */
export type CallbackMessage =
  | { source: 'resonant-hf-oauth'; code: string; state: string }
  | { source: 'resonant-hf-oauth'; error: string; state: string }

function isCallbackMessage(value: unknown): value is CallbackMessage {
  if (typeof value !== 'object' || value === null) return false
  const message = value as Record<string, unknown>
  if (message.source !== 'resonant-hf-oauth') return false
  if (typeof message.state !== 'string') return false
  return typeof message.code === 'string' || typeof message.error === 'string'
}

/** What a returning window hands back, whichever door it comes through. */
export type CallbackOutcome =
  /** Not a callback at all. Load the application as usual. */
  | { kind: 'none' }
  /** Announced to whichever window is waiting. This one renders nothing. */
  | { kind: 'handed-off' }
  /** This window started it and is finishing it. Render progress, not a login. */
  | { kind: 'resuming' }
  /** Refused, or unfinishable here. Render, and say why. */
  | { kind: 'failed'; problem: string }

/** Parameters an authorization response may leave behind. */
const CALLBACK_PARAMS = ['code', 'state', 'error', 'error_description', 'error_uri'] as const

/**
 * Takes the authorization response out of the address bar.
 *
 * An authorization code is single-use and short-lived, but a URL is copied,
 * bookmarked, put in a screenshot and handed to the next page as a referrer.
 * It has done its job by the time this runs, so it should stop existing.
 */
function stripCallbackParams(): void {
  const url = new URL(window.location.href)
  if (!CALLBACK_PARAMS.some((key) => url.searchParams.has(key))) return
  for (const key of CALLBACK_PARAMS) url.searchParams.delete(key)
  const query = url.searchParams.toString()
  window.history.replaceState(null, '', `${url.pathname}${query ? `?${query}` : ''}${url.hash}`)
}

/**
 * Says the result out loud, through both doors.
 *
 * `postMessage` is immediate when the opener survived; the channel is what
 * works when it did not. Whichever arrives second is ignored, and if nobody is
 * listening this is simply a message nobody hears.
 */
function announce(message: CallbackMessage): void {
  try {
    window.opener?.postMessage(message, window.location.origin)
  } catch {
    // The opener is gone. That is the case the channel below exists for.
  }
  try {
    const channel = new BroadcastChannel(CALLBACK_CHANNEL)
    channel.postMessage(message)
    // Not closed here: delivery is asynchronous, and closing the channel — or
    // the window — before the task runs would throw the message away.
    window.setTimeout(() => channel.close(), CLOSE_DELAY_MS)
  } catch {
    // No BroadcastChannel. The opener was the only way, and was tried above.
  }
}

/** Long enough for a queued broadcast to be delivered before the window goes. */
const CLOSE_DELAY_MS = 150

/** The provider's own refusals, in words that belong to this interface. */
function describeFailure(code: string, description: string | null): string {
  if (code === 'access_denied') return 'You did not approve the sign-in, so nothing was shared.'
  if (code === 'invalid_scope') return 'This application asked Hugging Face for something it is not allowed.'
  // A description is the provider's text. It is shown because it is the only
  // thing that explains an unfamiliar code, and it can never contain a token:
  // this is the error branch, where no token was ever issued.
  const detail = description && description.trim() ? `: ${description.trim()}` : ''
  return `Hugging Face refused the sign-in (${code})${detail}`
}

/**
 * Deals with an authorization response, wherever it landed.
 *
 * Called before React starts, so a valid callback never flashes the login page
 * on its way through. It recognises the response by what the URL carries, not
 * by its path: the redirect URI registered for this client is the application
 * root, so there is no route of our own to match on.
 */
export function consumeCallback(
  search: string = typeof window === 'undefined' ? '' : window.location.search,
): CallbackOutcome {
  if (typeof window === 'undefined') return { kind: 'none' }
  const params = new URLSearchParams(search)
  const code = params.get('code')
  const returned = params.get('state')
  const failure = params.get('error')
  if (!code && !failure) return { kind: 'none' }

  if (failure) {
    const problem = describeFailure(failure, params.get('error_description'))
    announce({ source: 'resonant-hf-oauth', error: problem, state: returned ?? '' })
    stripCallbackParams()
    if (pending && returned && pending.state === returned) pending = null
    publish({ status: 'signed-out', problem })
    return { kind: 'failed', problem }
  }

  if (!code || !returned) {
    stripCallbackParams()
    const problem = 'That sign-in came back incomplete. Try it again.'
    publish({ status: 'signed-out', problem })
    return { kind: 'failed', problem }
  }

  // Said before anything else, so a waiting window hears it even when this one
  // turns out to be able to finish the job itself.
  announce({ source: 'resonant-hf-oauth', code, state: returned })
  stripCallbackParams()

  // Only the window that started the sign-in can complete it: the verifier
  // lives in one heap and is written nowhere. When that is this window — a
  // same-window return, or a popup that was never really separate — finish here.
  if (pending && pending.state === returned) {
    void finishHandshake(code)
    return { kind: 'resuming' }
  }

  // Otherwise another window owns this sign-in and has just been told. Go away
  // if allowed to; a severed popup may no longer be allowed to close itself,
  // and `main.tsx` shows a small notice rather than the login page if so.
  window.setTimeout(() => {
    try { window.close() } catch { /* not ours to close */ }
  }, CLOSE_DELAY_MS)
  return { kind: 'handed-off' }
}

/**
 * Waits for the sign-in to come back, from whichever window it comes back in.
 *
 * Three things changed here, and all three are the same bug: the popup that
 * goes to Hugging Face may no longer be the popup that comes back, as far as
 * this window can tell.
 *
 * It listens on the channel as well as for a message, because a severed
 * opener can only use the channel. It matches on the transaction rather than
 * on `event.source`, because the severed window is not the handle we hold —
 * `state` is the unguessable value that says whose sign-in this is, and it is
 * checked against exactly this attempt. And a closed window is given a grace
 * period rather than failing on the spot, because a severed handle reports
 * `closed` while its window is still open and working.
 */
function awaitCallback(popup: Window, expected: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false
    const channel = openChannel()

    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      window.removeEventListener('message', onWindowMessage)
      channel?.close()
      window.clearInterval(closedCheck)
      window.clearTimeout(graceTimer)
      window.clearTimeout(overallTimer)
      fn()
    }

    const accept = (data: unknown) => {
      if (!isCallbackMessage(data)) return
      // Not ours: another tab's sign-in, or a stale one. Keep waiting.
      if (data.state !== expected) return
      if ('error' in data) {
        finish(() => reject(new Error(data.error)))
        return
      }
      finish(() => resolve(data.code))
    }

    const onWindowMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return
      accept(event.data)
    }

    let graceTimer = 0
    // A handle that reports `closed` may mean the window really went, or may
    // mean the provider's opener policy severed it. Give the answer time to
    // arrive either way before calling it a failure.
    const closedCheck = window.setInterval(() => {
      if (!popup.closed || graceTimer) return
      graceTimer = window.setTimeout(
        () => finish(() => reject(new Error('The sign-in window closed before it finished.'))),
        CLOSED_GRACE_MS,
      )
    }, 400)

    // A backstop, so a sign-in that is never answered does not wait for ever.
    const overallTimer = window.setTimeout(
      () => finish(() => reject(new Error('The sign-in took too long. Try it again.'))),
      SIGN_IN_TIMEOUT_MS,
    )

    window.addEventListener('message', onWindowMessage)
    if (channel) channel.onmessage = (event) => accept(event.data)
  })
}

/** How long a broadcast gets to arrive after the window handle says it is gone. */
const CLOSED_GRACE_MS = 3_000

/** How long the whole sign-in gets before it is abandoned. */
const SIGN_IN_TIMEOUT_MS = 5 * 60_000

function openChannel(): BroadcastChannel | null {
  try {
    return new BroadcastChannel(CALLBACK_CHANNEL)
  } catch {
    return null
  }
}

/**
 * Turns an authorization code into a session.
 *
 * Shared by both ways the code can arrive: handed back by another window, or
 * found in this window's own address bar. It consumes `pending`, so it can run
 * exactly once per transaction, and the verifier is gone by the time the
 * exchange is on the wire.
 */
async function finishHandshake(code: string): Promise<void> {
  const transaction = pending
  if (!transaction) {
    publish({ status: 'signed-out', problem: 'That sign-in is no longer the one in progress.' })
    return
  }
  pending = null
  publish({ status: 'signing-in' })

  try {
    const where = await discover()
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      // A public client: there is no secret, which is the whole point of PKCE.
      client_id: CONFIG.clientId,
      // Character for character what the authorize request sent, because the
      // provider compares them.
      redirect_uri: redirectUri(),
      code_verifier: transaction.verifier,
    })

    const response = await fetch(where.token, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: body.toString(),
    })
    if (!response.ok) throw new Error('Hugging Face would not complete the sign-in.')
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
    accessToken = null
    identity = null
    // Only messages written above reach here, never a response body, so this
    // can never carry a token.
    const problem = error instanceof Error && error.message ? error.message : 'Signing in did not work.'
    publish({ status: 'signed-out', problem })
  }
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
      redirect_uri: redirectUri(),
      scope: SCOPES,
      state: transaction,
      code_challenge: await challengeFor(verifier),
      code_challenge_method: 'S256',
    })
    popup.location.replace(`${where.authorization}?${query.toString()}`)

    const code = await awaitCallback(popup, transaction)
    // `finishHandshake` checks that this is still the transaction in progress,
    // consumes it, and does the exchange. Both ways a code can arrive run
    // through it, so neither can drift away from the other.
    if (!popup.closed) popup.close()
    await finishHandshake(code)
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
