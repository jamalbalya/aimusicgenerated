/**
 * The gate, on melodies whose answer is known before it runs.
 *
 * Every fixture here is built from an explicit progression and an explicit
 * melody, so a failure is a failure of the rule engine rather than of a
 * recording. The cases that matter most are the two that look alike from the
 * outside: a melody entirely inside the key that fits the chords, and a melody
 * entirely inside the key that does not. Any measure that cannot tell those two
 * apart is the measure this gate was built to replace.
 */

import { describe, expect, it } from 'vitest'
import {
  evaluate, judgeNotes, classifyInterval, STRICT_THRESHOLDS, withThresholds,
  type HarmonicRegion, type MusicalEvidence, type VocalNote,
} from '../../src/engine/quality'

const C = 0, D = 2, E = 4, F = 5, G = 7, A = 9, B = 11

/** C major, one chord per bar of four beats: C - Am - F - G, repeated. */
function progression(bars: number): HarmonicRegion[] {
  const cycle = [
    { root: C, pitchClasses: [C, E, G], name: 'C' },
    { root: A, pitchClasses: [A, C, E], name: 'Am' },
    { root: F, pitchClasses: [F, A, C], name: 'F' },
    { root: G, pitchClasses: [G, B, D], name: 'G' },
  ]
  return Array.from({ length: bars }, (_, bar) => ({
    startBeat: bar * 4,
    endBeat: bar * 4 + 4,
    ...cycle[bar % cycle.length]!,
  }))
}

/** One note per beat at the given pitch classes, in octave 4. */
function melody(pitchClasses: number[], durationBeats = 1, velocity = 0.8): VocalNote[] {
  return pitchClasses.map((pc, index) => ({
    startBeat: index * durationBeats,
    durationBeats,
    midi: 60 + pc,
    velocity,
  }))
}

function evidence(notes: VocalNote[], overrides: Partial<MusicalEvidence> = {}): MusicalEvidence {
  const bars = Math.max(4, Math.ceil((notes.at(-1)!.startBeat + notes.at(-1)!.durationBeats) / 4))
  return {
    source: 'score',
    confidence: 1,
    isolated: true,
    bpm: 100,
    beatsPerBar: 4,
    key: { tonic: C, scale: 'major', pitchClasses: [C, D, E, F, G, A, B], name: 'C major' },
    regions: progression(bars),
    notes,
    limitations: [],
    ...overrides,
  }
}

/** Chord tones of C - Am - F - G, four beats each: the melody the progression wants. */
const FITTING = [
  C, E, G, E, /* C  */ A, C, E, C, /* Am */ F, A, C, A, /* F  */ G, B, D, B, /* G  */
  C, E, G, E, A, C, E, C, F, A, C, A, G, B, D, B,
]

describe('a melody that follows the chords', () => {
  it('passes', () => {
    const report = evaluate(evidence(melody(FITTING)))
    expect(report.verdict).toBe('PASS')
    expect(report.failedChecks).toEqual([])
    expect(report.measurements!.harmonicCompatibility).toBeGreaterThan(0.95)
    expect(report.measurements!.severeConflicts).toBe(0)
  })
})

describe('a melody in the right key over the wrong chords', () => {
  /**
   * Every note is in C major. Every note is a chord tone — of the chord in the
   * *previous* bar. This is the exact failure the analyser found on a real
   * song: in tune, in key, and written against a different progression.
   */
  const SHIFTED = [...FITTING.slice(4), ...FITTING.slice(0, 4)]

  it('is rejected even though every note is in key', () => {
    const report = evaluate(evidence(melody(SHIFTED)))
    expect(report.verdict).toBe('REGENERATION_REQUIRED')
    // The point: in-key-ness is no defence.
    expect(report.measurements!.strongOutOfKeyPercent).toBe(0)
    expect(report.measurements!.strongChordConflictPercent)
      .toBeGreaterThan(STRICT_THRESHOLDS.maxStrongChordConflictPercent)
  })

  it('says pitch correction is the wrong tool', () => {
    const report = evaluate(evidence(melody(SHIFTED)))
    expect(report.reasons.join(' ')).toMatch(/pitch correction cannot fix this/i)
  })

  it('names where to listen', () => {
    const report = evaluate(evidence(melody(SHIFTED)))
    expect(report.worstMoments.length).toBeGreaterThan(0)
    expect(report.worstMoments[0]!.atSeconds).toBeGreaterThanOrEqual(0)
    expect(report.worstMoments[0]!.chord).toBeTruthy()
  })
})

