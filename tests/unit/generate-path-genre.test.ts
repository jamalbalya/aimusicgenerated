/**
 * The genre the Generate button actually produces.
 *
 * The previous round of this fix was verified against `detectGenre` alone and
 * reported as if the pipeline were proven. It was not: `detectGenre` is one
 * function on a path that runs
 *
 *     style text -> buildSpec -> planLiveGeneration -> compilePrompt -> caption
 *
 * and a unit test on the first link says nothing about the last. Worse, testing
 * `detectGenre` in isolation hid two real holes that only the whole path shows:
 * the genre is labelled "EDM / Festival", so "no EDM" matched no label and the
 * refusal was dropped; and `buildSpec` falls back to Pop when nothing is
 * detected, which would hand back the very genre a "no pop" had ruled out.
 *
 * So these tests call what the button calls. `StudioPage` runs
 * `planLiveGeneration(...)` and then `compilePrompt(plan, style)`; both are
 * exercised here with the same arguments, and the assertions are on
 * `plan.music.genre` — the value the interface prints as "Genre" — and on the
 * caption string that is posted to the Space.
 */

import { describe, expect, it } from 'vitest'
import { planLiveGeneration, type LiveGenerationInput } from '../../src/engine/live/plan'
import { compilePrompt } from '../../src/engine/live/promptCompiler'
import { GENRES } from '../../src/engine/compose/genres'
import { genreIsRefused, parseExclusions } from '../../src/engine/compose/prompt'

/** The style that was reported from the live site, verbatim. */
const REPORTED_STYLE = 'Cinematic Indonesian pop ballad, 84 BPM, deeply melancholic and '
  + 'intimate, warm mature male vocal, emotional grand piano, soft acoustic guitar, subtle '
  + 'warm strings, deep gentle bass, minimal organic percussion, spacious restrained '
  + 'production, simple poetic lyrics, short memorable phrases, quiet loneliness, emptiness '
  + 'and inner strength, gradual emotional build, heartfelt final chorus, dignified sorrow, '
  + 'no jazz, no EDM.'

const REPORTED_LYRICS = `[Intro, Sparse Piano]
Malam turun perlahan
Rumah mulai kehilangan suara

[Verse 1, Intimate Male Vocal]
Esok belum datang
Namun sudah ia pikirkan

[Chorus, Emotional Pop Vocal]
Di balik diamnya ayah
Ada hati yang sedang lelah

[Outro, Piano and Fading Strings]
Malam perlahan berganti pagi

[End]
`

/** Exactly the arguments StudioPage passes when the button is pressed. */
const generate = (style: string, lyrics = REPORTED_LYRICS) => {
  const input: LiveGenerationInput = {
    style, lyrics, instrumental: false,
    vocalGender: 'male', language: 'auto', durationSeconds: 210,
  }
  const plan = planLiveGeneration(input)
  const compiled = compilePrompt(plan, style)
  return { plan, compiled, appended: compiled.caption.slice(style.length) }
}

/** Words that would mean the engine asked for the thing the person refused. */
const JAZZ_WORDS = ['jazz', 'swing', 'swung', 'shuffled', 'bebop', 'bossa']
const EDM_WORDS = ['edm', 'festival', 'big room', 'techno', 'house', 'dubstep', 'four on the floor']

