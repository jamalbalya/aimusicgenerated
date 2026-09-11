/**
 * One take per run on the free GPU.
 *
 * Every neural take is its own generation. On the free ZeroGPU Space that is
 * its own slice of an allowance covering about one song a day, so a run of four
 * spends the day to return one song and three refusals — and holds four decoded
 * songs in memory while it tries: measured at roughly 198 MB downloaded and a
 * 452 MB JS heap for four production-sized takes.
 *
 * The cap belongs to the backend, not to the engine, and it is enforced in the
 * action rather than only in the control — a stale or tampered take count must
 * not be able to put four jobs on a free GPU from one press.
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

interface FakeSpace {
  /** Generations the Space was asked for. */
  joins: () => number
  /** Songs it actually handed over. */
  files: () => number
}

async function fakeSpace(page: Page): Promise<FakeSpace> {
  // The Space reports back the length it was handed, so the fake does too:
  // Auto sends ACE-Step's own "you choose" value instead of a number, and the
  // provider checks that echo against what it sent.
  let asked: unknown = SONG_SECONDS
  let joins = 0
  let files = 0
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
      const mine = joins
      const frame = (payload: unknown): string => `data: ${JSON.stringify(payload)}\n\n`
      return route.fulfill({
        contentType: 'text/event-stream',
        body:
          frame({
            msg: 'process_completed',
            event_id: `event-${mine}`,
            success: true,
            output: {
              data: [
                {
                  path: `/tmp/take-${mine}.wav`,
                  url: `${SPACE}${API}/file=/tmp/take-${mine}.wav`,
                  mime_type: 'audio/wav',
                  orig_name: `take-${mine}.wav`,
                  meta: { _type: 'gradio.FileData' },
                },
                JSON.stringify({ ...METADATA, seed: 101390300 + mine, requested_audio_duration_s: asked }),
              ],
            },
          })
          + frame({ msg: 'close_stream' }),
      })
    }

    if (path.startsWith(`${API}/file=`)) {
      files += 1
      return route.fulfill({ contentType: 'audio/wav', body: fullLengthSong() })
    }

    return route.fulfill({ status: 404, body: 'not a route this test serves' })
  })
  return { joins: () => joins, files: () => files }
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
const takesControl = (page: Page) => page.getByRole('group', { name: 'Takes per run' })

test.describe('the free GPU writes one take per run', () => {
  test('asks the Space for one generation however many takes are set', async ({ page }) => {
    const space = await fakeSpace(page)
    await page.goto('/')
    await page.getByRole('group', { name: 'Generation engine' })
      .getByRole('button', { name: 'Neural', exact: true }).click()
  // The neural engine needs a signed-in account now; this spec is about
  // what happens afterwards.
  await signIn(page)
    await requireFakeSpace(page)
    await page.getByRole('button', { name: /Show controls|Hide controls/ }).click()

    // The control says one, and refuses to say anything else.
    await expect(takesControl(page).getByRole('button', { name: '1', exact: true }))
      .toHaveAttribute('aria-pressed', 'true')
    for (const option of ['2', '3', '4']) {
      await expect(takesControl(page).getByRole('button', { name: option, exact: true })).toBeDisabled()
    }
    await expect(page.getByText(/One song per run on the free GPU/)).toBeVisible()

    // Force the take count past the control, the way a stale render or a
    // tampered client would: the action has to refuse it on its own.
    await takesControl(page).getByRole('button', { name: '4', exact: true }).evaluate((node) => {
      (node as HTMLButtonElement).disabled = false
      ;(node as HTMLButtonElement).click()
    })

    await page.getByLabel('Style').fill('Indonesian dangdut koplo, dramatic male vocal')
    await page.getByLabel('Lyrics').fill('Pagi datang hati berdebar\nBelum kerja sudah mulai gemetar')
    await generateButton(page).click()
    await expect(generateButton(page)).toBeEnabled({ timeout: 120_000 })

    expect(space.joins(), 'one press must be one generation on the free GPU').toBe(1)
    expect(space.files(), 'and one song downloaded').toBe(1)

    // One take means no take switcher, and one song in the player.
    await expect(page.getByText(/Generated by ACE-Step 1\.5/)).toBeVisible()
    await expect(page.getByText(/takes from one brief/i)).toHaveCount(0)
    await expect(page.getByText('Nothing loaded')).toHaveCount(0)
  })

  test('does not claim neural takes come with stems', async ({ page }) => {
    // They do not: the stems panel belongs to the offline engine's takes. The
    // claim only ever appeared above one take, so the count has to be pushed
    // past one before the hint can be caught making it.
    const space = await fakeSpace(page)
    await page.goto('/')
    await page.getByRole('group', { name: 'Generation engine' })
      .getByRole('button', { name: 'Neural', exact: true }).click()
  // The neural engine needs a signed-in account now; this spec is about
  // what happens afterwards.
  await signIn(page)
    await requireFakeSpace(page)
    await page.getByRole('button', { name: /Show controls|Hide controls/ }).click()

    await takesControl(page).getByRole('button', { name: '4', exact: true }).evaluate((node) => {
      (node as HTMLButtonElement).disabled = false
      ;(node as HTMLButtonElement).click()
    })

    await expect(page.getByText(/Stems are rendered for whichever one you keep/)).toHaveCount(0)
    expect(space.joins(), 'looking at a control must not generate anything').toBe(0)
  })
})

test.describe('the offline engine keeps its takes', () => {
  test('offers all four, and the control is live', async ({ page }) => {
    // The cap belongs to the free GPU, not to the studio. Nothing here touches
    // a backend at all — the offline engine renders on the device.
    const space = await fakeSpace(page)
    await page.goto('/')
    await page.getByRole('group', { name: 'Generation engine' })
      .getByRole('button', { name: 'Offline Procedural' }).click()
    await page.getByRole('button', { name: /Show controls|Hide controls/ }).click()

    for (const option of ['1', '2', '3', '4']) {
      await expect(takesControl(page).getByRole('button', { name: option, exact: true })).toBeEnabled()
    }
    await takesControl(page).getByRole('button', { name: '4', exact: true }).click()
    await expect(takesControl(page).getByRole('button', { name: '4', exact: true }))
      .toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByText(/One song per run on the free GPU/)).toHaveCount(0)
    expect(space.joins(), 'the offline engine must not call the Space').toBe(0)
  })
})