describe('a single strong chord-conflict note', () => {
  it('is rejected when it is held', () => {
    // Four beats of F# over a C chord: not in the key, not in the chord, held,
    // and nothing follows it until the chord has already changed.
    const notes = [
      { startBeat: 0, durationBeats: 4, midi: 60 + 6, velocity: 0.9 },
      ...melody(FITTING).slice(4),
    ]
    const report = evaluate(evidence(notes))
    expect(report.verdict).toBe('REGENERATION_REQUIRED')
    expect(report.failedChecks).toContain('severeConflicts')
  })
})

describe('a long unresolved dissonance', () => {
  it('is rejected', () => {
    // A C# held for three beats over a C major chord — a flat ninth beating
    // against a sounding root — and then leapt away from rather than resolved.
    // At 100 BPM that is 1.8 seconds, well past the 0.7 the ear allows.
    // A B natural here would *not* qualify: a major seventh over a major triad
    // is a Cmaj7, which is a chord, not a mistake. Neither would an F: see the
    // interval table below.
    const notes: VocalNote[] = [
      { startBeat: 0, durationBeats: 3, midi: 61, velocity: 0.9 },
      { startBeat: 3, durationBeats: 1, midi: 72, velocity: 0.8 },
      ...melody(FITTING).slice(4),
    ]
    const report = evaluate(evidence(notes))
    expect(report.verdict).toBe('REGENERATION_REQUIRED')
    expect(report.failedChecks.some((c) => c === 'severeConflicts' || c === 'unresolvedDissonance'))
      .toBe(true)
  })
})

describe('melodic figures that are not faults', () => {
  it('does not reject a passing tone between two chord tones', () => {
    // C - D - E over C major: D is not in the chord and is obviously passing.
    const notes: VocalNote[] = []
    for (let bar = 0; bar < 8; bar++) {
      const base = bar * 4
      const chord = [[C, E, G], [A, C, E], [F, A, C], [G, B, D]][bar % 4]!
      notes.push(
        { startBeat: base, durationBeats: 1, midi: 60 + chord[0]!, velocity: 0.8 },
        { startBeat: base + 1, durationBeats: 0.25, midi: 60 + chord[0]! + 1, velocity: 0.4 },
        { startBeat: base + 1.25, durationBeats: 0.75, midi: 60 + chord[0]! + 2, velocity: 0.6 },
        { startBeat: base + 2, durationBeats: 2, midi: 60 + chord[1]!, velocity: 0.8 },
      )
    }
    const judged = judgeNotes(evidence(notes))
    const shortOnes = judged.filter((j) => j.durationBeats === 0.25)
    expect(shortOnes.length).toBeGreaterThan(0)
    expect(shortOnes.every((j) => j.relation === 'passing')).toBe(true)
    expect(evaluate(evidence(notes)).verdict).not.toBe('REGENERATION_REQUIRED')
  })

  it('does not reject a neighbour tone that returns where it came from', () => {
    const notes: VocalNote[] = []
    for (let bar = 0; bar < 8; bar++) {
      const base = bar * 4
      const chord = [[C, E, G], [A, C, E], [F, A, C], [G, B, D]][bar % 4]!
      notes.push(
        { startBeat: base, durationBeats: 1, midi: 60 + chord[0]!, velocity: 0.8 },
        { startBeat: base + 1, durationBeats: 0.25, midi: 60 + chord[0]! + 1, velocity: 0.4 },
        { startBeat: base + 1.25, durationBeats: 0.75, midi: 60 + chord[0]!, velocity: 0.6 },
        { startBeat: base + 2, durationBeats: 2, midi: 60 + chord[2]!, velocity: 0.8 },
      )
    }
    const judged = judgeNotes(evidence(notes))
    const shortOnes = judged.filter((j) => j.durationBeats === 0.25)
    expect(shortOnes.every((j) => j.relation === 'neighbour')).toBe(true)
    expect(evaluate(evidence(notes)).verdict).not.toBe('REGENERATION_REQUIRED')
  })

  it('does not reject a suspension that resolves by step', () => {
    // A semitone above the root, held, then stepping down onto it: an
    // appoggiatura. A real dissonance — a flat ninth against a sounding root —
    // which is a figure rather than a fault only because it goes somewhere.
    const notes: VocalNote[] = []
    for (let bar = 0; bar < 8; bar++) {
      const base = bar * 4
      const chord = [[C, E, G], [A, C, E], [F, A, C], [G, B, D]][bar % 4]!
      notes.push(
        { startBeat: base, durationBeats: 0.9, midi: 60 + chord[0]! + 1, velocity: 0.8 },
        { startBeat: base + 1, durationBeats: 1, midi: 60 + chord[0]!, velocity: 0.8 },
        { startBeat: base + 2, durationBeats: 2, midi: 60 + chord[0]!, velocity: 0.8 },
      )
    }
    const judged = judgeNotes(evidence(notes))
    expect(judged.some((j) => j.relation === 'resolved')).toBe(true)
  })
})

