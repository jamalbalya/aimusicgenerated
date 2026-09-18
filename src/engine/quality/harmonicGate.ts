/**
 * The rule engine: one sung note against the chord underneath it, and then the
 * whole song against the thresholds.
 *
 * The thing this is built to catch is the failure the analyser found and could
 * not act on — a vocal that is perfectly in tune and singing the wrong notes.
 * That failure is invisible to every measure of tuning, and it is invisible to
 * "what percentage of the melody is in the key", because a melody can be
 * entirely inside the key and still fit none of the chords. G major contains
 * both C and B; over an Am chord one of them is the third and the other is a
 * semitone of grit held under the singer's own line, and no count of pitch
 * classes can tell them apart.
 *
 * So the unit here is the pair (note, chord sounding at that moment), and a
 * non-chord tone is not automatically a fault. Most of this file is the work of
 * *excusing* notes: a passing tone between two chord tones, a neighbour that
 * leaves and comes back, a suspension that resolves within the bar. Those are
 * how melodies are written. What is left after all the excuses — a note against
 * the chord, on a beat, held, going nowhere — is the thing worth refusing to
 * deliver.
 */

import type { PitchClass } from '../theory/pitch'
import type {
  HarmonicRegion, MusicalEvidence, NoteJudgement, NoteRelation,
  QualityMeasurements, QualityReport, VocalNote,
} from './types'
import { STRICT_THRESHOLDS, type QualityThresholds } from './thresholds'

/** How much each relation counts towards the compatibility score, 0..1. */
const RELATION_WEIGHT: Record<NoteRelation, number> = {
  'chord-tone': 1,
  tension: 0.9,
  passing: 0.8,
  neighbour: 0.8,
  resolved: 0.8,
  chromatic: 0.2,
  conflict: 0,
}

const pitchClassOf = (midi: number): PitchClass => (((Math.round(midi) % 12) + 12) % 12) as PitchClass

/** The chord sounding at a moment, or null. Judged at the note's own start. */
export function regionAt(regions: HarmonicRegion[], beat: number): HarmonicRegion | null {
  for (const region of regions) {
    if (beat >= region.startBeat && beat < region.endBeat) return region
  }
  return null
}

/**
 * How an interval above the chord root sits against that chord.
 *
 * Read off the chord's actual pitch classes rather than a quality name, because
 * the same name covers different chords once extensions are in play and the
 * notes are what the listener hears. The distinctions that matter:
 *
 *  - A third of the opposite quality is the loudest wrong note in music. A
 *    major third sung over a minor chord is not a colour, it is the chord
 *    changed under the singer.
 *  - A flat ninth against a root that is sounding is a semitone beating
 *    against the bass. Always a conflict outside a deliberately altered chord.
 *  - The natural eleventh is fine on a minor chord and a clash on a major one,
 *    for the same reason: on major it is a semitone from the third.
 */
export function classifyInterval(interval: number, chordPitchClasses: readonly number[], root: PitchClass):
  'chord-tone' | 'tension' | 'conflict' {
  const has = (semitones: number) => chordPitchClasses.includes(((root + semitones) % 12) as PitchClass)
  if (has(interval)) return 'chord-tone'

  const majorThird = has(4)
  const minorThird = has(3)
  const flatSeventh = has(10)

  switch (interval) {
    case 1: return 'conflict'                       // b9 against a sounding root
    case 2: return 'tension'                        // 9th: colour on anything
    case 3: return majorThird ? 'conflict' : 'tension'
    case 4: return minorThird ? 'conflict' : 'tension'
    // The perfect fourth is the one interval theory itself is split on. Jazz
    // calls it the avoid note over a major chord, because it sits a semitone
    // above the third. Modal and rock writing use it constantly, and for a
    // reason that is not a matter of taste: over any chord that is not the
    // tonic, the fourth above the root is frequently the key's own tonic held
    // as a pedal. A gate that fails a song for singing the tonic is wrong. So
    // it is a colour, and the duration and resolution rules below are what
    // decide whether a particular one is a suspension or a mistake.
    case 5: return 'tension'
    case 6: return 'conflict'                       // #11/b5 on a chord that does not have it
    case 7: return 'tension'                        // 5th of a chord voiced without one
    case 8: return majorThird ? 'conflict' : 'tension'  // b13 over major is the same semitone clash
    case 9: return 'tension'                        // 6th/13th
    case 10: return 'tension'                       // b7
    case 11: return flatSeventh ? 'conflict' : 'tension'  // maj7 over a dominant is both sevenths at once
    default: return 'conflict'
  }
}

