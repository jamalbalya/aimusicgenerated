/** Conversions shared by every audio and music module. */

export const SAMPLE_RATE = 44100

/** MIDI note number to frequency in Hz (A4 = note 69 = 440 Hz). */
export function midiToFreq(midi: number, a4 = 440): number {
  return a4 * Math.pow(2, (midi - 69) / 12)
}

/** Frequency in Hz back to a (fractional) MIDI note number. */
export function freqToMidi(freq: number, a4 = 440): number {
  if (freq <= 0) return 0
  return 69 + 12 * Math.log2(freq / a4)
}

/** Decibels to a linear amplitude multiplier. */
export function dbToGain(db: number): number {
  return Math.pow(10, db / 20)
}

/** Linear amplitude to decibels, floored at -120 dB to avoid -Infinity. */
export function gainToDb(gain: number): number {
  return 20 * Math.log10(Math.max(1e-6, Math.abs(gain)))
}

/** Beats to seconds at a given tempo. */
export function beatsToSeconds(beats: number, bpm: number): number {
  return (beats * 60) / bpm
}

export function secondsToBeats(seconds: number, bpm: number): number {
  return (seconds * bpm) / 60
}

export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

/** Formats seconds as m:ss (or h:mm:ss past an hour). */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0
  const total = Math.floor(seconds)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const pad = (n: number) => n.toString().padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`
}
