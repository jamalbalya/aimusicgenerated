/**
 * Melodic material: lead lines, basslines, arpeggios, chord comping and riffs.
 *
 * Melodies are built from motifs (a short cell of scale-step moves and
 * durations) that are then repeated and transformed across a phrase. That is
 * what makes the output feel composed rather than randomly wandering — the
 * listener hears the same idea come back, varied.
 */

import { Rng } from '../core/rng'
import {
  midiToScaleIndex,
  scaleIndexToMidi,
  snapToScale,
  type PitchClass,
  type ScaleName,
} from '../theory/pitch'
import { CHORD_INTERVALS, type Chord } from '../theory/chords'
import type { GenreDef } from './genres'
import type { ScoreNote, SectionKind } from './types'

export interface MelodyContext {
  chords: Chord[]
  startBeat: number
  bars: number
  beatsPerBar: number
  tonic: PitchClass
  scale: ScaleName
  genre: GenreDef
  intensity: number
  kind: SectionKind
  rng: Rng
  /** Centre of the melodic register in MIDI. */
  centerMidi: number
  /** Playable span around the centre, in semitones. */
  range: number
}

/** Rhythm cells, in beats, summing to one bar of 4/4. */
const RHYTHM_CELLS: number[][] = [
  [1, 1, 1, 1],
  [2, 1, 1],
  [1, 1, 2],
  [1.5, 0.5, 1, 1],
  [0.5, 0.5, 1, 1, 1],
  [2, 2],
  [1, 0.5, 0.5, 1, 1],
  [0.75, 0.75, 0.5, 1, 1],
  [1, 1, 0.5, 0.5, 1],
  [4],
  [3, 1],
  [1, 3],
  [0.5, 0.5, 0.5, 0.5, 1, 1],
]

/** Denser cells for busy genres and high-intensity sections. */
const BUSY_CELLS: number[][] = [
  [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5],
  [0.25, 0.25, 0.5, 0.5, 0.5, 1, 1],
  [0.5, 0.25, 0.25, 0.5, 0.5, 1, 1],
  [0.5, 0.5, 1, 0.5, 0.5, 1],
  [0.75, 0.25, 0.5, 0.5, 1, 1],
]

const SPARSE_CELLS: number[][] = [
  [4],
  [2, 2],
  [3, 1],
  [2, 1, 1],
  [4],
]

function pickCell(rng: Rng, density: number): number[] {
  const roll = rng.next()
  if (density > 0.68) {
    return roll < 0.55 ? rng.pick(BUSY_CELLS) : rng.pick(RHYTHM_CELLS)
  }
  if (density < 0.38) {
    return roll < 0.6 ? rng.pick(SPARSE_CELLS) : rng.pick(RHYTHM_CELLS)
  }
  return rng.pick(RHYTHM_CELLS)
}

/** Scales a 4/4 rhythm cell into a bar of any length. */
function fitCellToBar(cell: number[], beatsPerBar: number): number[] {
  const total = cell.reduce((a, b) => a + b, 0)
  if (Math.abs(total - beatsPerBar) < 1e-6) return cell.slice()
  const out: number[] = []
  let remaining = beatsPerBar
  for (const value of cell) {
    const scaled = Math.min(remaining, (value / total) * beatsPerBar)
    if (scaled > 0.05) out.push(scaled)
    remaining -= scaled
    if (remaining <= 0.05) break
  }
  if (remaining > 0.05) out.push(remaining)
  return out
}

interface Motif {
  /** Movement in scale steps between consecutive notes. */
  steps: number[]
  /** Durations in beats. */
  durations: number[]
}

function buildMotif(ctx: MelodyContext, density: number): Motif {
  const cell = fitCellToBar(pickCell(ctx.rng, density), ctx.beatsPerBar)
  const steps: number[] = [0]
  for (let i = 1; i < cell.length; i++) {
    // Mostly stepwise with occasional leaps — the shape of a singable line.
    const roll = ctx.rng.next()
    let move: number
    if (roll < 0.42) move = ctx.rng.pick([1, -1])
    else if (roll < 0.68) move = ctx.rng.pick([2, -2])
    else if (roll < 0.82) move = 0
    else move = ctx.rng.pick([3, -3, 4, -4])
    steps.push(move)
  }
  return { steps, durations: cell }
}

type MotifTransform = 'repeat' | 'transpose' | 'invert' | 'retrograde' | 'varyTail' | 'augment'