/** Is this note one the ear lands on, rather than one it passes through? */
function isStrong(note: VocalNote, beatsPerBar: number, thresholds: QualityThresholds): boolean {
  if (note.durationBeats >= thresholds.strongNoteBeats) return true
  if (note.velocity >= thresholds.accentVelocity) return true
  const inBar = ((note.startBeat % beatsPerBar) + beatsPerBar) % beatsPerBar
  const onDownbeat = Math.abs(inBar) < 1e-6
  const onHalf = Math.abs(inBar - beatsPerBar / 2) < 1e-6
  return onDownbeat || onHalf
}

/**
 * Does this note step to a chord tone soon enough to be heard as leading there?
 *
 * By step, because that is what resolution means — a dissonance that leaps away
 * has not resolved, it has simply stopped. Measured against the chord active
 * where the *next* note lands, since a suspension over a chord change resolves
 * into the new chord, which is the whole figure.
 */
function resolves(
  note: VocalNote, next: VocalNote | undefined, regions: HarmonicRegion[],
  thresholds: QualityThresholds,
): boolean {
  if (!next) return false
  const gap = next.startBeat - (note.startBeat + note.durationBeats)
  // The next note has to *follow* this one. A negative gap means they overlap,
  // and a dissonance that is still sounding underneath the note said to resolve
  // it has not resolved at all — it has been joined. Without this guard a note
  // held across the whole bar is excused by whatever happens to start during it.
  if (gap < -1e-6 || gap > thresholds.resolutionBeats) return false
  const step = Math.abs(Math.round(next.midi) - Math.round(note.midi))
  if (step === 0 || step > 2) return false
  const target = regionAt(regions, next.startBeat)
  if (!target) return false
  return target.pitchClasses.includes(pitchClassOf(next.midi))
}

/** Between two chord tones, moving in one direction, by step: a passing tone. */
function isPassing(previous: VocalNote | undefined, note: VocalNote, next: VocalNote | undefined): boolean {
  if (!previous || !next) return false
  const a = Math.round(previous.midi)
  const b = Math.round(note.midi)
  const c = Math.round(next.midi)
  const up = b - a
  const down = c - b
  if (up === 0 || down === 0) return false
  if (Math.sign(up) !== Math.sign(down)) return false
  return Math.abs(up) <= 2 && Math.abs(down) <= 2
}

/** Leaves a note by step and comes straight back to it: a neighbour tone. */
function isNeighbour(previous: VocalNote | undefined, note: VocalNote, next: VocalNote | undefined): boolean {
  if (!previous || !next) return false
  const a = Math.round(previous.midi)
  const b = Math.round(note.midi)
  const c = Math.round(next.midi)
  return a === c && Math.abs(b - a) <= 2 && b !== a
}

export interface GateOptions {
  thresholds?: QualityThresholds
  /** How many worst moments to list. */
  worstMoments?: number
}

/** Judges every note, in order, so each can see its neighbours. */
export function judgeNotes(
  evidence: MusicalEvidence, thresholds: QualityThresholds = STRICT_THRESHOLDS,
): NoteJudgement[] {
  const notes = [...evidence.notes].sort((a, b) => a.startBeat - b.startBeat)
  const secondsPerBeat = evidence.bpm > 0 ? 60 / evidence.bpm : 0
  const keySet = new Set(evidence.key.pitchClasses)

  return notes.map((note, index) => {
    const previous = notes[index - 1]
    const next = notes[index + 1]
    const pitchClass = pitchClassOf(note.midi)
    const region = regionAt(evidence.regions, note.startBeat)
    const inKey = keySet.has(pitchClass)
    const strong = isStrong(note, evidence.beatsPerBar, thresholds)
    const base = {
      index,
      startBeat: note.startBeat,
      atSeconds: note.startBeat * secondsPerBeat,
      durationBeats: note.durationBeats,
      midi: note.midi,
      pitchClass,
      strong,
      inKey,
    }

    if (!region) {
      // Nothing is playing underneath. Not a conflict — there is nothing to
      // conflict with — but not evidence of fit either.
      return {
        ...base, chord: null, intervalFromRoot: null,
        relation: inKey ? ('tension' as const) : ('chromatic' as const),
        severe: false,
        reason: 'no chord was sounding under this note',
      }
    }

    const interval = ((pitchClass - region.root + 12) % 12)
    const against = classifyInterval(interval, region.pitchClasses, region.root)
    let relation: NoteRelation
    let reason: string

    if (against === 'chord-tone') {
      relation = 'chord-tone'
      reason = `in ${region.name}`
    } else if (against === 'tension') {
      relation = 'tension'
      reason = `a ${interval}-semitone colour over ${region.name}`
    } else if (isPassing(previous, note, next)) {
      relation = 'passing'
      reason = `passing by step through ${region.name}`
    } else if (isNeighbour(previous, note, next)) {
      relation = 'neighbour'
      reason = `a neighbour note over ${region.name}, returning to where it came from`
    } else if (resolves(note, next, evidence.regions, thresholds)) {
      relation = 'resolved'
      reason = `dissonant over ${region.name}, resolving by step into the next chord`
    } else if (!inKey) {
      relation = 'chromatic'
      reason = `outside ${evidence.key.name} and against ${region.name}, with nothing explaining it`
    } else {
      relation = 'conflict'
      reason = `clashes with ${region.name} and does not resolve`
    }

    const unexplained = relation === 'conflict' || relation === 'chromatic'
    // Both limits, because each catches what the other misses: seconds is what
    // the ear actually measures, beats is what keeps a very slow song from
    // excusing a clash that lasts a whole bar.
    const severe = unexplained && strong
      && note.durationBeats > thresholds.maxUnresolvedDissonanceBeats
      && note.durationBeats * secondsPerBeat > thresholds.maxUnresolvedDissonanceSeconds

    return { ...base, chord: region.name, intervalFromRoot: interval, relation, severe, reason }
  })
}