describe('the Generate path never returns a refused genre', () => {
  it('the reported style produces Pop, not Jazz and not EDM', () => {
    const { plan } = generate(REPORTED_STYLE)
    expect(plan.music.genre).not.toBe('Jazz')
    expect(plan.music.genre).not.toBe('EDM / Festival')
    expect(plan.music.genre).toBe('Pop')
    expect(plan.music.genreId).toBe('pop')
    expect(plan.music.genreFamily).toBe('Popular')
  })

  it('and the rest of the plan matches what was asked for', () => {
    const { plan } = generate(REPORTED_STYLE)
    expect(plan.music.targetBpm).toBe(84)
    expect(plan.music.bpmStated).toBe(true)
    expect(plan.music.mood).toBe('Sad')
    // "deeply melancholic ... dignified sorrow" is not a major-key song.
    expect(plan.music.keyName.toLowerCase()).toContain('minor')
    // And not a swing feel.
    expect(plan.music.groove.toLowerCase()).not.toContain('swing')
    expect(plan.music.groove.toLowerCase()).not.toContain('shuffl')
  })

  it('the caption posted to the Space carries no jazz or EDM direction', () => {
    const { compiled, appended } = generate(REPORTED_STYLE)
    // The person's own refusal stays exactly as they typed it.
    expect(compiled.caption).toContain('no jazz, no EDM.')
    expect(compiled.caption.startsWith(REPORTED_STYLE)).toBe(true)
    // What the engine added must not contradict them.
    for (const word of [...JAZZ_WORDS, ...EDM_WORDS]) {
      expect(appended.toLowerCase()).not.toContain(word)
    }
  })

  it('both refusals are seen, not just the one whose label matched', () => {
    // "no EDM" used to match nothing: the genre is labelled "EDM / Festival".
    const refused = GENRES
      .filter((genre) => genreIsRefused(REPORTED_STYLE.toLowerCase(), genre))
      .map((genre) => genre.label)
    expect(refused).toContain('Jazz')
    expect(refused).toContain('EDM / Festival')
  })
})

describe('refusals hold across wordings, languages and the fallback', () => {
  const phrasings: [string, string][] = [
    ['English "no"', 'Warm piano ballad, no jazz'],
    ['English "without"', 'Warm piano ballad, without jazz'],
    ['English "avoid"', 'Warm piano ballad, avoid jazz'],
    ['English "not"', 'Warm piano ballad, not jazz'],
    ['Indonesian "tanpa"', 'Balada piano hangat, tanpa jazz'],
    ['Indonesian "bukan"', 'Balada piano hangat, bukan jazz'],
    ['Indonesian "jangan"', 'Balada piano hangat, jangan jazz'],
    ['Indonesian "hindari"', 'Balada piano hangat, hindari jazz'],
  ]
  for (const [name, style] of phrasings) {
    it(`${name}: the plan is not Jazz and the caption adds no swing`, () => {
      const { plan, appended } = generate(style)
      expect(plan.music.genre).not.toBe('Jazz')
      for (const word of JAZZ_WORDS) expect(appended.toLowerCase()).not.toContain(word)
    })
  }

  it('"no EDM" keeps every electronic-dance genre out of the plan', () => {
    const { plan, appended } = generate('Acoustic ballad with piano, no EDM')
    expect(plan.music.genre).not.toBe('EDM / Festival')
    for (const word of EDM_WORDS) expect(appended.toLowerCase()).not.toContain(word)
  })

  it('"no pop" is not answered with Pop by the fallback', () => {
    // buildSpec falls back to Pop when it detects nothing. The fallback has to
    // read the refusals too, or the default quietly overrules the person.
    const { plan } = generate('A quiet instrumental piece, no pop')
    expect(plan.music.genre).not.toBe('Pop')
    expect(plan.music.genreId).not.toBe('pop')
  })

  it('refusing everything still yields a usable plan rather than a crash', () => {
    const style = GENRES.map((genre) => `no ${genre.label.toLowerCase()}`).join(', ')
    const { plan } = generate(`A song, ${style}`)
    expect(plan.music.genre).toBeTruthy()
    expect(plan.music.targetBpm).toBeGreaterThan(0)
  })

  it('a refusal does not stop somebody asking for that genre elsewhere', () => {
    const { plan } = generate('Smoky jazz ballad, brushed drums, no EDM')
    expect(plan.music.genre).toBe('Jazz')
  })

  it('an empty refusal list changes nothing', () => {
    expect(parseExclusions(' warm piano ballad at 84 bpm ')).toEqual([])
    const { plan } = generate('Smoky jazz ballad at 72 BPM, brushed drums')
    expect(plan.music.genre).toBe('Jazz')
  })
})
