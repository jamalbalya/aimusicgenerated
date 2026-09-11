/**
 * The handoff from a finished neural generation to the transport.
 *
 * Production generated the whole 271-second Bos Toxic song on ZeroGPU and
 * filled in the result panel — engine, length, both model names, the seed —
 * while the player underneath still said "Nothing loaded" with Play disabled.
 * The song was decoded and in hand; the store discarded it because priming the
 * Web Audio graph had thrown.
 *
 * Nothing here reaches Hugging Face. Every route to the Space host is served
 * from this file, so these tests cannot spend ZeroGPU quota however often they
 * run, and they need no real generation to prove the handoff.
 */

import { test, expect, type Page, type Route } from '@playwright/test'

/**
 * The Space the build under test points at. Matches ACE_STEP_SPACE_URL in the
 * CI build step; a build without it skips these tests rather than failing them.
 */
const SPACE = 'https://fake-space.hf.space'
const API = '/gradio_api'
const EVENT_ID = 'event-1'

/** What the studio asks a ZeroGPU Space for when Length is left on Auto. */
const SONG_SECONDS = 271

/**
 * The real shape, from the one production run that succeeded.
 *
 * The provider checks this against what it asked for, so a trimmed copy would
 * test the checks rather than the handoff.
 */
const METADATA = {
  loaded_model: 'acestep-v15-turbo',
  loaded_lm_model: 'acestep-5Hz-lm-0.6B',
  loaded_lm_path: '/home/user/app/checkpoints/acestep-5Hz-lm-0.6B',
  lm_backend: 'pt',
  requested_model: 'acestep-v15-turbo',
  requested_lm_model: 'acestep-5Hz-lm-0.6B',
  requested_audio_duration_s: SONG_SECONDS,
  audio_duration_s: SONG_SECONDS,
  wav_sample_rate: 48000,
  wav_channels: 2,
  peak_level: 0.89,
  lyric_lines_sent: 2,
  instrumental: false,
  vocal_language: 'id',
  seed: 101390300,
}

/**
 * A real, playable, non-silent 16-bit stereo WAV at production's own rate and
 * length: 48 kHz, 271 seconds, the same 52 MB the live Space returned. The size
 * is the point — it is what the browser has to allocate for playback.
 */
let song: Buffer | undefined
function productionSong(): Buffer {
  if (song) return song
  const rate = 48000
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
    const sample = Math.round(Math.sin(frame / 40) * 0.4 * 32767)
    const at = 44 + frame * channels * 2
    buffer.writeInt16LE(sample, at)
    buffer.writeInt16LE(sample, at + 2)
  }
  song = buffer
  return song
}

