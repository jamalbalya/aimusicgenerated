/**
 * How many takes a run is allowed to write.
 *
 * Every neural take is its own generation. On the free ZeroGPU Space that is
 * its own slice of an allowance covering about one song a day, so a run of four
 * spends the day to return one song and three refusals.
 *
 * The rule the studio enforces is about the *backend*, not the engine. The
 * end-to-end tests can only exercise the backend the build was configured with,
 * so the table that matters — that a neural run on a machine of one's own is
 * left alone — is pinned here, where every backend can be asked at once.
 */

import { describe, expect, it } from 'vitest'

const { effectiveTakeCount } = await import('../../src/ui/pages/StudioPage')

describe('the free Space writes one take per run', () => {
  it('caps a neural run on ZeroGPU at one, whatever was asked for', () => {
    for (const asked of [1, 2, 3, 4]) {
      expect(effectiveTakeCount(asked, 'neural', 'zerogpu')).toBe(1)
    }
  })

  it('is the backend that caps, not the engine', () => {
    // An ACE-Step server on your own machine has no daily allowance to spend,
    // so a neural run there keeps every take it was asked for. A rule written
    // as "neural means one take" would fail this.
    for (const asked of [1, 2, 3, 4]) {
      expect(effectiveTakeCount(asked, 'neural', 'local')).toBe(asked)
    }
  })

  it('leaves the offline engine alone on either backend', () => {
    // Its takes are rendered on the device and cost nothing but time.
    for (const backend of ['zerogpu', 'local'] as const) {
      for (const asked of [1, 2, 3, 4]) {
        expect(effectiveTakeCount(asked, 'procedural', backend)).toBe(asked)
      }
    }
  })
})
