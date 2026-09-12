/**
 * The neural engine is for signed-in visitors only.
 *
 * The Space generates for an account it can name and refuses everyone else
 * with a 401, so a signed-out visitor must be stopped here, clearly, before a
 * request that could only fail. Three things have to hold at once, and this
 * file tests all three because any one of them alone is a gap:
 *
 *   * the Generate button is disabled, so the obvious way in is closed;
 *   * a panel says why, and offers the one thing that helps;
 *   * the action itself refuses, so the ⌘/Ctrl + Enter shortcut — which never
 *     touches the button — cannot get past it.
 *
 * And the opposite claim, which matters just as much: the offline engine asks
 * for nothing, so blocking the neural one must not block it too.
 *
 * Hugging Face is stood in for and the Space is intercepted. Nothing here
 * reaches either, and no GPU allowance is spent.
 */

import { test, expect, type Page, type Route } from '@playwright/test'

import { signIn, TEST_HF_TOKEN, TEST_HF_USERNAME } from './helpers/hfSignIn'

/** Must match ACE_STEP_SPACE_URL in the build these tests run against. */
const SPACE = 'https://fake-space.hf.space'
const API = '/gradio_api'

interface FakeSpace {
  /** Generations the Space was asked for, and what each one carried. */
  joins: () => (string | undefined)[]
}

/**
 * A Space that answers `/config` and records every generation asked of it.
 *
 * It deliberately fails the generation itself: what these tests need to know
 * is whether a request was made and what credential it carried, and a real
 * song would only make them slower. The refusal is a 500 rather than a 401,
 * because a 401 means "the Space refused this sign-in" and the studio answers
 * that by ending the session — true behaviour, tested in
 * `auth-cookie-free.spec.ts`, and not what is being measured here.
 */
async function fakeSpace(page: Page): Promise<FakeSpace> {
  const joins: (string | undefined)[] = []
  await page.route(`${SPACE}/**`, async (route: Route) => {
    const path = new URL(route.request().url()).pathname
    if (path === '/config') {
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          version: '6.2.0', protocol: 'sse_v3', api_prefix: API, root: SPACE,
          dependencies: [{ id: 0, api_name: 'generate_music', queue: true, api_visibility: 'public', backend_fn: true }],
        }),
      })
    }
    if (path.includes('/queue/join')) {
      joins.push(route.request().headers()['authorization'])
    }
    return route.fulfill({ status: 500, contentType: 'text/plain', body: 'not what this test is about' })
  })
  return { joins: () => joins }
}

/** Skips when the build under test was not pointed at the stand-ins. */
async function openNeural(page: Page): Promise<void> {
  await page.goto('/')
  await page.getByRole('group', { name: 'Generation engine' })
    .getByRole('button', { name: 'Neural', exact: true }).click()
  const ready = await page.evaluate(() => ({
    space: document.body.innerText.includes('fake-space.hf.space'),
    client: Boolean(document.querySelector('[data-testid="hf-auth"]')),
  }))
  test.skip(!ready.space,
    'This build does not point at the fake Space. Rebuild with '
    + 'ACE_STEP_BACKEND=zerogpu ACE_STEP_SPACE_URL=https://fake-space.hf.space.')
  test.skip(!ready.client, 'The sign-in control is not on the page; VITE_HF_CLIENT_ID may be unset.')
}

/** Fills in enough of a brief that nothing else could refuse the generation. */
async function describeSong(page: Page): Promise<void> {
  await page.getByRole('button', { name: /Show controls|Hide controls/ }).click()
  await page.getByLabel('Style').fill('Indonesian dangdut koplo, dramatic male vocal')
  await page.getByLabel('Lyrics').fill('baris satu\nbaris dua')
}

