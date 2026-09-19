/**
 * What a person is told when a generation fails.
 *
 * "Generation failed" is not a bug report. The engine already knows the stage a
 * request died at and the code it died with; these tests hold the screen to
 * showing both, plus whatever numbers were known, and to offering a retry only
 * where retrying could work.
 *
 * The sheet driven through here is the "Rindu yang Tak Selesai" brief that was
 * reported failing on 2026-09-18 — descriptive section tags with commas, a
 * [Break] with no words under it, and a closing [End]. It reaches the Space
 * intact and is counted the same on both sides; what these tests exercise is
 * what happens when the Space itself says no.
 */

import { test, expect, type Page, type Route } from '@playwright/test'

import { signIn } from './helpers/hfSignIn'

const SPACE = 'https://fake-space.hf.space'
const API = '/gradio_api'

const RINDU_STYLE = 'Romantic melancholic jazz ballad, 72 BPM, intimate late-night atmosphere, '
  + 'soulful soft male vocal, gentle piano voicings, warm upright bass, brushed drums, '
  + 'expressive tenor saxophone fills, subtle jazz harmony, spacious phrasing, tender emotional '
  + 'delivery, memorable melodic chorus, elegant and timeless arrangement, original melody'

const RINDU_LYRICS = [
  '[Intro, Soft Piano and Warm Upright Bass]', '', 'Malam turun perlahan',
  'Membawa sunyi ke dalam kamar', '',
  '[Verse 1, Intimate Soulful Vocal]', '', 'Dulu kita duduk berdua',
  'Berbagi mimpi di bawah rembulan', '',
  '[Pre-Chorus, Gentle Saxophone Response]', '', 'Aku mencoba melupakan', '',
  '[Chorus, Emotional Jazz Ballad]', '', 'Rindu ini tak pernah selesai',
  'Meski waktu terus berjalan', '',
  '[Break, Solo Piano]', '',
  '[Final Chorus, Soulful Vocal with Strings and Saxophone]', '',
  'Rindu ini akan tetap ada', '',
  '[Outro, Piano and Fading Saxophone]', '', 'Dan namamu tetap di sana', '',
  '[End]',
].join('\n')

/** A Space that answers, and fails the job in whatever way a test asks for. */
async function failingSpace(page: Page, failure: unknown): Promise<() => number> {
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
    if (path === `${API}/queue/data`) {
      const frame = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`
      return route.fulfill({ contentType: 'text/event-stream',
        body: frame({ msg: 'process_starts', event_id: 'event-1' })
          + frame(failure) + frame({ msg: 'close_stream' }) })
    }
    return route.fulfill({ status: 404, body: 'not a route this test serves' })
  })
  return () => joins
}

const generateButton = (page: Page) =>
  page.getByRole('button', { name: /^(Generate song|Generating…)$/ })

async function studio(page: Page): Promise<void> {
  await page.goto('/')
  await signIn(page)
  await page.getByRole('group', { name: 'Generation engine' })
    .getByRole('button', { name: 'Neural', exact: true }).click()
  await signIn(page)
}

async function generateRindu(page: Page): Promise<void> {
  await page.getByLabel('Style').fill(RINDU_STYLE)
  await page.getByLabel('Lyrics').fill(RINDU_LYRICS)
  await generateButton(page).click()
}

test.describe('a failed generation is reportable', () => {
  test('names the stage, the code and the numbers when the two lyric counts disagree', async ({ page }) => {
    // The Space claims a different count from the one the studio sent. This is
    // the failure the whole guard.py patch exists to prevent; if it ever comes
    // back, the screen has to say which number came from where.
    await failingSpace(page, {
      msg: 'process_completed', event_id: 'event-1', success: true,
      output: { data: [
        { path: '/tmp/x.wav', url: `${SPACE}${API}/file=/tmp/x.wav`, mime_type: 'audio/wav',
          orig_name: 'x.wav', meta: { _type: 'gradio.FileData' } },
        JSON.stringify({
          loaded_model: 'acestep-v15-turbo', loaded_lm_model: 'acestep-5Hz-lm-0.6B',
          lyric_lines_sent: 3, vocal_language: 'id', instrumental: false,
          requested_audio_duration_s: -1, audio_duration_s: 120, seed: 7,
        }),
      ] },
    })
    await studio(page)
    await generateRindu(page)

    const panel = page.getByTestId('engine-error')
    await expect(panel).toBeVisible()
    await expect(page.getByTestId('engine-error-code')).toHaveText('LYRICS_LINE_COUNT_MISMATCH')
    await expect(panel).toContainText('Checking the result')
    const details = page.getByTestId('engine-error-details')
    await expect(details).toContainText('spaceCounted')
    await expect(details).toContainText('3')
    await expect(details).toContainText('studioSent')
    await expect(details).toContainText('9')
  })

  test('names the inference stage when the Space itself fails', async ({ page }) => {
    await failingSpace(page, {
      msg: 'process_completed', event_id: 'event-1', success: false,
      output: { error: 'CUDA out of memory' },
      title: 'ZeroGPU worker error',
    })
    await studio(page)
    await generateRindu(page)

    await expect(page.getByTestId('engine-error-code')).toHaveText('INFERENCE_FAILED')
    await expect(page.getByTestId('engine-error')).toContainText('Generating')
    // Worth trying again, so the button is there.
    await expect(page.getByTestId('engine-error-retry')).toBeVisible()
  })

  test('does not treat a long style as a failure at all', async ({ page }) => {
    // Previously this asserted a STYLE_TOO_LONG panel with no retry button,
    // on the reasoning that a style too long is too long however many times it
    // is sent. True — but the premise went: it is no longer too long, because
    // the caption is compiled from it rather than being it. There is nothing
    // to report, so nothing is reported.
    const joins = await failingSpace(page, { msg: 'close_stream' })
    await studio(page)
    await page.getByLabel('Style').fill('a'.repeat(1457))
    await page.getByLabel('Lyrics').fill(RINDU_LYRICS)
    await generateButton(page).click()
    await expect(generateButton(page)).toBeEnabled({ timeout: 120_000 })

    await expect(page.getByTestId('engine-error-code')).not.toHaveText('STYLE_TOO_LONG')
    expect(joins(), 'a long style is compiled and sent, not refused').toBe(1)
  })

  test('the retry button starts a new generation', async ({ page }) => {
    const joins = await failingSpace(page, {
      msg: 'process_completed', event_id: 'event-1', success: false,
      output: { error: 'transient' }, title: 'ZeroGPU worker error',
    })
    await studio(page)
    await generateRindu(page)
    await expect(page.getByTestId('engine-error-retry')).toBeVisible()
    expect(joins()).toBe(1)

    await page.getByTestId('engine-error-retry').click()
    await expect.poll(joins, { message: 'Try again must submit a second job' }).toBe(2)
  })
})
