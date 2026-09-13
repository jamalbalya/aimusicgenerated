/**
 * The quota banner, in a real browser.
 *
 * The interesting parts are all behaviour rather than arithmetic — the sums are
 * covered in `tests/unit/zerogpu-quota.test.ts`. What is checked here is that
 * it appears without being asked for, that closing it lasts exactly as long as
 * the page does, that a real refusal puts a real figure in it, and that the
 * countdown is a live one rather than a number printed once.
 */

import { expect, test, type Page, type Route } from '@playwright/test'

import { signIn } from './helpers/hfSignIn'

const SPACE = 'https://fake-space.hf.space'
const API = '/gradio_api'

/** The refusal ZeroGPU sends, verbatim in shape. */
const QUOTA_MESSAGE = 'You have exceeded your free ZeroGPU quota. '
  + '120s requested vs. 116s left. Try again in 0:02:00.'

/** A Space that answers one generation with a spent allowance. */
async function spaceThatRefuses(page: Page, message: string = QUOTA_MESSAGE): Promise<void> {
  await page.route(`${SPACE}/**`, async (route: Route) => {
    const path = new URL(route.request().url()).pathname
    const frame = (payload: unknown): string => `data: ${JSON.stringify(payload)}\n\n`

    if (path === '/config') {
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          version: '6.2.0', protocol: 'sse_v3', api_prefix: API, root: SPACE,
          dependencies: [{ id: 0, api_name: 'generate_music', queue: true, api_visibility: 'public', backend_fn: true }],
        }),
      })
    }
    if (path === `${API}/queue/join`) {
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ event_id: 'event-1' }) })
    }
    if (path === `${API}/queue/data`) {
      return route.fulfill({
        contentType: 'text/event-stream',
        body: frame({
          msg: 'process_completed',
          event_id: 'event-1',
          success: false,
          title: 'ZeroGPU quota exceeded',
          output: { error: message },
        }) + frame({ msg: 'close_stream' }),
      })
    }
    return route.fulfill({ status: 404, body: 'not a route this test serves' })
  })
}

/** Signs in and lands on the Studio. The banner does not depend on the engine. */
async function enterStudio(page: Page): Promise<void> {
  await page.goto('/')
  // `signIn` does not return until the application is open, so there is
  // nothing further to wait for here. The sidebar that names the account is
  // desktop-only, which is why this does not look at it.
  await signIn(page)
}

/**
 * Selects the neural engine, and skips if this build was not pointed at the
 * stand-in Space — only the two tests that drive a generation need it.
 */
async function chooseNeural(page: Page): Promise<void> {
  await page.getByRole('group', { name: 'Generation engine' })
    .getByRole('button', { name: 'Neural', exact: true }).click()
  const configured = (await page.locator('body').innerText()).includes('fake-space.hf.space')
  test.skip(!configured, 'This build does not point at the fake Space.')
}

