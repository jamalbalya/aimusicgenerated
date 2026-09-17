/**
 * Controls the neural request cannot carry.
 *
 * ACE-Step 1.5's endpoint takes six things: a caption, a lyric sheet, a
 * language, a voice, an instrumental flag and a length. Genre, mood, tempo,
 * key, singing voice, seed and stems are read only by the offline engine —
 * `generateNeural` never looks at them, and `planZeroGpuRequest` has no slot
 * for them.
 *
 * Seed was the worst of them. It said "The same seed and settings always
 * produce the same song", took what was typed, passed it to the provider, and
 * the provider dropped it; the Space then drew its own seed and that different
 * number was shown back with the result. Anyone who wrote it down and typed it
 * again got a different song.
 *
 * These tests hold every one of them to being visibly unavailable in Neural
 * Mode, and to still working in Offline Procedural Mode, where they are real.
 */

import { test, expect, type Page, type Route } from '@playwright/test'

import { signIn } from './helpers/hfSignIn'

const SPACE = 'https://fake-space.hf.space'
const API = '/gradio_api'

/**
 * Controls the neural endpoint has no parameter for, addressed by role: the
 * page also has a chip row for choosing a genre, so "Genre" alone is ambiguous.
 */
const IGNORED = [
  ['combobox', 'Genre'], ['combobox', 'Mood'], ['combobox', 'Root note'],
  ['combobox', 'Scale'], ['combobox', 'Singing voice'], ['textbox', 'Seed'],
] as const

async function answeringSpace(page: Page): Promise<void> {
  await page.route(`${SPACE}/**`, (route: Route) => {
    const path = new URL(route.request().url()).pathname
    if (path === '/config') {
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({
        version: '6.2.0', protocol: 'sse_v3', api_prefix: API, root: SPACE,
        dependencies: [{ id: 0, api_name: 'generate_music', queue: true, api_visibility: 'public', backend_fn: true }],
      }) })
    }
    return route.fulfill({ status: 404, body: 'not a route this test serves' })
  })
}

async function openControls(page: Page, engine: 'Neural' | 'Offline Procedural'): Promise<void> {
  await page.goto('/')
  await signIn(page)
  await page.getByRole('group', { name: 'Generation engine' })
    .getByRole('button', { name: engine, exact: true }).click()
  if (engine === 'Neural') await signIn(page)
  const toggle = page.getByRole('button', { name: /Show controls/ })
  if (await toggle.count()) await toggle.click()
}

test.describe('the neural engine does not pretend to take settings it cannot', () => {
  test('every control the endpoint has no parameter for is disabled', async ({ page }) => {
    await answeringSpace(page)
    await openControls(page, 'Neural')
    for (const [role, name] of IGNORED) {
      await expect(page.getByRole(role, { name }),
        `${name} must not be operable in Neural Mode`).toBeDisabled()
    }
    // Tempo and Stems are not labelled controls; they carry their own names.
    await expect(page.getByLabel('Tempo in beats per minute')).toBeDisabled()
    await expect(page.getByRole('group', { name: 'Render stems' })
      .getByRole('button').first()).toBeDisabled()
  })

  test('the Seed field stops promising a song can be repeated', async ({ page }) => {
    await answeringSpace(page)
    await openControls(page, 'Neural')
    // The old wording was a factual claim this backend cannot honour.
    await expect(page.getByText('The same seed and settings always produce the same song.'))
      .toHaveCount(0)
    await expect(page.getByText(/ACE-Step draws its own seed for every run/)).toBeVisible()
    await expect(page.getByRole('textbox', { name: 'Seed' }))
      .toHaveAttribute('placeholder', 'drawn by ACE-Step')
  })

  test('says where the neural engine does take its direction from', async ({ page }) => {
    await answeringSpace(page)
    await openControls(page, 'Neural')
    await expect(page.getByTestId('neural-ignores-note')).toBeVisible()
    await expect(page.getByTestId('neural-ignores-note'))
      .toHaveText(/The neural engine takes its direction from the Style text/)
    // Said once. Repeating it under every disabled control is noise.
    await expect(page.getByText(/takes its direction from the Style text/)).toHaveCount(1)
  })

  test('all of them still work on the offline engine, which does read them', async ({ page }) => {
    await answeringSpace(page)
    await openControls(page, 'Offline Procedural')
    for (const [role, name] of IGNORED) {
      await expect(page.getByRole(role, { name }), `${name} must stay usable offline`).toBeEnabled()
    }
    await expect(page.getByLabel('Tempo in beats per minute')).toBeEnabled()
    // And the honest wording comes back, because offline it is true.
    await expect(page.getByText('The same seed and settings always produce the same song.'))
      .toBeVisible()
    await page.getByRole('textbox', { name: 'Seed' }).fill('12345')
    await expect(page.getByRole('textbox', { name: 'Seed' })).toHaveValue('12345')
  })
})

test.describe('the result panel agrees with the control above it', () => {
  test('the About page scopes its seed promise to the engine that keeps it', async ({ page }) => {
    await answeringSpace(page)
    await page.goto('/about')
    await signIn(page)
    // True of the offline engine, and it may keep saying so — but it has to say
    // which engine, because Neural mode cannot honour it.
    await expect(page.getByText('The same seed always gives the same song.')).toBeVisible()
    await expect(page.getByRole('heading', { name: /Composition — the offline engine/ })).toBeVisible()
    await expect(page.getByText(/ACE-Step, which draws its own seed for every run/)).toBeVisible()
  })
})
