/**
 * The composer: turns a song specification into a complete score — form,
 * harmony, drums, every instrumental part, and a vocal line with the lyrics
 * placed syllable-by-syllable onto its notes.
 */

import { Rng } from '../core/rng'
import { chordName, voiceChord, CHORD_INTERVALS } from '../theory/chords'
import { snapToScale } from '../theory/pitch'
import { buildForm, labelSlots, type FormSlot } from './arrangement'
import { generateDrums } from './drums'
import { generateArp, generateBass, generateMelody, compRhythm, type MelodyContext } from './melody'
import { planHarmony } from './harmony'
import { generateLyrics, type LyricSectionRequest } from '../lyrics/generator'
import { lineSyllables } from '../lyrics/syllables'
import type { SongSpec } from './prompt'
import type {
  InstrumentId, Score, ScoreNote, ScoreTrack, Section, SectionKind, TrackFx, TrackRole,
} from './types'

/** Section kinds that carry a sung or rapped line. */
const VOCAL_SECTIONS: SectionKind[] = ['verse', 'prechorus', 'chorus', 'bridge', 'drop', 'outro']

export interface ComposeOptions {
  /** Overrides the vocal register centre in MIDI (default 62 ≈ D4). */
  vocalCenterMidi?: number
}

export function composeSong(spec: SongSpec, options: ComposeOptions = {}): Score {
  const rng = new Rng(`${spec.seed}|compose`)
  const genre = spec.genre
  const beatsPerBar = genre.beatsPerBar

  const slots = buildForm(genre, spec.bpm, beatsPerBar, spec.durationSeconds, rng.fork('form'))
  const labels = labelSlots(slots)

  const slotStarts: number[] = []
  let cursor = 0
  for (const slot of slots) {
    slotStarts.push(cursor)
    cursor += slot.bars * beatsPerBar
  }
  const lengthBeats = cursor

  const harmony = planHarmony(slots, spec.key.tonic, spec.key.scale, genre, rng.fork('harmony'), spec.progressionId)

  const sections: Section[] = slots.map((slot, i) => ({
    kind: slot.kind,
    label: labels[i]!,
    startBeat: slotStarts[i]!,
    lengthBeats: slot.bars * beatsPerBar,
    chords: harmony.perSection[i]!,
    intensity: slot.intensity,
  }))

  const tracks: ScoreTrack[] = []
  const context = (slot: FormSlot, index: number, centerMidi: number, range: number): MelodyContext => ({
    chords: harmony.perSection[index]!,
    startBeat: slotStarts[index]!,
    bars: slot.bars,
    beatsPerBar,
    tonic: spec.key.tonic,
    scale: spec.key.scale,
    genre,
    intensity: slot.intensity,
    kind: slot.kind,
    rng: rng.fork(`sec${index}`),
    centerMidi,
    range,
  })

  // ---- Chords -------------------------------------------------------------
  const chordInstrument = rng.fork('inst').pick(genre.instruments.chords)
  const chordNotes: ScoreNote[] = []
  let previousVoicing: number[] | null = null
  for (let i = 0; i < slots.length; i++) {
    const slot = slots[i]!
    const chords = harmony.perSection[i]!
    const sectionRng = rng.fork(`comp${i}`)
    for (let bar = 0; bar < slot.bars; bar++) {
      const chord = chords[Math.min(chords.length - 1, bar)]!
      const voicing = voiceChord(chord, previousVoicing, 60, slot.intensity > 0.7 ? 4 : 3)
      previousVoicing = voicing
      const barStart = slotStarts[i]! + bar * beatsPerBar
      for (const step of compRhythm(genre, beatsPerBar, slot.intensity, sectionRng)) {
        for (const midi of voicing) {
          chordNotes.push({
            start: barStart + step.beat,
            duration: step.length,
            midi,
            velocity: Math.min(1, step.velocity * (0.8 + slot.intensity * 0.35)),
          })
        }
      }
    }
  }
  tracks.push(makeTrack('chords', 'Chords', 'chords', chordInstrument, chordNotes, {
    gainDb: -8, pan: rng.fork('pan1').float(-0.22, 0.22),
    fx: { reverbSend: 0.2 + genre.space * 0.2, delaySend: 0.05, sidechain: 0.25, drive: 0.1, highPassHz: 160 },
  }))

  // ---- Bass ---------------------------------------------------------------
  const bassInstrument = rng.fork('inst2').pick(genre.instruments.bass)
  const bassNotes: ScoreNote[] = []
  for (let i = 0; i < slots.length; i++) {
    const slot = slots[i]!
    if (slot.intensity < 0.3 && slot.kind === 'intro') continue
    bassNotes.push(...generateBass(context(slot, i, 40, 12)))
  }
  tracks.push(makeTrack('bass', 'Bass', 'bass', bassInstrument, bassNotes, {
    gainDb: -4, pan: 0,
    fx: { reverbSend: 0.02, delaySend: 0, sidechain: 0.55, drive: 0.18 },
  }))

  // ---- Pad ----------------------------------------------------------------
  const padInstrument = rng.fork('inst3').pick(genre.instruments.pad)
  const padNotes: ScoreNote[] = []
  for (let i = 0; i < slots.length; i++) {
    const slot = slots[i]!
    const chords = harmony.perSection[i]!
    let padVoicing: number[] | null = null
    for (let bar = 0; bar < slot.bars; bar++) {
      const chord = chords[Math.min(chords.length - 1, bar)]!
      padVoicing = voiceChord(chord, padVoicing, 64, 4)
      const barStart = slotStarts[i]! + bar * beatsPerBar
      for (const midi of padVoicing) {
        padNotes.push({
          start: barStart,
          duration: beatsPerBar * 0.98,
          midi,
          velocity: 0.3 + slot.intensity * 0.18,
        })
      }
    }
  }
  tracks.push(makeTrack('pad', 'Pad', 'pad', padInstrument, padNotes, {
    gainDb: -14, pan: 0,
    fx: { reverbSend: 0.4 + genre.space * 0.25, delaySend: 0.08, sidechain: 0.4, drive: 0, highPassHz: 220 },
  }))

  // ---- Arpeggio -----------------------------------------------------------
  const arpInstrument = rng.fork('inst4').pick(genre.instruments.arp)
  const arpNotes: ScoreNote[] = []
  const arpRate = genre.density > 0.65 ? 0.25 : 0.5
  for (let i = 0; i < slots.length; i++) {
    const slot = slots[i]!
    if (slot.intensity < 0.45) continue
    arpNotes.push(...generateArp(context(slot, i, 72, 12), arpRate))
  }
  if (arpNotes.length > 0) {
    tracks.push(makeTrack('arp', 'Arp', 'arp', arpInstrument, arpNotes, {
      gainDb: -16, pan: rng.fork('pan2').float(-0.5, 0.5),
      fx: { reverbSend: 0.28, delaySend: 0.22, sidechain: 0.35, drive: 0, highPassHz: 320 },
    }))
  }

  // ---- Vocals or lead melody ---------------------------------------------
  const hasVocals = spec.vocals !== 'none'
  const vocalCenter = options.vocalCenterMidi ?? (spec.vocals === 'rap' ? 55 : 62)
  const vocalRange = spec.vocals === 'rap' ? 7 : 14

  const leadSections: number[] = []
  const vocalSections: number[] = []
  for (let i = 0; i < slots.length; i++) {
    const slot = slots[i]!
    if (hasVocals && VOCAL_SECTIONS.includes(slot.kind) && slot.kind !== 'outro') {
      vocalSections.push(i)
    } else if (slot.intensity >= 0.45 || !hasVocals) {
      leadSections.push(i)
    }
  }

  const leadInstrument = rng.fork('inst5').pick(genre.instruments.lead)
  const leadNotes: ScoreNote[] = []
  for (const i of leadSections) {
    const slot = slots[i]!
    if (hasVocals && slot.kind !== 'solo' && slot.kind !== 'intro' && slot.kind !== 'outro' && slot.kind !== 'breakdown') continue
    leadNotes.push(...generateMelody(context(slot, i, 72, 16)).notes)
  }
  if (leadNotes.length > 0) {
    tracks.push(makeTrack('lead', 'Lead', 'lead', leadInstrument, leadNotes, {
      gainDb: hasVocals ? -14 : -7, pan: rng.fork('pan3').float(-0.2, 0.2),
      fx: { reverbSend: 0.25 + genre.space * 0.2, delaySend: 0.18, sidechain: 0.25, drive: 0.12, highPassHz: 200 },
    }))
  }

  // ---- Riff (guitar-driven genres) ---------------------------------------
  if (['rock', 'metal', 'punk', 'jpop', 'blues', 'disco'].includes(genre.id)) {
    const riffInstrument = rng.fork('inst6').pick(genre.instruments.riff)
    const riffNotes: ScoreNote[] = []
    for (let i = 0; i < slots.length; i++) {
      const slot = slots[i]!
      if (slot.intensity < 0.5) continue
      const ctx = context(slot, i, 52, 10)
      // A riff doubles the bass rhythm an octave up with chord thirds.
      for (const note of generateBass(ctx)) {
        riffNotes.push({ ...note, midi: note.midi + 12, velocity: note.velocity * 0.8 })
      }
    }
    if (riffNotes.length > 0) {
      tracks.push(makeTrack('riff', 'Riff', 'riff', riffInstrument, riffNotes, {
        gainDb: -11, pan: rng.fork('pan4').float(-0.6, 0.6),
        fx: { reverbSend: 0.14, delaySend: 0.05, sidechain: 0.2, drive: 0.4, highPassHz: 140 },
      }))
    }
  }

  const score: Score = {
    title: 'Untitled',
    bpm: spec.bpm,
    beatsPerBar,
    key: spec.key,
    lengthBeats,
    sections,
    tracks,
    drums: generateDrums({
      genre, beatsPerBar, slots, slotStarts, rng: rng.fork('drums'), energy: spec.energy,
    }),
    seed: spec.seed,
    genreId: genre.id,
  }

  if (hasVocals && vocalSections.length > 0) {
    attachVocals(score, spec, slots, vocalSections, context, vocalCenter, vocalRange, rng)
  } else {
    score.title = defaultTitle(spec, rng)
  }

  return score
}

