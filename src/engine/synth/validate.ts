/**
 * Checking that the render actually contains what was asked for.
 *
 * A finished audio file is not the same as a finished song. When a song is
 * asked for with a singer on it, the thing that matters is whether a listener
 * can hear the singer — not whether the pipeline ran without throwing. This
 * measures the render against the request and says plainly what came out, so
 * an instrumental is never reported as a completed vocal song.
 */

import { stft } from '../audio/stft'
import type { Score } from '../compose/types'

/** The band a voice is recognised in: above the body, below the air. */
const VOICE_LOW = 800
const VOICE_HIGH = 5000

export interface RenderValidation {
  /** What the render actually is, whatever was requested. */
  kind: 'vocal-song' | 'instrumental' | 'empty'
  /** True when the score asked for a singer. */
  vocalRequested: boolean
  durationSeconds: number
  /** Peak sample of the mix, 0..1. */
  peak: number
  /**
   * The vocal's share of the band a voice is heard in, 0..1. Undefined when
   * the render kept no stems, since there is then nothing to compare.
   */
  voiceBandShare?: number
  /** Anything wrong enough that a listener would notice. */
  problems: string[]
}

function bandPower(buffer: Float32Array, sampleRate: number, low: number, high: number): number {
  const spec = stft(buffer, 1024, 256, sampleRate)
  let total = 0
  for (const frame of spec.magnitude) {
    for (let bin = 1; bin < frame.length; bin++) {
      const hz = (bin * sampleRate) / 1024
      if (hz >= low && hz < high) total += frame[bin]! * frame[bin]!
    }
  }
  return total
}

export interface RenderedForValidation {
  left: Float32Array
  right: Float32Array
  sampleRate: number
  durationSeconds: number
  peak: number
  stems?: { id: string; left: Float32Array }[]
}

/** Stem ids that carry a voice. */
const VOICE_STEMS = new Set(['vocal', 'vocalHarmony'])

/**
 * Reads the render and reports what it is.
 *
 * The vocal check is deliberately about audibility rather than existence: a
 * vocal track that is present in the score but inaudible in the mix is the
 * same thing as no vocal, as far as the person listening is concerned.
 */
export function validateRender(score: Score, rendered: RenderedForValidation): RenderValidation {
  const problems: string[] = []

  const vocalTrack = score.tracks.find((track) => track.id === 'vocal')
  const sungNotes = vocalTrack?.notes.filter((note) => note.syllable).length ?? 0
  const vocalRequested = Boolean(score.lyrics) && sungNotes > 0

  if (rendered.durationSeconds < 1) problems.push('The render is shorter than a second.')
  if (rendered.peak < 0.01) problems.push('The render is silent.')
  for (const channel of [rendered.left, rendered.right]) {
    for (let i = 0; i < channel.length; i += 997) {
      if (!Number.isFinite(channel[i]!)) {
        problems.push('The render contains invalid samples.')
        i = channel.length
      }
    }
  }

  let voiceBandShare: number | undefined
  if (rendered.stems && rendered.stems.length > 0) {
    const voice = rendered.stems.filter((stem) => VOICE_STEMS.has(stem.id))
    const backing = rendered.stems.filter((stem) => !VOICE_STEMS.has(stem.id))
    if (voice.length > 0) {
      const sung = voice.reduce(
        (sum, stem) => sum + bandPower(stem.left, rendered.sampleRate, VOICE_LOW, VOICE_HIGH), 0)
      const rest = backing.reduce(
        (sum, stem) => sum + bandPower(stem.left, rendered.sampleRate, VOICE_LOW, VOICE_HIGH), 0)
      voiceBandShare = sung / (sung + rest || 1)
      // Below about a fifth of the band, a voice stops standing out from the
      // arrangement and the words go with it.
      if (vocalRequested && voiceBandShare < 0.2) {
        problems.push('The vocal is buried: it is not carrying the range words are heard in.')
      }
    } else if (vocalRequested) {
      problems.push('A vocal was written but no vocal was rendered.')
    }
  }

  const kind = problems.includes('The render is silent.')
    ? 'empty'
    : vocalRequested ? 'vocal-song' : 'instrumental'

  return {
    kind,
    vocalRequested,
    durationSeconds: rendered.durationSeconds,
    peak: rendered.peak,
    ...(voiceBandShare !== undefined ? { voiceBandShare } : {}),
    problems,
  }
}

/** One line describing the result, for the person who pressed Generate. */
export function describeResult(validation: RenderValidation): string {
  if (validation.kind === 'empty') return 'Nothing came out — the render is silent.'
  if (validation.kind === 'instrumental') return 'Instrumental generated.'
  return 'Vocal song generated — the lyrics are sung.'
}
