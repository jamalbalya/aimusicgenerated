/**
 * The live pipeline, in a browser, against a fake Space that counts.
 *
 * The unit tests prove the pieces. What can only be proved here is the thing
 * the requirement is actually about: that pressing Generate once — or twice in
 * a tenth of a second, or after a failure, or after a verification that found
 * a defect — results in exactly one `/queue/join`.
 *
 * The fake Space counts joins. Every assertion below is ultimately about that
 * number, because that number is someone's GPU allowance.
 *
 * Nothing here reaches Hugging Face and no allowance is spent.
 */

import { test, expect, type Page, type Route } from '@playwright/test'

import { signIn } from './helpers/hfSignIn'

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

const STYLE = 'Indonesian ballad, soft piano, melancholic'
const LYRICS = 'Aku masih di sini menunggu\nCahaya pagi yang tak kunjung datang'

/**
 * A playable stereo WAV with energy where a voice sits.
 *
 * The 2.2 kHz component matters: post-render verification fails a *vocal*
 * request whose audio has essentially nothing in the 1.5–4 kHz band, on the
 * grounds that the model returned a backing track. A test fixture of pure low
 * sine would trip that and the failure would look like a bug in the page.
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
    const t = frame / rate
    const value = 0.3 * Math.sin(2 * Math.PI * 220 * t) + 0.3 * Math.sin(2 * Math.PI * 2200 * t)
    const sample = Math.round(Math.max(-1, Math.min(1, value)) * 32767)
    const at = 44 + frame * channels * 2
    buffer.writeInt16LE(sample, at)
    buffer.writeInt16LE(sample, at + 2)
  }
  song = buffer
  return song
}

interface FakeSpace {
  /** Generations the Space was asked for. This is the number that matters. */
  joins: () => number
  /** The caption of the most recent request. */
  caption: () => string
}

async function fakeSpace(page: Page, options: { failGeneration?: boolean } = {}): Promise<FakeSpace> {
  let joins = 0
  let asked: unknown = SONG_SECONDS
  let caption = ''
  await page.route(`${SPACE}/**`, async (route: Route) => {
    const path = new URL(route.request().url()).pathname

    if (path === '/config') {
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          version: '6.2.0', protocol: 'sse_v3', api_prefix: API, root: SPACE,
          dependencies: [{
            id: 0, api_name: 'generate_music', queue: true,
            api_visibility: 'public', backend_fn: true,
          }],
        }),
      })
    }

    if (path === `${API}/queue/join`) {
      const data = (route.request().postDataJSON() as { data?: unknown[] } | null)?.data
      caption = String(data?.[0] ?? '')
      asked = data?.[5]
      joins += 1
      return route.fulfill({
        contentType: 'application/json', body: JSON.stringify({ event_id: `event-${joins}` }),
      })
    }

    if (path === `${API}/queue/data`) {
      const mine = joins
      const frame = (payload: unknown): string => `data: ${JSON.stringify(payload)}\n\n`
      if (options.failGeneration) {
        return route.fulfill({
          contentType: 'text/event-stream',
          body: frame({
            msg: 'process_completed', event_id: `event-${mine}`, success: false,
            output: { error: 'CUDA out of memory' },
          }) + frame({ msg: 'close_stream' }),
        })
      }
      return route.fulfill({
        contentType: 'text/event-stream',
        body: frame({
          msg: 'process_completed', event_id: `event-${mine}`, success: true,
          output: {
            data: [
              {
                path: `/tmp/take-${mine}.wav`,
                url: `${SPACE}${API}/file=/tmp/take-${mine}.wav`,
                mime_type: 'audio/wav', orig_name: `take-${mine}.wav`,
                meta: { _type: 'gradio.FileData' },
              },
              JSON.stringify({ ...METADATA, requested_audio_duration_s: asked }),
            ],
          },
        }) + frame({ msg: 'close_stream' }),
      })
    }

    if (path.startsWith(`${API}/file=`)) {
      return route.fulfill({ contentType: 'audio/wav', body: fullLengthSong() })
    }
    return route.fulfill({ status: 404, body: 'not a route this test serves' })
  })
  return { joins: () => joins, caption: () => caption }
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

