/**
 * The tempo gate, across every tempo the studio is calibrated for.
 *
 * The failure that prompted this: a song requested at 72 BPM came back at 89.8,
 * steady as a metronome, and was delivered. Nothing checked. The caption said
 * "72 BPM" and ACE-Step's endpoint has no tempo parameter to read it with, so
 * the words travelled to the model and the model did as it liked.
 */

import { describe, expect, it } from 'vitest'
import {
  tempoRequirement, checkTempo, InvalidTempoRequest,
  DEFAULT_BPM_TOLERANCE, BPM_RANGE, STABILITY_SPREAD_BPM,
  gateScoreTake, evaluate, STRICT_THRESHOLDS,
  type HarmonicRegion, type MusicalEvidence, type VocalNote,
} from '../../src/engine/quality'
import { buildSpec } from '../../src/engine/compose/prompt'
import { composeSong } from '../../src/engine/compose/composer'

/** The tempos the gate is held to, slow ballad through to drum and bass. */
const CALIBRATION = [60, 66, 72, 80, 90, 100, 110, 120, 128, 140, 160]

describe('a requested tempo is a requirement, not a hint', () => {
  it('is accepted across every calibration tempo', () => {
    for (const bpm of CALIBRATION) {
      const requirement = tempoRequirement(bpm)
      expect(requirement).toEqual({ targetBpm: bpm, toleranceBpm: DEFAULT_BPM_TOLERANCE })
    }
  })

  it('refuses a tempo nobody can play, rather than rounding it', () => {
    for (const bad of [0, -10, 20, 400, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => tempoRequirement(bad)).toThrow(InvalidTempoRequest)
    }
    expect(BPM_RANGE.min).toBe(40)
    expect(BPM_RANGE.max).toBe(220)
  })

  it('refuses a tolerance that could never be met', () => {
    expect(() => tempoRequirement(120, 0)).toThrow(InvalidTempoRequest)
    expect(() => tempoRequirement(120, -1)).toThrow(InvalidTempoRequest)
  })

  it('treats no tempo as no tempo, not as a tempo that passed', () => {
    expect(tempoRequirement(null)).toBeNull()
    expect(tempoRequirement(undefined)).toBeNull()
    const result = checkTempo({ bpm: 137 }, null)
    expect(result.passed).toBe(true)
    expect(result.reason).toBe('not-requested')
    expect(result.detail).toMatch(/not a tempo that passed/i)
  })
})

describe('the check, at every calibration tempo', () => {
  it('passes an exact match', () => {
    for (const bpm of CALIBRATION) {
      const result = checkTempo({ bpm }, tempoRequirement(bpm))
      expect(`${bpm}:${result.reason}:${result.passed}`).toBe(`${bpm}:ok:true`)
    }
  })

  it('passes inside the tolerance and fails outside it', () => {
    for (const bpm of CALIBRATION) {
      const requirement = tempoRequirement(bpm)
      expect(checkTempo({ bpm: bpm + 1.9 }, requirement).passed).toBe(true)
      expect(checkTempo({ bpm: bpm - 1.9 }, requirement).passed).toBe(true)
      const over = checkTempo({ bpm: bpm + 6 }, requirement)
      expect(`${bpm}:${over.passed}:${over.reason}`).toBe(`${bpm}:false:tempo-mismatch`)
    }
  })

  it('reports the difference so the number can be checked', () => {
    const result = checkTempo({ bpm: 89.1 }, tempoRequirement(72))
    expect(result.differenceBpm).toBeCloseTo(17.1, 1)
    expect(result.detail).toMatch(/17\.1 BPM out/)
  })
})

describe('octave errors are named, never silently accepted', () => {
  it('calls twice the requested tempo double-time', () => {
    for (const bpm of [60, 70, 80, 90]) {
      const result = checkTempo({ bpm: bpm * 2 }, tempoRequirement(bpm))
      expect(result.passed).toBe(false)
      expect(result.reason).toBe('double-time')
    }
  })

  it('calls half the requested tempo half-time', () => {
    for (const bpm of [120, 128, 140, 160]) {
      const result = checkTempo({ bpm: bpm / 2 }, tempoRequirement(bpm))
      expect(result.passed).toBe(false)
      expect(result.reason).toBe('half-time')
    }
  })

  it('explains that it is not resolving the ambiguity for you', () => {
    const result = checkTempo({ bpm: 144 }, tempoRequirement(72))
    expect(result.detail).toMatch(/looks identical from here/i)
  })
})

describe('a tempo that cannot be measured is not a tempo that failed', () => {
  it('reports detection failure rather than a mismatch', () => {
    const result = checkTempo({ bpm: null }, tempoRequirement(120))
    expect(result.passed).toBe(false)
    expect(result.reason).toBe('detection-failed')
  })

  it('refuses a track that does not hold one tempo', () => {
    const result = checkTempo({ bpm: 110, spreadBpm: 18 }, tempoRequirement(110))
    expect(result.passed).toBe(false)
    expect(result.reason).toBe('unstable-tempo')
    expect(STABILITY_SPREAD_BPM).toBe(5)
  })

  it('accepts a steady one at the same tempo', () => {
    expect(checkTempo({ bpm: 110, spreadBpm: 0.3 }, tempoRequirement(110)).passed).toBe(true)
  })
})

