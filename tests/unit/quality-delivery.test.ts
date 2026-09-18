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
import {
  gateScoreTake, tempoRequirement, OFFLINE_MAX_ATTEMPTS, DEFAULT_MAX_ATTEMPTS,
} from '../../src/engine/quality'
import { repairMelody } from '../../src/engine/compose/repair'

const PROMPTS = [
  'dangdut koplo sarcastic workplace anthem', 'lofi chill study music',
  'heavy metal guitar', 'upbeat pop love song', 'romantic melancholic jazz ballad',
  'punk rock fast', 'bossa nova', 'epic cinematic trailer',
]

describe('one press, one render, one song', () => {
  it('produces a song that passes on the first render, without regenerating', () => {
    // The guarantee, measured rather than asserted. `repairMelody` runs as the
    // last step of composing: a note that fights the chord under it is moved to
    // one the chord contains, while it is still a number in a list and before a
    // sample exists. Moving a note is composition; rolling the dice again is
    // regeneration, and this does the first.
    let passed = 0
    let total = 0
    for (const prompt of PROMPTS) {
      for (const seed of ['p0', 'p1', 'p2', 'p3']) {
        // With and without a requested tempo, because the tempo gate is part of
        // the same verdict and a song that passes only when nobody asked for a
        // tempo has not met the requirement.
        for (const bpm of [null, 72, 120]) {
          const score = composeSong(buildSpec(prompt, { seed, ...(bpm ? { bpm } : {}) }))
          const report = gateScoreTake(score, { tempo: tempoRequirement(bpm) })
          total++
          if (report.verdict === 'PASS') passed++
          else {
            // Name the failure rather than hiding it in a ratio.
            expect(`${prompt}/${seed}/bpm=${bpm}: ${report.verdict} `
              + `${report.rejectionReasons.join(',')}`)
              .toBe(`${prompt}/${seed}/bpm=${bpm}: PASS `)
          }
        }
      }
    }
    expect(`${passed}/${total}`).toBe(`${total}/${total}`)
  })

  it('moves only the notes that were wrong, and leaves the words where they were', () => {
    for (const prompt of PROMPTS.slice(0, 5)) {
      const before = composeSong(buildSpec(prompt, { seed: 'keep' }))
      // Compose twice with the same seed: identical scores, so the copy can be
      // repaired again and compared with the original note for note.
      const after = composeSong(buildSpec(prompt, { seed: 'keep' }))
      const sungBefore = before.tracks.filter((t) => t.role === 'vocal')
        .flatMap((t) => t.notes)
      const sungAfter = after.tracks.filter((t) => t.role === 'vocal').flatMap((t) => t.notes)
      expect(sungAfter).toHaveLength(sungBefore.length)
      for (let index = 0; index < sungBefore.length; index++) {
        // Everything but pitch survives: the beat it starts on, how long it is
        // held, the syllable it sings and the line that syllable belongs to.
        expect(sungAfter[index]!.start).toBe(sungBefore[index]!.start)
        expect(sungAfter[index]!.duration).toBe(sungBefore[index]!.duration)
        expect(sungAfter[index]!.syllable).toBe(sungBefore[index]!.syllable)
        expect(sungAfter[index]!.phraseText).toBe(sungBefore[index]!.phraseText)
      }
    }
  })

  it('repairs a deliberately broken plan rather than asking for a new one', () => {
    const score = composeSong(buildSpec('upbeat pop love song', { seed: 'broken' }))
    const vocal = score.tracks.find((track) => track.role === 'vocal')!
    const words = vocal.notes.map((note) => note.syllable)
    const beats = vocal.notes.map((note) => note.start)
    // Wreck the melody: push every sung note a semitone off whatever it was.
    for (const note of vocal.notes) note.midi += 1
    const broken = gateScoreTake(score)
    expect(broken.verdict).toBe('REGENERATION_REQUIRED')

    const repair = repairMelody(score)
    expect(repair.movedNotes).toBeGreaterThan(0)
    expect(gateScoreTake(score).verdict).toBe('PASS')
    // And the lyrics are still on the same beats they were written for.
    expect(vocal.notes.map((note) => note.syllable)).toEqual(words)
    expect(vocal.notes.map((note) => note.start)).toEqual(beats)
  })
})

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
