import { describe, expect, it } from 'vitest'
import { Rng, hashString } from '../../src/engine/core/rng'
import {
  inScale, midiToName, midiToScaleIndex, parsePitchClass, scaleIndexToMidi,
  scaleNotes, snapToScale, SCALES,
} from '../../src/engine/theory/pitch'
import {
  chordName, chordNotes, chordPitchClasses, diatonicChord, diatonicQuality,
  parseRoman, voiceChord,
} from '../../src/engine/theory/chords'
import { PROGRESSIONS, getProgression } from '../../src/engine/theory/progressions'
import { dbToGain, gainToDb, freqToMidi, midiToFreq, formatDuration } from '../../src/engine/core/units'

describe('Rng', () => {
  it('is deterministic for the same seed', () => {
    const a = new Rng('seed')
    const b = new Rng('seed')
    const first = Array.from({ length: 20 }, () => a.next())
    const second = Array.from({ length: 20 }, () => b.next())
    expect(first).toEqual(second)
  })

  it('produces different sequences for different seeds', () => {
    const a = new Rng('seed-a')
    const b = new Rng('seed-b')
    expect(a.next()).not.toBe(b.next())
  })

  it('stays inside [0, 1)', () => {
    const rng = new Rng(1)
    for (let i = 0; i < 5000; i++) {
      const value = rng.next()
      expect(value).toBeGreaterThanOrEqual(0)
      expect(value).toBeLessThan(1)
    }
  })

  it('never returns a degenerate sequence for seed zero', () => {
    const rng = new Rng(0)
    const values = new Set(Array.from({ length: 10 }, () => rng.next()))
    expect(values.size).toBeGreaterThan(5)
  })

  it('respects integer bounds', () => {
    const rng = new Rng('int')
    for (let i = 0; i < 2000; i++) {
      const value = rng.int(3, 7)
      expect(value).toBeGreaterThanOrEqual(3)
      expect(value).toBeLessThanOrEqual(7)
      expect(Number.isInteger(value)).toBe(true)
    }
  })

  it('honours weights', () => {
    const rng = new Rng('weights')
    const counts = [0, 0, 0]
    for (let i = 0; i < 3000; i++) counts[rng.weightedIndex([0, 1, 9])]!++
    expect(counts[0]).toBe(0)
    expect(counts[2]).toBeGreaterThan(counts[1]!)
  })

  it('shuffles without losing or duplicating items', () => {
    const rng = new Rng('shuffle')
    const input = [1, 2, 3, 4, 5, 6, 7, 8]
    const output = rng.shuffle(input)
    expect(output.slice().sort((a, b) => a - b)).toEqual(input)
    expect(input).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
  })

  it('hashes strings deterministically and distinctly', () => {
    expect(hashString('abc')).toBe(hashString('abc'))
    expect(hashString('abc')).not.toBe(hashString('abd'))
  })
})

describe('units', () => {
  it('round-trips MIDI and frequency', () => {
    expect(midiToFreq(69)).toBeCloseTo(440, 6)
    expect(freqToMidi(440)).toBeCloseTo(69, 6)
    for (const midi of [21, 36, 60, 72, 108]) {
      expect(freqToMidi(midiToFreq(midi))).toBeCloseTo(midi, 6)
    }
  })

  it('round-trips gain and decibels', () => {
    expect(dbToGain(0)).toBeCloseTo(1, 9)
    expect(dbToGain(-6)).toBeCloseTo(0.5011872, 5)
    expect(gainToDb(dbToGain(-12))).toBeCloseTo(-12, 5)
  })

  it('formats durations', () => {
    expect(formatDuration(0)).toBe('0:00')
    expect(formatDuration(65)).toBe('1:05')
    expect(formatDuration(3725)).toBe('1:02:05')
    expect(formatDuration(-5)).toBe('0:00')
    expect(formatDuration(Number.NaN)).toBe('0:00')
  })
})

