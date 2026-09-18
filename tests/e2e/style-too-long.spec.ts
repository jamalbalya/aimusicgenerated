/**
 * A style ACE-Step cannot take, seen from the outside.
 *
 * The Space refuses a caption over 512 characters with an HTTP 400 whose text
 * never reaches the person who wrote it. These tests hold the studio to saying
 * so itself: while the style is being typed, and — if Generate is pressed
 * anyway — in a message that names the overshoot, without a job ever being
 * submitted. Nothing here reaches Hugging Face and no GPU allowance is spent.
 */

import { test, expect, type Page, type Route } from '@playwright/test'

import { signIn } from './helpers/hfSignIn'

const SPACE = 'https://fake-space.hf.space'
const API = '/gradio_api'

/** The brief from the 2026-09-17 investigation: 1457 characters, 945 too many. */
const OVER_LIMIT = 'a'.repeat(1457)
const WELL_UNDER = 'Indonesian cinematic alternative rock ballad, dark and emotional'

/** A Space that answers, and counts anything asked of it. */
async function countingSpace(page: Page): Promise<() => number> {
  let joins = 0
  await page.route(`${SPACE}/**`, async (route: Route) => {
    const path = new URL(route.request().url()).pathname
    if (path === '/config') {
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({
        version: '6.2.0', protocol: 'sse_v3', api_prefix: API, root: SPACE,
        dependencies: [{ id: 0, api_name: 'generate_music', queue: true, api_visibility: 'public', backend_fn: true }],
      }) })
    }
    if (path === `${API}/queue/join`) {
      joins += 1
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ event_id: 'event-1' }) })
    }
    return route.fulfill({ status: 404, body: 'not a route this test serves' })
  })
  return () => joins
}

const counter = (page: Page) => page.getByTestId('style-length')
const generateButton = (page: Page) =>
  page.getByRole('button', { name: /^(Generate song|Generating…)$/ })

async function openNeuralStudio(page: Page): Promise<void> {
  await page.goto('/')
  await signIn(page)
  await page.getByRole('group', { name: 'Generation engine' })
    .getByRole('button', { name: 'Neural', exact: true }).click()
  await signIn(page)
}

test.describe('a style too long for ACE-Step', () => {
  test('is counted on screen before Generate is ever pressed', async ({ page }) => {
    await countingSpace(page)
    await openNeuralStudio(page)

    // Nothing to say about a short style, so nothing is said.
    await page.getByLabel('Style').fill(WELL_UNDER)
    await expect(counter(page)).toHaveCount(0)

    // It appears as the limit comes into view...
    await page.getByLabel('Style').fill('b'.repeat(500))
    await expect(counter(page)).toHaveText('500/512')

    // ...and states the overshoot in words, not just in digits.
    await page.getByLabel('Style').fill(OVER_LIMIT)
    await expect(counter(page)).toHaveText('1457/512')
    await expect(page.getByTestId('style-length-detail'))
      .toHaveText('1457 characters, 945 over the 512 ACE-Step allows')
    await expect(page.getByTestId('style-length-detail')).toHaveRole('status')
    // The digits must not also answer to "Style": one control per name.
    await expect(page.getByLabel('Style')).toHaveCount(1)
  })

  test('is refused with the overshoot named, and nothing is sent to the Space', async ({ page }) => {
    const joins = await countingSpace(page)
    await openNeuralStudio(page)

    await page.getByLabel('Style').fill(OVER_LIMIT)
    await page.getByLabel('Lyrics').fill('[Verse 1]\nPerlawanan akan menyala')
    await generateButton(page).click()

    // The report is the panel, which names the stage and the code and stays
    // put. It is deliberately not also a toast: that would be the same sentence
    // twice, with the transient copy covering the panel's own buttons.
    await expect(page.getByTestId('engine-error-message'))
      .toHaveText(/ACE-Step takes at most 512\. Shorten it by 945\./)
    await expect(page.getByTestId('engine-error-code')).toHaveText('STYLE_TOO_LONG')
    // One take was asked for, so nothing should imply there were others.
    await expect(page.getByText(/^Take \d+:/)).toHaveCount(0)
    // The whole point: the allowance is untouched.
    expect(joins(), 'a refused style must not reach the Space').toBe(0)
    // And the studio is ready to try again rather than stuck mid-generation.
    await expect(generateButton(page)).toBeEnabled()
    await expect(generateButton(page)).toHaveText('Generate song')
  })

  test('says nothing about a limit the offline engine does not have', async ({ page }) => {
    await countingSpace(page)
    await page.goto('/')
    await signIn(page)
    // The studio moves onto the neural engine by itself once the backend
    // answers, so the offline engine has to be chosen explicitly here.
    await page.getByRole('group', { name: 'Generation engine' })
      .getByRole('button', { name: 'Offline Procedural', exact: true }).click()
    // Offline Procedural Mode: the caption never reaches ACE-Step, so a 1457
    // character style is simply a long description and the count would be a
    // limit invented for a backend that has none.
    await page.getByLabel('Style').fill(OVER_LIMIT)
    await expect(counter(page)).toHaveCount(0)
  })
})

test.describe('the studio says what it means', () => {
  test('renders no escape sequences in its own hints', async ({ page }) => {
    await countingSpace(page)
    await openNeuralStudio(page)
    // `\u2019` written inside a normal string literal is four characters, not an
    // apostrophe, and reached the screen that way. Nothing on this page should
    // ever show one.
    const body = await page.locator('body').innerText()
    expect(body).not.toMatch(/\\u[0-9a-fA-F]{4}/)
    await expect(page.getByText(/language\u2019s own vowels and consonants/)).toBeVisible()
  })
})