async function openNeuralStudio(page: Page): Promise<void> {
  await page.goto('/')
  await signIn(page)
  await page.getByRole('group', { name: 'Generation engine' })
    .getByRole('button', { name: 'Neural', exact: true }).click()
  await signIn(page)
  await requireFakeSpace(page)
}

test.describe('one press, one ZeroGPU request', () => {
  test('a single Generate sends exactly one request and reports what it measured', async ({ page }) => {
    const space = await fakeSpace(page)
    await openNeuralStudio(page)

    await page.getByLabel('Style').fill(STYLE)
    await page.getByLabel('Lyrics').fill(LYRICS)
    await generateButton(page).click()
    await expect(generateButton(page)).toBeEnabled({ timeout: 120_000 })

    expect(space.joins(), 'one press must be exactly one ZeroGPU request').toBe(1)

    // The pipeline panel says what happened, in the words the requirement asks
    // for: the validation ran, one request was sent, and nothing regenerates.
    const pipeline = page.getByTestId('live-pipeline')
    await expect(pipeline).toBeVisible()
    await expect(page.getByTestId('live-validation'))
      .toHaveText('Pre-generation validation passed.')
    await expect(page.getByTestId('live-verification')).toBeVisible()
    // And the verdict is one of the four, never a bare claim of perfection.
    await expect(page.getByTestId('live-verdict'))
      .toHaveText(/^(PASS|PASS_WITH_LIMITATIONS|FAILED_VERIFICATION|ANALYSIS_UNAVAILABLE)$/)
    await expect(page.getByTestId('live-measurements')).toBeVisible()
  })

  test('leaves a countable trail: one ticket, one spend, one join, one result',
    async ({ page }) => {
      // The evidence a report can quote. Every number below is counted by the
      // fake Space or read off the page, not asserted from the code's intent.
      const space = await fakeSpace(page)
      await openNeuralStudio(page)

      await page.getByLabel('Style').fill(STYLE)
      await page.getByLabel('Lyrics').fill(LYRICS)
      await generateButton(page).click()
      await expect(generateButton(page)).toBeEnabled({ timeout: 120_000 })

      // One ticket, visible on the page, and it is the first of this session.
      await expect(page.getByTestId('live-ticket')).toHaveText('gen-1')
      // One /queue/join.
      expect(space.joins()).toBe(1)
      // One result, carrying the ticket that authorised it.
      await expect(page.getByTestId('live-verification')).toBeVisible()
      // One song in the player: no second candidate to choose between.
      await expect(page.getByText(/takes from one brief/i)).toHaveCount(0)

      // Nothing more arrives afterwards. A retry or a regeneration triggered by
      // the verification would land in this window.
      await page.waitForTimeout(3000)
      expect(space.joins(), 'no retry, no regeneration, no second candidate').toBe(1)

      // A second press is a second ticket, not a reuse of the first — which is
      // what makes "one press, one request" a count rather than a cap.
      await generateButton(page).click()
      await expect(generateButton(page)).toBeEnabled({ timeout: 120_000 })
      await expect(page.getByTestId('live-ticket')).toHaveText('gen-2')
      expect(space.joins(), 'two presses, two requests').toBe(2)
    })

  test('a rapid double-click still sends exactly one request', async ({ page }) => {
    const space = await fakeSpace(page)
    await openNeuralStudio(page)

    await page.getByLabel('Style').fill(STYLE)
    await page.getByLabel('Lyrics').fill(LYRICS)

    // Two clicks inside the time it takes React to flush state once. The
    // synchronous latch is what has to catch this, not the disabled attribute.
    await generateButton(page).click({ clickCount: 2, delay: 10 })
    await expect(generateButton(page)).toBeEnabled({ timeout: 120_000 })

    expect(space.joins(), 'a double-click must not buy two generations').toBe(1)
  })

  test('the caption that is sent is the compiled one, and the user words survive whole',
    async ({ page }) => {
      const space = await fakeSpace(page)
      await openNeuralStudio(page)

      await page.getByLabel('Style').fill(STYLE)
      await page.getByLabel('Lyrics').fill(LYRICS)
      await generateButton(page).click()
      await expect(generateButton(page)).toBeEnabled({ timeout: 120_000 })

      const sent = space.caption()
      // Their words, first and unedited.
      expect(sent.startsWith(STYLE)).toBe(true)
      // And the plan's directions after them, so the model was told more than
      // the bare style.
      expect(sent.length).toBeGreaterThan(STYLE.length)
      expect(sent.length).toBeLessThanOrEqual(512)
      // Not a tempo: ACE-Step 1.5 takes bpm as a real GenerationParams field,
      // so repeating it in the caption would spend characters to say, less
      // precisely, something the model is already told properly. What the
      // caption adds is the direction that has no parameter.
      expect(sent).not.toMatch(/\d+ BPM/)
      expect(sent.toLowerCase()).toMatch(/vocal|mood|straight|swung|structure/)
    })

  test('a failed generation does not start another one', async ({ page }) => {
    const space = await fakeSpace(page, { failGeneration: true })
    await openNeuralStudio(page)

    await page.getByLabel('Style').fill(STYLE)
    await page.getByLabel('Lyrics').fill(LYRICS)
    await generateButton(page).click()
    await expect(generateButton(page)).toBeEnabled({ timeout: 120_000 })

    // The failure is reported on the page, and the count is still one. A retry
    // here would be a second slice of someone's allowance spent without them
    // asking for it.
    await expect(page.getByTestId('engine-error-message')).toBeVisible()
    expect(space.joins(), 'a failure must not be retried automatically').toBe(1)

    // Give the page time to do something it should not.
    await page.waitForTimeout(2000)
    expect(space.joins()).toBe(1)
  })
})

