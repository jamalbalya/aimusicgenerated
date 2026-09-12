/**
 * The studio is private, and the door is the whole of it.
 *
 * Not "the neural engine asks for an account" — the application does. A
 * visitor who is not signed in gets a login page and nothing else: no
 * navigation, no tools, no transport, and no offline engine, which runs in the
 * browser and would otherwise be the way around the door.
 *
 * These tests check the absence of things, which is the hard half. It is easy
 * to hide a feature and leave it reachable — by a deep link, by a keyboard
 * shortcut, by a control that is merely disabled — so each of those is tried
 * rather than assumed.
 *
 * The real boundary is the Space's, tested in `poc/zerogpu-space/test_guard.py`
 * and over real HTTP by `live_boundary_test.py`. This is the door in front of
 * it: on a static site it is what a visitor meets, not what stops a determined
 * one.
 *
 * Hugging Face is stood in for and the Space is intercepted. Nothing here
 * reaches either, and no GPU allowance is spent.
 */

import { test, expect, type Page, type Route } from '@playwright/test'

import { routeHuggingFace, signIn, TEST_HF_USERNAME } from './helpers/hfSignIn'

const SPACE = 'https://fake-space.hf.space'
const PROVIDER = 'https://huggingface.co'

/** Counts anything the page tries to ask of the Space. */
async function watchSpace(page: Page): Promise<{ calls: () => string[] }> {
  const calls: string[] = []
  await page.route(`${SPACE}/**`, async (route: Route) => {
    const url = new URL(route.request().url())
    calls.push(`${route.request().method()} ${url.pathname}`)
    return route.fulfill({ status: 500, contentType: 'text/plain', body: 'not what this test is about' })
  })
  return { calls: () => calls }
}

/** Every name the application shows once it is open, and never before. */
const APPLICATION = [
  'Generate song',
  'Neural',
  'Offline Procedural',
  'Lyric Writer',
  'Text to Speech',
  'Stem Splitter',
  'Voice Changer',
  'Audio Toolkit',
  'Library',
]

async function expectOnlyLoginPage(page: Page): Promise<void> {
  await expect(page.getByTestId('login-page')).toBeVisible()
  // One way in, and it is the only primary action on the page.
  await expect(page.getByRole('button', { name: 'Sign in with Hugging Face' })).toBeVisible()
  // The shell is not rendered: not hidden, not disabled — absent.
  await expect(page.getByRole('navigation', { name: 'Tools' })).toHaveCount(0)
  await expect(page.getByTestId('signed-in-as')).toHaveCount(0)
  for (const name of APPLICATION) {
    await expect(page.getByText(name, { exact: true }), `"${name}" must not be on the page`)
      .toHaveCount(0)
  }
  // And nothing anywhere on this origin asks for a password.
  await expect(page.locator('input[type="password"]')).toHaveCount(0)
}

