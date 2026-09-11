/**
 * A generation outlives the page that started it.
 *
 * Leaving the Studio must never stop a song being made — the request keeps
 * running whatever React does with the component, and that is the intended
 * product behaviour, not an oversight. What used to be wrong was the way back:
 * the generation's state lived in `StudioPage`, so a remount showed an idle
 * studio above a job still running on the GPU, offered no way to cancel it, and
 * let one click start a second one on an allowance measured in minutes a day.
 *
 * These tests hold the Space's result stream open so the navigation happens
 * while the generation is genuinely in flight. Nothing reaches Hugging Face and
 * no allowance is spent, however often they run.
 *
 * Nothing here asserts that navigation cancels a generation. It must not.
 */

import { test, expect, type Page, type Route } from '@playwright/test'

/** Must match ACE_STEP_SPACE_URL in the build these tests run against. */
const SPACE = 'https://fake-space.hf.space'
const API = '/gradio_api'
const SONG_SECONDS = 271

const METADATA = {
  loaded_model: 'acestep-v15-turbo',
  loaded_lm_model: 'acestep-5Hz-lm-0.6B',
  requested_audio_duration_s: SONG_SECONDS,
  audio_duration_s: SONG_SECONDS,
  wav_sample_rate: 8000,
  wav_channels: 2,
  lyric_lines_sent: 2,
  instrumental: false,
  vocal_language: 'id',
  seed: 101390300,
}

/** A real, playable, non-silent 16-bit stereo WAV of the full length. */
let song: Buffer | undefined
function fullLengthSong(): Buffer {
  if (song) return song
  const rate = 8000
  const channels = 2
  const frames = rate * SONG_SECONDS
  const bytes = frames * channels * 2
  const buffer = Buffer.alloc(44 + bytes)
  buffer.write('RIFF', 0)
  buffer.writeUInt32LE(36 + bytes, 4)
  buffer.write('WAVE', 8)
  buffer.write('fmt ', 12)
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20)
  buffer.writeUInt16LE(channels, 22)
  buffer.writeUInt32LE(rate, 24)
  buffer.writeUInt32LE(rate * channels * 2, 28)
  buffer.writeUInt16LE(channels * 2, 32)
  buffer.writeUInt16LE(16, 34)
  buffer.write('data', 36)
  buffer.writeUInt32LE(bytes, 40)
  for (let frame = 0; frame < frames; frame++) {
    const sample = Math.round(Math.sin(frame / 20) * 0.4 * 32767)
    const at = 44 + frame * channels * 2
    buffer.writeInt16LE(sample, at)
    buffer.writeInt16LE(sample, at + 2)
  }
  song = buffer
  return song
}

interface HeldSpace {
  joins: () => number
  /** Lets the held generation finish. */
  finish: () => void
}

/** A Space that accepts a job and holds its result stream until released. */
async function heldSpace(page: Page): Promise<HeldSpace> {
  // The Space reports back the length it was handed, so the fake does too:
  // Auto sends ACE-Step's own "you choose" value instead of a number, and the
  // provider checks that echo against what it sent.
  let asked: unknown = SONG_SECONDS
  let joins = 0
  let release = (): void => { /* replaced below */ }
  const held = new Promise<void>((resolve) => { release = resolve })

  await page.route(`${SPACE}/**`, async (route: Route) => {
    const path = new URL(route.request().url()).pathname

    if (path === '/config') {
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          version: '6.2.0',
          protocol: 'sse_v3',
          api_prefix: API,
          root: SPACE,
          dependencies: [{ id: 0, api_name: 'generate_music', queue: true, api_visibility: 'public', backend_fn: true }],
        }),
      })
    }

    if (path === `${API}/queue/join`) {
      asked = (route.request().postDataJSON() as { data?: unknown[] } | null)?.data?.[5]
      joins += 1
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ event_id: `event-${joins}` }) })
    }

    if (path === `${API}/queue/data`) {
      await held
      const frame = (payload: unknown): string => `data: ${JSON.stringify(payload)}\n\n`
      return route.fulfill({
        contentType: 'text/event-stream',
        body:
          frame({ msg: 'process_starts', event_id: 'event-1' })
          + frame({
            msg: 'process_completed',
            event_id: 'event-1',
            success: true,
            output: {
              data: [
                {
                  path: '/tmp/bos-toxic.wav',
                  url: `${SPACE}${API}/file=/tmp/bos-toxic.wav`,
                  mime_type: 'audio/wav',
                  orig_name: 'bos-toxic.wav',
                  meta: { _type: 'gradio.FileData' },
                },
                JSON.stringify({ ...METADATA, requested_audio_duration_s: asked }),
              ],
            },
          })
          + frame({ msg: 'close_stream' }),
      })
    }

    if (path.startsWith(`${API}/file=`)) {
      return route.fulfill({ contentType: 'audio/wav', body: fullLengthSong() })
    }

    return route.fulfill({ status: 404, body: 'not a route this test serves' })
  })

  return { joins: () => joins, finish: () => release() }
}

