/**
 * The forensic caption: the person's Style, and nothing else.
 *
 * The first real generation has to answer one question — does ACE-Step follow
 * the Style, the bpm field, the lyrics and the melody? With the planner's
 * derived directions appended to the caption, it cannot. A song that comes
 * back sounding "Pop" proves nothing when the caption said "Pop"; the model
 * would have been graded against the planner's paraphrase of the request
 * rather than the request.
 *
 * So `bare` mode sends the Style byte for byte. What it does NOT do is remove
 * anything: every direction is still derived, `MusicControlSpec` is untouched,
 * and the withheld directions are listed so a report can say exactly what the
 * model was not told. A bare caption produced by a planner that derived
 * nothing would look identical from the outside and mean something completely
 * different, so that distinction is asserted here rather than assumed.
 */

import { describe, expect, it } from 'vitest'
import { planLiveGeneration } from '../../src/engine/live/plan'
import { compilePrompt } from '../../src/engine/live/promptCompiler'

const STYLE = 'Romantic melancholic pop ballad, 72 BPM, warm soulful vocal, intimate grand '
  + 'piano, soft acoustic guitar, tender strings, gentle bass, minimal percussion, '
  + 'spacious organic production, poetic storytelling, memorable singable chorus, '
  + 'emotional vocal harmonies, gradual build, bittersweet and heartfelt, elegant '
  + 'contemporary arrangement, sincere and timeless.'

const LYRICS = '[Verse 1]\nMalam menaruh cahaya di jendela\nDan namamu tinggal dalam doa\n\n'
  + '[Chorus]\nAku tetap memilihmu\nDi antara seribu jalan yang berlalu\n\n[End]\n'

const plan = (style: string = STYLE) => planLiveGeneration({
  style, lyrics: LYRICS, instrumental: false,
  vocalGender: 'male', language: 'auto', durationSeconds: 210,
})

describe('the bare caption is the user Style and nothing else', () => {
  it('sent_caption === original_user_style', () => {
    const compiled = compilePrompt(plan(), STYLE, 'bare')
    expect(compiled.caption).toBe(STYLE)
    expect(compiled.caption.length).toBe(STYLE.length)
    expect(compiled.captionMode).toBe('bare')
  })

  it('appends none of the planner\'s derived vocabulary', () => {
    const compiled = compilePrompt(plan(), STYLE, 'bare')
    for (const tag of ['popular', 'muted and measured', 'steady time', 'sung lead vocal',
      'baritone', 'warm lower-mid range', 'synth bass', 'saw lead', 'warm pad',
      'verse-chorus structure', 'no robotic delivery']) {
      // Guard the guard: a tag the person themselves wrote would be in the
      // caption legitimately, and asserting its absence would be wrong.
      expect(STYLE.toLowerCase()).not.toContain(tag.toLowerCase())
      expect(compiled.caption.toLowerCase()).not.toContain(tag.toLowerCase())
    }
  })

  it('still derives every direction, and records what it withheld', () => {
    const compiled = compilePrompt(plan(), STYLE, 'bare')
    expect(compiled.withheld.length).toBeGreaterThan(0)
    expect(compiled.dropped).toEqual([])
    for (const item of compiled.withheld) {
      expect(item.id).toBeTruthy()
      expect(item.text.trim()).toBe(item.text)
      expect(item.text.length).toBeGreaterThan(0)
    }
    // Withheld and included are disjoint, and together they account for every
    // direction the compiled mode would have considered.
    const compiledMode = compilePrompt(plan(), STYLE, 'compiled')
    const bareIds = [...compiled.withheld.map((item) => item.id), ...compiled.included].sort()
    const compiledIds = [...compiledMode.included, ...compiledMode.dropped].sort()
    expect(bareIds).toEqual(compiledIds)
  })

  it('a direction the person wrote themselves counts as included, not withheld', () => {
    // The person's own words are theirs. They are not "withheld" — they are
    // already in the caption because they wrote them.
    const compiled = compilePrompt(plan(), STYLE, 'bare')
    for (const item of compiled.withheld) {
      expect(STYLE.toLowerCase()).not.toContain(item.text.toLowerCase())
    }
  })

  it('never exceeds the model\'s caption limit', () => {
    const compiled = compilePrompt(plan(), STYLE, 'bare')
    expect(compiled.characters).toBe(compiled.caption.length)
    expect(compiled.characters).toBeLessThanOrEqual(compiled.limit)
  })

  it('leaves the compiled mode exactly as it was, and it is still the default', () => {
    // The Studio must not change. Only the real-run harness asks for bare.
    const byDefault = compilePrompt(plan(), STYLE)
    const explicit = compilePrompt(plan(), STYLE, 'compiled')
    expect(byDefault.caption).toBe(explicit.caption)
    expect(byDefault.captionMode).toBe('compiled')
    expect(byDefault.withheld).toEqual([])
    // And the compiled caption really is longer, or this test proves nothing.
    expect(byDefault.caption.length).toBeGreaterThan(STYLE.length)
    expect(byDefault.caption.startsWith(STYLE)).toBe(true)
  })

  it('carries the style through unedited even when it is short', () => {
    const terse = 'Slow piano ballad at 72 BPM.'
    const compiled = compilePrompt(plan(terse), terse, 'bare')
    expect(compiled.caption).toBe(terse)
  })

  it('a style the person wrote a derived word into keeps that word', () => {
    const withOwnWord = `${STYLE} Recorded with a baritone lead.`
    const compiled = compilePrompt(plan(withOwnWord), withOwnWord, 'bare')
    expect(compiled.caption).toBe(withOwnWord)
    expect(compiled.caption.toLowerCase()).toContain('baritone')
  })
})
