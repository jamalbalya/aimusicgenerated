/**
 * Standard MIDI file export.
 *
 * The score already knows every note, its pitch, its place and how hard it is
 * played, so the studio can hand the whole arrangement to a DAW rather than
 * only a finished mix. One track per part, drums on the percussion channel,
 * and the tempo and key written into the file so it opens in the right place.
 */

import type { DrumName, InstrumentId, Score, ScoreNote } from '../compose/types'

/** Ticks per quarter note. 480 divides cleanly by 2, 3, 4, 5, 6 and 8. */
const TICKS_PER_BEAT = 480

/** General MIDI programme numbers, as close as the standard set gets. */
const PROGRAMS: Record<InstrumentId, number> = {
  grandPiano: 0, electricPiano: 4, organ: 16,
  nylonGuitar: 24, cleanGuitar: 27, crunchGuitar: 29, distortedGuitar: 30,
  acousticBass: 32, electricBass: 33, subBass: 39, synthBass: 38, reeseBass: 38,
  sawLead: 81, squareLead: 80, pluck: 84, bell: 14, marimba: 12,
  warmPad: 89, glassPad: 88, choirPad: 52, strings: 48, brass: 61,
  flute: 73, violin: 40, cello: 42, harp: 46, sitar: 104, accordion: 21,
  chiptune: 80, noiseSweep: 122, vocal: 53,
}

/** Where each drum sits on the General MIDI percussion map. */
const DRUM_NOTES: Record<DrumName, number> = {
  kick: 36, snare: 38, clap: 39, rim: 37,
  hatClosed: 42, hatOpen: 46, hatPedal: 44,
  tomLow: 41, tomMid: 47, tomHigh: 50,
  crash: 49, ride: 51, shaker: 70, tambourine: 54,
  cowbell: 56, conga: 63, perc: 76,
  reverseCymbal: 52, sweepUp: 55, impact: 57,
}

/** MIDI writes note lengths as delta times, which are base-128 big-endian. */
function variableLength(value: number): number[] {
  const bytes = [value & 0x7f]
  let rest = value >> 7
  while (rest > 0) {
    bytes.unshift((rest & 0x7f) | 0x80)
    rest >>= 7
  }
  return bytes
}

function text(value: string): number[] {
  const bytes: number[] = []
  for (const character of value) {
    const code = character.codePointAt(0)!
    if (code < 128) bytes.push(code)
  }
  return bytes
}

interface Event {
  tick: number
  /** Note-offs sort before note-ons at the same tick, so a repeated note retriggers. */
  order: number
  data: number[]
}

function chunk(type: string, body: number[]): number[] {
  const length = body.length
  return [
    ...text(type),
    (length >> 24) & 0xff, (length >> 16) & 0xff, (length >> 8) & 0xff, length & 0xff,
    ...body,
  ]
}

function trackChunk(name: string, events: Event[], extra: number[] = []): number[] {
  const ordered = events.slice().sort((a, b) => (a.tick - b.tick) || (a.order - b.order))
  const body: number[] = [
    ...variableLength(0), 0xff, 0x03, ...variableLength(text(name).length), ...text(name),
    ...extra,
  ]
  let previous = 0
  for (const event of ordered) {
    body.push(...variableLength(event.tick - previous), ...event.data)
    previous = event.tick
  }
  body.push(...variableLength(0), 0xff, 0x2f, 0x00)
  return chunk('MTrk', body)
}

function noteEvents(notes: ScoreNote[], channel: number, pitchOf: (note: ScoreNote) => number): Event[] {
  const events: Event[] = []
  for (const note of notes) {
    const pitch = Math.max(0, Math.min(127, Math.round(pitchOf(note))))
    const velocity = Math.max(1, Math.min(127, Math.round(note.velocity * 127)))
    const start = Math.round(note.start * TICKS_PER_BEAT)
    // Every note needs to last at least one tick, or it never sounds.
    const end = Math.max(start + 1, Math.round((note.start + note.duration) * TICKS_PER_BEAT))
    events.push({ tick: start, order: 1, data: [0x90 | channel, pitch, velocity] })
    events.push({ tick: end, order: 0, data: [0x80 | channel, pitch, 0] })
  }
  return events
}

/** The whole arrangement as a type 1 standard MIDI file. */
export function scoreToMidi(score: Score): Uint8Array {
  const microsecondsPerBeat = Math.round(60_000_000 / score.bpm)
  const tempoTrack = trackChunk(score.title, [], [
    ...variableLength(0), 0xff, 0x51, 0x03,
    (microsecondsPerBeat >> 16) & 0xff, (microsecondsPerBeat >> 8) & 0xff, microsecondsPerBeat & 0xff,
    // Time signature: n/4, 24 clocks per beat, 8 demisemiquavers per beat.
    ...variableLength(0), 0xff, 0x58, 0x04, score.beatsPerBar, 0x02, 0x18, 0x08,
  ])

  const tracks: number[][] = [tempoTrack]
  // Channel 9 is reserved for percussion, so the pitched parts skip it.
  let channel = 0
  const nextChannel = (): number => {
    if (channel === 9) channel = 10
    const used = channel
    channel = Math.min(15, channel + 1)
    return Math.min(15, used)
  }

  for (const track of score.tracks) {
    if (track.notes.length === 0) continue
    const c = nextChannel()
    const program = PROGRAMS[track.instrument] ?? 0
    tracks.push(trackChunk(track.name, noteEvents(track.notes, c, (note) => note.midi), [
      ...variableLength(0), 0xc0 | c, program,
    ]))
  }

  if (score.drums.hits.length > 0) {
    const events: Event[] = []
    for (const hit of score.drums.hits) {
      const pitch = DRUM_NOTES[hit.drum] ?? 39
      const velocity = Math.max(1, Math.min(127, Math.round(hit.velocity * 127)))
      const start = Math.round(hit.start * TICKS_PER_BEAT)
      const end = start + Math.max(1, Math.round((hit.duration ?? 0.25) * TICKS_PER_BEAT))
      events.push({ tick: start, order: 1, data: [0x99, pitch, velocity] })
      events.push({ tick: end, order: 0, data: [0x89, pitch, 0] })
    }
    tracks.push(trackChunk('Drums', events))
  }

  const header = chunk('MThd', [
    0x00, 0x01,
    (tracks.length >> 8) & 0xff, tracks.length & 0xff,
    (TICKS_PER_BEAT >> 8) & 0xff, TICKS_PER_BEAT & 0xff,
  ])

  const bytes = [...header, ...tracks.flat()]
  return new Uint8Array(bytes)
}
