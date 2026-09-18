/**
 * The defect the quality gate found, pinned so it cannot come back.
 *
 * A genre's progression list is a list of idioms, not a list of keys. Applying
 * a major-key idiom in a minor key does not transpose it — numerals carrying an
 * explicit quality keep that quality — so `iim7 - V7 - iiim7 - vim7` in C minor
 * produced Dm7, G7, Ebm7 and Abm7, chords built on A, B, Gb, Db and Cb, none of
 * which are in C minor. Meanwhile the melody writer worked from the scale. The
 * result was a singer a semitone from the chord under them for most of the song
 * — the exact failure the gate exists to catch, arriving deterministically from
 * the composer rather than stochastically from a model.
 */

import { describe, expect, it } from 'vitest'
import { PROGRESSIONS, getProgression } from '../../src/engine/theory/progressions'
import { SCALES, isMinorScale, type PitchClass } from '../../src/engine/theory/pitch'
import { CHORD_INTERVALS, chordPitchClasses, parseRoman } from '../../src/engine/theory/chords'
import { buildSpec } from '../../src/engine/compose/prompt'
import { composeSong } from '../../src/engine/compose/composer'
import { evidenceFromScore } from '../../src/engine/quality'
import { fitChordsToMode, harmonicScaleFor } from '../../src/engine/compose/harmony'

describe('every progression declares the mode it is written in', () => {
  it('has a mode on all of them', () => {
    expect(PROGRESSIONS.length).toBeGreaterThan(20)
    for (const template of PROGRESSIONS) {
      expect(['major', 'minor', 'either']).toContain(template.mode)
    }
  })

  it('agrees with the case of its own tonic numeral', () => {
    for (const template of PROGRESSIONS) {
      if (template.mode === 'either') continue
      // The numeral the progression is built on says which mode it is in: "I"
      // is a major tonic, "i" a minor one. Anything else is a mislabelled
      // template, which is how the defect got in.
      // Exactly one i, not "ii" or "iv": the tonic numeral, not the second or
      // fourth degree, which carry their own case for their own reasons.
      const tonicNumeral = template.bars.find((bar) => /^[iI](?![iIvV])/.test(bar))
      if (!tonicNumeral) continue
      const written = /^[IV]+/.test(tonicNumeral) ? 'major' : 'minor'
      expect(`${template.id}:${template.mode}`).toBe(`${template.id}:${written}`)
    }
  })
})

