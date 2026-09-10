/** The score model every generator writes into and the renderer reads from. */

import type { PitchClass, ScaleName } from '../theory/pitch'
import type { Chord } from '../theory/chords'

export type InstrumentId =
  | 'grandPiano' | 'electricPiano' | 'organ' | 'nylonGuitar' | 'cleanGuitar'
  | 'crunchGuitar' | 'distortedGuitar' | 'acousticBass' | 'electricBass'
  | 'subBass' | 'synthBass' | 'reeseBass' | 'sawLead' | 'squareLead' | 'pluck' | 'bell' | 'marimba' | 'warmPad' | 'glassPad'
  | 'choirPad' | 'strings' | 'brass' | 'flute' | 'violin' | 'cello'
  | 'harp' | 'sitar' | 'accordion' | 'chiptune' | 'noiseSweep' | 'vocal'

export type TrackRole =
  | 'lead' | 'harmony' | 'chords' | 'bass' | 'arp' | 'pad' | 'counter'
  | 'texture' | 'riff' | 'vocal' | 'vocalHarmony' | 'fx'

import type { Syllable } from '../voice/phonemes'
import type { LanguageId } from '../lang/types'

export interface ScoreNote {
  /** Onset in beats from the start of the song. */
  start: number
  /** Length in beats. */
  duration: number
  midi: number
  /** 0..1 */
  velocity: number
  /** Lyric syllable as written, when this note is sung. */
  syllable?: string
  /**
   * The sounds that syllable is made of.
   *
   * Carried on the note rather than worked out at render time because the
   * reading depends on the whole word — "ção" is only nasal because of where
   * it sits in "coração" — and the note has already lost that context.
   */
  sounds?: Syllable
  /** Slides from the previous note's pitch instead of re-attacking. */
  legato?: boolean
  /**
   * First note of a sung phrase — one lyric line per phrase. Recorded here
   * rather than re-derived from the gaps between notes, because a legato
   * phrase ending leaves no gap to find.
   */
  phraseStart?: boolean
}

export type DrumName =
  | 'kick' | 'snare' | 'clap' | 'rim' | 'hatClosed' | 'hatOpen' | 'hatPedal'
  | 'tomLow' | 'tomMid' | 'tomHigh' | 'crash' | 'ride' | 'shaker' | 'tambourine'
  | 'cowbell' | 'conga' | 'perc' | 'reverseCymbal' | 'sweepUp' | 'impact'

export interface DrumHit {
  start: number
  drum: DrumName
  velocity: number
  /** Note length in beats — only open hats and cymbals use it. */
  duration?: number
}

export interface TrackFx {
  reverbSend: number
  delaySend: number
  /** 0..1 — how hard the track ducks under the kick. */
  sidechain: number
  drive: number
  /** Low-shelf / high-shelf trims in dB, applied at mix time. */
  lowShelfDb?: number
  highShelfDb?: number
  /** High-pass corner in Hz — keeps the low end clear of everything but bass. */
  highPassHz?: number
  /**
   * Lift in dB around 3 kHz, where consonants live. It is what makes a lyric
   * legible over a busy arrangement rather than merely louder than it.
   */
  presenceDb?: number
  chorus?: number
}

export interface ScoreTrack {
  id: string
  name: string
  role: TrackRole
  instrument: InstrumentId
  notes: ScoreNote[]
  gainDb: number
  /** -1 (hard left) .. 1 (hard right) */
  pan: number
  fx: TrackFx
}

export type SectionKind =
  | 'intro' | 'verse' | 'prechorus' | 'chorus' | 'bridge' | 'solo'
  | 'drop' | 'breakdown' | 'outro'

export interface Section {
  kind: SectionKind
  /** Human label, e.g. "Verse 2". */
  label: string
  startBeat: number
  lengthBeats: number
  /** Chord per bar for this section. */
  chords: Chord[]
  /** 0..1 — drives arrangement density and mix automation. */
  intensity: number
}

export interface DrumTrack {
  hits: DrumHit[]
  /** 0..1 swing applied to off-beat 8ths at render time. */
  swing: number
  gainDb: number
}

export interface Score {
  title: string
  bpm: number
  beatsPerBar: number
  key: { tonic: PitchClass; scale: ScaleName }
  lengthBeats: number
  sections: Section[]
  tracks: ScoreTrack[]
  drums: DrumTrack
  /** Set when the song has sung vocals. */
  lyrics?: SongLyrics
  /** The language the lyrics are pronounced in. */
  language: LanguageId
  seed: string
  genreId: string
}

export interface LyricLine {
  text: string
  section: SectionKind
  /** Index of the section within `Score.sections`. */
  sectionIndex: number
}

export interface SongLyrics {
  title: string
  lines: LyricLine[]
  /** Rendered plain text with section headers, for display and download. */
  formatted: string
}

/** Display names for the instrument ids. */
export const INSTRUMENT_LABELS: Record<InstrumentId, string> = {
  grandPiano: 'Grand piano', electricPiano: 'Electric piano', organ: 'Organ',
  nylonGuitar: 'Nylon guitar', cleanGuitar: 'Clean guitar', crunchGuitar: 'Crunch guitar',
  distortedGuitar: 'Distorted guitar', acousticBass: 'Upright bass', electricBass: 'Electric bass',
  subBass: '808 sub bass', synthBass: 'Synth bass', reeseBass: 'Reese bass',
  sawLead: 'Saw lead', squareLead: 'Square lead', pluck: 'Pluck', bell: 'Bell',
  marimba: 'Marimba', warmPad: 'Warm pad', glassPad: 'Glass pad', choirPad: 'Choir',
  strings: 'Strings', brass: 'Brass', flute: 'Flute', violin: 'Violin', cello: 'Cello',
  harp: 'Harp', sitar: 'Sitar', accordion: 'Accordion', chiptune: 'Chiptune',
  noiseSweep: 'Noise sweep', vocal: 'Voice',
}

export function emptyFx(): TrackFx {
  return { reverbSend: 0.12, delaySend: 0, sidechain: 0, drive: 0 }
}

/** Total duration of a score in seconds. */
export function scoreDurationSeconds(score: Score): number {
  return (score.lengthBeats * 60) / score.bpm
}