function transformMotif(motif: Motif, transform: MotifTransform, rng: Rng): Motif {
  switch (transform) {
    case 'repeat':
      return { steps: motif.steps.slice(), durations: motif.durations.slice() }
    case 'transpose': {
      const shift = rng.pick([1, 2, -1, -2, 3, -3])
      const steps = motif.steps.slice()
      steps[0] = (steps[0] ?? 0) + shift
      return { steps, durations: motif.durations.slice() }
    }
    case 'invert':
      return { steps: motif.steps.map((s, i) => (i === 0 ? s : -s)), durations: motif.durations.slice() }
    case 'retrograde':
      return { steps: [motif.steps[0] ?? 0, ...motif.steps.slice(1).reverse()], durations: motif.durations.slice().reverse() }
    case 'varyTail': {
      const steps = motif.steps.slice()
      const cut = Math.max(1, Math.floor(steps.length / 2))
      for (let i = cut; i < steps.length; i++) steps[i] = rng.pick([1, -1, 2, -2, 0])
      return { steps, durations: motif.durations.slice() }
    }
    case 'augment': {
      // Halve the note count, doubling durations — a natural phrase ending.
      const steps: number[] = []
      const durations: number[] = []
      for (let i = 0; i < motif.steps.length; i += 2) {
        steps.push(motif.steps[i] ?? 0)
        durations.push((motif.durations[i] ?? 1) + (motif.durations[i + 1] ?? 0))
      }
      return { steps, durations }
    }
  }
}

/** Chord tones as scale indices near a reference index. */
function chordToneIndices(chord: Chord, ctx: MelodyContext, nearIndex: number): number[] {
  const midis = CHORD_INTERVALS[chord.quality].map((i) => chord.root + i)
  const out = new Set<number>()
  for (const pc of midis) {
    for (let octave = 2; octave <= 7; octave++) {
      const midi = octave * 12 + (pc % 12)
      out.add(midiToScaleIndex(midi, ctx.tonic, ctx.scale))
    }
  }
  return [...out].sort((a, b) => Math.abs(a - nearIndex) - Math.abs(b - nearIndex))
}

/** Chord index for a given beat offset within the section. */
function chordAt(ctx: MelodyContext, beatInSection: number): Chord {
  const bar = Math.floor(beatInSection / ctx.beatsPerBar)
  return ctx.chords[Math.min(ctx.chords.length - 1, Math.max(0, bar))]!
}

export interface MelodyResult {
  notes: ScoreNote[]
  /** Note index ranges that form each phrase, for lyric alignment. */
  phrases: { start: number; end: number }[]
}

/**
 * Generates a lead/vocal melody across a section. Phrases are two bars long by
 * default and follow an A A' B A'' shape, with rests between phrases so a
 * singer could actually breathe.
 */