test.describe('the ZeroGPU quota banner', () => {
  test('is there without being asked for, and says what it does not know', async ({ page }) => {
    await enterStudio(page)
    const banner = page.getByTestId('zerogpu-quota-banner')
    await expect(banner).toBeVisible()
    // Nothing has been refused yet, and Hugging Face publishes no endpoint, so
    // the honest state is that there is no figure.
    await expect(page.getByTestId('zerogpu-quota-status'))
      .toContainText('Live quota information is unavailable')
    await expect(banner).not.toContainText('seconds')
  })

  test('closes for this page only, and comes back on the next one', async ({ page }) => {
    await enterStudio(page)
    const banner = page.getByTestId('zerogpu-quota-banner')
    await expect(banner).toBeVisible()

    await page.getByTestId('zerogpu-quota-dismiss').click()
    await expect(banner).toHaveCount(0)

    // Nothing was written anywhere, so a reload brings it straight back. The
    // reload also signs the visitor out, which is the point: a new session is
    // a new banner.
    await page.reload()
    await signIn(page)
    await expect(page.getByTestId('zerogpu-quota-banner')).toBeVisible()
  })

  test('keeps nothing about being closed', async ({ page, context }) => {
    await enterStudio(page)
    await page.getByTestId('zerogpu-quota-dismiss').click()
    await expect(page.getByTestId('zerogpu-quota-banner')).toHaveCount(0)

    const kept = await page.evaluate(() => ({
      local: Object.keys(localStorage),
      session: Object.keys(sessionStorage),
      cookie: document.cookie,
    }))
    const banner = /banner|quota|dismiss/i
    expect(kept.local.filter((key) => banner.test(key))).toEqual([])
    expect(kept.session.filter((key) => banner.test(key))).toEqual([])
    expect(banner.test(kept.cookie)).toBe(false)
    expect((await context.cookies()).filter((c) => banner.test(c.name))).toEqual([])
  })

  test('shows the figure a refusal stated, and counts down live', async ({ page }) => {
    await spaceThatRefuses(page)
    await enterStudio(page)

    await chooseNeural(page)
    await page.getByLabel('Style').fill('indonesian dangdut koplo, male vocal')
    await page.getByLabel('Lyrics').fill('[Verse]\nPagi datang hati berdebar')
    await page.getByRole('button', { name: 'Generate song' }).click()

    // The number the provider stated, not one this app worked out.
    await expect(page.getByTestId('quota-remaining')).toContainText('116 seconds', { timeout: 30_000 })
    await expect(page.getByTestId('zerogpu-quota-status')).toContainText('Last known value')
    // The daily total is not in the refusal, so it is not claimed.
    await expect(page.getByTestId('quota-total')).toContainText('not published')
    await expect(page.getByTestId('quota-used')).toContainText('not published')

    // Live: the same element reads lower a moment later, without a reload.
    const countdown = page.getByTestId('quota-countdown')
    const first = await countdown.innerText()
    await expect.poll(async () => countdown.innerText(), { timeout: 10_000 })
      .not.toBe(first)
  })

  test('says the allowance is back once the wait runs out, and stops counting', async ({ page }) => {
    // Two seconds, so the zero state is reachable inside a test rather than in
    // thirteen hours.
    await spaceThatRefuses(page, 'You have exceeded your free ZeroGPU quota. '
      + '120s requested vs. 0s left. Try again in 2s.')
    await enterStudio(page)
    await chooseNeural(page)
    await page.getByLabel('Style').fill('indonesian dangdut koplo, male vocal')
    await page.getByLabel('Lyrics').fill('[Verse]\nPagi datang hati berdebar')
    await page.getByRole('button', { name: 'Generate song' }).click()

    const countdown = page.getByTestId('quota-countdown')
    await expect(countdown).toBeVisible({ timeout: 30_000 })
    await expect(countdown).toContainText('Quota reset available', { timeout: 15_000 })

    // And it stays there: the timer stopped rather than counting into negatives.
    await page.waitForTimeout(2500)
    await expect(countdown).toContainText('Quota reset available')
    // Nothing was invented to replace the spent figure.
    await expect(page.getByTestId('quota-remaining')).toContainText('0 seconds')
  })

  test('puts no access token on the page', async ({ page }) => {
    await spaceThatRefuses(page)
    await enterStudio(page)
    await chooseNeural(page)
    await page.getByLabel('Style').fill('a short pop song')
    await page.getByLabel('Lyrics').fill('[Verse]\nPagi datang hati berdebar')
    await page.getByRole('button', { name: 'Generate song' }).click()
    await expect(page.getByTestId('quota-remaining')).toContainText('116 seconds', { timeout: 30_000 })

    const body = await page.locator('body').innerText()
    expect(body).not.toMatch(/hf_[A-Za-z0-9]{10,}/)
    expect(body).not.toContain('Bearer ')
    expect(body).not.toContain('Authorization')
  })
})