type ContextFactory = (slot: FormSlot, index: number, centerMidi: number, range: number) => MelodyContext

/** Writes the vocal melody, generates lyrics to fit it, and places syllables. */
function attachVocals(
  score: Score,
  spec: SongSpec,
  slots: FormSlot[],
  vocalSections: number[],
  context: ContextFactory,
  centerMidi: number,
  range: number,
  rng: Rng,
): void {
  // 1. Write the melody first, so the lyrics can be measured against it.
  const perSection = new Map<number, { notes: ScoreNote[]; phrases: { start: number; end: number }[] }>()
  for (const i of vocalSections) {
    const slot = slots[i]!
    perSection.set(i, generateMelody(context(slot, i, centerMidi, range)))
  }

  // 2. Ask for one lyric line per melodic phrase, sized to its note count.
  const structure: LyricSectionRequest[] = []
  const sectionOrder: number[] = []
  for (const i of vocalSections) {
    const result = perSection.get(i)!
    if (result.phrases.length === 0) continue
    structure.push({
      kind: slots[i]!.kind,
      lines: result.phrases.length,
      syllableTargets: result.phrases.map((p) => p.end - p.start),
    })
    sectionOrder.push(i)
  }
  if (structure.length === 0) {
    score.title = defaultTitle(spec, rng)
    return
  }

  const lyrics = generateLyrics({
    theme: spec.theme,
    mood: spec.mood.id,
    style: spec.vocals === 'rap' ? 'rap' : 'sung',
    seed: spec.seed,
    structure,
  })

  // 3. Place syllables on notes, phrase by phrase.
  const linesBySection = new Map<number, string[]>()
  lyrics.lines.forEach((line) => {
    const sectionIndex = sectionOrder[line.sectionIndex]
    if (sectionIndex === undefined) return
    const list = linesBySection.get(sectionIndex)
    if (list) list.push(line.text)
    else linesBySection.set(sectionIndex, [line.text])
  })

  const vocalNotes: ScoreNote[] = []
  const harmonyNotes: ScoreNote[] = []

  for (const i of sectionOrder) {
    const result = perSection.get(i)!
    const lines = linesBySection.get(i) ?? []
    const slot = slots[i]!
    const placed: ScoreNote[] = []

    result.phrases.forEach((phrase, phraseIndex) => {
      const phraseNotes = result.notes.slice(phrase.start, phrase.end)
      const syllables = lineSyllables(lines[phraseIndex] ?? '')
      placed.push(...fitSyllablesToNotes(phraseNotes, syllables))
    })

    vocalNotes.push(...placed)

    // Choruses get a harmony a third or fifth above, inside the key.
    if (slot.intensity >= 0.8) {
      const interval = rng.fork(`harm${i}`).pick([3, 4, 7])
      for (const note of placed) {
        harmonyNotes.push({
          ...note,
          midi: snapToScale(note.midi + interval, score.key.tonic, score.key.scale),
          velocity: note.velocity * 0.55,
        })
      }
    }
  }

  const vocalInstrument: InstrumentId = 'vocal'
  score.tracks.push(makeTrack('vocal', 'Lead Vocal', 'vocal', vocalInstrument, vocalNotes, {
    gainDb: -3, pan: 0,
    fx: { reverbSend: score.genreId === 'ambient' ? 0.42 : 0.22, delaySend: 0.14, sidechain: 0.15, drive: 0.08, highPassHz: 110 },
  }))
  if (harmonyNotes.length > 0) {
    score.tracks.push(makeTrack('vocalHarmony', 'Vocal Harmony', 'vocalHarmony', vocalInstrument, harmonyNotes, {
      gainDb: -13, pan: 0.25,
      fx: { reverbSend: 0.34, delaySend: 0.16, sidechain: 0.15, drive: 0.05, highPassHz: 160 },
    }))
  }

  score.lyrics = lyrics
  score.title = lyrics.title
}

