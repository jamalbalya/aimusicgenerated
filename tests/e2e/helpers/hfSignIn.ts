/**
 * Signing in, for the tests that are about something else.
 *
 * The whole application is private now: a visitor who is not signed in sees a
 * login page and nothing else, so every spec begins here whatever its subject.
 * This stands in for Hugging Face so they can get through, without reaching it
 * and without an OAuth application existing.
 *
 * `auth-cookie-free.spec.ts` tests the sign-in itself and `auth-required.spec.ts`
 * tests the door. This is only the door being opened for everyone else.
 */

import { expect, type Page, type Route } from '@playwright/test'

/** The real origin, intercepted — the page's own CSP permits no other. */
const PROVIDER = 'https://huggingface.co'

export const TEST_HF_TOKEN = 'hf_fake_access_token_for_tests_only'
export const TEST_HF_USERNAME = 'jamalbalya'

/** Answers the OAuth endpoints on whichever page asks. */
export async function routeHuggingFace(page: Page): Promise<void> {
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
      const back = `${url.searchParams.get('redirect_uri') ?? ''}`
        + `?code=fake-auth-code&state=${encodeURIComponent(url.searchParams.get('state') ?? '')}`
      return route.fulfill({
        contentType: 'text/html',
        body: `<!doctype html><meta http-equiv="refresh" content="0;url=${back}">`,
      })
    }
    if (url.pathname === '/oauth/token') {
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ access_token: TEST_HF_TOKEN, token_type: 'Bearer', expires_in: 3600 }),
      })
    }
    if (url.pathname === '/oauth/userinfo') {
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ sub: 'user-1', preferred_username: TEST_HF_USERNAME }),
      })
    }
    return route.fulfill({ status: 404, body: 'not a route this helper serves' })
  })
}

/**
 * Signs in through the real popup flow, from the login page.
 *
 * Call it on a freshly loaded page: the login page is all there is until it
 * returns, and the application shell only exists afterwards. Does nothing when
 * the build has no client id — those builds cannot sign in at all, and the
 * caller skips for its own reasons.
 */
export async function signIn(page: Page): Promise<void> {
  await routeHuggingFace(page)
  // The popup is its own page in the same context, and needs the same answers.
  page.context().on('page', (popup) => { void routeHuggingFace(popup) })

  const button = page.getByRole('button', { name: /Sign in with Hugging Face/ })
  if (await button.count() === 0) return

  await button.click()
  // The proof that it worked is the application: the shell names the account.
  await expect(page.getByTestId('signed-in-as')).toContainText(TEST_HF_USERNAME, { timeout: 30_000 })
}

/** Loads the site and signs in, which is what every spec needs to begin. */
export async function openStudio(page: Page): Promise<void> {
  await page.goto('/')
  await signIn(page)
}
