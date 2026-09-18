/**
 * What the gate considers acceptable, and why each number is where it is.
 *
 * These are strict on purpose. A gate tuned to let most takes through is a gate
 * that will let the failing take through too, and the failing take is the only
 * one the gate exists for. Loosening one of these is a product decision, so
 * each is named, documented and covered by a test rather than inlined at the
 * point it is compared.
 *
 * Every threshold is a *maximum tolerated* value unless its name says minimum.
 */

export interface QualityThresholds {
  // ---- hard harmonic gates -------------------------------------------------

  /**
   * Strong notes outside the key, as a percentage of strong notes.
   *
   * Not zero, because one leading tone borrowed from the parallel minor is
   * ordinary writing, not a defect. Five per cent of strong notes in a song of
   * two hundred is ten deliberate-sounding chromatic moments, which is already
   * generous; past that the melody is not in the key the band is playing.
   */
  maxStrongOutOfKeyPercent: number

  /**
   * Strong notes that conflict with the chord under them, as a percentage.
   *
   * Higher than the out-of-key figure because an in-key note can still be
   * wrong over a particular chord, and a little of that is normal — a 4th over
   * a major triad on a weak beat passes through. Eight per cent of *strong*
   * notes doing it is a melody written against a different progression.
   */
  maxStrongChordConflictPercent: number

  /**
   * How long a dissonance may hang without resolving, in beats.
   *
   * One beat. A suspension resolves within the bar or it is not a suspension;
   * at 90 BPM one beat is two thirds of a second, which is well past the point
   * where the ear stops hearing tension and starts hearing a mistake.
   */
  maxUnresolvedDissonanceBeats: number

  /**
   * The same limit in seconds, and the one that decides severity.
   *
   * Beats are the wrong unit for this and it took a measurement to see it: a
   * dissonance held one beat lasts 0.67 s at 90 BPM and 0.33 s at 180, so a
   * beat-only rule is twice as strict on fast music for no musical reason. The
   * ear does not count bars — it hears how long the clash lasts. Metal at 180
   * BPM was failing on notes held four tenths of a second.
   *
   * 0.7 s is where a suspension stops sounding like tension and starts sounding
   * like a wrong note, and it is what one beat meant at the mid tempo the
   * original figure was chosen for.
   */
  maxUnresolvedDissonanceSeconds: number

  /**
   * Severe conflicts tolerated. Zero.
   *
   * A severe conflict is a note that is against the chord, unexplained by any
   * melodic figure, *and* held past `maxUnresolvedDissonanceBeats`. There is no
   * reading of one of those that is not a wrong note, so there is no number of
   * them worth delivering.
   */
  maxSevereConflicts: number

  /**
   * The duration-weighted share of sung time that must fit the harmony.
   *
   * 0.80. The measure counts chord tones, accepted tensions, and non-chord
   * tones explained by passing, neighbour or resolving motion — so a melody
   * written to the progression scores well above this, and one written against
   * it cannot reach it by chance. The remaining fifth is the room real writing
   * needs for anticipations, escape tones and the note that arrives early.
   */
  minHarmonicCompatibility: number

  // ---- confidence ----------------------------------------------------------

  /**
   * Confidence below which PASS is not available, whatever the numbers say.
   *
   * 0.70. A score the composer wrote scores 1.0 because the notes and the
   * chords are the same object. A transcription off a separated stem scores
   * lower and has to earn it. Below this the honest answer is REVIEW_REQUIRED,
   * not PASS — an unverified song must never be labelled a verified one.
   */
  minConfidenceForPass: number

  // ---- performance gates ---------------------------------------------------

  /** Notes outside the requested vocal range. Zero: a note the voice cannot reach is not a take. */
  maxRangeViolations: number

  /**
   * Share of notes whose tuning error exceeds `seriousPitchDeviationCents`.
   *
   * Only meaningful on audio evidence; a symbolic score has no tuning error by
   * construction, and reporting 0% there would be a tautology rather than a
   * finding, so the check is skipped rather than passed.
   */
  maxSeriousPitchDeviationPercent: number

  /** Cents past which a single note counts as seriously out of tune. */
  seriousPitchDeviationCents: number

  /**
   * Share of notes sitting further off the beat grid than `timingToleranceBeats`.
   *
   * Loose, and deliberately so. Sung phrasing is not quantised, and a singer
   * who lands exactly on every subdivision sounds like a machine. This catches
   * a vocal that is not in time with the track at all, not one that breathes.
   */
  maxTimingProblemPercent: number

  /** How far off the nearest 16th a note may sit before it counts as a timing problem. */
  timingToleranceBeats: number

  // ---- what makes a note count ---------------------------------------------

  /**
   * How long a note must be held to be judged on its own, in beats.
   *
   * Half a beat. Shorter than that and a note is passing through whatever else
   * it is doing; the ear hears the line, not the note. This is the single
   * biggest reason the gate does not simply count out-of-key pitch classes.
   */
  strongNoteBeats: number

  /** Velocity at or above which a note counts as accented however short it is. */
  accentVelocity: number

  /** How long a dissonance has to reach a chord tone to count as having resolved. */
  resolutionBeats: number

  /**
   * How many times a chromatic pitch class must recur at the same metrical
   * position before it reads as writing rather than as a mistake.
   *
   * Two. Once is an accident; twice in the same place in the bar is a decision.
   * Notes that clear this are not counted as failures, but a take that leans on
   * them is reported as REVIEW_REQUIRED rather than PASS, because the gate
   * cannot tell a blue note from a wrong one and should not pretend to.
   */
  intentionalChromaticRepeats: number
}

/**
 * The defaults. Strict, and the ones every engine uses unless told otherwise.
 */
export const STRICT_THRESHOLDS: QualityThresholds = {
  maxStrongOutOfKeyPercent: 5,
  maxStrongChordConflictPercent: 8,
  maxUnresolvedDissonanceBeats: 1,
  maxUnresolvedDissonanceSeconds: 0.7,
  maxSevereConflicts: 0,
  minHarmonicCompatibility: 0.8,
  minConfidenceForPass: 0.7,
  maxRangeViolations: 0,
  maxSeriousPitchDeviationPercent: 5,
  seriousPitchDeviationCents: 35,
  maxTimingProblemPercent: 25,
  timingToleranceBeats: 0.125,
  strongNoteBeats: 0.5,
  accentVelocity: 0.75,
  resolutionBeats: 1,
  intentionalChromaticRepeats: 2,
}

/** Overrides on top of the strict defaults, for a caller that has a reason. */
export function withThresholds(overrides: Partial<QualityThresholds> = {}): QualityThresholds {
  return { ...STRICT_THRESHOLDS, ...overrides }
}