/**
 * A chromatic pitch class that keeps turning up in the same place in the bar is
 * a decision, not a slip. Counted, never used to excuse a severe conflict.
 */
function intentionalChromatics(
  judgements: NoteJudgement[], beatsPerBar: number, thresholds: QualityThresholds,
): number {
  const buckets = new Map<string, NoteJudgement[]>()
  for (const judgement of judgements) {
    // Chromatic means outside the key. An in-key note that clashes with one
    // chord is a different thing and is never excused as deliberate colour, so
    // it does not belong in this count however often it recurs.
    if (judgement.relation !== 'chromatic') continue
    const inBar = Math.round((((judgement.startBeat % beatsPerBar) + beatsPerBar) % beatsPerBar) * 4) / 4
    const key = `${judgement.pitchClass}@${inBar}`
    const bucket = buckets.get(key)
    if (bucket) bucket.push(judgement)
    else buckets.set(key, [judgement])
  }
  let total = 0
  for (const bucket of buckets.values()) {
    if (bucket.length >= thresholds.intentionalChromaticRepeats) total += bucket.length
  }
  return total
}

/** The longest run of consecutive unexplained notes, measured in beats. */
function longestUnresolved(judgements: NoteJudgement[]): number {
  let longest = 0
  let run = 0
  let runEndsAt = -Infinity
  for (const judgement of judgements) {
    const unexplained = judgement.relation === 'conflict' || judgement.relation === 'chromatic'
    if (!unexplained) { run = 0; runEndsAt = -Infinity; continue }
    // Only a note that starts where the previous one ended continues the run;
    // two clashes either side of a clean phrase are two problems, not one long one.
    run = Math.abs(judgement.startBeat - runEndsAt) < 1e-6 ? run + judgement.durationBeats : judgement.durationBeats
    runEndsAt = judgement.startBeat + judgement.durationBeats
    if (run > longest) longest = run
  }
  return longest
}

export function measure(
  evidence: MusicalEvidence, judgements: NoteJudgement[],
  thresholds: QualityThresholds = STRICT_THRESHOLDS,
): QualityMeasurements {
  const sungBeats = judgements.reduce((total, j) => total + j.durationBeats, 0)
  const strong = judgements.filter((j) => j.strong)
  const percent = (count: number, of: number) => (of > 0 ? (100 * count) / of : 0)

  const weighted = judgements.reduce(
    (total, j) => total + RELATION_WEIGHT[j.relation] * j.durationBeats, 0)

  const range = evidence.vocalRange
  const rangeViolations = range
    ? judgements.filter((j) => j.midi < range.lowMidi || j.midi > range.highMidi).length
    : 0

  const cents = evidence.centsDeviations ?? []
  const seriousPitchDeviationPercent = cents.length > 0
    ? percent(cents.filter((c) => Math.abs(c) > thresholds.seriousPitchDeviationCents).length, cents.length)
    : 0

  const grid = 0.25 // a sixteenth
  const offGrid = judgements.filter((j) => {
    const offset = Math.abs(j.startBeat / grid - Math.round(j.startBeat / grid)) * grid
    return offset > thresholds.timingToleranceBeats
  }).length

  return {
    notes: judgements.length,
    sungBeats,
    strongOutOfKeyPercent: percent(strong.filter((j) => !j.inKey).length, strong.length),
    strongChordConflictPercent: percent(
      strong.filter((j) => j.relation === 'conflict' || j.relation === 'chromatic').length, strong.length),
    longestUnresolvedDissonanceBeats: longestUnresolved(judgements),
    severeConflicts: judgements.filter((j) => j.severe).length,
    harmonicCompatibility: sungBeats > 0 ? weighted / sungBeats : 0,
    rangeViolations,
    seriousPitchDeviationPercent,
    timingProblemPercent: percent(offGrid, judgements.length),
    intentionalChromaticNotes: intentionalChromatics(judgements, evidence.beatsPerBar, thresholds),
  }
}

