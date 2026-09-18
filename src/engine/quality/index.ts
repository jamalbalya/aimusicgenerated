/**
 * The musical quality gate.
 *
 * Two questions, both of which have to be answered before a song is delivered:
 * is the singing accurate, and is it singing the notes these chords want? The
 * second is the one this package exists for, because it is the one that fails
 * invisibly — a take can be in tune to a few cents and still be a melody
 * written over a different progression, and no measure of tuning will ever say
 * so.
 */

export * from './types'
export * from './thresholds'
export {
  evaluate, judgeNotes, measure, classifyInterval, regionAt, type GateOptions,
} from './harmonicGate'
export { evidenceFromScore, regionsOf, sungNotes } from './scoreEvidence'
export {
  tempoRequirement, checkTempo, InvalidTempoRequest,
  BPM_RANGE, DEFAULT_BPM_TOLERANCE, STABILITY_SPREAD_BPM,
  type TempoRequirement, type TempoCheck, type TempoCheckReason, type TempoMeasurement,
} from './tempo'
export { evidenceFromNeuralAudio, NEURAL_ANALYSIS_UNAVAILABLE } from './neuralEvidence'
export {
  runGatedGeneration, describeAttempt, freshSeedSource, RequestMutatedError,
  STRICT_DELIVERY, DEFAULT_MAX_ATTEMPTS, OFFLINE_MAX_ATTEMPTS,
  type DeliveryPolicy, type GatedAttempt, type GatedOutcome, type GatedGenerationOptions,
} from './controller'
export { gateScoreTake, gateNeuralTake, type TakeGateResult } from './gate'
