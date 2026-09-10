import { describe, expect, it } from 'vitest'
import { buildSpec, detectGenre, detectMood, detectTheme, MOODS } from '../../src/engine/compose/prompt'
import { GENRES, getGenre } from '../../src/engine/compose/genres'
import { buildForm, labelSlots } from '../../src/engine/compose/arrangement'
import { planHarmony } from '../../src/engine/compose/harmony'
import { generateDrums } from '../../src/engine/compose/drums'
import { chordChart, composeSong, fitSyllablesToNotes, chordAtBeat } from '../../src/engine/compose/composer'
import { Rng } from '../../src/engine/core/rng'
import { inScale } from '../../src/engine/theory/pitch'
import { scoreDurationSeconds } from '../../src/engine/compose/types'

describe('prompt parsing', () => {
  it('detects genres from natural language', () => {
    expect(detectGenre(' i want a dark trap beat ')?.id).toBe('trap')
    expect(detectGenre(' lofi chill study music ')?.id).toBe('lofi')
    expect(detectGenre(' heavy metal guitar ')?.id).toBe('metal')
    expect(detectGenre(' epic cinematic trailer ')?.id).toBe('cinematic')
    expect(detectGenre(' something nice ')).toBeNull()
  })

  it('detects moods', () => {
    expect(detectMood(' a sad lonely song ')?.id).toBe('sad')
    expect(detectMood(' hype energetic workout ')?.id).toBe('energetic')
    expect(detectMood(' nothing in particular ')).toBeNull()
  })

  it('reads explicit tempo', () => {
    expect(buildSpec('trap at 140 bpm', { seed: 's' }).bpm).toBe(140)
    expect(buildSpec('house music at 124', { seed: 's' }).bpm).toBe(124)
  })

  it('clamps absurd tempos out of the text', () => {
    const spec = buildSpec('a song at 900 bpm', { seed: 's' })
    expect(spec.bpm).toBeGreaterThanOrEqual(40)
    expect(spec.bpm).toBeLessThanOrEqual(240)
  })

  it('reads explicit keys', () => {
    const spec = buildSpec('a ballad in F# minor', { seed: 's' })
    expect(spec.key.tonic).toBe(6)
    expect(spec.key.scale).toBe('minor')
  })

  it('reads durations', () => {
    expect(buildSpec('pop song, 2 minutes', { seed: 's' }).durationSeconds).toBe(120)
    expect(buildSpec('pop song, 90 seconds', { seed: 's' }).durationSeconds).toBe(90)
    expect(buildSpec('pop song, 1 minute and 30 seconds', { seed: 's' }).durationSeconds).toBe(90)
  })

  it('detects instrumental requests', () => {
    expect(buildSpec('lofi beat, no vocals', { seed: 's' }).vocals).toBe('none')
    expect(buildSpec('an instrumental piece', { seed: 's' }).instrumental).toBe(true)
  })

  it('detects rap', () => {
    expect(buildSpec('a hard rap song about the city', { seed: 's' }).vocals).toBe('rap')
  })

  it('extracts a theme', () => {
    expect(detectTheme(' a song about losing my dog ')).toBe('losing my dog')
  })

  it('honours overrides above everything', () => {
    const spec = buildSpec('a dark trap beat at 140 bpm in C minor', {
      seed: 's', genreId: 'jazz', bpm: 90, tonic: 5, scale: 'lydian', durationSeconds: 60, vocals: 'sung',
    })
    expect(spec.genre.id).toBe('jazz')
    expect(spec.bpm).toBe(90)
    expect(spec.key).toEqual({ tonic: 5, scale: 'lydian' })
    expect(spec.durationSeconds).toBe(60)
    expect(spec.vocals).toBe('sung')
  })

  it('is deterministic for a seed', () => {
    const a = buildSpec('make me a song', { seed: 'fixed' })
    const b = buildSpec('make me a song', { seed: 'fixed' })
    expect({ ...a, genre: a.genre.id, mood: a.mood.id }).toEqual({ ...b, genre: b.genre.id, mood: b.mood.id })
  })

  it('handles an empty prompt', () => {
    const spec = buildSpec('', { seed: 'empty' })
    expect(spec.bpm).toBeGreaterThan(0)
    expect(spec.durationSeconds).toBeGreaterThan(0)
  })
})