/** Not enough sung material to say anything about a song. */
const MIN_NOTES_FOR_A_VERDICT = 12

/**
 * The gate.
 *
 * Order matters. Everything that makes a verdict impossible is checked before
 * anything that makes one bad, so a song is never refused on a number that was
 * never trustworthy — and, far more importantly, never passed on one either.
 */
export function evaluate(evidence: MusicalEvidence, options: GateOptions = {}): QualityReport {
  const thresholds = options.thresholds ?? STRICT_THRESHOLDS
  const limit = options.worstMoments ?? 12
  const evidenceSummary = {
    source: evidence.source, confidence: evidence.confidence, isolated: evidence.isolated,
  }

  const unavailable = (reason: string): QualityReport => ({
    verdict: 'ANALYSIS_UNAVAILABLE',
    reasons: [reason],
    failedChecks: [],
    measurements: null,
    worstMoments: [],
    evidence: evidenceSummary,
    limitations: evidence.limitations,
  })

  // A measurement that cannot be attributed to the voice cannot clear the
  // voice. This is the one rule that is never traded against a good number.
  if (evidence.source === 'audio' && !evidence.isolated) {
    return unavailable(
      'The vocal was not separated from the instrumental, so nothing measured here is a '
      + 'measurement of the singing. On a real song the full mix reported strong agreement '
      + 'where the separated stems reported worse than chance, so this is not a weaker '
      + 'answer — it is the wrong one.')
  }
  if (evidence.regions.length === 0) {
    return unavailable('No chord progression was available, so there is nothing to judge the melody against.')
  }
  if (evidence.notes.length < MIN_NOTES_FOR_A_VERDICT) {
    return unavailable(
      `Only ${evidence.notes.length} sung notes were found; at least ${MIN_NOTES_FOR_A_VERDICT} `
      + 'are needed before a verdict means anything.')
  }

  const judgements = judgeNotes(evidence, thresholds)
  const measurements = measure(evidence, judgements, thresholds)
  const reasons: string[] = []
  const failedChecks: string[] = []

  const fail = (check: string, reason: string) => { failedChecks.push(check); reasons.push(reason) }

  if (measurements.severeConflicts > thresholds.maxSevereConflicts) {
    fail('severeConflicts',
      `${measurements.severeConflicts} severe harmonic conflict(s): a note against the chord, `
      + `held past ${thresholds.maxUnresolvedDissonanceBeats} beat(s) and `
      + `${thresholds.maxUnresolvedDissonanceSeconds}s, with nothing explaining it. `
      + `At most ${thresholds.maxSevereConflicts} is tolerated.`)
  }
  if (measurements.harmonicCompatibility < thresholds.minHarmonicCompatibility) {
    fail('harmonicCompatibility',
      `Harmonic compatibility ${measurements.harmonicCompatibility.toFixed(3)}, below the required `
      + `${thresholds.minHarmonicCompatibility.toFixed(2)}. The melody does not follow this chord `
      + 'progression.')
  }
  if (measurements.strongChordConflictPercent > thresholds.maxStrongChordConflictPercent) {
    fail('strongChordConflict',
      `${measurements.strongChordConflictPercent.toFixed(1)}% of the notes a listener lands on `
      + `clash with the chord underneath them, above the ${thresholds.maxStrongChordConflictPercent}% allowed.`)
  }
  if (measurements.strongOutOfKeyPercent > thresholds.maxStrongOutOfKeyPercent) {
    fail('strongOutOfKey',
      `${measurements.strongOutOfKeyPercent.toFixed(1)}% of the notes a listener lands on are outside `
      + `${evidence.key.name}, above the ${thresholds.maxStrongOutOfKeyPercent}% allowed.`)
  }
  if (measurements.longestUnresolvedDissonanceBeats > thresholds.maxUnresolvedDissonanceBeats) {
    fail('unresolvedDissonance',
      `A dissonance runs ${measurements.longestUnresolvedDissonanceBeats.toFixed(2)} beats without `
      + `resolving, past the ${thresholds.maxUnresolvedDissonanceBeats} allowed.`)
  }
  if (measurements.rangeViolations > thresholds.maxRangeViolations) {
    fail('vocalRange',
      `${measurements.rangeViolations} note(s) fall outside the requested vocal range.`)
  }
  if (evidence.centsDeviations && evidence.centsDeviations.length > 0
      && measurements.seriousPitchDeviationPercent > thresholds.maxSeriousPitchDeviationPercent) {
    fail('pitchAccuracy',
      `${measurements.seriousPitchDeviationPercent.toFixed(1)}% of notes are more than `
      + `${thresholds.seriousPitchDeviationCents} cents out, above the `
      + `${thresholds.maxSeriousPitchDeviationPercent}% allowed.`)
  }
  if (measurements.timingProblemPercent > thresholds.maxTimingProblemPercent) {
    fail('timing',
      `${measurements.timingProblemPercent.toFixed(1)}% of notes sit further off the beat than the `
      + `${thresholds.timingToleranceBeats} beat tolerance.`)
  }

  // Said once, on any harmonic rejection, because it is the thing most likely
  // to be got wrong next: a melody that does not fit the chords is not an
  // intonation problem and retuning it repairs nothing. Every note is already
  // on the grid — that is what makes the failure invisible to a tuning meter —
  // so moving each to its nearest semitone moves nothing at all. The repair is
  // a different melody, which means generating again.
  const HARMONIC_CHECKS = [
    'severeConflicts', 'harmonicCompatibility', 'strongChordConflict',
    'strongOutOfKey', 'unresolvedDissonance',
  ]
  if (failedChecks.some((check) => HARMONIC_CHECKS.includes(check))) {
    reasons.push(
      'Pitch correction cannot fix this: the notes are on the grid and simply do not fit the '
      + 'chords under them. The repair is a different melody, not a retuned one.')
  }

  const worstMoments = judgements
    .filter((j) => j.relation === 'conflict' || j.relation === 'chromatic')
    .sort((a, b) => (Number(b.severe) - Number(a.severe)) || (b.durationBeats - a.durationBeats))
    .slice(0, limit)

  if (failedChecks.length > 0) {
    return {
      verdict: 'REGENERATION_REQUIRED', reasons, failedChecks, measurements, worstMoments,
      evidence: evidenceSummary, limitations: evidence.limitations,
    }
  }

  // Inside every threshold. Whether that is a PASS now depends only on whether
  // the evidence was strong enough to be worth believing.
  if (evidence.confidence < thresholds.minConfidenceForPass) {
    return {
      verdict: 'REVIEW_REQUIRED',
      reasons: [
        `Every threshold is met, but the evidence is only ${(evidence.confidence * 100).toFixed(0)}% `
        + `confident, below the ${(thresholds.minConfidenceForPass * 100).toFixed(0)}% a PASS requires. `
        + 'Passing on this would be labelling an unverified song a verified one.',
      ],
      failedChecks: [], measurements, worstMoments,
      evidence: evidenceSummary, limitations: evidence.limitations,
    }
  }
  if (measurements.intentionalChromaticNotes > 0) {
    return {
      verdict: 'REVIEW_REQUIRED',
      reasons: [
        `Every threshold is met. ${measurements.intentionalChromaticNotes} chromatic note(s) recur at `
        + 'the same place in the bar, which reads as deliberate writing rather than a slip — but this '
        + 'gate cannot tell a blue note from a wrong one, so it says so instead of guessing.',
      ],
      failedChecks: [], measurements, worstMoments,
      evidence: evidenceSummary, limitations: evidence.limitations,
    }
  }

  return {
    verdict: 'PASS',
    reasons: [
      `Harmonic compatibility ${measurements.harmonicCompatibility.toFixed(3)} against a required `
      + `${thresholds.minHarmonicCompatibility.toFixed(2)}, no severe conflicts, and every other `
      + 'threshold met.',
    ],
    failedChecks: [], measurements, worstMoments: [],
    evidence: evidenceSummary, limitations: evidence.limitations,
  }
}