describe('the interval table', () => {
  it('calls a major third over a minor chord a conflict, not a colour', () => {
    expect(classifyInterval(4, [A, C, E], A)).toBe('conflict')
  })
  it('calls a minor third over a major chord a conflict', () => {
    expect(classifyInterval(3, [C, E, G], C)).toBe('conflict')
  })
  it('calls a flat ninth a conflict', () => {
    expect(classifyInterval(1, [C, E, G], C)).toBe('conflict')
  })
  it('calls the natural eleventh a colour in both modes', () => {
    // Both colours. The fourth over a major chord is jazz's avoid note, but
    // over any non-tonic chord it is frequently the key's own tonic held as a
    // pedal, and a gate that fails a song for singing the tonic is wrong.
    // Duration and resolution decide whether a given one is a suspension.
    expect(classifyInterval(5, [C, E, G], C)).toBe('tension')
    expect(classifyInterval(5, [A, C, E], A)).toBe('tension')
  })
  it('calls the ninth and the sixth colours', () => {
    expect(classifyInterval(2, [C, E, G], C)).toBe('tension')
    expect(classifyInterval(9, [C, E, G], C)).toBe('tension')
  })
})

describe('evidence that cannot support a verdict', () => {
  it('returns ANALYSIS_UNAVAILABLE for an unseparated mix, never PASS', () => {
    const report = evaluate(evidence(melody(FITTING), { source: 'audio', isolated: false }))
    expect(report.verdict).toBe('ANALYSIS_UNAVAILABLE')
    expect(report.reasons[0]).toMatch(/not separated/i)
  })

  it('returns ANALYSIS_UNAVAILABLE for a perfect-looking unseparated mix too', () => {
    // The trap: the numbers are flawless. It still must not pass.
    const report = evaluate(evidence(melody(FITTING), {
      source: 'audio', isolated: false, confidence: 0.99,
    }))
    expect(report.verdict).toBe('ANALYSIS_UNAVAILABLE')
  })

  it('returns ANALYSIS_UNAVAILABLE when no chords are known', () => {
    expect(evaluate(evidence(melody(FITTING), { regions: [] })).verdict).toBe('ANALYSIS_UNAVAILABLE')
  })

  it('returns ANALYSIS_UNAVAILABLE when there is barely any singing', () => {
    expect(evaluate(evidence(melody(FITTING.slice(0, 6)))).verdict).toBe('ANALYSIS_UNAVAILABLE')
  })
})

describe('confidence gates PASS', () => {
  it('holds a clean take at REVIEW_REQUIRED when the evidence is weak', () => {
    const report = evaluate(evidence(melody(FITTING), {
      source: 'audio', isolated: true, confidence: 0.5,
    }))
    expect(report.verdict).toBe('REVIEW_REQUIRED')
    expect(report.failedChecks).toEqual([])
  })

  it('passes the same take when the evidence is strong', () => {
    const report = evaluate(evidence(melody(FITTING), {
      source: 'audio', isolated: true, confidence: 0.9,
    }))
    expect(report.verdict).toBe('PASS')
  })
})

