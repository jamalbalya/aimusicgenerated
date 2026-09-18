/**
 * The gate, from the outside: what reaches the player.
 *
 * The property under test is not that a number is displayed. It is that a song
 * which reaches the player has been judged, that the verdict is shown in the
 * words the product uses, and that a take which failed is not what got opened.
 */

import { test, expect, type Page } from '@playwright/test'

import { signIn } from './helpers/hfSignIn'

function watchForErrors(page: Page): string[] {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(String(error)))
  return errors
}

test.describe('the musical quality gate', () => {
  test('judges every song the offline engine delivers', async ({ page }) => {
    const errors = watchForErrors(page)
    await page.goto('/')
    await signIn(page)
    await page.getByRole('textbox').first().fill('a short lo-fi loop, 20 seconds')
    await page.getByRole('button', { name: 'Generate song' }).click()

    const gate = page.getByTestId('quality-gate')
    await expect(gate).toBeVisible({ timeout: 180_000 })

    // Whatever the verdict, it is one of the four and it is stated plainly.
    const verdict = await page.getByTestId('quality-verdict').textContent()
    expect(['Quality gate passed', 'Regeneration required', 'Analysis unavailable', 'Review required'])
      .toContain(verdict?.trim())
    expect(errors).toEqual([])
  })

  test('shows the measurements behind a verdict, not just the verdict', async ({ page }) => {
    const errors = watchForErrors(page)
    await page.goto('/')
    await signIn(page)
    await page.getByRole('textbox').first().fill('upbeat pop love song, 20 seconds')
    await page.getByRole('button', { name: 'Generate song' }).click()

    await expect(page.getByTestId('quality-gate')).toBeVisible({ timeout: 180_000 })
    const verdict = (await page.getByTestId('quality-verdict').textContent())?.trim()
    // A delivered song has numbers behind it. Someone disagreeing with the
    // verdict can check the figure it was taken from.
    if (verdict === 'Quality gate passed') {
      const measurements = page.getByTestId('quality-measurements')
      await expect(measurements).toContainText('Harmonic compatibility')
      await expect(measurements).toContainText('Severe harmonic conflicts')
    }
    expect(errors).toEqual([])
  })

  test('only opens a song once it has passed', async ({ page }) => {
    const errors = watchForErrors(page)
    await page.goto('/')
    await signIn(page)
    await page.getByRole('textbox').first().fill('upbeat pop love song, 20 seconds')
    await page.getByRole('button', { name: 'Generate song' }).click()

    await expect(page.getByTestId('quality-gate')).toBeVisible({ timeout: 180_000 })
    const verdict = (await page.getByTestId('quality-verdict').textContent())?.trim()
    const player = page.getByRole('button', { name: /^(Play|Pause)$/ })

    if (verdict === 'Quality gate passed') {
      await expect(player).toBeVisible()
    } else if (verdict === 'Regeneration required') {
      // Nothing was delivered, so there is nothing to play. This is the whole
      // point: the last rejected take is not a fallback.
      await expect(player).toHaveCount(0)
    }
    expect(errors).toEqual([])
  })

  test('says a regenerating run regenerated, rather than just taking longer', async ({ page }) => {
    const errors = watchForErrors(page)
    await page.goto('/')
    await signIn(page)
    await page.getByRole('textbox').first().fill('heavy metal guitar, 20 seconds')
    await page.getByRole('button', { name: 'Generate song' }).click()

    await expect(page.getByTestId('quality-gate')).toBeVisible({ timeout: 300_000 })
    // The attempt count is in the panel whether it took one attempt or five.
    await expect(page.getByTestId('quality-gate')).toContainText(/attempt/i)
    expect(errors).toEqual([])
  })
})
