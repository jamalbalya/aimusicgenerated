/**
 * The version and build line on the About page.
 *
 * Its whole purpose is to make a screenshot unambiguous, so what this checks is
 * that the line is actually on the page, actually readable, and actually says
 * which build it is — not that some element exists somewhere.
 */

import { test, expect } from '@playwright/test'

/** `v1.0.0 · build 18c7692`, or `· build dev` on a build CI did not make. */
const BUILD_LINE = /^v\d+\.\d+\.\d+ · build ([0-9a-f]{7}|dev)\b/

test.describe('build identification', () => {
  test('the About page says which version and build it is', async ({ page }) => {
    await page.goto('/about')

    const line = page.getByTestId('build-info')
    await expect(line).toBeVisible()

    const text = (await line.innerText()).trim()
    expect(text, 'a screenshot of this page has to say which build it is').toMatch(BUILD_LINE)

    // A build time, when the build recorded one, so a stale cache is visible.
    if (text.includes('built ')) {
      expect(text).toMatch(/built \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC/)
    }

    // A build CI did not make says so, rather than passing for a deployment.
    const commit = BUILD_LINE.exec(text)![1]
    if (commit === 'dev') {
      expect(text).toContain('local build, not from CI')
    } else {
      expect(text).not.toContain('local build')
    }
  })

  test('the bundle carries no token, and no full commit hash', async ({ page }) => {
    const scripts: string[] = []
    page.on('response', async (response) => {
      if (!/\.js(\?|$)/.test(response.url())) return
      try {
        scripts.push(await response.text())
      } catch {
        // A response that cannot be read is one the page did not use.
      }
    })

    await page.goto('/about')
    await expect(page.getByTestId('build-info')).toBeVisible()
    expect(scripts.length, 'no script was captured, so this proves nothing').toBeGreaterThan(0)

    const bundle = scripts.join('\n')
    for (const shape of [/\bhf_[A-Za-z0-9]{20,}/, /\bghp_[A-Za-z0-9]{20,}/, /\bgithub_pat_[A-Za-z0-9_]{20,}/]) {
      expect(bundle, `${shape} must not appear in a public bundle`).not.toMatch(shape)
    }
    // Only the short form is baked; a 40-character hash would mean the
    // allowlist had been widened.
    expect(bundle).not.toMatch(/\b[0-9a-f]{40}\b/)
  })

  test('the build line does not appear on the Studio page', async ({ page }) => {
    // It belongs in the application information area, not on the main UI.
    await page.goto('/')
    await expect(page.getByRole('button', { name: 'Generate song' })).toBeVisible()
    await expect(page.getByTestId('build-info')).toHaveCount(0)
  })
})
