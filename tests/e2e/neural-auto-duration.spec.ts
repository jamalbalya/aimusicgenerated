/**
 * Auto is ACE-Step choosing the length.
 *
 * The studio used to turn Auto into a fixed number — a constant left over from
 * one unrelated test run — and send that. ACE-Step treats a stated length as a
 * hard token budget rather than a target, so a lyric sheet needing longer came
 * back cut off mid-phrase at exactly the length that had been asked for. Auto
 * now sends ACE-Step's own "you choose" value and the model picks a length that
 * fits the words.
 *
 * Nothing here reaches Hugging Face and no allowance is spent.
 */

import { test, expect, type Page, type Route } from '@playwright/test'

import { signIn } from './helpers/hfSignIn'

/** Must match ACE_STEP_SPACE_URL in the build these tests run against. */
const SPACE = 'https://fake-space.hf.space'
const API = '/gradio_api'
/** Not 271, and not a number the studio could have chosen: the model's answer. */
const CHOSEN_SECONDS = 238

const METADATA = {
  loaded_model: 'acestep-v15-turbo',
  loaded_lm_model: 'acestep-5Hz-lm-0.6B',
  // Echoed back the way the Space does, which is how Auto is checked at all.
  requested_audio_duration_s: -1,
  audio_duration_s: CHOSEN_SECONDS,
  wav_sample_rate: 8000,
  wav_channels: 2,
  lyric_lines_sent: 2,
  instrumental: false,
  vocal_language: 'id',
  seed: 101390300,
}

/** A real, playable, non-silent 16-bit stereo WAV that ends by fading out. */
let song: Buffer | undefined
function chosenLengthSong(): Buffer {
  if (song) return song
  const rate = 8000
  const channels = 2
  const frames = rate * CHOSEN_SECONDS
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
  const fadeFrom = frames - rate * 3
  for (let frame = 0; frame < frames; frame++) {
    const fade = frame < fadeFrom ? 1 : Math.max(0, 1 - (frame - fadeFrom) / (rate * 3))
    const sample = Math.round(Math.sin(frame / 20) * 0.4 * fade * 32767)
    const at = 44 + frame * channels * 2
    buffer.writeInt16LE(sample, at)
    buffer.writeInt16LE(sample, at + 2)
  }
  song = buffer
  return song
}

interface FakeSpace {
  /** The song length each generation asked the Space for. */
  durations: () => unknown[]
}

async function fakeSpace(page: Page): Promise<FakeSpace> {
  const durations: unknown[] = []
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
      const body = route.request().postDataJSON() as { data?: unknown[] } | null
      durations.push(body?.data?.[5])
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ event_id: 'event-1' }) })
    }

    if (path === `${API}/queue/data`) {
      const frame = (payload: unknown): string => `data: ${JSON.stringify(payload)}\n\n`
      return route.fulfill({
        contentType: 'text/event-stream',
        body:
          frame({
            msg: 'process_completed',
            event_id: 'event-1',
            success: true,
            output: {
              data: [
                {
                  path: '/tmp/auto.wav',
                  url: `${SPACE}${API}/file=/tmp/auto.wav`,
                  mime_type: 'audio/wav',
                  orig_name: 'auto.wav',
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
      return route.fulfill({ contentType: 'audio/wav', body: chosenLengthSong() })
    }

    return route.fulfill({ status: 404, body: 'not a route this test serves' })
  })
  return { durations: () => durations }
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

async function openNeuralControls(page: Page): Promise<void> {
  await page.goto('/')
  await page.getByRole('group', { name: 'Generation engine' })
    .getByRole('button', { name: 'Neural', exact: true }).click()
  // The neural engine needs a signed-in account now; this spec is about
  // what happens afterwards.
  await signIn(page)
  await requireFakeSpace(page)
  await page.getByRole('button', { name: /Show controls|Hide controls/ }).click()
}

test.describe('Auto lets ACE-Step pick the length', () => {
  test('says so, rather than naming a length it cannot know', async ({ page }) => {
    await openNeuralControls(page)

    await expect(page.getByText('Auto — ACE-Step chooses')).toBeVisible()
    // The old label promised a specific song length before any song existed.
    await expect(page.getByText(/Auto \(\d+:\d\d\)/)).toHaveCount(0)
    await expect(page.getByText('Auto (4:31)')).toHaveCount(0)
  })

  test('asks the Space for no length, and shows the one it chose', async ({ page }) => {
    const space = await fakeSpace(page)
    await openNeuralControls(page)

    await page.getByLabel('Style').fill('Indonesian dangdut koplo, dramatic male vocal')
    await page.getByLabel('Lyrics').fill('Pagi datang hati berdebar\nBelum kerja sudah mulai gemetar')
    await generateButton(page).click()
    await expect(generateButton(page)).toBeEnabled({ timeout: 120_000 })

    // ACE-Step's own "you choose" value, not a number of ours.
    expect(space.durations(), 'Auto must not state a length').toEqual([-1])

    // A length nothing in the studio asked for is accepted, and reported —
    // both where the result is summarised and in the transport that plays it.
    await expect(page.getByText(/Generated by ACE-Step 1\.5/)).toBeVisible()
    const lengthStat = page.locator('div.grid.gap-1').filter({ hasText: /^Length/ })
    await expect(lengthStat).toContainText('3:58')
    await expect(page.getByText('0:00 / 3:58')).toBeVisible()
    await expect(page.getByText('Nothing loaded')).toHaveCount(0)
    // It ended by fading out, so nothing is flagged as cut off.
    await expect(page.getByText(/stops abruptly/)).toHaveCount(0)
  })

  test('still sends a length the listener asked for', async ({ page }) => {
    // Auto changing does not change what an explicit choice means.
    const space = await fakeSpace(page)
    await openNeuralControls(page)

    await page.getByLabel('Song length in seconds').fill('240')
    await page.getByLabel('Style').fill('Indonesian dangdut koplo, dramatic male vocal')
    await page.getByLabel('Lyrics').fill('Pagi datang hati berdebar\nBelum kerja sudah mulai gemetar')
    await generateButton(page).click()
    await expect(generateButton(page)).toBeEnabled({ timeout: 120_000 })

    expect(space.durations()).toEqual([240])
  })
})