export function generateMelody(ctx: MelodyContext): MelodyResult {
  const notes: ScoreNote[] = []
  const phrases: { start: number; end: number }[] = []
  const density = Math.min(1, ctx.genre.density * 0.6 + ctx.intensity * 0.5)

  const barsPerPhrase = ctx.bars >= 8 ? 2 : ctx.bars >= 4 ? 2 : 1
  const phraseCount = Math.max(1, Math.floor(ctx.bars / barsPerPhrase))

  const seedMotif = buildMotif(ctx, density)
  const answerMotif = buildMotif(ctx, density)

  // Contour plan: how each phrase relates to the one before it.
  const plan: MotifTransform[] = []
  for (let i = 0; i < phraseCount; i++) {
    if (i === 0) plan.push('repeat')
    else if (i === phraseCount - 1) plan.push(ctx.rng.chance(0.5) ? 'augment' : 'varyTail')
    else if (i % 2 === 1) plan.push(ctx.rng.pick<MotifTransform>(['transpose', 'varyTail']))
    else plan.push(ctx.rng.pick<MotifTransform>(['repeat', 'invert', 'retrograde']))
  }

  const centerIndex = midiToScaleIndex(ctx.centerMidi, ctx.tonic, ctx.scale)
  const lowIndex = midiToScaleIndex(ctx.centerMidi - ctx.range / 2, ctx.tonic, ctx.scale)
  const highIndex = midiToScaleIndex(ctx.centerMidi + ctx.range / 2, ctx.tonic, ctx.scale)

  let currentIndex = centerIndex

  for (let p = 0; p < phraseCount; p++) {
    const phraseStartNote = notes.length
    const base = p % 2 === 0 ? seedMotif : answerMotif
    const motif = transformMotif(base, plan[p]!, ctx.rng)

    const phraseBeats = barsPerPhrase * ctx.beatsPerBar
    const phraseStartBeat = p * phraseBeats
    // Leave the tail of the phrase open so lines breathe.
    const restBeats = ctx.rng.chance(0.75) ? Math.min(phraseBeats * 0.25, ctx.beatsPerBar * 0.5) : 0
    const usableBeats = phraseBeats - restBeats

    let cursor = phraseStartBeat
    let motifPos = 0
    let guard = 0

    while (cursor < phraseStartBeat + usableBeats - 1e-6 && guard++ < 256) {
      const step = motif.steps[motifPos % motif.steps.length] ?? 0
      let duration = motif.durations[motifPos % motif.durations.length] ?? 1
      duration = Math.min(duration, phraseStartBeat + usableBeats - cursor)
      if (duration < 0.12) break

      currentIndex += step
      // Fold back into range instead of clamping, so the line keeps moving.
      if (currentIndex > highIndex) currentIndex -= Math.max(1, Math.round((currentIndex - highIndex) / 2) * 2)
      if (currentIndex < lowIndex) currentIndex += Math.max(1, Math.round((lowIndex - currentIndex) / 2) * 2)

      const beatInBar = cursor % ctx.beatsPerBar
      const isStrong = beatInBar < 0.05 || Math.abs(beatInBar - ctx.beatsPerBar / 2) < 0.05
      const chord = chordAt(ctx, cursor)

      let index = currentIndex
      if (isStrong || duration >= 1.5) {
        // Land on a chord tone where the harmony is exposed.
        const candidates = chordToneIndices(chord, ctx, currentIndex)
        const near = candidates.find((c) => Math.abs(c - currentIndex) <= 2)
        if (near !== undefined) index = near
        else if (candidates[0] !== undefined) index = candidates[0]
        currentIndex = index
      }

      const midi = snapToScale(scaleIndexToMidi(index, ctx.tonic, ctx.scale), ctx.tonic, ctx.scale)
      const accent = isStrong ? 0.1 : 0
      notes.push({
        start: ctx.startBeat + cursor,
        duration: duration * ctx.rng.float(0.86, 0.98),
        midi,
        velocity: Math.min(1, 0.6 + ctx.intensity * 0.25 + accent + ctx.rng.float(-0.05, 0.05)),
      })

      cursor += duration
      motifPos++
    }

    if (notes.length > phraseStartNote) {
      phrases.push({ start: phraseStartNote, end: notes.length })
      // Let the final note of a phrase ring into the rest.
      const last = notes[notes.length - 1]!
      last.duration = Math.min(last.duration + restBeats * 0.8, phraseBeats)
    }
  }

  return { notes, phrases }
}

/**
 * Basslines follow the chord roots with a genre-appropriate rhythm. Sub-heavy
 * genres get long sustained notes with slides; funk and house get syncopation.
 */
export function generateBass(ctx: MelodyContext): ScoreNote[] {
  const notes: ScoreNote[] = []
  const style = ctx.genre.drumStyle
  const sub = ['trap', 'drill', 'phonk'].includes(ctx.genre.id)
  const walking = ctx.genre.id === 'jazz' || ctx.genre.id === 'bossa'
  const octaveBase = sub ? 24 : 36

  for (let bar = 0; bar < ctx.bars; bar++) {
    const chord = ctx.chords[Math.min(ctx.chords.length - 1, bar)]!
    const rootPc = chord.bass ?? chord.root
    const barStart = ctx.startBeat + bar * ctx.beatsPerBar
    const rootMidi = octaveBase + (rootPc % 12) + (sub ? 12 : 12)

    if (walking) {
      // Quarter-note walking line through chord tones and passing notes.
      const targets = CHORD_INTERVALS[chord.quality].map((i) => rootMidi + i)
      for (let beat = 0; beat < ctx.beatsPerBar; beat++) {
        const pick = beat === 0 ? rootMidi : ctx.rng.pick(targets)
        const passing = beat === ctx.beatsPerBar - 1 && ctx.rng.chance(0.5) ? ctx.rng.pick([-1, 1]) : 0
        notes.push({
          start: barStart + beat,
          duration: 0.92,
          midi: snapOctave(pick + passing, 33, 55),
          velocity: 0.62 + (beat === 0 ? 0.12 : 0) + ctx.rng.float(-0.04, 0.04),
        })
      }
      continue
    }

    if (sub) {
      // 808: one long note per chord with a slide into the next bar.
      const length = ctx.beatsPerBar * (ctx.rng.chance(0.7) ? 1 : 0.75)
      notes.push({
        start: barStart,
        duration: length,
        midi: snapOctave(rootMidi, 24, 46),
        velocity: 0.9,
      })
      if (ctx.rng.chance(0.35) && ctx.beatsPerBar >= 4) {
        notes.push({
          start: barStart + ctx.beatsPerBar * 0.75,
          duration: ctx.beatsPerBar * 0.25,
          midi: snapOctave(rootMidi + ctx.rng.pick([5, 7, -2]), 24, 46),
          velocity: 0.78,
          legato: true,
        })
      }
      continue
    }

    const pattern = bassPattern(style, ctx.beatsPerBar, ctx.rng, ctx.intensity)
    for (const step of pattern) {
      const interval = step.tone === 'fifth' ? 7 : step.tone === 'octave' ? 12 : step.tone === 'third'
        ? (CHORD_INTERVALS[chord.quality][1] ?? 4)
        : 0
      notes.push({
        start: barStart + step.beat,
        duration: step.length,
        midi: snapOctave(rootMidi + interval, 30, 55),
        velocity: Math.min(1, step.velocity * (0.85 + ctx.intensity * 0.2)),
      })
    }
  }

  return notes
}

