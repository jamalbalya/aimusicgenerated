import { describe, expect, it } from 'vitest'
import { blockwise, shouldBlock } from '../../src/engine/audio/blockwise'
import { separateStems, splitVocals } from '../../src/engine/audio/separate'
import { reduceNoise } from '../../src/engine/audio/effects'
import type { AudioData } from '../../src/engine/audio/wav'

const RATE = 8000

function tone(freq: number, seconds: number, amplitude = 0.4): Float32Array {
  const out = new Float32Array(Math.round(seconds * RATE))
  for (let i = 0; i < out.length; i++) out[i] = Math.sin((2 * Math.PI * freq * i) / RATE) * amplitude
  return out
}

function stereoMix(seconds: number): AudioData {
  const length = Math.round(seconds * RATE)
  const left = new Float32Array(length)
  const right = new Float32Array(length)
  for (let i = 0; i < length; i++) {
    const vocal = Math.sin((2 * Math.PI * 330 * i) / RATE) * 0.35
    const side = Math.sin((2 * Math.PI * 1500 * i) / RATE) * 0.25
    left[i] = vocal + side
    right[i] = vocal - side
  }
  return { channels: [left, right], sampleRate: RATE }
}

function maxAbsDifference(a: Float32Array, b: Float32Array): number {
  let worst = 0
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    worst = Math.max(worst, Math.abs(a[i]! - b[i]!))
  }
  return worst
}

describe('blockwise', () => {
  it('passes short audio straight through', () => {
    const audio: AudioData = { channels: [tone(440, 2)], sampleRate: RATE }
    expect(shouldBlock(audio, 30)).toBe(false)
    let calls = 0
    const [out] = blockwise(audio, 1, (block) => {
      calls++
      return [block]
    })
    expect(calls).toBe(1)
    expect(out!.channels[0]).toEqual(audio.channels[0])
  })

  it('reassembles a long signal exactly when the operation is identity', () => {
    const audio: AudioData = { channels: [tone(440, 120), tone(660, 120)], sampleRate: RATE }
    expect(shouldBlock(audio, 30)).toBe(true)
    let calls = 0
    const [out] = blockwise(audio, 1, (block) => {
      calls++
      return [block]
    }, { blockSeconds: 20, overlapSeconds: 2 })

    expect(calls).toBeGreaterThan(3)
    expect(out!.channels).toHaveLength(2)
    expect(out!.channels[0]!.length).toBe(audio.channels[0]!.length)
    // Cross-fades of identical material must reconstruct the original exactly.
    expect(maxAbsDifference(out!.channels[0]!, audio.channels[0]!)).toBeLessThan(1e-5)
    expect(maxAbsDifference(out!.channels[1]!, audio.channels[1]!)).toBeLessThan(1e-5)
  })

  it('returns every requested output', () => {
    const audio: AudioData = { channels: [tone(440, 90)], sampleRate: RATE }
    const outputs = blockwise(audio, 3, (block) => [block, block, block], { blockSeconds: 20, overlapSeconds: 2 })
    expect(outputs).toHaveLength(3)
    for (const output of outputs) expect(output.channels[0]!.length).toBe(audio.channels[0]!.length)
  })

  it('handles empty audio', () => {
    const outputs = blockwise({ channels: [new Float32Array(0)], sampleRate: RATE }, 2, () => [])
    expect(outputs).toHaveLength(2)
    expect(outputs[0]!.channels[0]!.length).toBe(0)
  })
})

describe('long-file processing', () => {
  it('splits vocals from a two-minute file without artefacts at the joins', () => {
    const mix = stereoMix(120)
    const { vocals, instrumental } = splitVocals(mix, { frameSize: 512 })
    expect(vocals.channels[0]!.length).toBe(mix.channels[0]!.length)
    expect(instrumental.channels[0]!.length).toBe(mix.channels[0]!.length)

    // No sample may jump wildly between neighbours — that is what a bad join
    // sounds like, and it is what block processing has to avoid.
    let worstJump = 0
    for (let i = 1; i < vocals.channels[0]!.length; i++) {
      worstJump = Math.max(worstJump, Math.abs(vocals.channels[0]![i]! - vocals.channels[0]![i - 1]!))
    }
    expect(worstJump).toBeLessThan(0.5)
    for (let i = 0; i < vocals.channels[0]!.length; i += 101) {
      expect(Number.isFinite(vocals.channels[0]![i]!)).toBe(true)
    }
  })

  it('separates a long file into four stems', () => {
    const mix = stereoMix(90)
    const result = separateStems(mix, { frameSize: 512 })
    for (const stem of Object.values(result.stems)) {
      expect(stem.channels[0]!.length).toBe(mix.channels[0]!.length)
      for (let i = 0; i < stem.channels[0]!.length; i += 211) {
        expect(Number.isFinite(stem.channels[0]![i]!)).toBe(true)
      }
    }
  })

  it('reduces noise across a long file', () => {
    const length = 90 * RATE
    const signal = new Float32Array(length)
    for (let i = 0; i < length; i++) {
      signal[i] = Math.sin((2 * Math.PI * 440 * i) / RATE) * 0.4 + (Math.random() - 0.5) * 0.05
    }
    const cleaned = reduceNoise({ channels: [signal], sampleRate: RATE }, 0.7)
    expect(cleaned.channels[0]!.length).toBe(length)
    for (let i = 0; i < length; i += 307) expect(Number.isFinite(cleaned.channels[0]![i]!)).toBe(true)
  })
})
