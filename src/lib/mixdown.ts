/**
 * Summing stems back together.
 *
 * The renderer already produced every part separately, so the instrumental and
 * the vocal-only version are additions rather than another render: no waiting,
 * and they are exactly the parts that are in the finished mix.
 */

import type { AudioData } from '../engine/audio/wav'

export interface Stem {
  id: string
  name: string
  audio: AudioData
}

/** Stem ids that carry a voice. Everything else is the instrumental. */
const VOCAL_STEMS = new Set(['vocal', 'vocalHarmony'])

export function isVocalStem(id: string): boolean {
  return VOCAL_STEMS.has(id)
}

/**
 * Adds the chosen stems into one buffer.
 *
 * Returns null when nothing matched, which is what the caller shows as "this
 * song has no vocal track" rather than offering an empty file.
 */
export function sumStems(stems: Stem[], keep: (stem: Stem) => boolean): AudioData | null {
  const chosen = stems.filter(keep)
  if (chosen.length === 0) return null

  const sampleRate = chosen[0]!.audio.sampleRate
  const channelCount = Math.max(...chosen.map((stem) => stem.audio.channels.length))
  const length = Math.max(...chosen.map((stem) => stem.audio.channels[0]?.length ?? 0))
  if (length === 0) return null

  const channels: Float32Array[] = []
  for (let c = 0; c < channelCount; c++) {
    const out = new Float32Array(length)
    for (const stem of chosen) {
      // A mono stem in a stereo mix feeds both sides.
      const source = stem.audio.channels[c] ?? stem.audio.channels[0]
      if (!source) continue
      const count = Math.min(length, source.length)
      for (let i = 0; i < count; i++) out[i]! += source[i]!
    }
    channels.push(out)
  }

  return { channels, sampleRate }
}