test.describe('the application is private', () => {
  test('a first visit shows the login page and nothing else', async ({ page }) => {
    await page.goto('/')
    await expectOnlyLoginPage(page)
  })

  test('no tool can be reached by its own address', async ({ page }) => {
    // A deep link is the obvious way past a door that only guards the front.
    for (const path of ['/lyrics', '/voice', '/stems', '/shifter', '/toolkit', '/library', '/about']) {
      await page.goto(path)
      await expectOnlyLoginPage(page)
    }
  })

  test('neither engine can be used, and the Space is never asked', async ({ page }) => {
    const space = await watchSpace(page)
    await page.goto('/')

    // Neither the neural engine nor the offline one is on the page at all.
    await expect(page.getByRole('group', { name: 'Generation engine' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: /^Generate song$/ })).toHaveCount(0)

    // The keyboard shortcuts belong to controls that do not exist; pressing
    // them anyway must start nothing.
    await page.keyboard.press('Meta+Enter')
    await page.keyboard.press('Control+Enter')
    await page.waitForTimeout(500)

    await expectOnlyLoginPage(page)
    expect(space.calls(), 'the Space was never contacted').toEqual([])
  })

  test('signing in opens the application and names the account', async ({ page }) => {
    await page.goto('/')
    await signIn(page)

    // The shell is there, with the account it belongs to.
    await expect(page.getByTestId('signed-in-as')).toContainText(TEST_HF_USERNAME)
    await expect(page.getByRole('navigation', { name: 'Tools' }).first()).toBeVisible()
    await expect(page.getByRole('button', { name: /^Generate song$/ })).toBeVisible()
    await expect(page.getByRole('group', { name: 'Generation engine' })).toBeVisible()
    await expect(page.getByTestId('login-page')).toHaveCount(0)
  })

  test('signing out closes it again, at once', async ({ page }) => {
    await page.goto('/')
    await signIn(page)
    await expect(page.getByRole('button', { name: /^Generate song$/ })).toBeVisible()

    await page.getByRole('navigation', { name: 'Tools' }).first()
      .locator('xpath=..').getByRole('button', { name: 'Sign out' }).first()
      .click()

    await expectOnlyLoginPage(page)
  })

  test('a reload locks it again, because nothing was kept', async ({ page }) => {
    await page.goto('/')
    await signIn(page)
    // Asserted by what every viewport shows: the sidebar carrying the account
    // is hidden on a phone, so its visibility is not the thing to check.
    await expect(page.getByTestId('login-page')).toHaveCount(0)
    await expect(page.getByRole('button', { name: /^Generate song$/ })).toBeVisible()

    await page.reload()
    await expectOnlyLoginPage(page)
  })

  test('another Hugging Face account is signed in, and still kept out', async ({ page, context }) => {
    // The account is real and the sign-in works. It is simply not the one this
    // studio belongs to, so the application is not shown to it.
    const OTHER = 'someone-else'
    await routeHuggingFace(page)
    // Registered *after* the helper, because Playwright consults the most
    // recently added handler first: this one answers "who signed in" with a
    // different account and hands everything else back to the helper.
    await page.route(`${PROVIDER}/**`, async (route: Route) => {
      if (new URL(route.request().url()).pathname === '/oauth/userinfo') {
        return route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({ sub: 'user-2', preferred_username: OTHER }),
        })
      }
      return route.fallback()
    })
    context.on('page', (popup) => { void routeHuggingFace(popup) })

    await page.goto('/')
    const gate = page.getByTestId('login-page')
    await expect(gate).toBeVisible()
    await page.getByRole('button', { name: 'Sign in with Hugging Face' }).click()

    // Told plainly who they are and that it is not enough.
    await expect(gate).toContainText(OTHER, { timeout: 30_000 })
    await expect(gate).toContainText(/not the one this studio belongs to/i)
    // And none of the application came with them.
    await expect(page.getByRole('navigation', { name: 'Tools' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: /^Generate song$/ })).toHaveCount(0)
    // The way out is offered, and it returns them to the way in.
    await gate.getByRole('button', { name: 'Sign out' }).click()
    await expectOnlyLoginPage(page)
  })

  test('the sign-in goes to Hugging Face with the registered redirect URI', async ({ page, context }) => {
    await routeHuggingFace(page)
    context.on('page', (popup) => { void routeHuggingFace(popup) })
    await page.goto('/')

    const popupPromise = page.waitForEvent('popup')
    await page.getByRole('button', { name: 'Sign in with Hugging Face' }).click()
    const popup = await popupPromise
    await popup.waitForURL(/huggingface\.co/, { timeout: 30_000 })
    const url = new URL(popup.url())

    expect(url.origin, 'the password is typed on Hugging Face').toBe(PROVIDER)
    expect(url.pathname).toBe('/oauth/authorize')

    // The registered URI is the application root, with its trailing slash. The
    // live one is https://jamalbalya.github.io/aimusicgenerated/ — here the
    // origin is the preview server, and the rule is what is being checked.
    const redirect = url.searchParams.get('redirect_uri') ?? ''
    expect(redirect).toBe(new URL('/', page.url()).toString())
    expect(redirect.endsWith('/'), `${redirect} must end in a slash`).toBe(true)
    expect(redirect).not.toContain('/auth/callback')

    // PKCE, still, and no secret of ours anywhere near it.
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(url.searchParams.has('client_secret')).toBe(false)
    expect(url.searchParams.get('scope')).toBe('openid profile')
  })
})