test.describe('generating needs an account', () => {
  test('a signed-out visitor is blocked, and told why', async ({ page }) => {
    await fakeSpace(page)
    await openNeural(page)

    // The panel is the explanation, and it is not hidden in a tooltip.
    const panel = page.getByTestId('hf-signin-required')
    await expect(panel).toBeVisible()
    await expect(panel).toContainText(/Sign in with Hugging Face to use the neural engine/i)
    await expect(panel.getByRole('button', { name: /Sign in with Hugging Face/ })).toBeVisible()

    // The status line agrees with it, rather than claiming anything else.
    await expect(page.getByTestId('hf-auth')).toContainText(/Not signed in/i)
    await expect(page.getByTestId('hf-auth')).not.toContainText(TEST_HF_USERNAME)

    // And the ways to start a generation are closed.
    await expect(page.getByRole('button', { name: /^Generate song$/ })).toBeDisabled()
    await expect(page.getByRole('button', { name: /New take/ })).toBeDisabled()
  })

  test('nothing reaches the Space while signed out, not even by keyboard', async ({ page }) => {
    const space = await fakeSpace(page)
    await openNeural(page)
    await describeSong(page)

    // The shortcut never touches the button, so a disabled button cannot be
    // what stops it. The action has to refuse on its own.
    await page.getByLabel('Lyrics').click()
    await page.keyboard.press('Meta+Enter')
    await page.keyboard.press('Control+Enter')
    await page.getByLabel('Style').click()
    await page.keyboard.press('Meta+Enter')
    await page.keyboard.press('Control+Enter')

    // Scoped to the toast — the blocking panel carries the same sentence, and
    // matching that instead would pass without the shortcut being refused at
    // all. The toast is the studio answering this press.
    await expect(page.getByRole('status').filter({ hasText: /Sign in with Hugging Face/i }).first())
      .toBeVisible()
    expect(space.joins(), 'the Space was never asked to generate').toEqual([])
  })

  test('signing in unlocks generation, and the request carries the account', async ({ page }) => {
    const space = await fakeSpace(page)
    await openNeural(page)
    await describeSong(page)

    await signIn(page)

    // The block is gone, and the state is on the page rather than implied.
    await expect(page.getByTestId('hf-signin-required')).toHaveCount(0)
    await expect(page.getByTestId('hf-auth')).toContainText(`Signed in to Hugging Face as ${TEST_HF_USERNAME}`)
    await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible()

    const generate = page.getByRole('button', { name: /^(Generate song|Generating…)$/ })
    await expect(generate).toBeEnabled()
    await generate.click()
    await expect(generate).toBeEnabled({ timeout: 60_000 })

    expect(space.joins(), 'one generation, carrying the signed-in account')
      .toEqual([`Bearer ${TEST_HF_TOKEN}`])
  })

  test('an account the Space will not serve is told so, and stays signed in', async ({ page }) => {
    // The other half of the boundary. This visitor signed in correctly; they
    // are simply not the account the studio serves, so the Space answers 403.
    // Signing them out would delete the one fact that explains it.
    const refused = 'This Hugging Face account is not approved for this studio.'
    let joins = 0
    await page.route(`${SPACE}/**`, async (route: Route) => {
      const path = new URL(route.request().url()).pathname
      if (path === '/config') {
        return route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({
            version: '6.2.0', protocol: 'sse_v3', api_prefix: API, root: SPACE,
            dependencies: [{ id: 0, api_name: 'generate_music', queue: true, api_visibility: 'public', backend_fn: true }],
          }),
        })
      }
      if (path.includes('/queue/join')) joins += 1
      return route.fulfill({
        status: 403, contentType: 'application/json', body: JSON.stringify({ detail: refused }),
      })
    })

    await openNeural(page)
    await describeSong(page)
    await signIn(page)
    await page.getByRole('button', { name: /^(Generate song|Generating…)$/ }).click()

    // The Space's own sentence, on the page rather than in a toast that goes.
    await expect(page.getByRole('alert').filter({ hasText: refused }))
      .toBeVisible({ timeout: 60_000 })
    await expect(page.getByRole('alert').filter({ hasText: /HTTP 403/ })).toBeVisible()

    // Still signed in: the session is valid, and who it belongs to is the
    // explanation. No sign-in is offered, because signing in again is not it.
    await expect(page.getByTestId('hf-auth')).toContainText(TEST_HF_USERNAME)
    await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible()
    await expect(page.getByTestId('hf-signin-required')).toHaveCount(0)

    // And it was asked once, not once per take.
    expect(joins, 'the refusal ended the run instead of being retried').toBe(1)
  })

  test('the offline engine is never blocked, because it asks for nobody', async ({ page }) => {
    const space = await fakeSpace(page)
    await openNeural(page)
    await expect(page.getByRole('button', { name: /^Generate song$/ })).toBeDisabled()

    // Same visitor, same signed-out state, the other engine.
    await page.getByRole('group', { name: 'Generation engine' })
      .getByRole('button', { name: 'Offline Procedural', exact: true }).click()

    await expect(page.getByTestId('hf-signin-required')).toHaveCount(0)
    await expect(page.getByRole('button', { name: /^Generate song$/ })).toBeEnabled()
    await describeSong(page)
    await page.getByRole('button', { name: /^Generate song$/ }).click()

    // It rendered here, in this browser, without asking anyone for anything:
    // a titled song and a transport reporting a real length.
    const title = page.getByRole('heading', { level: 2 }).first()
    await expect(title).toBeVisible({ timeout: 150_000 })
    await expect(title).not.toHaveText('')
    await expect(page.getByText(/0:00 \/ \d+:\d\d/)).toBeVisible()
    expect(space.joins(), 'the Space was not involved at all').toEqual([])
  })
})
