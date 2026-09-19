/**
 * A planned melody never claims two notes sound at once.
 *
 * The failure this pins: a phrase's trailing rest is sized to fill the
 * phrase's slot, but it is given at least `shape.breath` beats even when the
 * words have already used the slot up. The following phrase then begins at
 * `Math.round(beat)`, which rounds *down* when that overrun is under half a
 * beat — so a rest ending at 4.25 sat across a line starting at 4.
 *
 * The consequence was much worse than a quarter-beat of arithmetic. The melody
 * validator treats overlapping notes as an error, a melody with an error is
 * never sent, and a request with no target melody reaches the vocal pipeline
 * as "no target melody was sent, so nothing to measure against". The song
 * would have generated, the report would have said correction was impossible,
 * and nothing anywhere would have named a rest as the reason.
 *
 * It was found on the Tetap Memilihmu sheet, which produced it in seven
 * places. The sheets already in the suite produced it in none, which is why it
 * survived: the arithmetic works out on most lyrics.
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'
import { planLiveGeneration } from '../../src/engine/live/plan'
import { buildTargetMelody } from '../../src/engine/live/targetMelody'
import { checkTargetMelody } from '../../src/engine/live/melodyCheck'

const STYLE = 'Romantic melancholic pop ballad, 72 BPM, warm soulful vocal, intimate grand '
  + 'piano, soft acoustic guitar, tender strings, gentle bass, minimal percussion.'

/**
 * The sheet that exposed it, read from the fixture the real run sends.
 *
 * Not a shortened copy. An abridged version of this sheet was tried first and
 * it did not reproduce: the overlap depends on how these particular syllable
 * counts divide these particular section slots, so a paraphrase is a different
 * test that passes for a different reason. It passed with the fix removed,
 * which is the only reason this note exists.
 */
const TETAP = readFileSync(
  resolve(__dirname, '../../poc/zerogpu-space/fixtures/tetap-memilihmu-lyrics.txt'), 'utf8')

/** Sheets of different shapes, so the property is not pinned to one song. */
const SHEETS: { name: string; lyrics: string }[] = [
  { name: 'the Tetap Memilihmu sheet', lyrics: TETAP },
  {
    name: 'a sheet of very short lines',
    lyrics: '[Verse 1]\nSatu\nDua\nTiga\nEmpat\n\n[Chorus]\nLima\nEnam\n\n[End]\n',
  },
  {
    name: 'a sheet of very long lines',
    lyrics: '[Verse 1]\n'
      + 'Sebuah baris yang panjang sekali dan terus berjalan tanpa pernah berhenti '
      + 'sampai akhirnya selesai\n'
      + 'Baris kedua yang juga panjang dan penuh dengan suku kata yang banyak '
      + 'sekali jumlahnya\n\n[Chorus]\nPendek\n\n[End]\n',
  },
  {
    name: 'a sheet mixing long and short lines',
    lyrics: '[Verse 1]\nYa\nSebuah baris yang jauh lebih panjang daripada baris sebelumnya\n'
      + 'Tidak\nBaris lain yang panjangnya sedang saja\n\n[Chorus]\nAku\nKamu\n\n[End]\n',
  },
]

const GENDERS = ['male', 'female'] as const

