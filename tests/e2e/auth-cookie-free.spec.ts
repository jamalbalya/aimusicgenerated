/**
 * Signing in leaves nothing behind.
 *
 * The claim being tested is not "the code does not call `document.cookie`" —
 * source can be read for that, and `tests/unit/auth-storage.test.ts` does. The
 * claim here is about the browser afterwards: a real sign-in runs, through a
 * real popup, and then every place a credential could have been left is looked
 * at. Cookies, both storages, IndexedDB, and the URL.
 *
 * Hugging Face is stood in for. Nothing here reaches it, no OAuth application
 * is involved and no ZeroGPU allowance is spent; what the stand-in has to be
 * faithful about is only the shape of the exchange, because the shape is what
 * decides where a credential could end up.
 */

import { test, expect, type Page, type Route } from '@playwright/test'

// The real origin, intercepted. Nothing leaves the browser — but using the
// production host is what proves the shipped `connect-src` actually permits the
// sign-in: an invented host would have been blocked by the page's own CSP,
// which is how the first run of this test failed.
const PROVIDER = 'https://huggingface.co'
const SPACE = 'https://fake-space.hf.space'
const TOKEN = 'hf_fake_access_token_for_tests_only'
const USERNAME = 'jamalbalya'

/** Serves the OAuth endpoints the sign-in discovers and calls. */
async function fakeProvider(page: Page): Promise<{ exchanges: () => number }> {
  let exchanges = 0
  await page.route(`${PROVIDER}/**`, async (route: Route) => {
    const url = new URL(route.request().url())

    if (url.pathname === '/.well-known/openid-configuration') {
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          authorization_endpoint: `${PROVIDER}/oauth/authorize`,
          token_endpoint: `${PROVIDER}/oauth/token`,
          userinfo_endpoint: `${PROVIDER}/oauth/userinfo`,
        }),
      })
    }

    // The consent screen. A real one asks; this one agrees at once and sends
    // the popup back to the callback the app asked it to use.
    if (url.pathname === '/oauth/authorize') {
      const redirect = url.searchParams.get('redirect_uri') ?? ''
      const state = url.searchParams.get('state') ?? ''
      // PKCE must be present, or this whole flow is not the one claimed.
      expect(url.searchParams.get('code_challenge_method')).toBe('S256')
      expect(url.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/)
      expect(url.searchParams.get('client_id')).toBeTruthy()
      const back = `${redirect}?code=fake-auth-code&state=${encodeURIComponent(state)}`
      return route.fulfill({
        contentType: 'text/html',
        body: `<!doctype html><meta http-equiv="refresh" content="0;url=${back}">`,
      })
    }

    if (url.pathname === '/oauth/token') {
      exchanges += 1
      const body = route.request().postData() ?? ''
      // A public client proves itself with the verifier, not a secret.
      expect(body).toContain('code_verifier=')
      expect(body).not.toContain('client_secret')
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ access_token: TOKEN, token_type: 'Bearer', expires_in: 3600 }),
      })
    }

    if (url.pathname === '/oauth/userinfo') {
      expect(route.request().headers()['authorization']).toBe(`Bearer ${TOKEN}`)
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ sub: 'user-1', preferred_username: USERNAME }),
      })
    }

    return route.fulfill({ status: 404, body: 'not a route this test serves' })
  })
  return { exchanges: () => exchanges }
}

/** Records what the Space was sent, so the header can be checked. */
async function watchSpace(page: Page): Promise<{ authHeaders: () => (string | undefined)[] }> {
  const authHeaders: (string | undefined)[] = []
  await page.route(`${SPACE}/**`, async (route: Route) => {
    const path = new URL(route.request().url()).pathname
    if (path.includes('/queue/join')) authHeaders.push(route.request().headers()['authorization'])
    if (path === '/config') {
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          version: '6.2.0', protocol: 'sse_v3', api_prefix: '/gradio_api', root: SPACE,
          dependencies: [{ id: 0, api_name: 'generate_music', queue: true, api_visibility: 'public', backend_fn: true }],
        }),
      })
    }
    // Everything else fails, because these tests are about which credential
    // travels rather than about songs. It fails with a server error and not a
    // 401 on purpose: a 401 means the Space refused this sign-in, and the
    // studio answers that by ending the session — which is the subject of its
    // own test below, and would end this one before it could sign out itself.
    return route.fulfill({ status: 500, contentType: 'text/plain', body: 'not what this test is about' })
  })
  return { authHeaders: () => authHeaders }
}