describe('deliberate chromaticism', () => {
  it('is reported as REVIEW_REQUIRED rather than passed or rejected', () => {
    // An Eb on beat 3 of every bar: a blue note, or a mistake made twice. The
    // gate says it cannot tell, which is the documented rule.
    const notes = melody(FITTING)
    for (const note of notes) {
      if (note.startBeat % 4 === 2) note.midi = 60 + 3
    }
    const report = evaluate(evidence(notes, {
      thresholds: undefined,
    } as Partial<MusicalEvidence>), {
      thresholds: withThresholds({
        maxStrongChordConflictPercent: 100,
        maxStrongOutOfKeyPercent: 100,
        minHarmonicCompatibility: 0,
        maxUnresolvedDissonanceBeats: 4,
      }),
    })
    expect(report.measurements!.intentionalChromaticNotes).toBeGreaterThan(0)
    expect(report.verdict).toBe('REVIEW_REQUIRED')
  })
})

describe('vocal range', () => {
  it('rejects notes the requested voice cannot reach', () => {
    const notes = melody(FITTING)
    notes[0] = { ...notes[0]!, midi: 96 }
    const report = evaluate(evidence(notes, { vocalRange: { lowMidi: 48, highMidi: 72 } }))
    expect(report.verdict).toBe('REGENERATION_REQUIRED')
    expect(report.failedChecks).toContain('vocalRange')
  })
})

describe('pitch accuracy, when it was measured', () => {
  it('rejects a take with too many seriously out-of-tune notes', () => {
    const notes = melody(FITTING)
    const report = evaluate(evidence(notes, {
      source: 'audio', isolated: true, confidence: 0.9,
      centsDeviations: notes.map((_, index) => (index % 2 === 0 ? 60 : 3)),
    }))
    expect(report.verdict).toBe('REGENERATION_REQUIRED')
    expect(report.failedChecks).toContain('pitchAccuracy')
  })

  it('does not invent a tuning check for a symbolic score', () => {
    const report = evaluate(evidence(melody(FITTING)))
    expect(report.failedChecks).not.toContain('pitchAccuracy')
    expect(report.measurements!.seriousPitchDeviationPercent).toBe(0)
  })
})

describe('the neural path, from the browser', () => {
  it('is always ANALYSIS_UNAVAILABLE, never a pass', async () => {
    const { gateNeuralTake } = await import('../../src/engine/quality')
    // Called a hundred times with nothing to vary: the answer is a property of
    // the environment, not of the take, and it can never come out as PASS.
    for (let i = 0; i < 100; i++) {
      expect(gateNeuralTake().verdict).toBe('ANALYSIS_UNAVAILABLE')
    }
  })

  it('says why, and where a real verdict comes from', async () => {
    const { gateNeuralTake } = await import('../../src/engine/quality')
    const report = gateNeuralTake()
    expect(report.reasons[0]).toMatch(/no vocal separator runs in a browser/i)
    expect(report.reasons[0]).toMatch(/poc\/audio-quality\/analyze\.py/)
  })

  it('does not claim the mix was measured and discounted', async () => {
    // It was tried, and it measured backwards: +6.46 from the mix against −2.49
    // from the separated stems on the same song. A gate that can return a
    // confident PASS on a song that should be rejected launders the failure.
    const { gateNeuralTake } = await import('../../src/engine/quality')
    expect(gateNeuralTake().measurements).toBeNull()
  })
})

describe('the two rules that are never traded away', () => {
  it('no evidence, however good its numbers, passes without isolation', () => {
    for (const confidence of [0.7, 0.8, 0.9, 0.99, 1]) {
      const report = evaluate(evidence(melody(FITTING), {
        source: 'audio', isolated: false, confidence,
      }))
      expect(report.verdict).toBe('ANALYSIS_UNAVAILABLE')
    }
  })

  it('a rejected take is never reported as anything but rejected', () => {
    const shifted = [...FITTING.slice(4), ...FITTING.slice(0, 4)]
    for (const confidence of [0.7, 0.9, 1]) {
      const report = evaluate(evidence(melody(shifted), { confidence }))
      expect(report.verdict).toBe('REGENERATION_REQUIRED')
    }
  })
})