/** Skips when the build under test does not point at the fake Space. */
async function requireFakeSpace(page: Page): Promise<void> {
  const host = SPACE.replace('https://', '')
  const configured = await page.locator('body').innerText().then((text) => text.includes(host))
  test.skip(!configured,
    `This build does not point at ${SPACE}. Rebuild with `
    + `ACE_STEP_BACKEND=zerogpu ACE_STEP_SPACE_URL=${SPACE}.`)
}

const generateButton = (page: Page) =>
  page.getByRole('button', { name: /^(Generate song|Generating…)$/ })

const studioHeading = (page: Page) =>
  page.getByRole('heading', { level: 1, name: /Describe a song/i })

/**
 * Clicks a navigation link, whichever nav is on screen.
 *
 * The sidebar and the mobile tab bar are both in the document and name the same
 * tool differently — "Lyric Writer" and "Lyrics" — so the visible one is the one
 * to click. It has to be a click: `page.goto` would be a full page load, which
 * destroys the JavaScript context and with it the generation these tests are
 * about.
 */
async function navigateTo(page: Page, name: RegExp): Promise<void> {
  await page.getByRole('link', { name }).filter({ visible: true }).first().click()
}

const TO_LYRICS = /^(Lyric Writer|Lyrics)$/
const TO_STUDIO = /^(Song Studio|Studio)$/

/** Starts one generation and returns once the Space has it. */
async function startGeneration(page: Page, space: HeldSpace): Promise<void> {
  await page.goto('/')
  await page.getByRole('group', { name: 'Generation engine' })
    .getByRole('button', { name: 'Neural', exact: true }).click()
  await requireFakeSpace(page)
  await page.getByLabel('Style').fill('Indonesian dangdut koplo, dramatic male vocal')
  await page.getByLabel('Lyrics').fill('Pagi datang hati berdebar\nBelum kerja sudah mulai gemetar')
  await generateButton(page).click()
  await expect.poll(space.joins, { message: 'the Space should have exactly one job' }).toBe(1)
}