/**
 * Places a line's syllables on a phrase's notes. Extra syllables split the
 * notes they land on; spare notes are absorbed into the previous syllable so
 * the melody still runs its full length.
 */
export function fitSyllablesToNotes(notes: ScoreNote[], syllables: string[]): ScoreNote[] {
  if (notes.length === 0) return []
  if (syllables.length === 0) return notes.map((n) => ({ ...n }))

  const out: ScoreNote[] = []
  const noteCount = notes.length
  const syllableCount = syllables.length

  if (syllableCount === noteCount) {
    return notes.map((note, i) => ({ ...note, syllable: syllables[i] }))
  }

  if (syllableCount > noteCount) {
    // Split notes, giving the extra syllables to the longest notes first.
    const extras = syllableCount - noteCount
    const splitCounts = new Array(noteCount).fill(1)
    const order = notes
      .map((n, i) => ({ i, duration: n.duration }))
      .sort((a, b) => b.duration - a.duration)
    for (let e = 0; e < extras; e++) {
      const target = order[e % order.length]!.i
      splitCounts[target] += 1
    }
    let syllableIndex = 0
    for (let i = 0; i < noteCount; i++) {
      const note = notes[i]!
      const pieces = splitCounts[i]!
      const pieceDuration = note.duration / pieces
      for (let p = 0; p < pieces; p++) {
        out.push({
          ...note,
          start: note.start + p * pieceDuration,
          duration: pieceDuration * 0.96,
          syllable: syllables[syllableIndex++] ?? '',
          legato: p > 0,
        })
      }
    }
    return out
  }

  // Fewer syllables than notes: melisma — hold each syllable over the extras.
  const perSyllable = new Array(syllableCount).fill(1)
  for (let extra = 0; extra < noteCount - syllableCount; extra++) {
    perSyllable[extra % syllableCount] += 1
  }
  let noteIndex = 0
  for (let s = 0; s < syllableCount; s++) {
    const count = perSyllable[s]!
    for (let c = 0; c < count; c++) {
      const note = notes[noteIndex++]!
      out.push({ ...note, syllable: c === 0 ? syllables[s] : undefined, legato: c > 0 })
    }
  }
  return out
}