/** Serves Gradio's queue protocol for one successful generation. */
async function fakeSpace(page: Page): Promise<void> {
  // The Space reports back the length it was handed, so the fake does too:
  // Auto sends ACE-Step's own "you choose" value instead of a number, and the
  // provider checks that echo against what it sent.
  let asked: unknown = SONG_SECONDS
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
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ event_id: EVENT_ID }) })
    }

    if (path === `${API}/queue/data`) {
      const frame = (payload: unknown): string => `data: ${JSON.stringify(payload)}\n\n`
      return route.fulfill({
        contentType: 'text/event-stream',
        body:
          frame({ msg: 'estimation', event_id: EVENT_ID, rank: 0, queue_size: 1 })
          + frame({ msg: 'process_starts', event_id: EVENT_ID })
          + frame({
            msg: 'process_completed',
            event_id: EVENT_ID,
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
      return route.fulfill({ contentType: 'audio/wav', body: productionSong() })
    }

    return route.fulfill({ status: 404, body: 'not a route this test serves' })
  })
}

/** Selects the neural engine, which is also what reveals which Space it is. */
async function selectNeural(page: Page): Promise<void> {
  const engines = page.getByRole('group', { name: 'Generation engine' })
  await engines.getByRole('button', { name: 'Neural', exact: true }).click()
}

/** Fills the brief and presses Generate. */
async function generate(page: Page): Promise<void> {
  await page.getByLabel('Style').fill('Indonesian dangdut koplo, dramatic male vocal')
  await page.getByLabel('Lyrics').fill('Pagi datang hati berdebar\nBelum kerja sudah mulai gemetar')
  await page.getByRole('button', { name: 'Generate song' }).click()
}

/**
 * Skips when the build under test does not point at the fake Space.
 *
 * The engine card names the Space only once the neural engine is selected, so
 * this runs after `selectNeural`.
 */
async function requireFakeSpace(page: Page): Promise<void> {
  const host = SPACE.replace('https://', '')
  const configured = await page.locator('body').innerText().then((text) => text.includes(host))
  test.skip(!configured,
    `This build does not point at ${SPACE}. Rebuild with `
    + `ACE_STEP_BACKEND=zerogpu ACE_STEP_SPACE_URL=${SPACE}.`)
}

test.describe('a finished neural take reaches the player', () => {
  test('loads into the transport, and Play plays it', async ({ page }) => {
    await fakeSpace(page)
    await page.goto('/')
    await selectNeural(page)
    await requireFakeSpace(page)

    await generate(page)

    // The result panel is what production already showed, so it is the
    // precondition here, not the assertion.
    await expect(page.getByText(/Generated by ACE-Step 1\.5/)).toBeVisible({ timeout: 120_000 })
    await expect(page.getByText('acestep-5Hz-lm-0.6B')).toBeVisible()

    // This is the part that was broken.
    await expect(page.getByText('Nothing loaded')).toHaveCount(0)
    const play = page.getByRole('button', { name: 'Play' })
    await expect(play).toBeEnabled()

    // A transport that reports the song's real length is one that actually
    // holds the decoded audio: the clock reads it off the player's own buffer.
    await expect(page.getByText(`0:00 / ${Math.floor(SONG_SECONDS / 60)}:${String(SONG_SECONDS % 60).padStart(2, '0')}`))
      .toBeVisible()

    // And it plays. The button becomes Pause only once playback has started.
    await play.click()
    await expect(page.getByRole('button', { name: 'Pause' })).toBeVisible()
    await expect(page.getByText(/0:0[1-9] \/ 4:31/)).toBeVisible({ timeout: 15_000 })

    // Pause still works, and leaves the playhead where it was.
    await page.getByRole('button', { name: 'Pause' }).click()
    await expect(page.getByRole('button', { name: 'Play' })).toBeVisible()

    // Export is still offered for the neural take.
    await expect(page.getByRole('button', { name: 'Export' })).toBeEnabled()
  })

  test('keeps the song when the browser refuses the audio buffer', async ({ page }) => {
    // A browser declining to allocate a four-minute stereo buffer is what put
    // "Nothing loaded" under a finished result panel. The song must survive it
    // — it is decoded and in hand — and the reason must be said out loud.
    await page.addInitScript(() => {
      const ctor = window.AudioContext
        ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
      const real = ctor.prototype.createBuffer
      ctor.prototype.createBuffer = function (this: BaseAudioContext, channels: number, length: number, rate: number) {
        if (length > 1_000_000) throw new DOMException('memory', 'NotSupportedError')
        return real.call(this, channels, length, rate)
      }
    })
    await fakeSpace(page)
    await page.goto('/')
    await selectNeural(page)
    await requireFakeSpace(page)

    await generate(page)
    await expect(page.getByText(/Generated by ACE-Step 1\.5/)).toBeVisible({ timeout: 120_000 })

    // The track is still there: the transport names the song rather than
    // saying it has nothing.
    await expect(page.getByText('Nothing loaded')).toHaveCount(0)
    await expect(page.getByText('Pagi datang hati berdebar').first()).toBeVisible()
    await expect(page.getByRole('button', { name: 'Export' })).toBeEnabled()

    // And the browser's own words stay on screen, where Play is not working,
    // instead of flashing past in a toast the next message overwrites.
    await expect(page.getByText(/would not open the song for playback \(NotSupportedError/))
      .toBeVisible()
    // Play is off, because it genuinely cannot play — not enabled and silent.
    await expect(page.getByRole('button', { name: 'Play' })).toBeDisabled()
  })
})
