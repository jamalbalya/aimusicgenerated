import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, test, type Page } from '@playwright/test'
import { writeFixture } from './make-fixture'

const FIXTURE = writeFixture()

/** Fails the test if the page logged an error, so silent breakage cannot pass. */
function watchForErrors(page: Page): string[] {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`))
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`)
  })
  return errors
}

test.describe('shell', () => {
  test('loads, routes between every tool, and survives a reload', async ({ page }) => {
    const errors = watchForErrors(page)
    await page.goto('/')
    await expect(page.getByRole('heading', { name: /Describe a song/i })).toBeVisible()

    const routes: [string, RegExp][] = [
      ['/lyrics', /Words that scan/i],
      ['/voice', /Eight voices/i],
      ['/stems', /Take the track apart/i],
      ['/shifter', /Change the voice/i],
      ['/toolkit', /Edit, treat and measure/i],
      ['/library', /Saved on this device/i],
      ['/about', /Everything runs here/i],
    ]

    for (const [path, heading] of routes) {
      await page.goto(path)
      await expect(page.getByRole('heading', { name: heading, level: 1 })).toBeVisible()
      // A deep link must survive a hard reload, not only client-side routing.
      await page.reload()
      await expect(page.getByRole('heading', { name: heading, level: 1 })).toBeVisible()
    }

    await page.goto('/')
    expect(errors).toEqual([])
  })

  test('shows a 404 for an unknown route', async ({ page }) => {
    await page.goto('/not-a-real-page')
    await expect(page.getByRole('heading', { name: /No tool lives here/i })).toBeVisible()
    await page.getByRole('link', { name: /Back to the studio/i }).click()
    await expect(page.getByRole('heading', { name: /Describe a song/i })).toBeVisible()
  })

  test('remembers the theme across reloads', async ({ page, isMobile }) => {
    await page.goto('/')
    const toggle = isMobile
      ? page.getByRole('button', { name: /Switch to light theme/i })
      : page.getByRole('button', { name: /Light theme/i })
    await toggle.click()
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
    await page.reload()
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  })
})