describe('pitch', () => {
  it('parses note names', () => {
    expect(parsePitchClass('C')).toBe(0)
    expect(parsePitchClass('f#')).toBe(6)
    expect(parsePitchClass('Bb')).toBe(10)
    expect(parsePitchClass('Eb3')).toBe(3)
    expect(parsePitchClass('H')).toBeNull()
  })

  it('names MIDI notes', () => {
    expect(midiToName(60)).toBe('C4')
    expect(midiToName(69)).toBe('A4')
    expect(midiToName(61, true)).toBe('Db4')
  })

  it('generates scales inside the requested range', () => {
    const notes = scaleNotes(0, 'major', 60, 72)
    expect(notes).toEqual([60, 62, 64, 65, 67, 69, 71, 72])
  })

  it('recognises scale membership', () => {
    expect(inScale(64, 0, 'major')).toBe(true)
    expect(inScale(63, 0, 'major')).toBe(false)
    expect(inScale(63, 0, 'minor')).toBe(true)
  })

  it('snaps out-of-scale notes into the scale', () => {
    for (const scale of Object.keys(SCALES) as (keyof typeof SCALES)[]) {
      for (let midi = 48; midi < 84; midi++) {
        const snapped = snapToScale(midi, 5, scale)
        expect(inScale(snapped, 5, scale)).toBe(true)
        expect(Math.abs(snapped - midi)).toBeLessThanOrEqual(6)
      }
    }
  })

  it('round-trips scale indices', () => {
    for (const scale of ['major', 'minor', 'dorian', 'minorPentatonic'] as const) {
      for (let index = -14; index < 21; index++) {
        const midi = scaleIndexToMidi(index, 2, scale)
        expect(midiToScaleIndex(midi, 2, scale)).toBe(index)
      }
    }
  })
})

describe('chords', () => {
  it('derives diatonic qualities in major', () => {
    const expected = ['maj', 'min', 'min', 'maj', 'maj', 'min', 'dim']
    expected.forEach((quality, degree) => {
      expect(diatonicQuality('major', degree)).toBe(quality)
    })
  })

  it('derives diatonic qualities in natural minor', () => {
    const expected = ['min', 'dim', 'maj', 'min', 'min', 'maj', 'maj']
    expected.forEach((quality, degree) => {
      expect(diatonicQuality('minor', degree)).toBe(quality)
    })
  })

  it('derives seventh qualities', () => {
    expect(diatonicQuality('major', 0, true)).toBe('maj7')
    expect(diatonicQuality('major', 4, true)).toBe('dom7')
    expect(diatonicQuality('major', 1, true)).toBe('min7')
    expect(diatonicQuality('major', 6, true)).toBe('min7b5')
  })

  it('builds chord tones', () => {
    expect(chordNotes({ root: 0, quality: 'maj' }, 4)).toEqual([60, 64, 67])
    expect(chordPitchClasses({ root: 9, quality: 'min7' })).toEqual([0, 4, 7, 9])
  })

  it('names chords, including slash chords', () => {
    expect(chordName({ root: 0, quality: 'maj' })).toBe('C')
    expect(chordName({ root: 9, quality: 'min7' })).toBe('Am7')
    expect(chordName({ root: 0, quality: 'maj', bass: 7 })).toBe('C/G')
  })

  it('parses roman numerals', () => {
    expect(parseRoman('I', 0, 'major')).toMatchObject({ root: 0, quality: 'maj' })
    expect(parseRoman('vi', 0, 'major')).toMatchObject({ root: 9, quality: 'min' })
    expect(parseRoman('bVII', 0, 'minor')).toMatchObject({ root: 10, quality: 'maj' })
    expect(parseRoman('V', 0, 'minor')).toMatchObject({ root: 7, quality: 'maj' })
    expect(parseRoman('iim7b5', 0, 'minor')).toMatchObject({ root: 2, quality: 'min7b5' })
    expect(parseRoman('V7', 5, 'major')).toMatchObject({ root: 0, quality: 'dom7' })
  })

  it('never produces an out-of-range root', () => {
    for (const template of PROGRESSIONS) {
      for (const symbol of template.bars) {
        for (let tonic = 0; tonic < 12; tonic++) {
          const chord = parseRoman(symbol, tonic, 'minor')
          expect(chord.root).toBeGreaterThanOrEqual(0)
          expect(chord.root).toBeLessThan(12)
        }
      }
    }
  })

  it('voices chords with minimal movement', () => {
    const first = voiceChord({ root: 0, quality: 'maj' }, null, 60, 4)
    const second = voiceChord({ root: 5, quality: 'maj' }, first, 60, 4)
    const movement = second.reduce((sum, note, i) => sum + Math.abs(note - first[i]!), 0)
    expect(movement).toBeLessThan(24)
    expect(second).toHaveLength(4)
  })

  it('keeps voicings inside a sane register', () => {
    let previous: number[] | null = null
    for (let degree = 0; degree < 24; degree++) {
      const chord = diatonicChord(0, 'major', degree)
      previous = voiceChord(chord, previous, 60, 4)
      for (const note of previous) {
        expect(note).toBeGreaterThan(30)
        expect(note).toBeLessThan(100)
      }
    }
  })
})

describe('progressions', () => {
  it('has unique ids and non-empty bars', () => {
    const ids = new Set<string>()
    for (const template of PROGRESSIONS) {
      expect(ids.has(template.id)).toBe(false)
      ids.add(template.id)
      expect(template.bars.length).toBeGreaterThan(0)
      expect(getProgression(template.id)).toBe(template)
    }
  })
})
