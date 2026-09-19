/**
 * Vocal hints, from the outside.
 *
 * The property that matters is that the Style box is never edited on the
 * person's behalf. The chips keep their own state and are joined to the caption
 * when the request is built, so what these tests check is that the text they
 * typed comes back byte for byte while the hint reaches the Space.
 */

import { test, expect, type Page, type Route } from '@playwright/test'

import { signIn } from './helpers/hfSignIn'

const SPACE = 'https://fake-space.hf.space'
const API = '/gradio_api'
const STYLE = 'Romantic melancholic jazz ballad, 72 BPM, soulful soft male vocal'
const BARITONE = 'warm male baritone lead vocal, comfortable low-to-mid range, natural chest voice'

async function space(page: Page): Promise<() => unknown> {
  let body: unknown = null
  await page.route(`${SPACE}/**`, (route: Route) => {
    const path = new URL(route.request().url()).pathname
    if (path === '/config') {
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({
        version: '6.2.0', protocol: 'sse_v3', api_prefix: API, root: SPACE,
        dependencies: [{ id: 0, api_name: 'generate_music', queue: true, api_visibility: 'public', backend_fn: true }],
      }) })
    }
    if (path === `${API}/queue/join`) {
      body = route.request().postDataJSON()
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ event_id: 'e1' }) })
    }
    return route.fulfill({ status: 404, body: 'not served' })
  })
  return () => body
}

async function studio(page: Page): Promise<void> {
  await page.goto('/')
  await signIn(page)
  await page.getByRole('group', { name: 'Generation engine' })
    .getByRole('button', { name: 'Neural', exact: true }).click()
  await signIn(page)
}

test.describe('vocal hints', () => {
  test('are off until chosen, and say they are only hints', async ({ page }) => {
    await space(page)
    await studio(page)
    for (const id of ['baritone', 'tenor', 'soft-vibrato']) {
      await expect(page.getByTestId(`vocal-hint-${id}`)).toHaveAttribute('aria-pressed', 'false')
    }
    await expect(page.getByText(/do not\s+make the model sing a particular note/)).toBeVisible()
  })

  test('never edit what was typed, and reach the Space in the caption', async ({ page }) => {
    const sent = await space(page)
    await studio(page)
    await page.getByLabel('Style').fill(STYLE)
    await page.getByLabel('Lyrics').fill('[Verse 1]\nMalam turun perlahan')

    await page.getByTestId('vocal-hint-baritone').click()
    await expect(page.getByTestId('vocal-hint-baritone')).toHaveAttribute('aria-pressed', 'true')
    // The box still holds exactly what was typed.
    await expect(page.getByLabel('Style')).toHaveValue(STYLE)
    await expect(page.getByTestId('composed-style')).toContainText(BARITONE)

    await page.getByRole('button', { name: /^Generate song$/ }).click()
    await expect.poll(() => (sent() as { data?: string[] } | null)?.data?.[0] ?? '')
      .toContain(BARITONE)
    const caption = (sent() as { data: string[] }).data[0]!
    expect(caption.startsWith(STYLE), 'the caption must begin with their own words').toBe(true)
    // Eleven inputs now: ACE-Step 1.5's metadata parameters and the target
    // melody joined the six. The property this line is for is unchanged — the
    // endpoint's shape is pinned, so a hint cannot quietly add a parameter.
    expect((sent() as { data: unknown[] }).data).toHaveLength(11)
  })

  test('unticking removes only that hint', async ({ page }) => {
    await space(page)
    await studio(page)
    await page.getByLabel('Style').fill(STYLE)
    await page.getByTestId('vocal-hint-baritone').click()
    await page.getByTestId('vocal-hint-sustained').click()
    await expect(page.getByTestId('composed-style')).toContainText(BARITONE)
    await expect(page.getByTestId('composed-style')).toContainText('sustained notes held evenly')

    await page.getByTestId('vocal-hint-baritone').click()
    await expect(page.getByTestId('composed-style')).not.toContainText(BARITONE)
    await expect(page.getByTestId('composed-style')).toContainText('sustained notes held evenly')
    await expect(page.getByLabel('Style')).toHaveValue(STYLE)

    // And with none left, the preview disappears and the caption is theirs again.
    await page.getByTestId('vocal-hint-sustained').click()
    await expect(page.getByTestId('composed-style')).toHaveCount(0)
    await expect(page.getByLabel('Style')).toHaveValue(STYLE)
  })

  test('count towards the caption budget, because they are part of the style', async ({ page }) => {
    await space(page)
    await studio(page)
    await page.getByLabel('Style').fill('b'.repeat(460))
    await expect(page.getByTestId('style-length')).toHaveText('460/512')
    await page.getByTestId('vocal-hint-baritone').click()

    // 460 + ", " + the hint = 542, which is past the caption. The counter still
    // follows what the style actually contains — that is the property this test
    // is for — but past the limit it reads as a compilation rather than an
    // overshoot, because a long style is now compiled down to a caption instead
    // of being refused. The hint competes for caption space; it no longer
    // trips a limit.
    const total = 460 + 2 + BARITONE.length
    expect(total).toBeGreaterThan(512)
    await expect(page.getByTestId('style-length')).toHaveText(`${total} → 512`)
  })

  test('are not offered by the offline engine, which cannot use them', async ({ page }) => {
    await space(page)
    await page.goto('/')
    await signIn(page)
    await page.getByRole('group', { name: 'Generation engine' })
      .getByRole('button', { name: 'Offline Procedural', exact: true }).click()
    await expect(page.getByTestId('vocal-hint-baritone')).toHaveCount(0)
  })
})
