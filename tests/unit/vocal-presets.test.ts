/**
 * The rule that makes the presets safe: the person's text is never touched.
 *
 * Selection is kept apart from what they typed and joined to it only when a
 * request is built. That is what lets a preset be removed cleanly — there is no
 * hint to find and delete in text that may have been edited since it was added.
 */

import { describe, expect, it } from 'vitest'
import {
  VOCAL_PRESETS, composeStyle, togglePreset,
} from '../../src/lib/vocalPresets'
import { planZeroGpuRequest } from '../../src/engine/providers'

const STYLE = 'Romantic melancholic jazz ballad, 72 BPM, soulful soft male vocal'

describe('vocal hints are added to a caption without rewriting it', () => {
  it('changes nothing at all when none is chosen', () => {
    expect(composeStyle(STYLE, [])).toBe(STYLE)
    // Not even the whitespace: an untouched caption is untouched.
    expect(composeStyle('  spaced out  ', [])).toBe('  spaced out  ')
  })

  it('appends the chosen hint after what was written', () => {
    const composed = composeStyle(STYLE, ['baritone'])
    expect(composed.startsWith(STYLE)).toBe(true)
    expect(composed).toBe(`${STYLE}, ${VOCAL_PRESETS[0]!.hint}`)
  })

  it('never mutates the caption it was given', () => {
    const original = STYLE
    composeStyle(original, ['baritone', 'soft-vibrato'])
    expect(original).toBe(STYLE)
  })

  it('composes in a fixed order, whichever order they were clicked', () => {
    const one = composeStyle(STYLE, ['sustained', 'baritone', 'soft-vibrato'])
    const two = composeStyle(STYLE, ['soft-vibrato', 'baritone', 'sustained'])
    expect(one).toBe(two)
    // And that order is the order they are declared in, so the caption reads
    // the same way every time.
    expect(one.indexOf('baritone')).toBeLessThan(one.indexOf('vibrato'))
  })

  it('removing one leaves the original plus whatever is still chosen', () => {
    const both = ['baritone', 'sustained']
    const after = togglePreset(both, 'baritone')
    expect(after).toEqual(['sustained'])
    expect(composeStyle(STYLE, after)).toBe(`${STYLE}, ${VOCAL_PRESETS[5]!.hint}`)
    // And removing the last one gets the caption back exactly.
    expect(composeStyle(STYLE, togglePreset(after, 'sustained'))).toBe(STYLE)
  })

  it('does not say the same thing twice', () => {
    const twice = composeStyle(STYLE, ['baritone', 'baritone'])
    expect(twice).toBe(`${STYLE}, ${VOCAL_PRESETS[0]!.hint}`)
  })

  it('skips a hint the person has already written themselves', () => {
    const written = `${STYLE}, ${VOCAL_PRESETS[0]!.hint}`
    expect(composeStyle(written, ['baritone'])).toBe(written)
  })

  it('joins cleanly onto a caption that ends in punctuation', () => {
    expect(composeStyle('jazz ballad,  ', ['minimal-vibrato']))
      .toBe(`jazz ballad, ${VOCAL_PRESETS[4]!.hint}`)
    expect(composeStyle('', ['minimal-vibrato'])).toBe(VOCAL_PRESETS[4]!.hint)
  })

  it('toggling is a pure function of what came in', () => {
    const before = ['tenor']
    const after = togglePreset(before, 'sustained')
    expect(before).toEqual(['tenor'])
    expect(after).toEqual(['tenor', 'sustained'])
  })

  it('promises nothing the model cannot do', () => {
    // These words read as instructions a model will obey. It has no key, scale,
    // pitch or melody parameter, so a caption claiming otherwise is a lie told
    // to the person reading the chip.
    const forbidden = /perfect pitch|accurate pitch|in tune|no wrong notes|guaranteed|exact pitch/i
    for (const preset of VOCAL_PRESETS) {
      expect(preset.hint, `${preset.id} hint`).not.toMatch(forbidden)
      expect(preset.description, `${preset.id} description`).not.toMatch(forbidden)
    }
  })
})

describe('the request contract is unchanged by any of this', () => {
  const request = {
    style: composeStyle(STYLE, ['baritone', 'sustained']),
    lyrics: '[Verse 1]\nMalam turun perlahan',
    language: 'id',
    vocalGender: 'male',
  }

  it('still sends exactly the six inputs the Space declares', () => {
    const plan = planZeroGpuRequest(request as never, {} as never)
    expect(plan.data).toHaveLength(6)
    expect(typeof plan.data[0]).toBe('string')   // style, hints included
    expect(typeof plan.data[1]).toBe('string')   // lyrics
    expect(typeof plan.data[2]).toBe('string')   // language
    expect(plan.data[3]).toBe('male')            // vocal_gender
    expect(typeof plan.data[4]).toBe('boolean')  // instrumental
    expect(typeof plan.data[5]).toBe('number')   // duration
  })

  it('adds no parameter for anything the endpoint does not take', () => {
    const plan = planZeroGpuRequest(request as never, {} as never)
    const sent = JSON.stringify(plan.data).toLowerCase()
    for (const unsupported of ['seed', 'guidance', 'cfg', 'inference_steps',
      'temperature', 'bpm', 'key', 'scale']) {
      expect(sent, `${unsupported} must not be sent`).not.toContain(`"${unsupported}"`)
    }
  })

  it('carries the hints in the caption, which is the only channel there is', () => {
    const plan = planZeroGpuRequest(request as never, {} as never)
    expect(plan.data[0]).toContain('warm male baritone lead vocal')
    expect(plan.data[0]).toContain(STYLE)
  })
})
