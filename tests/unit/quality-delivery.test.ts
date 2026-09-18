/**
 * The product claim, checked on real generated material rather than fixtures.
 *
 * Two things have to hold at once and they pull against each other. Nothing
 * that failed the gate may ever be opened — that is the safety property, and a
 * gate that refuses everything satisfies it perfectly. And the studio has to
 * actually produce songs — that is the product, and a gate that passes
 * everything satisfies that one. So this runs the loop the page runs, over real
 * composed scores across a spread of genres, and asserts both.
 */

import { describe, expect, it } from 'vitest'
import { buildSpec } from '../../src/engine/compose/prompt'
import { composeSong } from '../../src/engine/compose/composer'
import { gateScoreTake, OFFLINE_MAX_ATTEMPTS, DEFAULT_MAX_ATTEMPTS } from '../../src/engine/quality'

const PROMPTS = [
  'dangdut koplo sarcastic workplace anthem', 'lofi chill study music',
  'heavy metal guitar', 'upbeat pop love song', 'romantic melancholic jazz ballad',
  'punk rock fast', 'bossa nova', 'epic cinematic trailer',
]

describe('the loop the studio runs', () => {
  it('opens nothing that did not pass, and still delivers a song', () => {
    let delivered = 0
    let refused = 0

    for (const prompt of PROMPTS) {
      for (const run of [0, 1, 2]) {
        let opened = false
        for (let attempt = 1; attempt <= OFFLINE_MAX_ATTEMPTS; attempt++) {
          const score = composeSong(buildSpec(prompt, { seed: `${prompt}|run${run}|a${attempt}` }))
          const report = gateScoreTake(score)
          if (report.verdict === 'PASS') { opened = true; break }
          // The page's loop opens a take only on PASS, and keeps a non-PASS one
          // only when it is not a hard failure. Every rejection here is a hard
          // failure, so nothing was kept and nothing was opened.
          expect(report.verdict).toBe('REGENERATION_REQUIRED')
          expect(report.failedChecks.length).toBeGreaterThan(0)
        }
        if (opened) delivered++
        else refused++
      }
    }

    // Safety: every run that delivered, delivered a take that passed. Enforced
    // by the assertion inside the loop — a non-PASS take never reaches `opened`.
    // Product: the gate cannot be so strict that the studio stops working.
    expect(delivered + refused).toBe(PROMPTS.length * 3)
    expect(delivered / (delivered + refused)).toBeGreaterThan(0.9)
  })

  it('gives a free engine more attempts than one that costs an allowance', () => {
    // Offline takes cost local CPU time and nothing else, so spending ten is
    // cheap. A neural take spends a share of a free GPU allowance that resets on
    // someone else's schedule, so five is the limit there.
    expect(OFFLINE_MAX_ATTEMPTS).toBe(10)
    expect(DEFAULT_MAX_ATTEMPTS).toBe(5)
    expect(OFFLINE_MAX_ATTEMPTS).toBeGreaterThan(DEFAULT_MAX_ATTEMPTS)
  })
})
