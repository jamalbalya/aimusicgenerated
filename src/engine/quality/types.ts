/**
 * What the quality gate looks at, and what it decides.
 *
 * The gate exists because of a finding the analyser made and the studio could
 * not previously act on: a vocal can be accurate to five cents and still be
 * wrong. Landing on the twelve-tone grid and choosing the note the chords want
 * are different questions, they fail independently, and only the second one is
 * what a listener hears as "this song is out of tune with itself".
 *
 * So nothing here measures tuning alone. The unit of judgement is a sung note
 * against the chord that is sounding underneath it at that moment.
 *
 * Everything in this file is symbolic — beats, MIDI numbers, pitch classes —
 * and deliberately says nothing about where the evidence came from. A score the
 * composer wrote and a transcription taken off a separated stem both reduce to
 * the same shape, which is what lets one rule engine judge both and one set of
 * tests cover both.
 */

import type { PitchClass, ScaleName } from '../theory/pitch'

/**
 * The four verdicts, and the only four.
 *
 * There is no "probably fine". The whole point of the gate is that the
 * uncertain cases are named as uncertain rather than rounded towards delivery,
 * because rounding towards delivery is exactly how a song with a melody in the
 * wrong key reaches a listener.
 */
export type QualityVerdict =
  /** Every mandatory check passed, on evidence strong enough to be worth acting on. */
  | 'PASS'
  /** A hard failure. The song is not delivered; another is generated instead. */
  | 'REGENERATION_REQUIRED'
  /** The evidence cannot support a judgement. Never silently promoted to PASS. */
  | 'ANALYSIS_UNAVAILABLE'
  /** Genuinely ambiguous: inside the thresholds, but on evidence too weak to call. */
  | 'REVIEW_REQUIRED'

/** A chord, and the stretch of the song it is sounding over. */
export interface HarmonicRegion {
  startBeat: number
  endBeat: number
  /** Root pitch class, so intervals can be measured from it. */
  root: PitchClass
  /** Every pitch class the chord contains. */
  pitchClasses: PitchClass[]
  /** For the report, e.g. "Am7". Never used to decide anything. */
  name: string
}

/** One sung note. */
export interface VocalNote {
  startBeat: number
  durationBeats: number
  /** May be fractional when it came from a pitch tracker. */
  midi: number
  /** 0..1. Stands in for accent: a loud note is one the ear lands on. */
  velocity: number
}

/**
 * Everything the gate needs, and a statement of how much it can be trusted.
 *
 * `confidence` and `isolated` are not decoration. A measurement taken off a
 * full mix is not a weaker version of a measurement taken off a separated
 * vocal — on a real song the two disagreed in *sign*, the mix reporting strong
 * agreement where the stems reported worse than chance. So evidence that cannot
 * be attributed to the voice is refused rather than discounted.
 */
export interface MusicalEvidence {
  /** `score` is exact — the composer's own notes. `audio` is estimated. */
  source: 'score' | 'audio'
  /** 0..1. Below `minConfidenceForPass` the best available verdict is REVIEW_REQUIRED. */
  confidence: number
  /** True only when the vocal really was separated from the band. */
  isolated: boolean
  bpm: number
  beatsPerBar: number
  key: { tonic: PitchClass; scale: ScaleName; pitchClasses: PitchClass[]; name: string }
  regions: HarmonicRegion[]
  notes: VocalNote[]
  /** The range the voice was asked for, when one was asked for. */
  vocalRange?: { lowMidi: number; highMidi: number }
  /** Per-note tuning error in cents, when it was measured. Symbolic scores have none. */
  centsDeviations?: number[]
  /** What this evidence cannot support, in the words the report will print. */
  limitations: string[]
}

/** Why evidence could not be gathered. Carries the reason all the way to the user. */
export interface EvidenceUnavailable {
  available: false
  reason: string
}

export type EvidenceResult = ({ available: true } & MusicalEvidence) | EvidenceUnavailable