test.describe('a generation survives leaving the Studio', () => {
  test('is still running, still cancellable and still alone when the user comes back', async ({ page }) => {
    const space = await heldSpace(page)
    await startGeneration(page, space)
    await expect(generateButton(page)).toBeDisabled()

    // Leave. The Studio unmounts; the generation does not stop.
    await navigateTo(page, TO_LYRICS)
    await expect(page.getByRole('heading', { level: 1, name: /Words that scan/i })).toBeVisible()
    await expect(studioHeading(page), 'the Studio should have unmounted').toHaveCount(0)
    expect(space.joins(), 'leaving must not start or stop anything').toBe(1)

    // Come back, with the job still in flight.
    await navigateTo(page, TO_STUDIO)
    await expect(studioHeading(page)).toBeVisible()

    // The studio has to know what it left running.
    await expect(generateButton(page), 'Generate must stay disabled while it runs').toBeDisabled()
    await expect(generateButton(page)).toHaveText('Generating…')
    await expect(page.getByText(/Waiting for the neural music engine|Generating song|Preparing neural/))
      .toBeVisible()
    await expect(page.getByRole('button', { name: 'Cancel' }),
      'Cancel must be available again, or the job cannot be stopped at all').toBeVisible()

    // And it must refuse to start a second one — the whole point.
    await page.getByLabel('Lyrics').click()
    await page.keyboard.press('Meta+Enter')
    await page.keyboard.press('Control+Enter')
    await generateButton(page).click({ force: true })
    await page.waitForTimeout(1500)
    expect(space.joins(), 'returning to the Studio must not allow a second job').toBe(1)

    // The original completes, and its result arrives in the studio it started in.
    space.finish()
    await expect(page.getByText(/Generated by ACE-Step 1\.5/)).toBeVisible({ timeout: 120_000 })
    await expect(page.getByText('acestep-5Hz-lm-0.6B')).toBeVisible()
    await expect(page.getByText('Nothing loaded')).toHaveCount(0)

    // Back to ready, for a new generation.
    await expect(generateButton(page)).toBeEnabled()
    await expect(generateButton(page)).toHaveText('Generate song')
    expect(space.joins(), 'still exactly one job for the whole run').toBe(1)
  })

  test('the browser Back button follows the same rules', async ({ page }) => {
    // Back is client-side here, so it is the same lifecycle — asserted rather
    // than assumed, and with no special-case handling anywhere in the app.
    const space = await heldSpace(page)
    await startGeneration(page, space)

    await navigateTo(page, TO_LYRICS)
    await expect(page.getByRole('heading', { level: 1, name: /Words that scan/i })).toBeVisible()
    await page.goBack()
    await expect(studioHeading(page)).toBeVisible()

    await expect(generateButton(page)).toBeDisabled()
    await expect(page.getByRole('button', { name: 'Cancel' })).toBeVisible()

    space.finish()
    await expect(page.getByText(/Generated by ACE-Step 1\.5/)).toBeVisible({ timeout: 120_000 })
    expect(space.joins()).toBe(1)
  })
})

test.describe('a result that finished while the Studio was closed', () => {
  test('is waiting when the user returns', async ({ page }) => {
    const space = await heldSpace(page)
    await startGeneration(page, space)

    // Leave, and let it finish with the Studio unmounted the whole time.
    await navigateTo(page, TO_LYRICS)
    await expect(page.getByRole('heading', { level: 1, name: /Words that scan/i })).toBeVisible()
    space.finish()

    // The song reaches the player from wherever the user happens to be.
    await expect(page.getByText('Pagi datang hati berdebar').first()).toBeVisible({ timeout: 120_000 })
    await expect(page.getByText('Nothing loaded')).toHaveCount(0)
    await expect(page.getByText(/Engine: ACE-Step 1\.5 — Neural/)).toBeVisible()

    // Now come back. The result panel has to be there too, not just the audio.
    await navigateTo(page, TO_STUDIO)
    await expect(studioHeading(page)).toBeVisible()

    await expect(page.getByText(/Generated by ACE-Step 1\.5/)).toBeVisible()
    await expect(page.getByText('acestep-v15-turbo').first()).toBeVisible()
    await expect(page.getByText('acestep-5Hz-lm-0.6B')).toBeVisible()
    await expect(page.getByText('101390300')).toBeVisible()
    // The panel's own Length stat, and the transport's clock, are different
    // elements — both have to have survived the round trip.
    await expect(page.getByText('4:31', { exact: true })).toBeVisible()
    await expect(page.getByText('0:00 / 4:31')).toBeVisible()

    // And the studio is ready for the next one.
    await expect(generateButton(page)).toBeEnabled()
    await expect(generateButton(page)).toHaveText('Generate song')
    expect(space.joins()).toBe(1)
  })
})
