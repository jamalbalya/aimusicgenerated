/**
 * What the person wrote in the style box, and whether it survives the planner.
 *
 * A reported generation came back planned as
 *
 *     Genre  Rock          Key  A minor          Tempo  112 BPM
 *
 * from a style that opens "Hardcore conscious hip-hop / rap-rock" and says
 * "dark F-minor tonal center". Two explicit statements were replaced by
 * guesses, and the interface printed the guesses as the plan.
 *
 * Both had the same shape of cause, and neither was a scoring preference:
 *
 *   * `parseKey` demanded the word "in" or "key of" in front of the note.
 *     "dark F-minor tonal center" says neither, so the key read as absent and
 *     the planner fell through to `rng.pick([0, 2, 3, 5, 7, 8, 9, 10])`.
 *     A minor was a random draw presented as a decision.
 *
 *   * Genre labels and tags were matched as plain substrings. The Hip Hop
 *     label is "hip hop"; the text said "hip-hop"; they never matched. "Rock"
 *     did match — inside "rap-rock". The genre nobody asked for won on a
 *     fragment of the genre they did.
 *
 * So these tests call what the Generate button calls — `planLiveGeneration`
 * and then `compilePrompt` — and assert on the values the interface prints and
 * on the parameters the provider is handed. The false-positive guards matter
 * as much as the fixes: a looser key parser that reads "a minor detail" as a
 * key would be worse than the bug.
 */

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { planLiveGeneration, type LiveGenerationInput } from '../../src/engine/live/plan'
import { compilePrompt } from '../../src/engine/live/promptCompiler'
import { aceStepKeyscale } from '../../src/engine/live/musicControlSpec'
import { buildSpec } from '../../src/engine/compose/prompt'

/** The style as reported from the live site, verbatim. */
const STYLE = 'Hardcore conscious hip-hop / rap-rock, 112 BPM, aggressive mature male vocal, '
  + 'dark F-minor tonal center, heavy boom-bap drums, distorted bass, sharp electric guitar riffs, '
  + 'ominous piano, industrial impacts, restrained opening rap, escalating rhythmic verses, '
  + 'full-speed double-time rap across the central section, explosive melodic hook, '
  + 'half-time bridge, layered gang vocals, cinematic tension, raw defiance and urgency, '
  + 'precise diction, controlled breathing, dynamic final climax, polished modern production, '
  + 'no EDM, no trap overload, no artist imitation.'

/** The lyric sheet as supplied, byte for byte. */
const LYRICS = readFileSync(new URL('./fixtures/rap-rock-lyrics.txt', import.meta.url), 'utf8')
  .replace(/\n$/, '')

const input = (): LiveGenerationInput => ({
  style: STYLE, lyrics: LYRICS, language: 'auto', vocalGender: 'auto',
  instrumental: false, durationSeconds: undefined,
})

const NOTES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']

describe('an explicit style is not replaced by a guess', () => {
  it('keeps the stated tempo of 112 BPM', () => {
    const plan = planLiveGeneration(input())
    expect(plan.music.targetBpm).toBe(112)
    expect(plan.music.bpmStated).toBe(true)
  })

  it('keeps the stated key of F minor, which used to come back A minor', () => {
    const plan = planLiveGeneration(input())
    expect(plan.music.keyName).toBe('F minor')
    expect(NOTES[plan.music.tonic]).toBe('F')
    expect(plan.music.scale).toBe('minor')
  })

  it('reads the key the same way however many times it is planned', () => {
    // The old failure was a random draw, so it only looked stable by luck.
    const keys = new Set<string>()
    for (let i = 0; i < 8; i += 1) keys.add(planLiveGeneration(input()).music.keyName)
    expect([...keys]).toEqual(['F minor'])
  })

  it('does not reduce "hip-hop / rap-rock" to generic Rock', () => {
    const plan = planLiveGeneration(input())
    expect(plan.music.genre).not.toBe('Rock')
    expect(plan.music.genre).toBe('Hip Hop')
    expect(plan.music.genreId).toBe('hiphop')
  })

  it('plans a rapped vocal, which is what the genre decides', () => {
    expect(planLiveGeneration(input()).music.vocalType).toMatch(/rap/i)
  })
})

describe('the key parser does not invent keys out of ordinary prose', () => {
  const keyOf = (style: string): string => {
    const spec = buildSpec(style, { seed: 'fixed-for-this-test' })
    return `${NOTES[spec.key.tonic]} ${spec.key.scale}`
  }

  it('reads a hyphenated key', () => {
    expect(keyOf('brooding track, dark F-minor tonal center')).toBe('F minor')
    expect(keyOf('bright song, Bb-major tonal center')).toBe('A# major')
  })

  it('reads a key named before the word "tonal center"', () => {
    expect(keyOf('ballad, F minor tonal center, warm piano')).toBe('F minor')
  })

  it('still reads the anchored forms it always did', () => {
    expect(keyOf('moody track in C# minor')).toBe('C# minor')
    expect(keyOf('a piece in the key of Eb')).toBe('D# major')
  })

  it('does not read "a minor detail" as the key of A minor', () => {
    // The guard that makes the looser parser safe: an unanchored note must be
    // capitalised, because that is how a key is written and prose is not.
    expect(keyOf('warm ballad, a minor detail in the mix')).not.toBe('A minor')
    expect(keyOf('warm ballad, a minor adjustment to the drums')).not.toBe('A minor')
  })
})

