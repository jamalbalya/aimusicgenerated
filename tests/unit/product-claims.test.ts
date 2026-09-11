/**
 * What the site says about where a song is made.
 *
 * The offline engine really does run on the device, and the copy said so
 * everywhere. Then Neural mode became the engine a visitor lands on once the
 * Space answers — and it sends the style and the lyric sheet to Hugging Face,
 * queues, and has a daily allowance. "Nothing uploaded, ever" stopped being
 * true of the thing most people would use first.
 *
 * These tests read the copy itself rather than the rendered page, so they cover
 * the README and the page metadata too, and so a claim cannot come back by
 * being moved somewhere else.
 */

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8')

/** Everywhere a visitor reads a promise about this application. */
const SURFACES = {
  'the About page': 'src/ui/pages/AboutPage.tsx',
  'the README': 'README.md',
  'the page metadata': 'index.html',
} as const

/**
 * Claims that are true of the offline engine and false of the neural one.
 *
 * Each is matched as written, allowing for line wrapping, because the wording
 * is what a person reads; a paraphrase that means the same thing would be a new
 * claim to judge on its own.
 */
const RETIRED_CLAIMS: [name: string, pattern: RegExp][] = [
  ['nothing uploaded, ever', /nothing\s+uploaded,?\s+ever/i],
  ['nothing uploaded anywhere', /nothing\s+uploaded\s+anywhere/i],
  ['no daily quota', /no\s+daily\s+quota/i],
  ['no queue', /\bno\s+queue\b/i],
  ['unlimited generations, every day', /unlimited\s+generations,\s+every\s+day/i],
  ['everything runs here', /everything\s+runs\s+here/i],
  ['runs entirely in your browser', /runs\s+entirely\s+in\s+(your|the)\s+browser/i],
  ['all of it unlimited', /all\s+of\s+it\s+unlimited/i],
]

describe('the site does not promise what the neural engine cannot keep', () => {
  for (const [surface, path] of Object.entries(SURFACES)) {
    const text = read(path)
    for (const [claim, pattern] of RETIRED_CLAIMS) {
      it(`${surface} does not claim "${claim}"`, () => {
        expect(pattern.test(text), `${path} still says "${claim}"`).toBe(false)
      })
    }
  }

  it('is not vacuous: the patterns match the wording that shipped', () => {
    // The exact sentences these tests exist to keep out, so a regex that had
    // been loosened into uselessness would fail here.
    const shipped = 'Everything runs here. That is why it is free. There is no server doing the '
      + 'work, so there is no bill to pass on to you, no queue, no daily quota and no account. '
      + 'Unlimited generations, every day. Nothing uploaded, ever. all of it unlimited, '
      + 'unwatermarked and free, with nothing uploaded anywhere. runs entirely in your browser.'
    for (const [claim, pattern] of RETIRED_CLAIMS) {
      expect(pattern.test(shipped), `the pattern for "${claim}" no longer matches its own wording`).toBe(true)
    }
  })
})

describe('the About page says what the neural engine actually does', () => {
  const about = read('src/ui/pages/AboutPage.tsx')

  it('names the model and where it runs', () => {
    expect(about).toMatch(/ACE-Step 1\.5/)
    expect(about).toMatch(/Hugging Face ZeroGPU/)
  })

  it('says the style and lyrics leave the device', () => {
    expect(about.replace(/\s+/g, ' ')).toMatch(/sends your style and lyrics/i)
  })

  it('says there is a queue and a daily allowance', () => {
    expect(about).toMatch(/queue/i)
    expect(about).toMatch(/daily (allowance|limit)/i)
  })

  it('lists exactly what is sent, and no more', () => {
    // JSX wraps prose across lines, so every phrase here is matched with the
    // line breaks collapsed, the way a reader sees it rather than the way the
    // file stores it.
    const prose = about.replace(/\s+/g, ' ')
    // The six inputs of the Space's endpoint, as the provider sends them.
    for (const value of [
      'the style', 'your lyrics exactly as you wrote them', 'the language',
      'the vocal gender', 'whether you asked for an instrumental', 'the length',
    ]) {
      expect(prose, `the About page should name "${value}" among what is sent`).toContain(value)
    }
    expect(prose).toMatch(/no account, no identifier/i)
  })

  it('still says the offline engine keeps everything on the device', () => {
    const prose = about.replace(/\s+/g, ' ')
    expect(prose).toMatch(/offline engine/i)
    expect(prose).toMatch(/on your own device/i)
  })
})
