/**
 * What the rendered About page tells a visitor about where a song is made.
 *
 * The unit tests read the source, which covers the README and the page
 * metadata too. This reads the page as a person sees it, so a claim cannot
 * survive by being rendered from somewhere the source scan does not look.
 */

import { test, expect } from '@playwright/test'

import { signIn } from './helpers/hfSignIn'

const RETIRED = [
  /nothing\s+uploaded,?\s+ever/i,
  /no\s+daily\s+quota/i,
  /\bno\s+queue\b/i,
  /unlimited\s+generations,\s+every\s+day/i,
  /everything\s+runs\s+here/i,
  /runs\s+entirely\s+in\s+(your|the)\s+browser/i,
]

test.describe('About page claims', () => {
  test('describes the neural engine honestly, and makes no retired promise', async ({ page }) => {
    await page.goto('/about')
    await signIn(page)
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()

    const prose = (await page.locator('body').innerText()).replace(/\s+/g, ' ')
    expect(prose.length, 'the page should have rendered').toBeGreaterThan(500)

    for (const claim of RETIRED) {
      expect(prose, `the About page still makes the claim ${claim}`).not.toMatch(claim)
    }

    // The neural engine is described, not merely not-denied.
    expect(prose).toMatch(/ACE-Step 1\.5/)
    expect(prose).toMatch(/sends your style and lyrics/i)
    expect(prose).toMatch(/queue/i)
    expect(prose).toMatch(/daily (allowance|limit)/i)
    expect(prose).toMatch(/your lyrics exactly as you wrote them/i)

    // And the offline engine's own promise, which is still true, survives.
    expect(prose).toMatch(/on your own device/i)
    expect(prose).toMatch(/offline engine/i)
  })
})
