/**
 * Telling a song that ended from a song that was cut off.
 *
 * A real generation came back at exactly its requested length with the music
 * still playing at −21 dBFS, then digital silence 60 ms later, then two seconds
 * of nothing: a hard token budget had ended it mid-performance while the file
 * still ran to full length. Length alone could never have caught that, because
 * the length was right.
 *
 * What matters as much as catching it is leaving real endings alone. A fade, a
 * ring-out, a quiet outro and a track that simply ends at its last beat all
 * have to pass, or the warning becomes noise and gets ignored.
 */

import { describe, expect, it } from 'vitest'

import { checkWavBuffer } from '../../src/engine/providers/audioCheck'

const RATE = 8000

/** A 16-bit mono WAV whose level at each frame is given by `level(t)`, 0..1. */
function song(seconds: number, level: (t: number) => number): ArrayBuffer {
  const frames = Math.round(RATE * seconds)
  const buffer = new ArrayBuffer(44 + frames * 2)
  const view = new DataView(buffer)
  const ascii = (at: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(at + i, text.charCodeAt(i))
  }
  ascii(0, 'RIFF'); view.setUint32(4, 36 + frames * 2, true); ascii(8, 'WAVE')
  ascii(12, 'fmt '); view.setUint32(16, 16, true)
  view.setUint16(20, 1, true); view.setUint16(22, 1, true)
  view.setUint32(24, RATE, true); view.setUint32(28, RATE * 2, true)
  view.setUint16(32, 2, true); view.setUint16(34, 16, true)
  ascii(36, 'data'); view.setUint32(40, frames * 2, true)
  for (let i = 0; i < frames; i++) {
    const t = i / RATE
    // A tone, so every frame carries real signal at the level asked for.
    view.setInt16(44 + i * 2, Math.round(Math.sin(i / 3) * level(t) * 32767), true)
  }
  return buffer
}

const LENGTH = 30
/** Playing at a normal level; what every ending below is an ending of. */
const playing = 0.4

describe('a generation that was cut off', () => {
  it('is caught when full-level audio becomes silence and stays silent', () => {
    // The measured shape: playing, gone within 60 ms, two seconds of nothing.
    const cut = song(LENGTH, (t) => (t < LENGTH - 2.17 ? playing : 0))
    expect(checkWavBuffer(cut).endsAbruptly).toBe(true)
  })

  it('is caught even with the short de-click ramp a real cut has', () => {
    const at = LENGTH - 2.17
    const cut = song(LENGTH, (t) => {
      if (t < at) return playing
      if (t < at + 0.06) return playing * (1 - (t - at) / 0.06)
      return 0
    })
    expect(checkWavBuffer(cut).endsAbruptly).toBe(true)
  })
})

describe('songs that actually end', () => {
  it('leaves a fade-out alone', () => {
    // Three seconds from full level to nothing: the same distance the cut
    // covers in 60 ms, which is the whole difference between them.
    const fade = song(LENGTH, (t) => {
      const left = LENGTH - t
      return left > 3 ? playing : playing * (left / 3)
    })
    expect(checkWavBuffer(fade).endsAbruptly).toBeUndefined()
  })

  it('leaves a final chord ringing out alone', () => {
    // A struck chord decaying through the room, then a little silence after.
    const at = LENGTH - 2.5
    const ring = song(LENGTH, (t) => {
      if (t < at) return playing
      const since = t - at
      return since < 1.8 ? playing * Math.exp(-since * 2.2) : 0
    })
    expect(checkWavBuffer(ring).endsAbruptly).toBeUndefined()
  })

  it('leaves a quiet outro alone', () => {
    // It never gets loud on the way out, so there is no collapse to find.
    const quiet = song(LENGTH, (t) => {
      const left = LENGTH - t
      if (left > 6) return playing
      if (left > 1.5) return 0.02
      return 0
    })
    expect(checkWavBuffer(quiet).endsAbruptly).toBeUndefined()
  })

  it('leaves a song that simply stops at its last beat alone', () => {
    // Plays to the final sample. Nothing was truncated; there is no silence.
    const full = song(LENGTH, () => playing)
    expect(checkWavBuffer(full).endsAbruptly).toBeUndefined()
  })

  it('leaves a brief gap before a final hit alone', () => {
    // Silence in the tail, but not the end of the audio.
    const stab = song(LENGTH, (t) => {
      const left = LENGTH - t
      if (left > 1.2) return playing
      if (left > 0.5) return 0
      return playing
    })
    expect(checkWavBuffer(stab).endsAbruptly).toBeUndefined()
  })

  it('does not flag a fade that happens to finish early', () => {
    // Faded out properly, then half a second of silence: still an ending.
    const at = LENGTH - 3
    const fade = song(LENGTH, (t) => {
      if (t < at) return playing
      const since = t - at
      return since < 2.5 ? playing * (1 - since / 2.5) : 0
    })
    expect(checkWavBuffer(fade).endsAbruptly).toBeUndefined()
  })
})

describe('what it refuses to guess about', () => {
  it('says nothing either way about audio it could not parse', () => {
    // An MP3 is passed through unmeasured, so no ending claim is made.
    const notWav = new Uint8Array(2048)
    notWav.set([0x49, 0x44, 0x33])
    expect(checkWavBuffer(notWav.buffer).endsAbruptly).toBeUndefined()
  })

  it('says nothing about a file that is silent throughout', () => {
    // Already refused for being silent; there is no ending to judge.
    const silence = song(LENGTH, () => 0)
    const check = checkWavBuffer(silence)
    expect(check.valid).toBe(false)
    expect(check.endsAbruptly).toBeUndefined()
  })
})