interface BassStep {
  beat: number
  length: number
  tone: 'root' | 'fifth' | 'octave' | 'third'
  velocity: number
}

function bassPattern(style: string, beatsPerBar: number, rng: Rng, intensity: number): BassStep[] {
  const root = (beat: number, length: number, velocity = 0.75): BassStep => ({ beat, length, tone: 'root', velocity })
  switch (style) {
    case 'fourFloor':
      return Array.from({ length: beatsPerBar }, (_v, i): BassStep => ({
        beat: i + 0.5, length: 0.45, tone: i % 2 === 1 ? 'octave' : 'root', velocity: 0.8,
      }))
    case 'disco': {
      const steps: BassStep[] = []
      for (let i = 0; i < beatsPerBar; i++) {
        steps.push({ beat: i, length: 0.4, tone: 'root', velocity: 0.8 })
        steps.push({ beat: i + 0.5, length: 0.4, tone: i % 2 === 0 ? 'octave' : 'fifth', velocity: 0.68 } satisfies BassStep)
      }
      return steps
    }
    case 'metal':
    case 'punk': {
      const steps: BassStep[] = []
      const div = intensity > 0.7 ? 0.25 : 0.5
      for (let b = 0; b < beatsPerBar; b += div) steps.push(root(b, div * 0.9, 0.8))
      return steps
    }
    case 'rock': {
      const steps: BassStep[] = [root(0, 1, 0.85), root(1.5, 0.5, 0.6), root(2, 1, 0.75), { beat: 3, length: 0.9, tone: 'fifth', velocity: 0.65 }]
      return steps.filter((s) => s.beat < beatsPerBar)
    }
    case 'reggaeton': {
      const steps: BassStep[] = [root(0, 0.9, 0.85), { beat: 1.5, length: 0.4, tone: 'fifth', velocity: 0.6 }, root(2, 0.9, 0.8), root(3.5, 0.4, 0.6)]
      return steps.filter((s) => s.beat < beatsPerBar)
    }
    case 'afrobeat': {
      const steps: BassStep[] = [root(0, 0.7, 0.85), root(1.5, 0.4, 0.6), { beat: 2.5, length: 0.5, tone: 'fifth', velocity: 0.7 }, root(3, 0.9, 0.75)]
      return steps.filter((s) => s.beat < beatsPerBar)
    }
    case 'dnb': {
      const steps: BassStep[] = [root(0, 1.4, 0.85), { beat: 2.5, length: 1.2, tone: 'fifth', velocity: 0.7 }]
      return steps.filter((s) => s.beat < beatsPerBar)
    }
    case 'waltz': {
      const steps: BassStep[] = [root(0, 0.9, 0.85), { beat: 1, length: 0.8, tone: 'fifth', velocity: 0.6 }, { beat: 2, length: 0.8, tone: 'octave', velocity: 0.55 }]
      return steps.filter((s) => s.beat < beatsPerBar)
    }
    case 'ambient':
    case 'none':
      return [root(0, beatsPerBar * 0.95, 0.6)]
    default: {
      const steps: BassStep[] = [root(0, 0.9, 0.85)]
      if (rng.chance(0.7)) steps.push(root(1.5, 0.45, 0.6))
      steps.push(root(2, 0.9, 0.78))
      if (rng.chance(0.5)) steps.push({ beat: 3.5, length: 0.45, tone: 'fifth', velocity: 0.6 })
      return steps.filter((s) => s.beat < beatsPerBar)
    }
  }
}