test.describe('validation happens before the GPU, not after it', () => {
  test('a lyric sheet longer than ACE-Step takes is refused without a request', async ({ page }) => {
    const space = await fakeSpace(page)
    await openNeuralStudio(page)

    await page.getByLabel('Style').fill(STYLE)
    // Past ACE-Step's 4096-character sheet limit. The planner has to catch this
    // rather than let the provider catch it: by the time the provider does, the
    // interface has already told the person their request was fine.
    await page.getByLabel('Lyrics').fill(
      Array.from({ length: 200 }, (_, index) =>
        `Baris ${index} dengan kata kata panjang sekali untuk mengisi ruang`).join('\n'))

    await generateButton(page).click()
    await expect(generateButton(page)).toBeEnabled({ timeout: 30_000 })

    await expect(page.getByTestId('live-validation'))
      .toHaveText(/Pre-generation validation failed/)
    await expect(page.getByTestId('live-stage'))
      .toHaveText(/No request was sent and no GPU time was used/)
    expect(space.joins(), 'a request the planner refused must not reach the Space').toBe(0)
  })

  test('an empty lyric sheet is refused before anything is sent', async ({ page }) => {
    const space = await fakeSpace(page)
    await openNeuralStudio(page)

    await page.getByLabel('Style').fill(STYLE)
    await page.getByLabel('Lyrics').fill('')
    await generateButton(page).click()
    await expect(generateButton(page)).toBeEnabled({ timeout: 30_000 })

    expect(space.joins(), 'an invalid request must not consume ZeroGPU').toBe(0)
  })

  test('an empty style is refused before anything is sent', async ({ page }) => {
    const space = await fakeSpace(page)
    await openNeuralStudio(page)

    await page.getByLabel('Style').fill('')
    await page.getByLabel('Lyrics').fill(LYRICS)
    await generateButton(page).click()
    await expect(generateButton(page)).toBeEnabled({ timeout: 30_000 })

    expect(space.joins(), 'an invalid request must not consume ZeroGPU').toBe(0)
  })
})
