/** Note names, scales and modes. */

export const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const
export const FLAT_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'] as const

export type PitchClass = number // 0..11, C = 0

const NAME_TO_PC: Record<string, number> = {
  c: 0, 'c#': 1, db: 1, d: 2, 'd#': 3, eb: 3, e: 4, fb: 4, 'e#': 5,
  f: 5, 'f#': 6, gb: 6, g: 7, 'g#': 8, ab: 8, a: 9, 'a#': 10, bb: 10, b: 11, cb: 11,
}

/** Parses "C", "F#", "Bb", "Eb3" into a pitch class 0..11. Returns null if unparseable. */
export function parsePitchClass(name: string): PitchClass | null {
  const match = /^([a-gA-G])([#b]?)/.exec(name.trim())
  if (!match) return null
  const key = (match[1]! + match[2]!).toLowerCase()
  const pc = NAME_TO_PC[key]
  return pc === undefined ? null : pc
}

/** Human-readable name for a MIDI note, e.g. 60 -> "C4". */
export function midiToName(midi: number, useFlats = false): string {
  const rounded = Math.round(midi)
  const pc = ((rounded % 12) + 12) % 12
  const octave = Math.floor(rounded / 12) - 1
  const names = useFlats ? FLAT_NAMES : NOTE_NAMES
  return `${names[pc]}${octave}`
}

/** Semitone offsets from the tonic for every supported scale. */
export const SCALES = {
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
  harmonicMinor: [0, 2, 3, 5, 7, 8, 11],
  melodicMinor: [0, 2, 3, 5, 7, 9, 11],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  phrygian: [0, 1, 3, 5, 7, 8, 10],
  lydian: [0, 2, 4, 6, 7, 9, 11],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
  locrian: [0, 1, 3, 5, 6, 8, 10],
  majorPentatonic: [0, 2, 4, 7, 9],
  minorPentatonic: [0, 3, 5, 7, 10],
  blues: [0, 3, 5, 6, 7, 10],
  phrygianDominant: [0, 1, 4, 5, 7, 8, 10],
  wholeTone: [0, 2, 4, 6, 8, 10],
  japanese: [0, 1, 5, 7, 8],
} as const

export type ScaleName = keyof typeof SCALES

export const SCALE_NAMES = Object.keys(SCALES) as ScaleName[]

/** Is `scale` one of the minor-flavoured scales? Used for mood decisions. */
export function isMinorScale(scale: ScaleName): boolean {
  return SCALES[scale][2] === 3
}

/** Absolute MIDI notes of a scale across a range, ascending. */
export function scaleNotes(tonic: PitchClass, scale: ScaleName, lowMidi: number, highMidi: number): number[] {
  const steps = SCALES[scale]
  const out: number[] = []
  const startOctave = Math.floor(lowMidi / 12) - 1
  for (let octave = startOctave; octave <= Math.floor(highMidi / 12) + 1; octave++) {
    for (const step of steps) {
      const midi = (octave + 1) * 12 + tonic + step
      if (midi >= lowMidi && midi <= highMidi) out.push(midi)
    }
  }
  return out.sort((a, b) => a - b)
}

/** True when the MIDI note belongs to the scale, ignoring octave. */
export function inScale(midi: number, tonic: PitchClass, scale: ScaleName): boolean {
  const rel = (((Math.round(midi) - tonic) % 12) + 12) % 12
  return (SCALES[scale] as readonly number[]).includes(rel)
}

/**
 * Moves a note to the nearest scale tone. Ties resolve upward, which keeps
 * melodies from drifting flat when they are repeatedly quantised.
 */
export function snapToScale(midi: number, tonic: PitchClass, scale: ScaleName): number {
  const rounded = Math.round(midi)
  if (inScale(rounded, tonic, scale)) return rounded
  for (let distance = 1; distance <= 6; distance++) {
    if (inScale(rounded + distance, tonic, scale)) return rounded + distance
    if (inScale(rounded - distance, tonic, scale)) return rounded - distance
  }
  return rounded
}

/**
 * Index of a MIDI note within the scale, counted in scale degrees from the
 * tonic at octave -1. Lets melodies move "three steps up" rather than in
 * semitones, which is what keeps generated lines diatonic.
 */
export function midiToScaleIndex(midi: number, tonic: PitchClass, scale: ScaleName): number {
  const steps = SCALES[scale] as readonly number[]
  const snapped = snapToScale(midi, tonic, scale)
  const rel = snapped - tonic
  const octave = Math.floor(rel / 12)
  const within = ((rel % 12) + 12) % 12
  const degree = steps.indexOf(within)
  return octave * steps.length + (degree >= 0 ? degree : 0)
}

/** Inverse of {@link midiToScaleIndex}. */
export function scaleIndexToMidi(index: number, tonic: PitchClass, scale: ScaleName): number {
  const steps = SCALES[scale] as readonly number[]
  const len = steps.length
  const octave = Math.floor(index / len)
  const degree = ((index % len) + len) % len
  return tonic + octave * 12 + steps[degree]!
}
