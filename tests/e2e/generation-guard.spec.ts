/**
 * One generation at a time.
 *
 * The Generate button has always been disabled while a generation runs, but the
 * ⌘/Ctrl + Enter handlers on the two textareas were not guarded, so a double
 * press submitted two jobs to the Space. On a backend where a visitor's whole
 * daily allowance is a couple of minutes of GPU that spends the day on one
 * brief, and it left the first generation uncancellable: the controller the
 * Cancel button holds had already been overwritten by the second.
 *
 * These tests hold the Space's result stream open, so the second press lands
 * while the first generation is genuinely still running — which is the only
 * moment the bug existed. Nothing reaches Hugging Face and no allowance is
 * spent, however often they run.
 */

import { test, expect, type Page, type Route } from '@playwright/test'

/** Must match ACE_STEP_SPACE_URL in the build these tests run against. */
const SPACE = 'https://fake-space.hf.space'
const API = '/gradio_api'
const EVENT_ID = 'event-1'

/** What the studio asks a ZeroGPU Space for when Length is left on Auto. */
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

/**
 * A real, playable, non-silent 16-bit stereo WAV of the full length.
 *
 * 8 kHz rather than production's 48: the provider measures the length from the
 * file's own header and these tests are about how many jobs are submitted, not
 * about fidelity, so a smaller file keeps them quick.
 */
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
  /** How many jobs have been submitted to the Space. */
  joins: () => number
  /** Lets the held generation finish. */
  finish: () => void
}

/**
 * A Space that accepts a job and then holds its result stream open until the
 * test says otherwise, so a generation can be observed mid-flight.
 */
async function heldSpace(page: Page): Promise<HeldSpace> {
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
      joins += 1
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ event_id: `${EVENT_ID}-${joins}` }) })
    }

    if (path === `${API}/queue/data`) {
      // The generation is running from here until the test releases it.
      await held
      const frame = (payload: unknown): string => `data: ${JSON.stringify(payload)}\n\n`
      return route.fulfill({
        contentType: 'text/event-stream',
        body:
          frame({ msg: 'process_starts', event_id: `${EVENT_ID}-1` })
          + frame({
            msg: 'process_completed',
            event_id: `${EVENT_ID}-1`,
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
                JSON.stringify(METADATA),
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

/** Selects the neural engine and fills a brief, without pressing anything. */
async function readyToGenerate(page: Page): Promise<void> {
  await page.goto('/')
  await page.getByRole('group', { name: 'Generation engine' })
    .getByRole('button', { name: 'Neural', exact: true }).click()
  await requireFakeSpace(page)
  await page.getByLabel('Style').fill('Indonesian dangdut koplo, dramatic male vocal')
  await page.getByLabel('Lyrics').fill('Pagi datang hati berdebar\nBelum kerja sudah mulai gemetar')
}

const generateButton = (page: Page) =>
  page.getByRole('button', { name: /^(Generate song|Generating…)$/ })

test.describe('only one generation runs at a time', () => {
  test('repeated ⌘/Ctrl + Enter while generating submits nothing more', async ({ page }) => {
    const space = await heldSpace(page)
    await readyToGenerate(page)

    // One press, from the lyrics box, starts exactly one generation.
    await page.getByLabel('Lyrics').click()
    await page.keyboard.press('Meta+Enter')
    await expect(generateButton(page)).toBeDisabled()
    await expect(page.getByText(/Waiting for the neural music engine|Generating song/)).toBeVisible()
    await expect.poll(space.joins, { message: 'the first press should submit one job' }).toBe(1)

    // Now press again, both ways, from both textareas, while it is still
    // running. None of these may reach the Space.
    await page.getByLabel('Lyrics').click()
    await page.keyboard.press('Meta+Enter')
    await page.keyboard.press('Control+Enter')
    await page.getByLabel('Style').click()
    await page.keyboard.press('Meta+Enter')
    await page.keyboard.press('Control+Enter')
    // Held down: keydown repeats faster than React state flushes.
    await page.keyboard.down('Meta')
    for (let i = 0; i < 5; i++) await page.keyboard.press('Enter')
    await page.keyboard.up('Meta')

    await page.waitForTimeout(2000)
    expect(space.joins(), 'nine further presses must submit nothing').toBe(1)

    // The button was disabled the whole time — that behaviour is unchanged.
    await expect(generateButton(page)).toBeDisabled()

    // The original generation still completes normally.
    space.finish()
    await expect(page.getByText(/Generated by ACE-Step 1\.5/)).toBeVisible({ timeout: 120_000 })
    await expect(page.getByText('Nothing loaded')).toHaveCount(0)

    // And the studio returns to idle, ready for a new generation.
    await expect(generateButton(page)).toBeEnabled()
    await expect(generateButton(page)).toHaveText('Generate song')
    expect(space.joins(), 'still exactly one job for the whole run').toBe(1)
  })

  test('a press after it has finished starts a new generation', async ({ page }) => {
    // The guard must refuse a second generation only while one is running. If
    // it latched permanently the studio would be usable exactly once.
    const space = await heldSpace(page)
    await readyToGenerate(page)

    await page.getByLabel('Lyrics').click()
    await page.keyboard.press('Control+Enter')
    await expect.poll(space.joins).toBe(1)
    space.finish()
    await expect(page.getByText(/Generated by ACE-Step 1\.5/)).toBeVisible({ timeout: 120_000 })
    await expect(generateButton(page)).toBeEnabled()

    await page.getByLabel('Lyrics').click()
    await page.keyboard.press('Control+Enter')
    await expect.poll(space.joins, { message: 'an idle studio must still accept the shortcut' }).toBe(2)
  })
})