/** A melody whose notes are the chord tones of the region under them. */
function fittingEvidence(bpm: number): MusicalEvidence {
  const cycle = [
    { root: 0, pitchClasses: [0, 4, 7], name: 'C' },
    { root: 9, pitchClasses: [9, 0, 4], name: 'Am' },
    { root: 5, pitchClasses: [5, 9, 0], name: 'F' },
    { root: 7, pitchClasses: [7, 11, 2], name: 'G' },
  ]
  const regions: HarmonicRegion[] = Array.from({ length: 8 }, (_, bar) => ({
    startBeat: bar * 4, endBeat: bar * 4 + 4, ...cycle[bar % 4]!,
  }))
  const notes: VocalNote[] = []
  for (let bar = 0; bar < 8; bar++) {
    const chord = cycle[bar % 4]!.pitchClasses
    for (let beat = 0; beat < 4; beat++) {
      notes.push({
        startBeat: bar * 4 + beat, durationBeats: 1,
        midi: 60 + chord[beat % chord.length]!, velocity: 0.8,
      })
    }
  }
  return {
    source: 'score', confidence: 1, isolated: true, bpm, beatsPerBar: 4,
    key: { tonic: 0, scale: 'major', pitchClasses: [0, 2, 4, 5, 7, 9, 11], name: 'C major' },
    regions, notes, limitations: [],
  }
}

describe('the tempo gate inside the verdict', () => {
  it('passes a well-written song at every calibration tempo', () => {
    for (const bpm of CALIBRATION) {
      const report = evaluate(fittingEvidence(bpm), {
        thresholds: STRICT_THRESHOLDS, tempo: tempoRequirement(bpm), measuredBpm: bpm,
      })
      expect(`${bpm}:${report.verdict}`).toBe(`${bpm}:PASS`)
      expect(report.accepted).toBe(true)
      expect(report.deliveryAllowed).toBe(true)
    }
  })

  it('rejects the same song when the tempo is wrong', () => {
    for (const bpm of CALIBRATION) {
      const report = evaluate(fittingEvidence(bpm), {
        thresholds: STRICT_THRESHOLDS,
        tempo: tempoRequirement(bpm),
        measuredBpm: bpm + 17,
      })
      expect(`${bpm}:${report.verdict}`).toBe(`${bpm}:REGENERATION_REQUIRED`)
      expect(report.accepted).toBe(false)
      expect(report.deliveryAllowed).toBe(false)
      expect(report.rejectionReasons).toContain('TEMPO_MISMATCH')
    }
  })

  it('is the actual failure, reproduced', () => {
    // Requested 72, produced 89.1. This is the regression test for the bug.
    const report = evaluate(fittingEvidence(72), {
      thresholds: STRICT_THRESHOLDS, tempo: tempoRequirement(72), measuredBpm: 89.1,
    })
    expect(report.verdict).toBe('REGENERATION_REQUIRED')
    expect(report.accepted).toBe(false)
    expect(report.deliveryAllowed).toBe(false)
    expect(report.rejectionReasons).toContain('TEMPO_MISMATCH')
    expect(report.tempo!.requestedBpm).toBe(72)
    expect(report.tempo!.detectedBpm).toBe(89.1)
    expect(report.tempo!.differenceBpm).toBeCloseTo(17.1, 1)
  })

  it('separates an unmeasurable tempo from a wrong one', () => {
    const report = evaluate(fittingEvidence(120), {
      thresholds: STRICT_THRESHOLDS, tempo: tempoRequirement(120), measuredBpm: null,
    })
    expect(report.rejectionReasons).toContain('TEMPO_UNMEASURABLE')
    expect(report.rejectionReasons).not.toContain('TEMPO_MISMATCH')
    expect(report.deliveryAllowed).toBe(false)
  })

  it('never lets a tempo failure reach PASS, whatever else is perfect', () => {
    const report = evaluate(fittingEvidence(100), {
      thresholds: STRICT_THRESHOLDS, tempo: tempoRequirement(100), measuredBpm: 140,
    })
    // The melody is every chord tone in order; nothing about the notes is wrong.
    expect(report.measurements!.harmonicCompatibility).toBeGreaterThan(0.95)
    expect(report.verdict).not.toBe('PASS')
    expect(report.accepted).toBe(false)
  })
})

describe('the offline engine honours a requested tempo, so the gate is exact', () => {
  it('composes at the tempo asked for and passes its own tempo check', () => {
    for (const bpm of [60, 72, 90, 120, 140]) {
      const score = composeSong(buildSpec('a warm pop song', { seed: `t${bpm}`, bpm }))
      expect(`${bpm}:${score.bpm}`).toBe(`${bpm}:${bpm}`)
      const report = gateScoreTake(score, { tempo: tempoRequirement(bpm) })
      // The verdict may still fail on the notes; the tempo must not be why.
      expect(report.rejectionReasons).not.toContain('TEMPO_MISMATCH')
    }
  })

  it('reports a tempo mismatch when the score disagrees with the request', () => {
    const score = composeSong(buildSpec('a warm pop song', { seed: 'x', bpm: 96 }))
    const report = gateScoreTake(score, { tempo: tempoRequirement(72) })
    expect(report.rejectionReasons).toContain('TEMPO_MISMATCH')
    expect(report.deliveryAllowed).toBe(false)
  })
})