/** Skips when the build under test cannot sign in at all. */
async function requireSignIn(page: Page): Promise<void> {
  const ready = await page.evaluate(() =>
    Boolean(document.querySelector('[data-testid="login-page"]'))
    && document.body.innerText.includes('Sign in with Hugging Face'))
  test.skip(!ready, 'This build has no sign-in control; VITE_HF_CLIENT_ID may be unset.')
}

/** Skips when the signed-in build was not pointed at the stand-in Space. */
async function requireFakeSpace(page: Page): Promise<void> {
  const ready = await page.evaluate(() => document.body.innerText.includes('fake-space.hf.space'))
  test.skip(!ready,
    'This build does not point at the fake Space. Rebuild with '
    + 'ACE_STEP_BACKEND=zerogpu ACE_STEP_SPACE_URL=https://fake-space.hf.space.')
}

/**
 * Loads the login page, which is all a signed-out visitor gets.
 *
 * The engine cannot be chosen from here: the application does not exist until
 * the sign-in these tests are about has happened.
 */
async function openLogin(page: Page): Promise<void> {
  await page.goto('/')
  await requireSignIn(page)
}

/** Selects the neural engine, once the application is open. */
async function openNeural(page: Page): Promise<void> {
  await page.getByRole('group', { name: 'Generation engine' })
    .getByRole('button', { name: 'Neural', exact: true }).click()
  await requireFakeSpace(page)
}

/** Everywhere a credential could have been left, read from the live page. */
async function residue(page: Page) {
  return page.evaluate(async () => {
    const databases = typeof indexedDB.databases === 'function'
      ? (await indexedDB.databases()).map((d) => d.name ?? '')
      : []
    return {
      cookie: document.cookie,
      local: Object.entries(localStorage).map(([k, v]) => `${k}=${v}`),
      session: Object.entries(sessionStorage).map(([k, v]) => `${k}=${v}`),
      databases,
      url: location.href,
    }
  })
}