/** How one sung note relates to the chord underneath it. */
export type NoteRelation =
  /** In the chord. Always fine. */
  | 'chord-tone'
  /** A colour the chord accepts — a 9th on a triad, a 6th on a minor. */
  | 'tension'
  /** Not in the chord, but stepping through between two notes that are. */
  | 'passing'
  /** Not in the chord, but leaving and returning to the same neighbour. */
  | 'neighbour'
  /** Not in the chord, but resolving by step to one soon enough to be heard as leading there. */
  | 'resolved'
  /** Outside the key entirely, and not explained by any of the above. */
  | 'chromatic'
  /** Against the chord, unexplained, and audible. This is the one that fails a song. */
  | 'conflict'

/** One note, judged. */
export interface NoteJudgement {
  index: number
  startBeat: number
  /** Where in the song, for a report someone can actually check by listening. */
  atSeconds: number
  durationBeats: number
  midi: number
  pitchClass: PitchClass
  /** The chord sounding under it, or null when nothing was. */
  chord: string | null
  /** Semitones above the chord root, 0..11. */
  intervalFromRoot: number | null
  relation: NoteRelation
  inKey: boolean
  /** Long enough, loud enough or well enough placed that a listener lands on it. */
  strong: boolean
  /** A conflict this long, unresolved, is a severe one. */
  severe: boolean
  /** Why it was judged this way, in one phrase. */
  reason: string
}

/** The numbers the thresholds are compared against. */
export interface QualityMeasurements {
  notes: number
  /** Total sung time, in beats — the denominator for every duration-weighted share. */
  sungBeats: number
  /** Share of *strong* notes whose pitch class is outside the key. */
  strongOutOfKeyPercent: number
  /** Share of *strong* notes that conflict with the chord under them. */
  strongChordConflictPercent: number
  /** The longest single stretch of unresolved dissonance, in beats. */
  longestUnresolvedDissonanceBeats: number
  /** Conflicts held long enough that no listener could miss them. */
  severeConflicts: number
  /**
   * Duration-weighted share of sung time that fits the harmony: chord tones,
   * accepted tensions, and non-chord tones that are explained by their
   * movement. 0..1. This is the headline figure and the hard gate.
   */
  harmonicCompatibility: number
  /** Notes outside the requested vocal range. */
  rangeViolations: number
  /** Share of notes whose tuning error exceeds the serious threshold. */
  seriousPitchDeviationPercent: number
  /** Share of notes that sit further off the beat grid than the tolerance. */
  timingProblemPercent: number
  /** Chromatic notes that look deliberate: repeated, and resolved. */
  intentionalChromaticNotes: number
}

/**
 * Stable codes for why a take was refused.
 *
 * An interface, not a message: the regeneration loop branches on these and a
 * report prints them, so they are spelled once and never reworded in place.
 */
export type RejectionReason =
  | 'TEMPO_MISMATCH'
  | 'TEMPO_UNMEASURABLE'
  | 'HARMONIC_MISMATCH'
  | 'WEAKEST_FOUR'
  | 'SEVERE_CONFLICT'
  | 'PITCH_PROBLEM'
  | 'VOCAL_RANGE'
  | 'TIMING'
  | 'ANALYSIS_UNAVAILABLE'

/** The gate's full answer. Every field is something a person can check. */
export interface QualityReport {
  verdict: QualityVerdict
  /** True only on PASS. Never inferred from the verdict by a caller. */
  accepted: boolean
  /**
   * Whether this take may reach a listener.
   *
   * Asked of the report rather than re-derived from the verdict at each call
   * site, because a second place deciding what may be delivered is a second
   * place to get it wrong.
   */
  deliveryAllowed: boolean
  rejectionReasons: RejectionReason[]
  /** The tempo check, when a tempo was requested. */
  tempo?: import('./tempo').TempoCheck
  /** One sentence per reason, in the order they were decided. */
  reasons: string[]
  /** Which checks failed, by name, for a machine to branch on. */
  failedChecks: string[]
  measurements: QualityMeasurements | null
  /** The worst moments, longest first, so a listener knows where to check. */
  worstMoments: NoteJudgement[]
  evidence: { source: 'score' | 'audio'; confidence: number; isolated: boolean }
  limitations: string[]
}
