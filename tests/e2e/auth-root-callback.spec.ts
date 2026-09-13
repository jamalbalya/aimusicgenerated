/**
 * The sign-in as Hugging Face actually performs it.
 *
 * Two things about the real provider were missing from the stand-in, and
 * together they were the whole of a production bug: the code comes back to the
 * application root rather than to a route of ours, and the authorize page
 * carries `Cross-Origin-Opener-Policy: same-origin`, which severs the popup
 * from the window that opened it. Severed, `window.opener` is null in the
 * popup and the handle the opener holds reports `closed` while the window sits
 * there on screen — so the popup re-rendered the login page and the opener
 * gave up with "The sign-in window was closed."
 *
 * A stand-in that redirects wherever it is asked to, over a response with no
 * opener policy, cannot fail that way and so proved nothing. This one does
 * both, and the assertion is not the shape of a URL: it is that the visitor
 * ends up inside the application.
 */

import { expect, test, type Page, type Route } from '@playwright/test'

const PROVIDER = 'https://huggingface.co'
const TOKEN = 'hf_fake_access_token_for_tests_only'
const USERNAME = 'jamalbalya'

/** Every redirect_uri the application asked for, in order. */
const asked: string[] = []

/**
 * Hugging Face, including the two behaviours that matter.
 *
 * `severOpener` puts the real opener policy on the authorize response. With it
 * off, this is the old stand-in, which is how the regression can be shown to
 * be a regression rather than a rewrite.
 */
async function routeProvider(page: Page, severOpener: boolean): Promise<void> {
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

    if (url.pathname === '/oauth/authorize') {
      const requested = url.searchParams.get('redirect_uri') ?? ''
      asked.push(requested)
      // The real provider returns the code to the registered URI, which is the
      // application root — not to whatever path the client might prefer.
      const back = `${requested}?code=fake-auth-code`
        + `&state=${encodeURIComponent(url.searchParams.get('state') ?? '')}`
      return route.fulfill({
        contentType: 'text/html',
        headers: severOpener
          ? { 'Cross-Origin-Opener-Policy': 'same-origin', 'Content-Type': 'text/html' }
          : { 'Content-Type': 'text/html' },
        body: `<!doctype html><meta http-equiv="refresh" content="0;url=${back}">`,
      })
    }

    if (url.pathname === '/oauth/token') {
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ access_token: TOKEN, token_type: 'Bearer', expires_in: 3600 }),
      })
    }
    if (url.pathname === '/oauth/userinfo') {
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ sub: 'user-1', preferred_username: USERNAME }),
      })
    }
    return route.fulfill({ status: 404, body: 'not a route this helper serves' })
  })
}

async function signInThrough(page: Page, severOpener: boolean): Promise<void> {
  asked.length = 0
  await routeProvider(page, severOpener)
  page.context().on('page', (popup) => { void routeProvider(popup, severOpener) })

  await page.goto('/')
  const button = page.getByRole('button', { name: /Sign in with Hugging Face/ })
  test.skip(await button.count() === 0, 'This build has no client id, so it cannot sign in.')
  await button.click()
}

test.describe('the sign-in comes back to the application root', () => {
  test('lets the visitor in even when the provider severs the popup', async ({ page }) => {
    await signInThrough(page, true)

    // The point of the whole exercise: the application, not the login page.
    await expect(page.getByTestId('signed-in-as')).toContainText(USERNAME, { timeout: 30_000 })

    // And the code is not left lying in the address bar.
    const url = new URL(page.url())
    expect(url.searchParams.get('code')).toBeNull()
    expect(url.searchParams.get('state')).toBeNull()
  })

  test('asks for exactly the registered redirect URI, trailing slash included', async ({ page, baseURL }) => {
    await signInThrough(page, true)
    await expect(page.getByTestId('signed-in-as')).toContainText(USERNAME, { timeout: 30_000 })

    // One spelling, sent to authorize; `auth-storage.test.ts` pins the same
    // builder against the production origin.
    expect(asked.length).toBeGreaterThan(0)
    expect(asked[0]).toBe(`${baseURL}/`)
    expect(asked[0]!.endsWith('/')).toBe(true)
  })

  test('still works when the opener survives, as it did before', async ({ page }) => {
    await signInThrough(page, false)
    await expect(page.getByTestId('signed-in-as')).toContainText(USERNAME, { timeout: 30_000 })
  })

  test('shows the provider refusing, and keeps the reason out of the URL', async ({ page }) => {
    asked.length = 0
    // Hugging Face when the visitor declines: no code, an error, back to the
    // same registered root.
    const deny = async (target: Page) => {
      await target.route(`${PROVIDER}/**`, async (route: Route) => {
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
        if (url.pathname === '/oauth/authorize') {
          const requested = url.searchParams.get('redirect_uri') ?? ''
          const back = `${requested}?error=access_denied`
            + `&error_description=${encodeURIComponent('The user denied the request')}`
            + `&state=${encodeURIComponent(url.searchParams.get('state') ?? '')}`
          return route.fulfill({
            headers: { 'Cross-Origin-Opener-Policy': 'same-origin', 'Content-Type': 'text/html' },
            body: `<!doctype html><meta http-equiv="refresh" content="0;url=${back}">`,
          })
        }
        return route.fulfill({ status: 404, body: 'not a route this helper serves' })
      })
    }
    await deny(page)
    page.context().on('page', (popup) => { void deny(popup) })

    await page.goto('/')
    const button = page.getByRole('button', { name: /Sign in with Hugging Face/ })
    test.skip(await button.count() === 0, 'This build has no client id, so it cannot sign in.')
    await button.click()

    // Said out loud, on the login page, in words rather than a code.
    await expect(page.getByTestId('login-problem')).toContainText(/did not approve/i, { timeout: 30_000 })
    // Still locked, and the refusal is not left in the address bar.
    await expect(page.getByTestId('signed-in-as')).toHaveCount(0)
    const url = new URL(page.url())
    expect(url.searchParams.get('error')).toBeNull()
    expect(url.searchParams.get('error_description')).toBeNull()
  })
})