describe('a progression in the key it was chosen for', () => {
  /**
   * Foreign chord tones produced by a numeral that *forces* a quality.
   *
   * Only suffix-carrying numerals are counted, because only those can go wrong
   * by transposition. Everything else is the writer being explicit:
   *
   *  - `bVII`, `bVI` are borrowings, written as borrowings.
   *  - Case is an instruction. `V` in a minor key is the harmonic-minor
   *    dominant, four hundred years old; `iv` in a major key is the gospel
   *    minor four, and the whole reason that progression exists.
   *  - `I7`, `IV7` are the twelve-bar blues, whose flat sevenths are the form.
   *
   * A suffix such as `m7` or `maj7` is different: it survives transposition
   * untouched, so a major-key turnaround keeps its major-key chords when it is
   * dropped into a minor key. That is what went wrong, and that is what this
   * counts.
   */
  function foreignTones(templateId: string, tonic: PitchClass, scale: 'major' | 'minor'): number {
    const template = getProgression(templateId)!
    const inScale = new Set(SCALES[scale].map((step) => ((tonic + step) % 12) as PitchClass))
    let foreign = 0
    for (const bar of template.bars) {
      if (/^(b|#)/.test(bar)) continue
      // Split, do not match a group: `/^[IViv]+(.+)$/` backtracks on "iv" and
      // hands back "v" as the suffix.
      const numeral = /^[IViv]+/.exec(bar)?.[0] ?? ''
      const suffix = bar.slice(numeral.length)
      if (!suffix || suffix === '7') continue
      for (const pc of chordPitchClasses(parseRoman(bar, tonic, scale))) {
        if (!inScale.has(pc)) foreign++
      }
    }
    return foreign
  }

  it('is the thing that went wrong: the lofi turnaround in a minor key', () => {
    // The original bug, stated as a number. It is not subtle.
    expect(foreignTones('lofi', 0, 'minor')).toBeGreaterThan(3)
    expect(foreignTones('lofi', 0, 'major')).toBe(0)
  })

  it('never happens once each template is used in its own mode', () => {
    for (const template of PROGRESSIONS) {
      if (template.mode === 'either') continue
      expect(`${template.id}:${foreignTones(template.id, 0, template.mode)}`)
        .toBe(`${template.id}:0`)
    }
  })
})

describe('the composer only reaches for progressions that fit the key', () => {
  const PROMPTS = [
    'lofi chill study music', 'dangdut koplo sarcastic workplace anthem',
    'dark trap beat', 'romantic melancholic jazz ballad', 'upbeat pop love song',
    'house music at 124', 'epic cinematic trailer', 'heavy metal guitar',
  ]

  it('never writes a chord on a degree outside the key it declared', () => {
    for (const prompt of PROMPTS) {
      for (const seed of ['a', 'b', 'c', 'd']) {
        const score = composeSong(buildSpec(prompt, { seed }))
        const minor = isMinorScale(score.key.scale)
        // Sections carry the chords the renderer plays. A tonic chord of the
        // wrong quality is the signature of a mismatched template.
        for (const section of score.sections) {
          for (const chord of section.chords) {
            if (chord.root !== score.key.tonic) continue
            // The chord's own third, from its quality — not any pitch class
            // that happens to be three or four semitones up, which would read a
            // slash chord's bass note as a third.
            const third = CHORD_INTERVALS[chord.quality].find((iv) => iv === 3 || iv === 4)
            if (third === undefined) continue
            expect(`${prompt}/${seed}: tonic third ${third}, minor=${minor}`)
              .toBe(`${prompt}/${seed}: tonic third ${minor ? 3 : 4}, minor=${minor}`)
          }
        }
      }
    }
  })

  it('leaves the melody in the same key as the chords', () => {
    // The measurable consequence: before the fix, generated songs sat around
    // 0.58-0.63 harmonic compatibility. Nothing should now be down there.
    for (const prompt of PROMPTS) {
      for (const seed of ['a', 'b', 'c']) {
        const score = composeSong(buildSpec(prompt, { seed }))
        const evidence = evidenceFromScore(score)
        if (!evidence.available) continue
        const outOfKey = evidence.notes.filter((note) => {
          const pc = ((Math.round(note.midi) % 12) + 12) % 12
          return !evidence.key.pitchClasses.includes(pc as PitchClass)
        })
        expect(`${prompt}/${seed}: ${outOfKey.length} sung notes outside the key`)
          .toBe(`${prompt}/${seed}: 0 sung notes outside the key`)
      }
    }
  })
})


describe('an inversion puts a chord tone in the bass', () => {
  it('never a note the chord does not contain', () => {
    // A fixed [3, 4, 7] list used to choose the bass whatever the chord was, so
    // a minor chord could be given a major third underneath it — G#m7/C, a C
    // natural a semitone below the chord's own B, in the most exposed voice in
    // the mix. Found by the quality gate, not by listening.
    for (const prompt of PROMPTS_FOR_INVERSIONS) {
      for (const seed of ['a', 'b', 'c', 'd', 'e']) {
        const score = composeSong(buildSpec(prompt, { seed }))
        for (const section of score.sections) {
          for (const chord of section.chords) {
            if (chord.bass === undefined) continue
            expect(`${prompt}/${seed} ${chord.bass} in ${chordPitchClasses(chord).join(',')}`)
              .toBe(`${prompt}/${seed} ${chord.bass} in ${chordPitchClasses(chord).join(',')}`)
            expect(chordPitchClasses(chord)).toContain(chord.bass)
          }
        }
      }
    }
  })
})

const PROMPTS_FOR_INVERSIONS = [
  'romantic melancholic jazz ballad', 'lofi chill study music', 'bossa nova',
  'rnb slow jam', 'gospel choir', 'house music at 124', 'disco groove',
]

describe('chords are pulled into the key in modes the numerals were not written for', () => {
  const EXOTIC = [
    'dangdut koplo sarcastic workplace anthem', 'romantic melancholic jazz ballad',
    'heavy metal guitar', 'lofi chill study music', 'epic cinematic trailer',
    'dark trap beat', 'synthwave night drive', 'bossa nova',
  ]

  it('leaves no chord tone outside the key, in any mode but major and natural minor', () => {
    // Roman numerals assume two things that only hold in major and natural
    // minor: case implies a quality, and an accidental measures from the
    // parallel major. In C dorian `bVI` builds on A flat while the sixth degree
    // is A natural, so the band played A flat under a melody singing A natural.
    // In A melodic minor the tonic seventh came out as Am7, a G natural in a key
    // whose seventh is G sharp. Every one was a sustained semitone between the
    // singer and the chord under them.
    for (const prompt of EXOTIC) {
      for (const seed of ['s0', 's1', 's2', 's3']) {
        const score = composeSong(buildSpec(prompt, { seed }))
        if (harmonicScaleFor(score.key.scale) === 'major'
          || harmonicScaleFor(score.key.scale) === 'minor') continue
        // Against the harmonic parent, because that is what the chords are
        // built from: a pentatonic melody over ordinary minor chords is how
        // this music is actually written, and every pentatonic note is in the
        // parent, so the melody still cannot clash with the harmony.
        const inScale = new Set(SCALES[harmonicScaleFor(score.key.scale)]
          .map((step) => ((score.key.tonic + step) % 12) as PitchClass))
        for (const section of score.sections) {
          for (const chord of section.chords) {
            const foreign = chordPitchClasses(chord).filter((pc) => !inScale.has(pc))
            expect(`${prompt}/${seed} ${score.key.scale}: ${foreign.length} foreign tones`)
              .toBe(`${prompt}/${seed} ${score.key.scale}: 0 foreign tones`)
          }
        }
      }
    }
  })

  it('leaves major and natural minor entirely alone', () => {
    // The borrowings there are deliberate and load-bearing: the raised leading
    // tone of a minor-key V is how minor keys have cadenced for four hundred
    // years, and fitting it to the scale would delete the cadence.
    const chords = [parseRoman('V', 0, 'minor')]
    const before = chordPitchClasses(chords[0]!).join(',')
    fitChordsToMode(chords, 0, 'minor')
    expect(chordPitchClasses(chords[0]!).join(',')).toBe(before)
    // B natural, the raised seventh, still there.
    expect(chordPitchClasses(chords[0]!)).toContain(11)
  })

  it('drops a seventh rather than keep a note the mode does not have', () => {
    // A melodic-minor tonic is min-maj7, which no quality in this library can
    // spell; the nearest is min7, whose flat seventh is exactly the note the
    // mode does not have. A triad is a voicing choice, a wrong note is a defect.
    const chords = [parseRoman('im7', 9, 'melodicMinor')]
    fitChordsToMode(chords, 9, 'melodicMinor')
    const inScale = new Set(SCALES.melodicMinor.map((step) => ((9 + step) % 12) as PitchClass))
    for (const pc of chordPitchClasses(chords[0]!)) expect(inScale.has(pc)).toBe(true)
  })
})