function snapOctave(midi: number, low: number, high: number): number {
  let value = Math.round(midi)
  while (value < low) value += 12
  while (value > high) value -= 12
  return value
}

/** Repeating arpeggio figure over the chord track. */
export function generateArp(ctx: MelodyContext, rate = 0.25): ScoreNote[] {
  const notes: ScoreNote[] = []
  const shape = ctx.rng.pick<'up' | 'down' | 'updown' | 'random'>(['up', 'up', 'updown', 'down', 'random'])
  const octaves = ctx.rng.pick([1, 1, 2])

  for (let bar = 0; bar < ctx.bars; bar++) {
    const chord = ctx.chords[Math.min(ctx.chords.length - 1, bar)]!
    const base = ctx.centerMidi - (ctx.centerMidi % 12) + chord.root
    const tones: number[] = []
    for (let o = 0; o < octaves; o++) {
      for (const interval of CHORD_INTERVALS[chord.quality]) tones.push(base + interval + o * 12)
    }
    const sequence = shape === 'down' ? tones.slice().reverse()
      : shape === 'updown' ? [...tones, ...tones.slice(1, -1).reverse()]
      : tones

    const stepsInBar = Math.round(ctx.beatsPerBar / rate)
    for (let step = 0; step < stepsInBar; step++) {
      const midi = shape === 'random'
        ? ctx.rng.pick(sequence)
        : sequence[step % sequence.length]!
      notes.push({
        start: ctx.startBeat + bar * ctx.beatsPerBar + step * rate,
        duration: rate * 0.9,
        midi: snapOctave(midi, ctx.centerMidi - 14, ctx.centerMidi + 18),
        velocity: 0.42 + (step % 4 === 0 ? 0.12 : 0) + ctx.rng.float(-0.04, 0.04),
      })
    }
  }
  return notes
}

/** Rhythmic chord comping, voiced by the caller. */
export interface CompStep {
  beat: number
  length: number
  velocity: number
}

export function compRhythm(genre: GenreDef, beatsPerBar: number, intensity: number, rng: Rng): CompStep[] {
  const style = genre.drumStyle
  const full = (): CompStep[] => [{ beat: 0, length: beatsPerBar * 0.95, velocity: 0.55 }]

  switch (style) {
    case 'fourFloor':
    case 'disco':
      return Array.from({ length: beatsPerBar }, (_v, i) => ({ beat: i + 0.5, length: 0.4, velocity: 0.5 }))
    case 'reggaeton':
      return [{ beat: 0.5, length: 0.4, velocity: 0.5 }, { beat: 1.5, length: 0.4, velocity: 0.45 }, { beat: 2.5, length: 0.4, velocity: 0.5 }, { beat: 3.5, length: 0.4, velocity: 0.45 }]
        .filter((s) => s.beat < beatsPerBar)
    case 'punk':
    case 'metal':
      return Array.from({ length: beatsPerBar * 2 }, (_v, i) => ({ beat: i * 0.5, length: 0.45, velocity: 0.6 }))
    case 'rock':
      return [{ beat: 0, length: 1.4, velocity: 0.6 }, { beat: 1.5, length: 0.9, velocity: 0.5 }, { beat: 2.5, length: 1.4, velocity: 0.55 }]
        .filter((s) => s.beat < beatsPerBar)
    case 'bossa':
      return [{ beat: 0, length: 0.9, velocity: 0.5 }, { beat: 1.5, length: 0.5, velocity: 0.42 }, { beat: 2.5, length: 0.9, velocity: 0.48 }]
        .filter((s) => s.beat < beatsPerBar)
    case 'jazzSwing':
      return [{ beat: 0, length: 1.4, velocity: 0.48 }, { beat: 2, length: 0.9, velocity: 0.42 }, { beat: 3.5, length: 0.5, velocity: 0.4 }]
        .filter((s) => s.beat < beatsPerBar)
    case 'ambient':
    case 'none':
      return full()
    default: {
      if (intensity < 0.4) return full()
      const steps: CompStep[] = [{ beat: 0, length: 1.4, velocity: 0.55 }]
      if (rng.chance(0.7)) steps.push({ beat: 1.5, length: 0.4, velocity: 0.45 })
      steps.push({ beat: 2, length: 1.2, velocity: 0.5 })
      if (rng.chance(0.5)) steps.push({ beat: 3.5, length: 0.4, velocity: 0.42 })
      return steps.filter((s) => s.beat < beatsPerBar)
    }
  }
}