function makeTrack(
  id: string,
  name: string,
  role: TrackRole,
  instrument: InstrumentId,
  notes: ScoreNote[],
  options: { gainDb: number; pan: number; fx: TrackFx },
): ScoreTrack {
  return {
    id, name, role, instrument,
    notes: notes.sort((a, b) => a.start - b.start),
    gainDb: options.gainDb,
    pan: options.pan,
    fx: options.fx,
  }
}

function defaultTitle(spec: SongSpec, rng: Rng): string {
  const theme = spec.theme.trim()
  if (theme && theme.length <= 40 && theme.split(/\s+/).length <= 5) {
    return theme.charAt(0).toUpperCase() + theme.slice(1)
  }
  const adjectives = ['Distant', 'Golden', 'Electric', 'Quiet', 'Endless', 'Neon', 'Hollow', 'Silver', 'Restless']
  const nouns = ['Signal', 'Horizon', 'Machine', 'Current', 'Light', 'Motion', 'Static', 'Circuit', 'Tide']
  return `${rng.pick(adjectives)} ${rng.pick(nouns)}`
}

/** Human-readable chord chart, one entry per section. */
export function chordChart(score: Score): { label: string; chords: string[] }[] {
  return score.sections.map((section) => ({
    label: section.label,
    chords: section.chords.map(chordName),
  }))
}

/** Chord tones sounding at a given beat — used by the visualiser. */
export function chordAtBeat(score: Score, beat: number): string | null {
  for (const section of score.sections) {
    if (beat >= section.startBeat && beat < section.startBeat + section.lengthBeats) {
      const bar = Math.floor((beat - section.startBeat) / score.beatsPerBar)
      const chord = section.chords[Math.min(section.chords.length - 1, bar)]
      return chord ? chordName(chord) : null
    }
  }
  return null
}

export { CHORD_INTERVALS }
