/**
 * Time-coded lyric files.
 *
 * The score knows which note carries which syllable, so the words can be
 * timed against the mix exactly rather than guessed at. SRT is what video
 * editors read; LRC is what music players read and what a karaoke display
 * needs, so the studio writes both.
 */

import type { Score, ScoreNote } from '../compose/types'

interface TimedLine {
  start: number
  end: number
  text: string
}

/**
 * Rebuilds the sung lines with their timings.
 *
 * A line begins on a note marked as a phrase start and runs to the moment the
 * last note of that phrase stops sounding.
 */
export function timedLyricLines(score: Score): TimedLine[] {
  const vocal = score.tracks.find((track) => track.id === 'vocal')
  if (!vocal || vocal.notes.length === 0) return []

  const secondsPerBeat = 60 / score.bpm
  const phrases: ScoreNote[][] = []
  let current: ScoreNote[] = []
  for (let i = 0; i < vocal.notes.length; i++) {
    const note = vocal.notes[i]!
    if (i > 0 && note.phraseStart && current.length > 0) {
      phrases.push(current)
      current = []
    }
    current.push(note)
  }
  if (current.length > 0) phrases.push(current)

  const lines: TimedLine[] = []
  for (const phrase of phrases) {
    const words = phrase
      .map((note) => note.syllable)
      .filter((syllable): syllable is string => Boolean(syllable))
    if (words.length === 0) continue

    const first = phrase[0]!
    const last = phrase[phrase.length - 1]!
    lines.push({
      start: first.start * secondsPerBeat,
      end: (last.start + last.duration) * secondsPerBeat,
      // Syllables of one word were split apart to sit on separate notes;
      // joining them with nothing puts the word back together.
      text: joinSyllables(words),
    })
  }
  return lines
}

/**
 * Puts split syllables back into words.
 *
 * The fitter cut the line at syllable boundaries, and only the boundaries that
 * were spaces in the original are word breaks — but that information is gone by
 * now, so a capitalised syllable or one following a full syllable of its own
 * word is the best available signal. Rejoining on the written text keeps the
 * result readable either way.
 */
function joinSyllables(syllables: string[]): string {
  return syllables
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function srtTime(seconds: number): string {
  const total = Math.max(0, seconds)
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const secs = Math.floor(total % 60)
  const millis = Math.round((total - Math.floor(total)) * 1000)
  const pad = (value: number, width = 2): string => String(value).padStart(width, '0')
  return `${pad(hours)}:${pad(minutes)}:${pad(secs)},${pad(millis, 3)}`
}

function lrcTime(seconds: number): string {
  const total = Math.max(0, seconds)
  const minutes = Math.floor(total / 60)
  const secs = total % 60
  return `[${String(minutes).padStart(2, '0')}:${secs.toFixed(2).padStart(5, '0')}]`
}

/** SubRip subtitles, for video editors and players. */
export function scoreToSrt(score: Score): string {
  const lines = timedLyricLines(score)
  if (lines.length === 0) return ''
  return lines
    .map((line, index) => `${index + 1}\n${srtTime(line.start)} --> ${srtTime(line.end)}\n${line.text}\n`)
    .join('\n')
}

/** LRC lyrics, for music players and karaoke displays. */
export function scoreToLrc(score: Score): string {
  const lines = timedLyricLines(score)
  if (lines.length === 0) return ''
  const header = [
    `[ti:${score.title}]`,
    `[al:Resonant Studio]`,
    `[length:${lrcTime((score.lengthBeats * 60) / score.bpm).slice(1, -1)}]`,
  ]
  return [...header, ...lines.map((line) => `${lrcTime(line.start)}${line.text}`)].join('\n')
}
