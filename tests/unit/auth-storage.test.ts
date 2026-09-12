/**
 * The sign-in keeps nothing.
 *
 * The access token, the PKCE verifier and the transaction state exist in one
 * tab's JavaScript heap and nowhere else. A reload signs the visitor out, and
 * that is the point: anything durable enough to survive a reload is durable
 * enough for something else to read.
 *
 * These are build-time assertions rather than behavioural ones. A test that
 * drove a login and then looked at `localStorage` would only prove the storage
 * was empty on that path; reading the source proves there is no path at all.
 * The companion end-to-end test then checks the real browser after a real
 * sign-in, because source that looks clean can still pull in a dependency that
 * is not.
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

const AUTH_SOURCE = readFileSync(new URL('../../src/auth/hfOAuth.ts', import.meta.url), 'utf8')

/** Storage a token must never reach. */
const FORBIDDEN = [
  'localStorage',
  'sessionStorage',
  'indexedDB',
  'document.cookie',
  'caches.open',
  'navigator.storage',
] as const

/** Comments describe the rule; only code can break it. */
function code(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('*') && !line.trim().startsWith('//'))
    .join('\n')
}

describe('the sign-in writes to no storage', () => {
  const executable = code(AUTH_SOURCE)

  for (const api of FORBIDDEN) {
    it(`never touches ${api}`, () => {
      expect(executable).not.toContain(api)
    })
  }

  it('keeps the token in a module variable and hands out only a header', () => {
    // The token is never exported. What leaves this module is a finished
    // header string, so nothing else can hold the raw value.
    expect(executable).toMatch(/let accessToken: string \| null = null/)
    expect(executable).not.toMatch(/export\s+(const|let|function)\s+accessToken/)
    expect(executable).toMatch(/export function authorizationHeader/)
  })

  it('clears the token, the identity and the transaction on sign-out', () => {
    const signOut = executable.slice(executable.indexOf('export function signOut'))
      .slice(0, executable.slice(executable.indexOf('export function signOut')).indexOf('\n}') + 2)
    expect(signOut).toContain('accessToken = null')
    expect(signOut).toContain('identity = null')
    expect(signOut).toContain('pending = null')
  })

  it('never puts a token in a URL', () => {
    // The token goes in a header. A URL is logged, referred and shared.
    expect(executable).not.toMatch(/access_token=\$\{/)
    expect(executable).not.toMatch(/[?&]token=/)
  })

  it('is not persisted through the store', () => {
    const store = readFileSync(new URL('../../src/state/store.ts', import.meta.url), 'utf8')
    expect(store).not.toContain('hfOAuth')
    expect(store).not.toContain('accessToken')
    // Zustand's persist middleware would write the whole slice to storage.
    expect(store).not.toContain('zustand/middleware')

    // The store does keep two things across reloads — the theme and the render
    // quality — through its own small helper. Those are display preferences and
    // may stay; the point is that the list is exactly those two, so a token
    // cannot quietly join them.
    const persisted = [...store.matchAll(/persist\((\w+),/g)].map((match) => match[1])
    expect([...new Set(persisted)].sort()).toEqual(['QUALITY_KEY', 'THEME_KEY'])
  })
})

describe('the password is typed on Hugging Face, and nowhere else', () => {
  const executable = code(AUTH_SOURCE)

  it('this application has no password field at all', () => {
    // The requirement is not "our password form is careful". It is that the
    // password never reaches this origin, so the only safe number of password
    // fields in this source tree is none.
    const source: string[] = []
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name)
        if (entry.isDirectory()) walk(path)
        else if (/\.(ts|tsx|html|css)$/.test(entry.name)) source.push(readFileSync(path, 'utf8'))
      }
    }
    walk(new URL('../../src/', import.meta.url).pathname)
    const executableSource = source.map(code).join('\n')
    for (const shape of [
      /type=["']password["']/,
      /autocomplete=["'](current|new)-password["']/,
      /\bpassword\b/i,
      /\bcredentials\.password\b/,
    ]) {
      expect(executableSource, `${shape} must not appear in the frontend`).not.toMatch(shape)
    }
  })

  it('sends the visitor to the provider to type it, over https', () => {
    // The authorize endpoint is Hugging Face's own, discovered from its
    // OpenID document, and anything that is not https is refused in favour of
    // the documented path — so the login page cannot be moved by an answer.
    expect(executable).toContain('/.well-known/openid-configuration')
    expect(executable).toContain('/oauth/authorize')
    expect(executable).toMatch(/startsWith\('https:\/\/'\)/)
  })

  it('proves possession with PKCE rather than with any secret of its own', () => {
    expect(executable).toContain("code_challenge_method: 'S256'")
    expect(executable).toContain('code_verifier')
    expect(executable).toContain("response_type: 'code'")
    expect(executable).not.toContain('client_secret')
  })

  it('asks Hugging Face for the smallest thing that names the account', () => {
    // Enough to learn the username the Space checks, and nothing that could
    // write to the account or read a repository.
    expect(AUTH_SOURCE).toMatch(/SCOPES\s*=\s*'openid profile'/)
    for (const scope of ['write', 'repo', 'inference', 'email ']) {
      expect(AUTH_SOURCE.match(new RegExp(`SCOPES = '[^']*${scope}`))).toBeNull()
    }
  })
})

describe('nothing else in the app reaches for the token', () => {
  it('only the two known places ask for the header', () => {
    const root = new URL('../../src/', import.meta.url).pathname
    const callers: string[] = []
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name)
        if (entry.isDirectory()) walk(path)
        else if (/\.tsx?$/.test(entry.name) && !path.endsWith('auth/hfOAuth.ts')) {
          if (readFileSync(path, 'utf8').includes('authorizationHeader')) callers.push(path.slice(root.length))
        }
      }
    }
    walk(root)
    // Pinned, so a third caller is a deliberate change rather than a drift.
    // Both are in the interface layer: nothing in `engine/` reaches for a token.
    expect(callers.sort()).toEqual(['ui/pages/StudioPage.tsx', 'ui/useNeuralEngine.ts'])
    expect(callers.every((path) => path.startsWith('ui/'))).toBe(true)
  })
})

describe('the built bundle keeps nothing either', () => {
  const dist = new URL('../../dist/assets/', import.meta.url).pathname

  it('ships no source maps for anything to be read out of', () => {
    const distRoot = new URL('../../dist/', import.meta.url).pathname
    if (!existsSync(distRoot)) return
    const maps: string[] = []
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name)
        if (entry.isDirectory()) walk(path)
        else if (entry.name.endsWith('.map')) maps.push(entry.name)
      }
    }
    walk(distRoot)
    expect(maps).toEqual([])
  })

  it('contains no OAuth client secret and no access token', () => {
    if (!existsSync(dist)) return
    const bundle = readdirSync(dist)
      .filter((name) => name.endsWith('.js'))
      .map((name) => readFileSync(join(dist, name), 'utf8'))
      .join('\n')
    // A public client has no secret, so any of these appearing means one was
    // added where it must never be.
    for (const shape of [
      /\bhf_[A-Za-z0-9]{20,}/,
      /client_secret/,
      /OAUTH_CLIENT_SECRET/,
      /ALLOWED_HF_USERS/,
    ]) {
      expect(bundle, `${shape} must not reach a public bundle`).not.toMatch(shape)
    }
  })
})