test.describe('song studio', () => {
  test('generates, plays, and exposes lyrics, chords and stems', async ({ page }) => {
    const errors = watchForErrors(page)
    await page.goto('/')

    await page.getByRole('textbox').first().fill('an upbeat pop song about the summer, 30 seconds')
    await page.getByRole('button', { name: 'Generate song' }).click()

    const title = page.getByRole('heading', { level: 2 }).first()
    await expect(title).toBeVisible({ timeout: 150_000 })
    await expect(title).not.toHaveText('')

    // Stats are real numbers, not placeholders.
    const tempoLabel = page.getByText('Tempo', { exact: true }).first()
    await expect(tempoLabel).toBeVisible()
    const tempo = await tempoLabel.locator('xpath=following-sibling::span[1]').innerText()
    expect(Number(tempo)).toBeGreaterThan(40)

    // The transport picked the render up and reports a real duration.
    await expect(page.getByText(/0:00 \/ 0:\d\d/)).toBeVisible()

    await page.getByRole('button', { name: 'Play' }).click()
    await page.waitForTimeout(1500)
    const readout = await page.getByText(/\d:\d\d \/ \d:\d\d/).first().innerText()
    expect(readout).not.toMatch(/^0:00 /)

    // Lyrics tab has real words in it.
    await page.getByRole('button', { name: 'Lyrics', exact: true }).click()
    const lyricsText = await page.locator('.lyrics-body').innerText()
    expect(lyricsText.split(/\s+/).length).toBeGreaterThan(15)
    expect(lyricsText).not.toContain('%END')
    expect(lyricsText).not.toContain('undefined')
    expect(lyricsText).not.toMatch(/[{}]/)

    // Chords tab lists chord symbols.
    await page.getByRole('button', { name: 'Chords', exact: true }).click()
    await expect(page.getByText(/^[A-G][#b]?(m|maj7|m7|7|dim|sus[24]|add9|m9|9|6|aug)?(\/[A-G][#b]?)?$/).first()).toBeVisible()

    // Stems tab lists per-instrument renders.
    await page.getByRole('button', { name: 'Stems', exact: true }).click()
    await expect(page.getByRole('button', { name: /^Play$/ }).first()).toBeVisible()

    expect(errors).toEqual([])
  })

  test('sings the words you type, in the language you typed them in', async ({ page }) => {
    const errors = watchForErrors(page)
    await page.goto('/')

    await page.getByLabel('Style').fill('gentle acoustic ballad, 30 seconds')
    await page.getByLabel('Lyrics').fill('Aku masih di sini menunggu\nSampai malam berganti pagi')

    // The reading is shown before anything is generated, so it can be corrected.
    await expect(page.getByText('Indonesian', { exact: true }).first()).toBeVisible()

    await page.getByRole('button', { name: 'Generate song' }).click()
    const title = page.getByRole('heading', { level: 2 }).first()
    await expect(title).toBeVisible({ timeout: 150_000 })

    // The lyric sheet is what was typed, not something the studio invented.
    await page.getByRole('button', { name: 'Lyrics', exact: true }).click()
    await expect(page.locator('.lyrics-body')).toContainText('Aku masih di sini menunggu')

    // And the render is long enough to be a song rather than an empty buffer.
    await expect(page.getByText(/0:00 \/ 0:\d\d/)).toBeVisible()

    expect(errors).toEqual([])
  })

  test('picks a genre from the chips and turns vocals off', async ({ page }) => {
    const errors = watchForErrors(page)
    await page.goto('/')

    // The popular genres are offered up front; the rest are behind the chevron.
    await expect(page.getByRole('button', { name: 'Pop', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Reggaeton / Latin', exact: true })).toBeHidden()
    await page.getByRole('button', { name: 'Show every genre' }).click()
    await expect(page.getByRole('button', { name: 'Reggaeton / Latin', exact: true })).toBeVisible()

    const jazz = page.getByRole('button', { name: 'Jazz', exact: true })
    await jazz.click()
    await expect(jazz).toHaveAttribute('aria-pressed', 'true')
    // Clicking the chosen genre again clears it.
    await jazz.click()
    await expect(jazz).toHaveAttribute('aria-pressed', 'false')
    await jazz.click()

    // The switch is a real checkbox behind its own label, so the label is what
    // receives the click.
    const instrumental = page.getByLabel('Instrumental')
    await expect(instrumental).not.toBeChecked()
    await instrumental.check({ force: true })
    await expect(instrumental).toBeChecked()

    await page.getByLabel('Style').fill('30 seconds')
    await page.getByRole('button', { name: 'Generate song' }).click()
    await expect(page.getByRole('heading', { level: 2 }).first()).toBeVisible({ timeout: 150_000 })

    // No vocals means no lyric sheet to show.
    await page.getByRole('button', { name: 'Lyrics', exact: true }).click()
    await expect(page.getByText('This is an instrumental', { exact: true })).toBeVisible()

    expect(errors).toEqual([])
  })

  test('exports the song as MIDI, subtitles and separate mixes', async ({ page }) => {
    const errors = watchForErrors(page)
    await page.goto('/')

    await page.getByLabel('Style').fill('a short pop song, 30 seconds')
    await page.getByRole('button', { name: 'Generate song' }).click()
    await expect(page.getByRole('heading', { level: 2 }).first()).toBeVisible({ timeout: 150_000 })

    // The transport at the foot of the page has an Export button of its own.
    const details = page.getByRole('main')
    await details.getByRole('button', { name: 'Export', exact: true }).click()
    // Scoped to the export list, so the lyric field's structure chips (which
    // include "Instrumental Break") cannot match.
    const exports = details.locator('.panel-sunken')
    for (const label of ['Instrumental', 'Vocals only', 'MIDI', 'Lyric sheet', 'Subtitles', 'Karaoke lyrics']) {
      await expect(exports.filter({ hasText: new RegExp(`^${label}`) }).first()).toBeVisible()
    }

    const download = page.waitForEvent('download')
    await exports.filter({ hasText: /^MIDI/ }).first().click()
    expect((await download).suggestedFilename()).toMatch(/\.mid$/)

    expect(errors).toEqual([])
  })

  test('downloads the finished song as an audio file', async ({ page }) => {
    const errors = watchForErrors(page)
    await page.goto('/')

    await page.getByLabel('Style').fill('a short pop song, 30 seconds')
    await page.getByRole('button', { name: 'Generate song' }).click()
    await expect(page.getByRole('heading', { level: 2 }).first()).toBeVisible({ timeout: 150_000 })

    // The transport at the foot of every page is where audio leaves the studio.
    await page.getByRole('button', { name: 'Export' }).last().click()
    const dialog = page.getByRole('dialog', { name: 'Export audio' })
    await expect(dialog).toBeVisible()

    for (const format of ['MP3 · 320 kbps', 'WAV · 16-bit']) {
      await dialog.getByRole('button', { name: format }).click()
      const started = page.waitForEvent('download')
      await dialog.getByRole('button', { name: 'Download' }).click()
      const file = await started
      expect(file.suggestedFilename()).toMatch(format.startsWith('MP3') ? /\.mp3$/ : /\.wav$/)
      // A real file, not an empty placeholder.
      const path = await file.path()
      expect(path).toBeTruthy()
      const { statSync } = await import('node:fs')
      expect(statSync(path!).size).toBeGreaterThan(50_000)
      await page.getByRole('button', { name: 'Export' }).last().click()
    }

    expect(errors).toEqual([])
  })

  test('the same seed reproduces the same song', async ({ page }) => {
    await page.goto('/')
    await page.getByRole('textbox').first().fill('a lo-fi beat, 20 seconds')
    await page.getByRole('button', { name: /Show controls/i }).click()
    await page.getByLabel('Seed').fill('reproducible-seed')

    await page.getByRole('button', { name: 'Generate song' }).click()
    const first = page.getByRole('heading', { level: 2 }).first()
    await expect(first).toBeVisible({ timeout: 150_000 })
    const firstTitle = await first.innerText()

    await page.getByRole('button', { name: 'Generate song' }).click()
    await page.waitForTimeout(500)
    await expect(page.getByRole('heading', { level: 2 }).first()).toBeVisible({ timeout: 150_000 })
    expect(await page.getByRole('heading', { level: 2 }).first().innerText()).toBe(firstTitle)
  })

  test('writes several takes from one brief and lets you pick between them', async ({ page }) => {
    const errors = watchForErrors(page)
    await page.goto('/')
    await page.getByRole('textbox').first().fill('a short lo-fi loop, 20 seconds')
    await page.getByRole('button', { name: /Show controls/i }).click()

    await page.getByRole('group', { name: 'Takes per run' }).getByRole('button', { name: '2' }).click()
    await page.getByRole('button', { name: 'Generate song' }).click()

    await expect(page.getByText('2 takes from one brief')).toBeVisible({ timeout: 200_000 })
    const chooser = page.getByRole('group', { name: 'Choose a take' })
    await expect(chooser.getByRole('button')).toHaveCount(2)

    // The first take is the one playing, and it is a finished song.
    const first = chooser.getByRole('button', { name: /Take 1/ })
    await expect(first).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByText(/0:00 \/ 0:\d\d/)).toBeVisible()

    // Switching takes swaps what is loaded, without generating again.
    const second = chooser.getByRole('button', { name: /Take 2/ })
    await second.click()
    await expect(second).toHaveAttribute('aria-pressed', 'true')
    await expect(first).toHaveAttribute('aria-pressed', 'false')

    // Several takes come back without stems; the one you keep can have them.
    const renderStems = page.getByRole('button', { name: 'Render stems for this take' })
    await expect(renderStems).toBeVisible()
    await renderStems.click()
    await expect(renderStems).toBeHidden({ timeout: 200_000 })
    await page.getByRole('button', { name: 'Stems', exact: true }).click()
    await expect(page.getByRole('button', { name: /^Play$/ }).first()).toBeVisible()

    expect(errors).toEqual([])
  })

  test('offers a re-render when the quality setting changes', async ({ page, isMobile }) => {
    test.skip(isMobile, 'The quality control lives in the desktop sidebar.')
    await page.goto('/')
    await page.getByRole('textbox').first().fill('a short lo-fi loop, 20 seconds')
    await page.getByRole('button', { name: 'Generate song' }).click()
    await expect(page.getByRole('heading', { level: 2 }).first()).toBeVisible({ timeout: 150_000 })

    // No re-render offered while the render matches the setting.
    await expect(page.getByRole('button', { name: /Re-render at/ })).toBeHidden()

    await page.getByRole('button', { name: 'Draft · 22 kHz' }).click()
    const rerender = page.getByRole('button', { name: /Re-render at Draft/ })
    await expect(rerender).toBeVisible()
    await rerender.click()
    await expect(rerender).toBeHidden({ timeout: 150_000 })
  })

  test('refuses to generate with nothing to go on', async ({ page }) => {
    await page.goto('/')
    await page.getByRole('button', { name: 'Generate song' }).click()
    await expect(page.getByText(/Describe the song you want/i)).toBeVisible()
  })
})

test.describe('lyric writer', () => {
  test('writes editable, structured lyrics', async ({ page }) => {
    const errors = watchForErrors(page)
    await page.goto('/lyrics')
    await page.getByLabel(/What is it about/i).fill('the last summer before everyone moved away')
    await page.getByRole('button', { name: /Write lyrics/i }).click()

    const editor = page.getByLabel('Lyrics')
    await expect(editor).toBeVisible({ timeout: 60_000 })
    const value = await editor.inputValue()
    expect(value.length).toBeGreaterThan(80)
    expect(value).toContain('[Chorus]')
    expect(value).not.toContain('%END')
    expect(value).not.toMatch(/[{}]/)

    // Both choruses are identical — that is what makes it a hook.
    const choruses = value.split(/\[Chorus[^\]]*\]/).slice(1).map((block) => block.split(/\n\[/)[0]!.trim())
    if (choruses.length > 1) expect(choruses[0]).toBe(choruses[1])

    await expect(page.getByText(/\d+ lines · \d+ syllables/)).toBeVisible()
    expect(errors).toEqual([])
  })

  test('sings edited lyrics over a backing track', async ({ page }) => {
    const errors = watchForErrors(page)
    await page.goto('/lyrics')
    await page.getByLabel(/What is it about/i).fill('driving home at the end of a long year')
    await page.getByRole('button', { name: /Write lyrics/i }).click()
    await expect(page.getByLabel('Lyrics')).toBeVisible({ timeout: 60_000 })

    // Replace the generated words entirely — the singer must follow the box.
    await page.getByLabel('Lyrics').fill(
      [
        'I was standing in the doorway when it turned cold',
        'We were younger and we never learned to wait',
        'Take me where the rivers run',
        'This is how we start again',
      ].join('\n'),
    )

    await page.getByRole('button', { name: /Sing it/i }).click()
    await expect(page.getByText(/0:00 \/ 0:\d\d/)).toBeVisible({ timeout: 150_000 })

    await page.getByRole('button', { name: 'Play' }).click()
    await page.waitForTimeout(1200)
    const readout = await page.getByText(/\d:\d\d \/ \d:\d\d/).first().innerText()
    expect(readout).not.toMatch(/^0:00 /)
    expect(errors).toEqual([])
  })
})

test.describe('text to speech', () => {
  test('synthesises speech and loads it into the transport', async ({ page }) => {
    const errors = watchForErrors(page)
    await page.goto('/voice')
    await page.getByLabel('Text to speak').fill('Testing the built in speech engine.')
    await page.getByRole('button', { name: /Speak & load/i }).click()

    await expect(page.getByText(/0:00 \/ 0:\d\d/)).toBeVisible({ timeout: 60_000 })
    await expect(page.getByText(/Testing the built in speech/i).last()).toBeVisible()
    expect(errors).toEqual([])
  })
})

test.describe('stem splitter', () => {
  test('separates an uploaded mix into stems', async ({ page }) => {
    const errors = watchForErrors(page)
    await page.goto('/stems')
    await page.setInputFiles('input[type="file"]', FIXTURE)
    await expect(page.getByText('test-mix.wav')).toBeVisible()

    await page.getByRole('button', { name: /Split vocal & backing/i }).click()
    await expect(page.getByText('Vocals', { exact: true })).toBeVisible({ timeout: 120_000 })
    await expect(page.getByText('Instrumental', { exact: true })).toBeVisible()
    expect(errors).toEqual([])
  })
})

test.describe('voice changer', () => {
  test('applies a character to an uploaded file', async ({ page }) => {
    const errors = watchForErrors(page)
    await page.goto('/shifter')
    await page.setInputFiles('input[type="file"]', FIXTURE)
    await expect(page.getByText('test-mix.wav')).toBeVisible()

    await page.getByRole('button', { name: 'Chipmunk' }).click()
    await page.getByRole('button', { name: 'Apply', exact: true }).click()
    await expect(page.getByText(/\+9 st · formant/)).toBeVisible({ timeout: 120_000 })
    expect(errors).toEqual([])
  })
})

test.describe('audio toolkit', () => {
  test('edits and analyses an uploaded file', async ({ page }) => {
    const errors = watchForErrors(page)
    await page.goto('/toolkit')
    await page.setInputFiles('input[type="file"]', FIXTURE)
    await expect(page.getByText('Length', { exact: true })).toBeVisible()

    // Normalise, then confirm the edit registered.
    await page.getByRole('button', { name: /Peak to −1 dB/i }).click()
    await expect(page.getByText(/Peak normalise applied/i)).toBeVisible({ timeout: 60_000 })

    await page.getByRole('button', { name: 'Analyse', exact: true }).first().click()
    await page.getByRole('button', { name: 'Analyse', exact: true }).last().click()
    // The fixture is a 120 BPM click, so detection should land on it.
    await expect(page.getByText(/^1\d\d(\.\d)? BPM$/)).toBeVisible({ timeout: 120_000 })
    await expect(page.getByText(/^-?\d+(\.\d)? LUFS$/)).toBeVisible()
    expect(errors).toEqual([])
  })
})

test.describe('library', () => {
  test('saves a generated song and lists it', async ({ page }) => {
    const errors = watchForErrors(page)
    await page.goto('/')
    await page.getByRole('textbox').first().fill('a short lo-fi loop, 20 seconds')
    await page.getByRole('button', { name: 'Generate song' }).click()
    await expect(page.getByRole('heading', { level: 2 }).first()).toBeVisible({ timeout: 150_000 })

    await page.getByRole('button', { name: /Save to library/i }).click()
    await expect(page.getByText(/Saved to your library/i)).toBeVisible({ timeout: 60_000 })

    await page.goto('/library')
    await expect(page.getByRole('button', { name: /^Open$|^Play$/ }).first()).toBeVisible({ timeout: 30_000 })
    expect(errors).toEqual([])
  })
})

test.describe('cover', () => {
  test('separates, transforms and rebuilds a full song', async ({ page }) => {
    const errors = watchForErrors(page)
    await page.goto('/shifter')
    await page.setInputFiles('input[type="file"]', FIXTURE)
    await expect(page.getByText('test-mix.wav')).toBeVisible()

    await page.getByRole('button', { name: 'A full song' }).click()
    await page.getByRole('button', { name: 'Deeper' }).click()
    await page.getByRole('button', { name: /Make a cover/i }).click()

    await expect(page.getByText('Cover parts')).toBeVisible({ timeout: 150_000 })
    await expect(page.getByRole('button', { name: /Full cover/ })).toBeVisible()
    await expect(page.getByRole('button', { name: /Backing track/ })).toBeVisible()

    // Loading a part swaps what the transport is playing.
    await page.getByRole('button', { name: /Backing track/ }).click()
    await expect(page.getByText(/— Backing track/)).toBeVisible()
    expect(errors).toEqual([])
  })
})

test.describe('single-file build', () => {
  test.skip(({ isMobile }) => isMobile, 'The bundle is identical; running it once is enough.')

  test('runs standalone, with no worker and no server', async ({ page }) => {
    const built = resolve(process.cwd(), 'dist-single/resonant-studio.html')
    test.skip(!existsSync(built), 'Run `npm run build:single` first.')

    const errors = watchForErrors(page)
    // Opened straight from disk: no origin, no worker, no network at all.
    await page.goto(pathToFileURL(built).href)
    await expect(page.getByRole('heading', { name: /Describe a song/i })).toBeVisible()

    await page.getByRole('textbox').first().fill('a lofi beat, 20 seconds')
    await page.getByRole('button', { name: 'Generate song' }).click()
    await expect(page.getByText('Arrangement', { exact: true })).toBeVisible({ timeout: 150_000 })
    await expect(page.getByText(/0:00 \/ 0:\d\d/)).toBeVisible()

    // Routing has to work with no server able to rewrite paths.
    await page.getByRole('link', { name: 'Audio Toolkit', exact: true }).first().click()
    await expect(page.getByRole('heading', { name: /Edit, treat and measure/i })).toBeVisible()

    expect(errors).toEqual([])
  })
})
