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

/** Skips when the build under test was not pointed at the stand-ins. */
async function requireFakes(page: Page): Promise<void> {
  const ready = await page.evaluate(() => ({
    space: document.body.innerText.includes('fake-space.hf.space'),
    client: Boolean(document.querySelector('[data-testid="hf-auth"]')),
  }))
  test.skip(!ready.space,
    'This build does not point at the fake Space. Rebuild with '
    + 'ACE_STEP_BACKEND=zerogpu ACE_STEP_SPACE_URL=https://fake-space.hf.space.')
  test.skip(!ready.client, 'The sign-in control is not on the page; VITE_HF_CLIENT_ID may be unset.')
}

async function openNeural(page: Page): Promise<void> {
  await page.goto('/')
  await page.getByRole('group', { name: 'Generation engine' })
    .getByRole('button', { name: 'Neural', exact: true }).click()
  await requireFakes(page)
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

    await openNeural(page)
    await expect(page.getByTestId('hf-auth')).toContainText(/Not signed in/i)

    await page.getByRole('button', { name: /Sign in with Hugging Face/ }).click()
    await expect(page.getByTestId('hf-auth')).toContainText(`Signed in to Hugging Face as ${USERNAME}`, {
      timeout: 30_000,
    })
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

    await openNeural(page)
    await page.getByRole('button', { name: /Sign in with Hugging Face/ }).click()
    await expect(page.getByTestId('hf-auth')).toContainText(USERNAME, { timeout: 30_000 })

    await page.getByRole('button', { name: /Show controls|Hide controls/ }).click()
    await page.getByLabel('Style').fill('Indonesian dangdut koplo')
    await page.getByLabel('Lyrics').fill('baris satu\nbaris dua')
    await page.getByRole('button', { name: /^(Generate song|Generating…)$/ }).click()
    await expect(page.getByRole('button', { name: /^(Generate song|Generating…)$/ })).toBeEnabled({ timeout: 60_000 })

    expect(space.authHeaders(), 'the Space was handed the bearer').toEqual([`Bearer ${TOKEN}`])

    // Signing out ends the ability to generate, not just the header.
    await page.getByRole('button', { name: 'Sign out' }).click()
    await expect(page.getByTestId('hf-auth')).toContainText(/Not signed in/i)
    await expect(page.getByTestId('hf-auth')).not.toContainText(USERNAME)

    // No second request goes out at all — signed out, there is nothing to send
    // and the Space would refuse it. The button says so by being disabled.
    await expect(page.getByRole('button', { name: /^Generate song$/ })).toBeDisabled()
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

    await openNeural(page)
    await page.getByRole('button', { name: /Sign in with Hugging Face/ }).click()
    await expect(page.getByTestId('hf-auth')).toContainText(USERNAME, { timeout: 30_000 })

    await page.getByRole('button', { name: /Show controls|Hide controls/ }).click()
    await page.getByLabel('Style').fill('Indonesian dangdut koplo')
    await page.getByLabel('Lyrics').fill('baris satu\nbaris dua')
    await page.getByRole('button', { name: /^(Generate song|Generating…)$/ }).click()

    // What the Space said, shown as it said it.
    await expect(page.getByRole('alert').filter({ hasText: refusal })).toBeVisible({ timeout: 60_000 })
    // And the session is over: the page no longer claims to be signed in, and
    // offers the one thing that can help.
    await expect(page.getByTestId('hf-auth')).not.toContainText(USERNAME)
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

    await openNeural(page)
    await page.getByRole('button', { name: /Sign in with Hugging Face/ }).click()
    await expect(page.getByTestId('hf-auth')).toContainText(USERNAME, { timeout: 30_000 })

    await page.reload()
    await page.getByRole('group', { name: 'Generation engine' })
      .getByRole('button', { name: 'Neural', exact: true }).click()
    // Intended, not a defect: the session lived in a heap that no longer exists.
    await expect(page.getByTestId('hf-auth')).toContainText(/Not signed in/i)
    expect((await residue(page)).cookie).toBe('')
  })
})
