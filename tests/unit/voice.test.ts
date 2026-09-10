/**
 * What the singing voice has to measure, not just do.
 *
 * These are the two properties that decide whether a listener hears words or
 * hears a hum, and both of them were broken in ways that no functional test
 * would have caught: the vowels have to be measurably different from one
 * another, and the source has to be less than perfectly periodic. Each test
 * here fixes a number that a real defect moved.
 */

import { describe, expect, it } from 'vitest'
import { pronounceWord } from '../../src/engine/lang'
import { vowelFormants } from '../../src/engine/voice/formants'
import { renderSungNote, SING_PRESETS } from '../../src/engine/voice/singer'
import { stft } from '../../src/engine/audio/stft'
import type { Vowel } from '../../src/engine/voice/phonemes'

const SR = 44100

function sing(vowel: Vowel, midi = 55): Float32Array {
  return renderSungNote({
    midi, duration: 0.6, velocity: 0.9,
    sounds: { text: vowel, onset: [], vowel, coda: [] },
    sampleRate: SR, style: SING_PRESETS.baritone!, seed: 5, legato: false,
  })
}

/** Share of a sound's 200 Hz - 4 kHz energy that lands inside one band. */
function bandShare(buffer: Float32Array, low: number, high: number): number {
  const spec = stft(buffer, 2048, 512, SR)
  let inBand = 0
  let total = 0
  for (const frame of spec.magnitude) {
    for (let bin = 1; bin < frame.length; bin++) {
      const hz = (bin * SR) / 2048
      if (hz < 200 || hz > 4000) continue
      const power = frame[bin]! * frame[bin]!
      total += power
      if (hz >= low && hz < high) inBand += power
    }
  }
  return inBand / (total || 1)
}

/**
 * How deep the valleys between the harmonics are, in dB. A perfectly periodic
 * source leaves them close to empty; a voice fills them with breath and with
 * the small irregularity of one cycle to the next.
 */
function combDepth(buffer: Float32Array, f0: number): number {
  const size = 4096
  const spec = stft(buffer, size, 1024, SR)
  const bins = size / 2
  const average = new Array<number>(bins).fill(0)
  for (const frame of spec.magnitude) {
    for (let bin = 0; bin < bins && bin < frame.length; bin++) {
      average[bin] += frame[bin]! * frame[bin]!
    }
  }
  const around = (hz: number, pick: (a: number, b: number) => number, start: number): number => {
    const from = Math.max(0, Math.round(((hz - f0 * 0.2) * size) / SR))
    const to = Math.min(bins - 1, Math.round(((hz + f0 * 0.2) * size) / SR))
    let value = start
    for (let bin = from; bin <= to; bin++) value = pick(value, average[bin]!)
    return value
  }
  const peaks: number[] = []
  const valleys: number[] = []
  for (let harmonic = 2; harmonic * f0 < 3000; harmonic++) {
    peaks.push(around(harmonic * f0, Math.max, 0))
    valleys.push(around(harmonic * f0 + f0 / 2, Math.min, Infinity))
  }
  const mean = (values: number[]) => values.reduce((a, b) => a + b, 0) / (values.length || 1)
  return 10 * Math.log10(mean(peaks) / (mean(valleys) || 1e-12))
}

describe('the vowels are distinguishable from one another', () => {
  it('gives the five-vowel languages a u of their own', () => {
    // Borrowing English "oo" put their u on top of their o: the two vowels'
    // second formants were 30 Hz apart, and no listener can separate that.
    for (const [word, language] of [['bus', 'id'], ['luna', 'es'], ['puso', 'tl']] as const) {
      expect(pronounceWord(word, language)[0]!.vowel, word).toBe('U')
    }
    const u = vowelFormants('U', 'baritone')[1]!.freq
    const o = vowelFormants('O', 'baritone')[1]!.freq
    expect(o / u).toBeGreaterThan(1.3)
  })

  it('lets each vowel own the band its own second formant sits in', () => {
    // The second formant is what says which vowel this is. A vowel that puts
    // less energy in its own F2 band than a different vowel does is a vowel
    // the listener will hear as that other one.
    for (const vowel of ['A', 'IY', 'U', 'O'] as Vowel[]) {
      const f2 = vowelFormants(vowel, 'baritone')[1]!.freq
      const low = f2 * 0.85
      const high = f2 * 1.18
      const own = bandShare(sing(vowel), low, high)
      for (const other of ['A', 'IY', 'U', 'O'] as Vowel[]) {
        if (other === vowel) continue
        expect(own, `${vowel} against ${other} in ${Math.round(f2)} Hz`)
          .toBeGreaterThan(bandShare(sing(other), low, high))
      }
    }
  })
})

describe('the voice is not perfectly periodic', () => {
  it('fills the valleys between the harmonics', () => {
    // Aspiration is broadband and rides the glottal opening. Without it the
    // valleys run 30 dB deep, which is a comb no larynx produces and a large
    // part of what makes formant synthesis sound like an oscillator.
    const f0 = 440 * Math.pow(2, (55 - 69) / 12)
    for (const vowel of ['A', 'IY', 'E'] as Vowel[]) {
      expect(combDepth(sing(vowel), f0), vowel).toBeLessThan(27)
    }
  })

  it('varies the pitch and the strength cycle by cycle, not sample by sample', () => {
    // Two takes of the same note differ, and the robot preset — which asks
    // for no pitch variation at all — differs only by its breath.
    const take = (seed: number, style = SING_PRESETS.baritone!) => renderSungNote({
      midi: 57, duration: 0.5, velocity: 0.85,
      sounds: { text: 'a', onset: [], vowel: 'A', coda: [] },
      sampleRate: SR, style, seed, legato: false,
    })
    const correlation = (a: Float32Array, b: Float32Array): number => {
      let dot = 0, na = 0, nb = 0
      for (let i = 0; i < Math.min(a.length, b.length); i++) {
        dot += a[i]! * b[i]!; na += a[i]! ** 2; nb += b[i]! ** 2
      }
      return dot / (Math.sqrt(na * nb) || 1)
    }
    expect(correlation(take(1), take(2))).toBeLessThan(0.8)
    expect(correlation(take(1, SING_PRESETS.robot!), take(2, SING_PRESETS.robot!)))
      .toBeGreaterThan(0.95)
  })
})