describe('genre data', () => {
  it('has unique ids and complete instrument racks', () => {
    const ids = new Set<string>()
    for (const genre of GENRES) {
      expect(ids.has(genre.id)).toBe(false)
      ids.add(genre.id)
      expect(genre.bpm[0]).toBeLessThan(genre.bpm[1])
      expect(genre.scales.length).toBeGreaterThan(0)
      expect(genre.progressions.length).toBeGreaterThan(0)
      for (const role of ['chords', 'bass', 'lead', 'pad', 'arp', 'riff'] as const) {
        expect(genre.instruments[role].length).toBeGreaterThan(0)
      }
    }
    expect(getGenre('does-not-exist').id).toBe(GENRES[0]!.id)
  })

  it('every mood has tags', () => {
    for (const mood of MOODS) expect(mood.tags.length).toBeGreaterThan(0)
  })
})

describe('arrangement', () => {
  it('lands close to the requested duration', () => {
    for (const seconds of [30, 60, 120, 180, 300]) {
      for (const genre of [getGenre('pop'), getGenre('edm'), getGenre('ambient'), getGenre('lofi')]) {
        const bpm = (genre.bpm[0] + genre.bpm[1]) / 2
        const slots = buildForm(genre, bpm, 4, seconds, new Rng(`${genre.id}-${seconds}`))
        const bars = slots.reduce((sum, s) => sum + s.bars, 0)
        const actual = (bars * 4 * 60) / bpm
        expect(actual).toBeGreaterThan(seconds * 0.6)
        expect(actual).toBeLessThan(seconds * 1.5)
      }
    }
  })

  it('always produces at least one section with positive length', () => {
    const slots = buildForm(getGenre('pop'), 120, 4, 10, new Rng('tiny'))
    expect(slots.length).toBeGreaterThan(0)
    for (const slot of slots) expect(slot.bars).toBeGreaterThanOrEqual(2)
  })

  it('numbers repeated sections', () => {
    const labels = labelSlots([
      { kind: 'verse', bars: 8, intensity: 0.5 },
      { kind: 'chorus', bars: 8, intensity: 0.9 },
      { kind: 'verse', bars: 8, intensity: 0.5 },
    ])
    expect(labels).toEqual(['Verse 1', 'Chorus', 'Verse 2'])
  })
})

describe('harmony', () => {
  it('gives every bar a chord and reuses chorus harmony', () => {
    const slots = buildForm(getGenre('pop'), 110, 4, 120, new Rng('h'))
    const plan = planHarmony(slots, 0, 'major', getGenre('pop'), new Rng('h2'))
    expect(plan.perSection).toHaveLength(slots.length)
    slots.forEach((slot, i) => {
      expect(plan.perSection[i]).toHaveLength(slot.bars)
    })
    const chorusIds = slots
      .map((slot, i) => (slot.kind === 'chorus' ? plan.progressionIds[i] : null))
      .filter(Boolean)
    if (chorusIds.length > 1) expect(new Set(chorusIds).size).toBe(1)
  })
})