test.describe('signing in keeps nothing', () => {
  test('completes a real PKCE sign-in through a popup', async ({ page, context }) => {
    const provider = await fakeProvider(page)
    await watchSpace(page)
    // The popup is a separate page in the same context, and it needs the
    // provider routes too.
    context.on('page', (popup) => { void fakeProvider(popup) })

    await openLogin(page)
    // Nothing but the login page yet: this is the moment before a sign-in.
    await expect(page.getByTestId('login-page')).toBeVisible()

    await page.getByRole('button', { name: /Sign in with Hugging Face/ }).click()
    await expect(page.getByTestId('signed-in-as')).toContainText(USERNAME, { timeout: 30_000 })
    expect(provider.exchanges(), 'the code was exchanged exactly once').toBe(1)

    // Now the part that matters: what is left in the browser.
    const left = await residue(page)
    expect(left.cookie, 'the application sets no cookie at all').toBe('')
    expect(left.local.join('|'), 'no token in localStorage').not.toContain(TOKEN)
    expect(left.session.join('|'), 'no token in sessionStorage').not.toContain(TOKEN)
    expect(left.databases, 'no IndexedDB database was created').toEqual([])
    expect(left.url, 'no code or token in the address bar').not.toMatch(/code=|token=|state=/)

    // The only stored things are the two display preferences.
    const keys = (await page.evaluate(() => Object.keys(localStorage))).sort()
    expect(keys.filter((k) => !k.startsWith('resonant.'))).toEqual([])
    expect(keys.every((k) => k === 'resonant.theme' || k === 'resonant.quality')).toBe(true)

    // And Playwright's own view of cookie storage agrees.
    expect(await context.cookies()).toEqual([])
  })

  test('sends the bearer to the Space, and stops sending it after signing out', async ({ page, context }) => {
    await fakeProvider(page)
    const space = await watchSpace(page)
    context.on('page', (popup) => { void fakeProvider(popup) })

    await openLogin(page)
    await page.getByRole('button', { name: /Sign in with Hugging Face/ }).click()
    await expect(page.getByTestId('signed-in-as')).toContainText(USERNAME, { timeout: 30_000 })
    await openNeural(page)

    await page.getByRole('button', { name: /Show controls|Hide controls/ }).click()
    await page.getByLabel('Style').fill('Indonesian dangdut koplo')
    await page.getByLabel('Lyrics').fill('baris satu\nbaris dua')
    await page.getByRole('button', { name: /^(Generate song|Generating…)$/ }).click()
    await expect(page.getByRole('button', { name: /^(Generate song|Generating…)$/ })).toBeEnabled({ timeout: 60_000 })

    expect(space.authHeaders(), 'the Space was handed the bearer').toEqual([`Bearer ${TOKEN}`])

    // Signing out closes the whole application, so there is no second request
    // to make: the controls that could have made one are gone with it.
    await page.getByRole('button', { name: 'Sign out' }).first().click()
    await expect(page.getByTestId('login-page')).toBeVisible()
    await expect(page.getByRole('button', { name: /^Generate song$/ })).toHaveCount(0)
    expect(space.authHeaders(), 'no second request was made at all').toHaveLength(1)

    const left = await residue(page)
    expect(left.cookie).toBe('')
    expect(left.local.join('|')).not.toContain(TOKEN)
    expect(left.session.join('|')).not.toContain(TOKEN)
  })

  test('a sign-in the Space refuses ends the session, rather than being offered again', async ({ page, context }) => {
    await fakeProvider(page)
    // The gate's own answer for a bearer Hugging Face will not confirm — an
    // expired token, most often — taken from `poc/zerogpu-space/guard.py` and
    // confirmed against the live Space.
    const refusal = 'That Hugging Face sign-in is no longer valid. Sign in again.'
    await page.route(`${SPACE}/**`, async (route: Route) => {
      const path = new URL(route.request().url()).pathname
      if (path === '/config') {
        return route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({
            version: '6.2.0', protocol: 'sse_v3', api_prefix: '/gradio_api', root: SPACE,
            dependencies: [{ id: 0, api_name: 'generate_music', queue: true, api_visibility: 'public', backend_fn: true }],
          }),
        })
      }
      return route.fulfill({
        status: 401, contentType: 'application/json', body: JSON.stringify({ detail: refusal }),
      })
    })
    context.on('page', (popup) => { void fakeProvider(popup) })

    await openLogin(page)
    await page.getByRole('button', { name: /Sign in with Hugging Face/ }).click()
    await expect(page.getByTestId('signed-in-as')).toContainText(USERNAME, { timeout: 30_000 })
    await openNeural(page)

    await page.getByRole('button', { name: /Show controls|Hide controls/ }).click()
    await page.getByLabel('Style').fill('Indonesian dangdut koplo')
    await page.getByLabel('Lyrics').fill('baris satu\nbaris dua')
    await page.getByRole('button', { name: /^(Generate song|Generating…)$/ }).click()

    // The session is over — a refused sign-in ends it, and ending it closes the
    // whole application — so what the Space said has to be waiting on the login
    // page. Being returned to the door with no explanation would be worse than
    // the refusal itself.
    await expect(page.getByTestId('login-page')).toBeVisible({ timeout: 60_000 })
    await expect(page.getByTestId('login-problem')).toContainText(refusal)
    await expect(page.getByTestId('login-problem')).toContainText('HTTP 401')
    await expect(page.getByRole('button', { name: /Sign in with Hugging Face/ })).toBeVisible()
    // Nothing was kept anywhere, exactly as when signing out by hand.
    const left = await residue(page)
    expect(left.cookie).toBe('')
    expect(left.local.join('|')).not.toContain(TOKEN)
    expect(left.session.join('|')).not.toContain(TOKEN)
  })

  test('a reload signs the visitor out, because nothing was kept', async ({ page, context }) => {
    await fakeProvider(page)
    await watchSpace(page)
    context.on('page', (popup) => { void fakeProvider(popup) })

    await openLogin(page)
    await page.getByRole('button', { name: /Sign in with Hugging Face/ }).click()
    await expect(page.getByTestId('signed-in-as')).toContainText(USERNAME, { timeout: 30_000 })

    await page.reload()
    // Intended, not a defect: the session lived in a heap that no longer
    // exists, so the studio is shut again and asks to be opened.
    await expect(page.getByTestId('login-page')).toBeVisible()
    await expect(page.getByTestId('signed-in-as')).toHaveCount(0)
    expect((await residue(page)).cookie).toBe('')
  })
})
