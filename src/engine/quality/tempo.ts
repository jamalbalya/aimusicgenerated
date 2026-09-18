/**
 * The requested tempo, as a requirement rather than a wish.
 *
 * "72 BPM" in a caption is a wish. ACE-Step's endpoint takes a style string, a
 * lyric sheet, a language, a vocal gender, an instrumental flag and a duration,
 * and none of those is a tempo — so the words reach the model and the model
 * does what it likes with them. One real song asked for 72 and came back at
 * 89.8, steady as a metronome, seventeen and a half BPM out.
 *
 * So the number is recorded here, apart from the caption, and checked against
 * what was produced. That is not enforcement at generation time; no such
 * enforcement exists for this engine. It is enforcement at delivery time, which
 * is the only kind available — and the only kind that matters to a listener.
 */

/** Tempos a song can plausibly be written at. */
export const BPM_RANGE = { min: 40, max: 220 } as const

/**
 * How far the measured tempo may sit from the requested one.
 *
 * Two BPM. At 72 that is 2.8%, inside what a rhythm section drifts by and well
 * outside what a generated track does — the song above held its tempo to 0.3
 * BPM across ten thirty-second windows. A tolerance loose enough to absorb 89.8
 * against 72 would not be a tolerance, it would be a formality.
 */
export const DEFAULT_BPM_TOLERANCE = 2

export interface TempoRequirement {
  targetBpm: number
  toleranceBpm: number
}

export type TempoCheckReason =
  | 'ok'
  /** Nothing was asked for, so nothing was checked. Not the same as passing. */
  | 'not-requested'
  | 'tempo-mismatch'
  | 'half-time'
  | 'double-time'
  | 'unstable-tempo'
  | 'detection-failed'

export interface TempoCheck {
  requestedBpm: number | null
  detectedBpm: number | null
  differenceBpm: number | null
  toleranceBpm: number | null
  passed: boolean
  reason: TempoCheckReason
  detail: string
}

export class InvalidTempoRequest extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidTempoRequest'
  }
}

/**
 * A requirement, or the reason the request cannot be one.
 *
 * Nothing is rounded into range. A tempo nobody can play is a request to fix,
 * not a number to adjust behind someone's back — and silently changing what
 * someone asked for is how a studio stops being trustworthy.
 */
export function tempoRequirement(
  targetBpm: number | null | undefined,
  toleranceBpm: number = DEFAULT_BPM_TOLERANCE,
): TempoRequirement | null {
  if (targetBpm === null || targetBpm === undefined) return null
  if (!Number.isFinite(targetBpm)) throw new InvalidTempoRequest('The tempo must be a number.')
  if (targetBpm <= 0) {
    throw new InvalidTempoRequest(`The tempo must be positive; got ${targetBpm}.`)
  }
  if (targetBpm < BPM_RANGE.min || targetBpm > BPM_RANGE.max) {
    throw new InvalidTempoRequest(
      `${targetBpm} BPM is outside the playable range ${BPM_RANGE.min}–${BPM_RANGE.max}.`)
  }
  if (!Number.isFinite(toleranceBpm) || toleranceBpm <= 0) {
    throw new InvalidTempoRequest(
      `The tolerance must be positive; got ${toleranceBpm}. Zero fails every take, because no `
      + 'estimator returns an exact integer.')
  }
  return { targetBpm, toleranceBpm }
}

/** How close to exactly twice or half counts as an octave relationship. */
const OCTAVE_TOLERANCE = 0.06

function octaveRelation(detected: number, target: number): 'half-time' | 'double-time' | null {
  if (detected <= 0 || target <= 0) return null
  if (Math.abs(detected / (target * 2) - 1) <= OCTAVE_TOLERANCE) return 'double-time'
  if (Math.abs(detected / (target * 0.5) - 1) <= OCTAVE_TOLERANCE) return 'half-time'
  return null
}

export interface TempoMeasurement {
  bpm: number | null
  /** Widest minus narrowest windowed tempo, when windows were measured. */
  spreadBpm?: number
}

/** Widest windowed spread a track may have and still be said to hold a tempo. */
export const STABILITY_SPREAD_BPM = 5

/**
 * Holds a measurement to a requirement.
 *
 * An octave error is reported rather than resolved. A song measured at 144
 * against a requested 72 is either correctly written and miscounted by the
 * estimator, or genuinely twice as fast — and nothing in the audio says which.
 * Guessing in the song's favour is how a wrong tempo ships.
 */
export function checkTempo(
  measurement: TempoMeasurement,
  requirement: TempoRequirement | null,
): TempoCheck {
  if (!requirement) {
    return {
      requestedBpm: null, detectedBpm: measurement.bpm, differenceBpm: null,
      toleranceBpm: null, passed: true, reason: 'not-requested',
      detail: 'No tempo was requested, so none was checked. This is not a tempo that passed.',
    }
  }
  const base = {
    requestedBpm: requirement.targetBpm,
    detectedBpm: measurement.bpm,
    toleranceBpm: requirement.toleranceBpm,
  }
  if (measurement.bpm === null || !Number.isFinite(measurement.bpm)) {
    return {
      ...base, differenceBpm: null, passed: false, reason: 'detection-failed',
      detail: 'The tempo could not be measured, so it could not be checked.',
    }
  }
  if (measurement.spreadBpm !== undefined && measurement.spreadBpm > STABILITY_SPREAD_BPM) {
    return {
      ...base, differenceBpm: null, passed: false, reason: 'unstable-tempo',
      detail: `Windowed tempos span ${measurement.spreadBpm.toFixed(1)} BPM, past the `
        + `${STABILITY_SPREAD_BPM} allowed. There is no one tempo to hold to the request.`,
    }
  }

  const difference = Math.abs(measurement.bpm - requirement.targetBpm)
  if (difference <= requirement.toleranceBpm) {
    return {
      ...base, differenceBpm: Number(difference.toFixed(2)), passed: true, reason: 'ok',
      detail: `${measurement.bpm.toFixed(1)} BPM against ${requirement.targetBpm} requested, `
        + `inside the ${requirement.toleranceBpm} BPM allowed.`,
    }
  }

  const relation = octaveRelation(measurement.bpm, requirement.targetBpm)
  if (relation) {
    return {
      ...base, differenceBpm: Number(difference.toFixed(2)), passed: false, reason: relation,
      detail: `${measurement.bpm.toFixed(1)} BPM is `
        + `${relation === 'double-time' ? 'twice' : 'half'} the requested `
        + `${requirement.targetBpm}. Estimators make this error constantly and a song at `
        + 'genuinely the wrong speed looks identical from here, so it is not excused.',
    }
  }

  return {
    ...base, differenceBpm: Number(difference.toFixed(2)), passed: false, reason: 'tempo-mismatch',
    detail: `${measurement.bpm.toFixed(1)} BPM against ${requirement.targetBpm} requested — `
      + `${difference.toFixed(1)} BPM out, past the ${requirement.toleranceBpm} allowed.`,
  }
}
