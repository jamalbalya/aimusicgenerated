/**
 * Fixing the plan before anything is rendered.
 *
 * The quality gate used to run on a finished take, which meant a song that did
 * not fit its own chords cost a full render to discover and another to replace.
 * That is the wrong place for it. A score is not audio — it is a list of notes
 * and the chords underneath them — so whether the melody fits can be decided
 * before a single sample exists, and a note that does not fit can be moved.
 *
 * Moving it is composition, not regeneration. Nothing is generated again: the
 * rhythm, the phrasing, the syllable on each note, the lyric line it belongs to
 * and the contour of the line are all left exactly as written. The only thing
 * that changes is the pitch of a note that was wrong, and it changes to the
 * nearest note the chord actually contains.
 *
 * That distinction is the whole point of this file. A regeneration loop rolls
 * the dice again and hopes; this decides what the note should have been.
 */

import { SCALES, type PitchClass } from '../theory/pitch'
import { judgeNotes, regionsOf, evidenceFromScore, gateScoreTake } from '../quality'
import type { MusicalEvidence, NoteJudgement } from '../quality'
import type { Score, ScoreNote } from './types'

/** Track roles carrying a sung line. Harmony parts are heard, so they count. */
const SUNG_ROLES = new Set(['vocal', 'vocalHarmony'])

/**
 * How many times the repair is applied.
 *
 * Moving one note changes how its neighbours read: a note that was a passing
 * tone between two others may not be once one of them moves, and a conflict may
 * become an ordinary step. Three passes settles every score measured; the loop
 * stops early when a pass changes nothing, so the cost is one pass on a melody
 * that was already right.
 */
const MAX_PASSES = 3

/** What a repair did, so the studio can say so rather than quietly differ. */
export interface RepairReport {
  /** Notes whose pitch was moved. */
  movedNotes: number
  /** Total semitones of movement, so a large rewrite is visible as one. */
  totalSemitones: number
  /** How many passes it took. */
  passes: number
  /** Notes that were against the chord and could not be placed. */
  unresolved: number
}

/** The pitch classes a chord actually contains, as a set for quick lookup. */
function chordTones(pitchClasses: readonly PitchClass[]): Set<number> {
  return new Set(pitchClasses)
}

/**
 * The nearest pitch that belongs to the chord, preferring the direction the
 * line was already moving.
 *
 * Nearest matters more than it sounds: a melody is a shape, and moving a note
 * to the closest chord tone keeps the shape while fixing the note. Jumping it
 * to the root would fix the harmony and destroy the tune.
 */
function nearestChordTone(midi: number, tones: Set<number>, preferUp: boolean | null): number {
  const rounded = Math.round(midi)
  for (let distance = 1; distance <= 6; distance++) {
    const up = rounded + distance
    const down = rounded - distance
    const upFits = tones.has(((up % 12) + 12) % 12)
    const downFits = tones.has(((down % 12) + 12) % 12)
    if (upFits && downFits) return preferUp === false ? down : up
    if (upFits) return up
    if (downFits) return down
  }
  return rounded
}

/**
 * Which notes are worth moving.
 *
 * Only the ones a listener lands on. A passing tone, a neighbour note and a
 * suspension that resolves are how melodies are written, and "fixing" them
 * would flatten every line into arpeggios. What gets moved is a note that is
 * against the chord, unexplained by any figure, and either held or on a beat.
 */
function shouldMove(judgement: NoteJudgement, includeWeak: boolean): boolean {
  const unexplained = judgement.relation === 'conflict' || judgement.relation === 'chromatic'
  if (unexplained) return includeWeak || judgement.strong
  // Once escalating, a note the ear lands on that is outside the key is moved
  // even when its neighbours make it read as a passing tone. A line transposed
  // wholesale is full of perfectly-formed figures in the wrong key, and every
  // one of them is still a note nobody meant to sing.
  return includeWeak && judgement.strong && !judgement.inKey
}

function evidenceFor(score: Score): MusicalEvidence | null {
  const evidence = evidenceFromScore(score)
  return evidence.available ? evidence : null
}

/**
 * Repairs a score in place and reports what it did.
 *
 * In place, deliberately: the caller holds the score the renderer will play, and
 * handing back a copy invites the two to drift. Everything about each note
 * except its pitch survives — start, duration, velocity, the syllable, the
 * phonemes that syllable was resolved to, the phrase it opens and the lyric line
 * it carries — so the words still land on the same beats they were written for.
 */
export function repairMelody(score: Score): RepairReport {
  const report: RepairReport = { movedNotes: 0, totalSemitones: 0, passes: 0, unresolved: 0 }
  const sungTracks = score.tracks.filter((track) => SUNG_ROLES.has(track.role))
  if (sungTracks.length === 0) return report

  const regions = regionsOf(score)
  if (regions.length === 0) return report

  const tonic = score.key.tonic
  const inKey = new Set<number>(SCALES[score.key.scale].map((step) => (tonic + step) % 12))

  for (let pass = 0; pass < MAX_PASSES * 2; pass++) {
    // The first passes move only the notes a listener lands on, because a
    // passing tone and a neighbour are how melodies are written and flattening
    // them would turn every line into an arpeggio.
    //
    // Escalation exists for the case that does not fix: a melody transposed
    // wholesale keeps all its intervals, so every wrong note still reads as a
    // passing tone of the note beside it and the gentle pass moves nothing
    // while the song remains in the wrong key. When the song is still failing
    // after the gentle passes, the weak ones move too.
    const includeWeak = pass >= MAX_PASSES
    if (includeWeak && gateScoreTake(score).verdict === 'PASS') break
    const evidence = evidenceFor(score)
    if (!evidence) break
    const judgements = judgeNotes(evidence)

    // The gate sorts every sung note by time; so does this, so the two indices
    // line up. Rebuilt each pass because a moved note changes its neighbours.
    const notes: ScoreNote[] = []
    for (const track of sungTracks) notes.push(...track.notes)
    notes.sort((a, b) => a.start - b.start)

    let moved = 0
    for (let index = 0; index < judgements.length && index < notes.length; index++) {
      const judgement = judgements[index]!
      const note = notes[index]!
      if (!shouldMove(judgement, includeWeak)) continue

      const region = regions.find(
        (candidate) => note.start >= candidate.startBeat && note.start < candidate.endBeat)
      if (!region) continue

      // Keep the line moving the way it was moving.
      const previous = notes[index - 1]
      const next = notes[index + 1]
      const direction = previous && next
        ? (next.midi > previous.midi ? true : next.midi < previous.midi ? false : null)
        : null

      const tones = chordTones(region.pitchClasses)
      const target = nearestChordTone(note.midi, tones, direction)
      const distance = Math.abs(target - note.midi)
      if (distance === 0 || distance > 6) {
        report.unresolved++
        continue
      }
      // A repair that leaves the key is not a repair.
      if (!inKey.has(((target % 12) + 12) % 12) && !tones.has(((target % 12) + 12) % 12)) {
        report.unresolved++
        continue
      }
      note.midi = target
      report.totalSemitones += distance
      moved++
    }

    report.passes = pass + 1
    report.movedNotes += moved
    // Nothing moved and the gentle passes are done: either it is right, or the
    // weak pass is about to have its turn.
    if (moved === 0 && includeWeak) break
  }
  return report
}
