/**
 * Turning a composed score into evidence the gate can judge.
 *
 * This path is exact. The notes and the chords are the same object the renderer
 * plays, not an estimate taken off a recording, so there is no separation step
 * to fail and no pitch tracker to make an octave error. That is why its
 * confidence is 1.0 and why it is the only path in the browser that can reach
 * PASS: the offline engine can be held to this standard because the offline
 * engine's own working is visible.
 *
 * It is also the harder test of the two. A gate applied to a score the composer
 * wrote will find every place the composer wrote a melody against its own
 * chords, which is the point.
 */

import { SCALES, type PitchClass } from '../theory/pitch'
import { chordName, chordPitchClasses } from '../theory/chords'
import { harmonicScaleFor } from '../compose/harmony'
import type { Score } from '../compose/types'
import type { EvidenceResult, HarmonicRegion, VocalNote } from './types'

/** Track roles that carry a sung line. Harmony parts are judged too — they are heard. */
const SUNG_ROLES = new Set(['vocal', 'vocalHarmony'])

/** Chords, one region per bar, laid out on the same beat axis as the notes. */
export function regionsOf(score: Score): HarmonicRegion[] {
  const regions: HarmonicRegion[] = []
  for (const section of score.sections) {
    if (section.chords.length === 0) continue
    const barsInSection = Math.max(1, Math.round(section.lengthBeats / score.beatsPerBar))
    for (let bar = 0; bar < barsInSection; bar++) {
      // Clamped, not wrapped — `Math.min(chords.length - 1, bar)` is what the
      // melody writer, the chord track and the bass line all do, so a section
      // that runs longer than its progression holds the last chord rather than
      // starting it again. Wrapping here instead would put the gate's chords out
      // of step with the ones actually sounding, and a melody written correctly
      // against the real progression would be judged against a rotated one —
      // which is precisely the failure this gate exists to catch, arriving as a
      // false positive instead.
      const chord = section.chords[Math.min(section.chords.length - 1, bar)]!
      const startBeat = section.startBeat + bar * score.beatsPerBar
      regions.push({
        startBeat,
        endBeat: startBeat + score.beatsPerBar,
        root: chord.root,
        pitchClasses: chordPitchClasses(chord),
        name: chordName(chord),
      })
    }
  }
  return regions.sort((a, b) => a.startBeat - b.startBeat)
}

/** Every sung note in the score, in time order. */
export function sungNotes(score: Score): VocalNote[] {
  const notes: VocalNote[] = []
  for (const track of score.tracks) {
    if (!SUNG_ROLES.has(track.role)) continue
    for (const note of track.notes) {
      notes.push({
        startBeat: note.start,
        durationBeats: note.duration,
        midi: note.midi,
        velocity: note.velocity,
      })
    }
  }
  return notes.sort((a, b) => a.startBeat - b.startBeat)
}

/**
 * Evidence from a score, or a stated reason there is none.
 *
 * An instrumental has no vocal to judge, and saying so is not the same as
 * failing: there is no melody to be incompatible with anything.
 */
export function evidenceFromScore(score: Score): EvidenceResult {
  const notes = sungNotes(score)
  if (notes.length === 0) {
    return {
      available: false,
      reason: 'This take has no sung notes, so there is no vocal line to judge against the chords.',
    }
  }
  const regions = regionsOf(score)
  if (regions.length === 0) {
    return { available: false, reason: 'The score carries no chords, so there is nothing to judge the melody against.' }
  }

  const tonic = score.key.tonic
  // In-key is judged against the scale the *chords* are built from, not the one
  // the melody is drawn from, and for a gapped scale those differ.
  //
  // A blues or pentatonic song has a five-note melodic scale and seven-note
  // harmony: `fitChordsToMode` builds the chords from the harmonic parent,
  // because a pentatonic has degrees on which no triad exists. Judging
  // in-key-ness against the pentatonic then marks the parent's other two
  // degrees as outside the key — including notes that are chord tones of the
  // chord sounding at that moment. That failed seven of six hundred generated
  // songs on `strongOutOfKey` while every note was a chord tone or an accepted
  // tension and compatibility was 0.957.
  const harmonicScale = harmonicScaleFor(score.key.scale)
  const pitchClasses = SCALES[harmonicScale].map((step) => (((tonic + step) % 12) as PitchClass))

  return {
    available: true,
    source: 'score',
    // The notes and the chords are the same data the renderer plays. There is
    // no estimation anywhere in this path, so there is nothing to discount.
    confidence: 1,
    isolated: true,
    bpm: score.bpm,
    beatsPerBar: score.beatsPerBar,
    key: {
      tonic,
      scale: harmonicScale,
      pitchClasses,
      name: `${chordName({ root: tonic, quality: 'maj' })} ${score.key.scale}`,
    },
    regions,
    notes,
    limitations: [
      'Judged from the score the engine wrote, not from the rendered audio. It proves the '
      + 'melody fits the chords as written; it says nothing about the synthesis, the mix or '
      + 'how the voice sounds.',
    ],
  }
}
