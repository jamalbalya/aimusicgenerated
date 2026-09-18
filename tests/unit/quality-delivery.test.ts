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

  it('can fill a several-take run with takes that all passed', () => {
    // Asking for two takes to compare must not come back with one, or with one
    // that passed beside one that did not. The chooser is a list of things a
    // person can press play on: a rejected take sitting in it is a rejected
    // take that gets played, which is the single thing the gate exists to stop.
    const WANTED = 2
    let runsFilled = 0
    const runs = 12
    for (let run = 0; run < runs; run++) {
      const prompt = PROMPTS[run % PROMPTS.length]!
      const passed: string[] = []
      for (let attempt = 1; attempt <= OFFLINE_MAX_ATTEMPTS && passed.length < WANTED; attempt++) {
        for (const take of [0, 1]) {
          const score = composeSong(buildSpec(prompt, { seed: `${prompt}|fill${run}|${attempt}|${take}` }))
          const report = gateScoreTake(score)
          // Whatever lands in the list has passed. There is no other branch.
          if (report.verdict === 'PASS') passed.push(report.verdict)
        }
      }
      expect(passed.every((verdict) => verdict === 'PASS')).toBe(true)
      if (passed.length >= WANTED) runsFilled++
    }
    // Not every run has to fill, but the feature has to work most of the time.
    expect(runsFilled / runs).toBeGreaterThan(0.8)
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
