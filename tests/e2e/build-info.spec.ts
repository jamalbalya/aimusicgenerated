/**
 * The version and build line on the About page.
 *
 * Its whole purpose is to make a screenshot unambiguous, so what this checks is
 * that the line is actually on the page, actually readable, and actually says
 * which build it is — not that some element exists somewhere.
 */

import { test, expect, type Page } from '@playwright/test'

/** `v1.0.0 · build 18c7692`, or `· build dev` on a build CI did not make. */
const BUILD_LINE = /^v\d+\.\d+\.\d+ · build ([0-9a-f]{7}|dev)\b/

/** An instant written so it cannot be read as anything but UTC. */
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

/**
 * The build time as the reader's own device should write it.
 *
 * Computed here, in Node, from the instant the page itself published — so the
 * expectation is derived from the timezone rules rather than from the code
 * under test, and never from the clock this suite happens to run on.
 */
function localBuildTime(iso: string, locale: string, timeZone: string): string {
  return new Intl.DateTimeFormat(locale, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZoneName: 'short',
    timeZone,
  }).format(new Date(iso))
}

/** The build line's instant and its rendered local time, from one visitor. */
async function readBuildTime(page: Page): Promise<{ iso: string; local: string }> {
  await page.goto('/about')
  const stamp = page.getByTestId('build-info').locator('time')
  await expect(stamp).toBeVisible()
  return {
    iso: (await stamp.getAttribute('datetime')) ?? '',
    local: (await stamp.innerText()).trim(),
  }
}

test.describe('build identification', () => {
  test('the About page says which version and build it is', async ({ page }) => {
    await page.goto('/about')

    const line = page.getByTestId('build-info')
    await expect(line).toBeVisible()

    const text = (await line.innerText()).trim()
    expect(text, 'a screenshot of this page has to say which build it is').toMatch(BUILD_LINE)

    // A build time, when the build recorded one, so a stale cache is visible.
    // It is written on the reader's clock, so the exact instant lives in the
    // `datetime` attribute rather than in the text — see the timezone tests.
    if (text.includes('built ')) {
      await expect(line.locator('time')).toHaveAttribute('datetime', ISO_UTC)
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


/**
 * The build line says when this build was made, on the clock of whoever is
 * reading it.
 *
 * `BUILD_TIME` is baked in as UTC. These set the browser's timezone explicitly
 * rather than trusting the machine the suite runs on, because a test that
 * passed only where it was written would prove nothing about a visitor
 * somewhere else.
 */
test.describe('the build time is shown on the reader\u2019s clock', () => {
  test.describe('a visitor in Jakarta', () => {
    test.use({ timezoneId: 'Asia/Jakarta', locale: 'id-ID' })

    test('reads the build time as WIB, on their own date', async ({ page }) => {
      const { iso, local } = await readBuildTime(page)

      // The stored instant is still UTC and still unambiguous.
      expect(iso, 'the exact instant must stay recoverable from the page').toMatch(ISO_UTC)

      // And the text is that same instant, seven hours on.
      expect(local).toBe(localBuildTime(iso, 'id-ID', 'Asia/Jakarta'))
      expect(local, 'an Indonesian browser has a name for this zone').toContain('WIB')

      // Not the time the page was opened: a page opened now, showing a build
      // made earlier, must not have quietly re-stamped itself.
      const opened = await page.evaluate(() => new Date().toISOString())
      expect(new Date(iso).getTime()).toBeLessThanOrEqual(new Date(opened).getTime())
    })
  })

  test.describe('a visitor in New York', () => {
    test.use({ timezoneId: 'America/New_York', locale: 'en-US' })

    test('reads the same instant as their own morning', async ({ page }) => {
      const { iso, local } = await readBuildTime(page)
      expect(iso).toMatch(ISO_UTC)
      expect(local).toBe(localBuildTime(iso, 'en-US', 'America/New_York'))
    })
  })

  test('one build, two clocks, two different readings', async ({ browser }) => {
    // The point of the whole change, in one assertion: the device decides. Both
    // contexts load the same deployed build; only the timezone differs.
    const jakarta = await browser.newContext({ timezoneId: 'Asia/Jakarta', locale: 'id-ID' })
    const newYork = await browser.newContext({ timezoneId: 'America/New_York', locale: 'en-US' })
    try {
      const here = await readBuildTime(await jakarta.newPage())
      const there = await readBuildTime(await newYork.newPage())

      expect(here.iso, 'the recorded instant is the build\u2019s, not the visitor\u2019s').toBe(there.iso)
      expect(here.local, 'and the two readers must not be shown the same wall clock')
        .not.toBe(there.local)

      // Eleven hours apart in September, so the hour always differs and the
      // date usually does.
      expect(here.local).toBe(localBuildTime(here.iso, 'id-ID', 'Asia/Jakarta'))
      expect(there.local).toBe(localBuildTime(there.iso, 'en-US', 'America/New_York'))
    } finally {
      await jakarta.close()
      await newYork.close()
    }
  })
})