describe('genre matching reads hyphens and slashes as spaces', () => {
  it('matches a hyphenated request against a spaced label', () => {
    expect(buildSpec('hip-hop track, boom-bap drums', { seed: 's' }).genre.label).toBe('Hip Hop')
  })

  it('still matches genres whose own tags contain hyphens', () => {
    // Normalising only the text would break these: the tags are "lo-fi" and
    // "k-pop". Both sides are flattened, so either spelling works.
    expect(buildSpec('lo-fi chill beats', { seed: 's' }).genre.label).toBe('Lo-fi Chill')
    expect(buildSpec('lo fi chill beats', { seed: 's' }).genre.label).toBe('Lo-fi Chill')
    expect(buildSpec('k-pop dance track', { seed: 's' }).genre.label).toBe('K-Pop')
  })
})

describe('the sheet the person wrote is the form that is planned', () => {
  it('keeps every section, with its own direction', () => {
    const plan = planLiveGeneration(input())
    const sections = plan.lyrics.script.sections.map((s) => `${s.sectionName}|${s.sectionDirection}`)
    expect(sections).toEqual([
      'Intro|Dark Piano',
      'Verse 1|Controlled Rap',
      'Pre-Chorus|Rising Guitar',
      'Chorus|Explosive Rap-Rock',
      'Verse 2|Aggressive Rap',
      'Full-Speed Rap|Double-Time',
      'Pre-Chorus|Rising Drums',
      'Chorus|Full Energy',
      'Bridge|Half-Time',
      'Final Chorus|Maximum Energy',
      'Outro|Distorted Guitar',
    ])
  })

  it('carries the double-time and half-time instructions per section, not globally', () => {
    const plan = planLiveGeneration(input())
    const byLabel = new Map(plan.music.form.map((f) => [f.label, f]))
    expect(byLabel.get('Full-Speed Rap, Double-Time')?.direction).toBe('Double-Time')
    expect(byLabel.get('Bridge, Half-Time')?.direction).toBe('Half-Time')
    expect(byLabel.get('Final Chorus, Maximum Energy')?.direction).toBe('Maximum Energy')
    // Each is attached to one section. No other section inherits them.
    const doubleTime = plan.music.form.filter((f) => /double-time/i.test(f.direction ?? ''))
    const halfTime = plan.music.form.filter((f) => /half-time/i.test(f.direction ?? ''))
    expect(doubleTime).toHaveLength(1)
    expect(halfTime).toHaveLength(1)
  })

  it('treats [End] as a marker and never as something to sing', () => {
    const plan = planLiveGeneration(input())
    expect(plan.lyrics.script.terminated).toBe(true)
    expect(/\[\s*end\s*\]/i.test(plan.lyrics.text)).toBe(false)
    expect(LYRICS.startsWith(plan.lyrics.text)).toBe(true)
  })

  it('sends the sheet whole, with nothing rewritten or dropped', () => {
    const plan = planLiveGeneration(input())
    const sung = (text: string): string[] =>
      text.split('\n').filter((l) => l.trim() && !/^\[/.test(l.trim()))
    expect(sung(plan.lyrics.text)).toEqual(sung(LYRICS))
  })
})

describe('the request that reaches ACE-Step', () => {
  it('fits the 4096-character lyric contract without truncating anything', () => {
    const plan = planLiveGeneration(input())
    expect(plan.lyrics.text.length).toBeLessThanOrEqual(4096)
    // Under the limit, so nothing may be dropped to fit it.
    expect(plan.lyrics.text.length).toBe(LYRICS.length - '\n\n[End]'.length)
  })

  it('keeps the caption within ACE-Step\'s 512 characters', () => {
    const compiled = compilePrompt(planLiveGeneration(input()), STYLE)
    expect(compiled.caption.length).toBeLessThanOrEqual(512)
  })

  it('keeps the genre identity in the caption rather than spending it on filler', () => {
    const compiled = compilePrompt(planLiveGeneration(input()), STYLE)
    expect(compiled.caption).toMatch(/hip-?hop/i)
    expect(compiled.caption).toMatch(/rap/i)
    expect(compiled.caption).toMatch(/f-?minor/i)
    expect(compiled.caption).toMatch(/no EDM/i)
  })

  it('sends tempo and key as parameters, which is where they cannot be overwritten', () => {
    // Deliberately not in the caption: `GenerationParams.bpm` and `.keyscale`
    // are real fields, and prose saying the same thing less precisely would
    // only compete with them for the 512 characters.
    const plan = planLiveGeneration(input())
    expect(plan.music.targetBpm).toBe(112)
    expect(aceStepKeyscale(plan.music.tonic, plan.music.scale)).toBe('F Minor')
  })
})