describe('drums', () => {
  it('produces hits inside the song and none for silent styles', () => {
    const genre = getGenre('pop')
    const slots = buildForm(genre, 110, 4, 60, new Rng('d'))
    const starts: number[] = []
    let cursor = 0
    for (const slot of slots) {
      starts.push(cursor)
      cursor += slot.bars * 4
    }
    const track = generateDrums({ genre, beatsPerBar: 4, slots, slotStarts: starts, rng: new Rng('d2'), energy: 0.7 })
    expect(track.hits.length).toBeGreaterThan(20)
    for (const hit of track.hits) {
      expect(hit.start).toBeGreaterThanOrEqual(0)
      expect(hit.start).toBeLessThan(cursor + 4)
      expect(hit.velocity).toBeGreaterThan(0)
      expect(hit.velocity).toBeLessThanOrEqual(1)
    }
    // Hits are sorted by time, which the renderer relies on.
    for (let i = 1; i < track.hits.length; i++) {
      expect(track.hits[i]!.start).toBeGreaterThanOrEqual(track.hits[i - 1]!.start)
    }

    const classical = getGenre('classical')
    const silent = generateDrums({
      genre: classical, beatsPerBar: 4, slots, slotStarts: starts, rng: new Rng('d3'), energy: 0.5,
    })
    expect(silent.hits).toHaveLength(0)
  })
})

describe('syllable placement', () => {
  const note = (start: number, duration: number) => ({ start, duration, midi: 60, velocity: 0.8 })

  it('matches one syllable per note when counts agree', () => {
    const out = fitSyllablesToNotes([note(0, 1), note(1, 1)], ['la', 'la'])
    expect(out.map((n) => n.syllable)).toEqual(['la', 'la'])
  })

  it('splits notes when there are more syllables', () => {
    const out = fitSyllablesToNotes([note(0, 2)], ['ver', 'y', 'good'])
    expect(out).toHaveLength(3)
    expect(out.map((n) => n.syllable)).toEqual(['ver', 'y', 'good'])
    expect(out[0]!.start).toBeCloseTo(0)
    expect(out[2]!.start).toBeCloseTo(4 / 3, 5)
    // Total span still covers the original note.
    expect(out[2]!.start + out[2]!.duration).toBeLessThanOrEqual(2.01)
  })

  it('holds syllables across extra notes', () => {
    const out = fitSyllablesToNotes([note(0, 1), note(1, 1), note(2, 1)], ['love'])
    expect(out).toHaveLength(3)
    expect(out[0]!.syllable).toBe('love')
    expect(out[1]!.syllable).toBeUndefined()
    expect(out[1]!.legato).toBe(true)
  })

  it('handles empty inputs', () => {
    expect(fitSyllablesToNotes([], ['a'])).toEqual([])
    expect(fitSyllablesToNotes([note(0, 1)], [])).toHaveLength(1)
  })
})

