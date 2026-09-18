/**
 * The two entry points the studio actually calls.
 *
 * Both return a `QualityReport` whatever happens, including when there was
 * nothing to judge, so no caller has to decide what an absent report means.
 * A missing verdict is how an unverified song gets treated as a verified one.
 */

import type { Score } from '../compose/types'
import { evaluate, type GateOptions } from './harmonicGate'
import { evidenceFromScore } from './scoreEvidence'
import { evidenceFromNeuralAudio } from './neuralEvidence'
import type { QualityReport } from './types'

export type TakeGateResult = QualityReport

function unavailable(reason: string, source: 'score' | 'audio'): QualityReport {
  return {
    verdict: 'ANALYSIS_UNAVAILABLE',
    reasons: [reason],
    failedChecks: [],
    measurements: null,
    worstMoments: [],
    evidence: { source, confidence: 0, isolated: false },
    limitations: [reason],
  }
}

/** Judges a take from the offline engine, against the score it was rendered from. */
export function gateScoreTake(score: Score, options: GateOptions = {}): TakeGateResult {
  const evidence = evidenceFromScore(score)
  if (!evidence.available) return unavailable(evidence.reason, 'score')
  return evaluate(evidence, options)
}

/** Judges a take from the neural engine. Always ANALYSIS_UNAVAILABLE in a browser; see `neuralEvidence`. */
export function gateNeuralTake(): TakeGateResult {
  const evidence = evidenceFromNeuralAudio()
  if (!evidence.available) return unavailable(evidence.reason, 'audio')
  return evaluate(evidence)
}