describe('a planned melody is singable by one singer', () => {
  for (const sheet of SHEETS) {
    for (const vocalGender of GENDERS) {
      it(`has no overlapping notes: ${sheet.name}, ${vocalGender}`, () => {
        const plan = planLiveGeneration({
          style: STYLE, lyrics: sheet.lyrics, instrumental: false,
          vocalGender, language: 'auto', durationSeconds: 210,
        })
        const melody = buildTargetMelody(plan, vocalGender)
        const overlaps = melody.notes.slice(1).filter(
          (note, index) => note.startBeat
            < melody.notes[index]!.startBeat + melody.notes[index]!.durationBeats - 1e-6)
        expect(overlaps.map((note) => ({
          at: note.startBeat, section: note.sectionName, syllable: note.syllable,
        }))).toEqual([])
      })

      it(`every note is at least a sixteenth long: ${sheet.name}, ${vocalGender}`, () => {
        // Trimming a rest must not leave a sliver behind: a rest with no room
        // is dropped, never kept at zero beats, which would trip the duration
        // check instead of the overlap one and be no better.
        const plan = planLiveGeneration({
          style: STYLE, lyrics: sheet.lyrics, instrumental: false,
          vocalGender, language: 'auto', durationSeconds: 210,
        })
        const melody = buildTargetMelody(plan, vocalGender)
        const tooShort = melody.notes.filter((note) => note.durationBeats < 0.25 - 1e-9)
        expect(tooShort.map((note) => note.startBeat)).toEqual([])
      })

      it(`indices stay contiguous after trimming: ${sheet.name}, ${vocalGender}`, () => {
        const plan = planLiveGeneration({
          style: STYLE, lyrics: sheet.lyrics, instrumental: false,
          vocalGender, language: 'auto', durationSeconds: 210,
        })
        const melody = buildTargetMelody(plan, vocalGender)
        expect(melody.notes.map((note) => note.index))
          .toEqual(melody.notes.map((_, index) => index))
      })
    }
  }

  it('the Tetap Memilihmu sheet yields a melody the validator will send', () => {
    // The point of the fix, stated as the product outcome rather than the
    // arithmetic: this sheet must produce a melody that is actually sent.
    const plan = planLiveGeneration({
      style: STYLE, lyrics: TETAP, instrumental: false,
      vocalGender: 'male', language: 'auto', durationSeconds: 210,
    })
    const melody = buildTargetMelody(plan, 'male')
    const check = checkTargetMelody(melody)
    const errors = check.problems.filter((problem) => problem.severity === 'error')
    expect(errors.map((problem) => `${problem.code}: ${problem.message}`)).toEqual([])
    expect(check.usable).toBe(true)
    expect(melody.notes.length).toBeGreaterThan(0)
  })

  it('trimming only ever shortens silence, never a sung note', () => {
    // A sung note's start, length and pitch are the plan. If trimming could
    // touch one, the melody would no longer be the melody the planner wrote,
    // and every correction made against it would be against something else.
    const plan = planLiveGeneration({
      style: STYLE, lyrics: TETAP, instrumental: false,
      vocalGender: 'male', language: 'auto', durationSeconds: 210,
    })
    const melody = buildTargetMelody(plan, 'male')
    const sung = melody.notes.filter((note) => note.role !== 'rest')
    expect(sung.length).toBeGreaterThan(0)
    for (const note of sung) {
      expect(note.durationBeats).toBeGreaterThanOrEqual(0.25 - 1e-9)
      expect(note.midi).toBeGreaterThan(0)
      // A sung note's seconds must still agree with its beats.
      const secondsPerBeat = 60 / melody.bpm
      expect(note.endSeconds - note.startSeconds)
        .toBeCloseTo(note.durationBeats * secondsPerBeat, 6)
    }
  })

  it('the sheet the owner wrote is never edited by reading it', () => {
    // The compiler is free to build whatever internal representation it wants.
    // What it may not do is change the source. `script.original` is the sheet
    // as handed in, and it must come back byte for byte — trailing newline,
    // blank lines and the [End] marker included — or something in the reader
    // is quietly rewriting someone else's words.
    const plan = planLiveGeneration({
      style: STYLE, lyrics: TETAP, instrumental: false,
      vocalGender: 'male', language: 'auto', durationSeconds: 210,
    })
    expect(plan.lyrics.script.original).toBe(TETAP)
    expect(plan.lyrics.script.terminated).toBe(true)
    expect(plan.lyrics.script.terminator).toBe('[End]')
    // The terminator ends the reading, and nothing follows it in this sheet.
    expect(plan.lyrics.script.afterEnd.length).toBe(0)
    // And what is sent carries no end tag of any spelling.
    expect(plan.lyrics.text).not.toContain('[End]')
    for (const line of plan.lyrics.text.split('\n')) {
      expect(['[end]', '(end)']).not.toContain(line.trim().toLowerCase())
    }
  })

  it('a trimmed rest keeps its seconds consistent with its beats', () => {
    const plan = planLiveGeneration({
      style: STYLE, lyrics: TETAP, instrumental: false,
      vocalGender: 'male', language: 'auto', durationSeconds: 210,
    })
    const melody = buildTargetMelody(plan, 'male')
    const secondsPerBeat = 60 / melody.bpm
    for (const note of melody.notes.filter((candidate) => candidate.role === 'rest')) {
      expect(note.endSeconds - note.startSeconds)
        .toBeCloseTo(note.durationBeats * secondsPerBeat, 6)
    }
  })
})