describe('composeSong', () => {
  const prompts = [
    'an upbeat pop song about summer',
    'dark trap beat at 140 bpm',
    'lofi chill study music, instrumental',
    'epic cinematic trailer music',
    'a sad acoustic folk song about home',
    'k-pop dance track',
    'jazz lounge, instrumental',
    'ambient meditation, 3 minutes',
    'heavy metal, angry',
    'reggaeton summer party',
  ]

  it.each(prompts)('produces a valid score for "%s"', (prompt) => {
    const spec = buildSpec(prompt, { seed: `t-${prompt}`, durationSeconds: 45 })
    const score = composeSong(spec)

    expect(score.lengthBeats).toBeGreaterThan(0)
    expect(score.sections.length).toBeGreaterThan(0)
    expect(score.tracks.length).toBeGreaterThan(2)
    expect(score.title.length).toBeGreaterThan(1)
    expect(scoreDurationSeconds(score)).toBeGreaterThan(10)

    // Sections tile the timeline exactly, with no gaps or overlaps.
    let cursor = 0
    for (const section of score.sections) {
      expect(section.startBeat).toBe(cursor)
      expect(section.lengthBeats).toBeGreaterThan(0)
      expect(section.chords.length).toBe(section.lengthBeats / score.beatsPerBar)
      cursor += section.lengthBeats
    }
    expect(cursor).toBe(score.lengthBeats)

    for (const track of score.tracks) {
      expect(track.notes.length).toBeGreaterThan(0)
      for (const note of track.notes) {
        expect(Number.isFinite(note.start)).toBe(true)
        expect(note.start).toBeGreaterThanOrEqual(0)
        expect(note.start).toBeLessThan(score.lengthBeats + score.beatsPerBar)
        expect(note.duration).toBeGreaterThan(0)
        expect(note.midi).toBeGreaterThanOrEqual(12)
        expect(note.midi).toBeLessThanOrEqual(108)
        expect(note.velocity).toBeGreaterThan(0)
        expect(note.velocity).toBeLessThanOrEqual(1)
      }
      // Notes are time-ordered, which the renderer assumes.
      for (let i = 1; i < track.notes.length; i++) {
        expect(track.notes[i]!.start).toBeGreaterThanOrEqual(track.notes[i - 1]!.start)
      }
    }
  })

  it('keeps melodies in key', () => {
    const spec = buildSpec('a pop song', { seed: 'inkey', durationSeconds: 60 })
    const score = composeSong(spec)
    const melodic = score.tracks.filter((t) => ['lead', 'vocal', 'vocalHarmony'].includes(t.role))
    expect(melodic.length).toBeGreaterThan(0)
    for (const track of melodic) {
      const inKey = track.notes.filter((n) => inScale(n.midi, score.key.tonic, score.key.scale)).length
      expect(inKey / track.notes.length).toBeGreaterThan(0.95)
    }
  })

  it('attaches lyrics and syllables when there are vocals', () => {
    const spec = buildSpec('a pop song about the ocean', { seed: 'lyr', durationSeconds: 90, vocals: 'sung' })
    const score = composeSong(spec)
    expect(score.lyrics).toBeDefined()
    expect(score.lyrics!.lines.length).toBeGreaterThan(4)
    expect(score.title).toBe(score.lyrics!.title)
    const vocal = score.tracks.find((t) => t.role === 'vocal')
    expect(vocal).toBeDefined()
    const withSyllables = vocal!.notes.filter((n) => n.syllable && n.syllable.length > 0)
    expect(withSyllables.length).toBeGreaterThan(vocal!.notes.length * 0.5)
  })

  it('omits vocals for instrumentals', () => {
    const spec = buildSpec('an instrumental lofi beat', { seed: 'inst', durationSeconds: 45 })
    const score = composeSong(spec)
    expect(score.tracks.some((t) => t.role === 'vocal')).toBe(false)
    expect(score.lyrics).toBeUndefined()
  })

  it('is deterministic for a seed', () => {
    const make = () => composeSong(buildSpec('a pop song about rain', { seed: 'same', durationSeconds: 45 }))
    expect(JSON.stringify(make())).toBe(JSON.stringify(make()))
  })

  it('produces a chord chart and can look up a chord at a beat', () => {
    const score = composeSong(buildSpec('a pop song', { seed: 'chart', durationSeconds: 45 }))
    const chart = chordChart(score)
    expect(chart.length).toBe(score.sections.length)
    expect(chordAtBeat(score, 0)).toBeTruthy()
    expect(chordAtBeat(score, score.lengthBeats + 100)).toBeNull()
  })

  it('handles every genre without throwing', () => {
    for (const genre of GENRES) {
      const spec = buildSpec('a song', { seed: `g-${genre.id}`, genreId: genre.id, durationSeconds: 30 })
      const score = composeSong(spec)
      expect(score.genreId).toBe(genre.id)
      expect(score.tracks.length).toBeGreaterThan(1)
    }
  })

  it('handles extreme durations', () => {
    for (const seconds of [15, 600]) {
      const score = composeSong(buildSpec('a pop song', { seed: 'd', durationSeconds: seconds }))
      expect(score.lengthBeats).toBeGreaterThan(0)
      expect(scoreDurationSeconds(score)).toBeGreaterThan(seconds * 0.5)
    }
  })
})
