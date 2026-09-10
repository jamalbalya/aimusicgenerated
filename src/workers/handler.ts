/**
 * Every expensive job the studio can run, as plain functions.
 *
 * This module deliberately knows nothing about workers. The worker is a thin
 * wrapper around it, and when a worker cannot be created — a strict content
 * policy, an unusual embedded browser — the same code runs on the main thread
 * instead. One implementation, two ways to reach it.
 */

import { buildSpec } from '../engine/compose/prompt'
import { composeSong, fitSyllablesToNotes } from '../engine/compose/composer'
import { renderScore } from '../engine/synth/render'
import { SING_PRESETS } from '../engine/voice/singer'
import { generateLyrics } from '../engine/lyrics/generator'
import { lineSyllables } from '../engine/lyrics/syllables'
import { separateStems, splitVocals } from '../engine/audio/separate'
import { pitchShiftAudio, timeStretchAudio, varispeed } from '../engine/audio/pitchshift'
import { detectKey, detectTempo, measureLoudness } from '../engine/audio/analyze'
import { synthesizeSpeech } from '../engine/voice/speech'
import {
  applyChorus, applyCompression, applyDistortion, applyEcho, applyLimiter, applyReverb,
  equalize, fade, gain, mixDown, normalizeLoudness, normalizePeak, reduceNoise, reverse, trim,
} from '../engine/audio/effects'
import {
  QUALITY_SAMPLE_RATES,
  type ProcessOp, type TransferAudio, type WorkerRequest, type WorkerResult,
} from './protocol'
import type { AudioData } from '../engine/audio/wav'
import type { Score, ScoreNote } from '../engine/compose/types'

export type ProgressReporter = (progress: number, stage: string) => void

/** Set for the duration of a job, so the helpers below can report progress. */
let reportProgress: ProgressReporter = () => {}

function progress(_id: number, value: number, stage: string): void {
  reportProgress(Math.max(0, Math.min(1, value)), stage)
}

function toAudioData(audio: TransferAudio): AudioData {
  return { channels: audio.channels, sampleRate: audio.sampleRate }
}

function toTransfer(audio: AudioData): TransferAudio {
  return { channels: audio.channels, sampleRate: audio.sampleRate }
}

function applyOps(audio: AudioData, ops: ProcessOp[], id: number): AudioData {
  let current = audio
  ops.forEach((op, index) => {
    progress(id, index / Math.max(1, ops.length), describeOp(op))
    current = applyOp(current, op)
  })
  return current
}

function describeOp(op: ProcessOp): string {
  const labels: Record<ProcessOp['op'], string> = {
    pitch: 'Shifting pitch', tempo: 'Stretching time', varispeed: 'Changing speed',
    trim: 'Trimming', fade: 'Fading', reverse: 'Reversing', gain: 'Adjusting level',
    normalize: 'Normalising loudness', normalizePeak: 'Normalising peaks',
    reverb: 'Adding reverb', echo: 'Adding echo', chorus: 'Adding chorus',
    distortion: 'Adding drive', compress: 'Compressing', limit: 'Limiting',
    denoise: 'Reducing noise', eq: 'Equalising', telephone: 'Applying telephone',
    megaphone: 'Applying megaphone', radio: 'Applying radio',
  }
  return labels[op.op]
}

function applyOp(audio: AudioData, op: ProcessOp): AudioData {
  switch (op.op) {
    case 'pitch':
      return pitchShiftAudio(audio, {
        semitones: op.semitones,
        preserveFormants: op.preserveFormants,
        formantSemitones: op.formantSemitones,
      })
    case 'tempo':
      return timeStretchAudio(audio, op.ratio)
    case 'varispeed':
      return varispeed(audio, op.ratio)
    case 'trim':
      return trim(audio, op.startSeconds, op.endSeconds)
    case 'fade':
      return fade(audio, op.inSeconds, op.outSeconds)
    case 'reverse':
      return reverse(audio)
    case 'gain':
      return gain(audio, op.db)
    case 'normalize':
      return normalizeLoudness(audio, op.targetLufs)
    case 'normalizePeak':
      return normalizePeak(audio, op.targetDb)
    case 'reverb':
      return applyReverb(audio, { size: op.size, damping: op.damping, mix: op.mix })
    case 'echo':
      return applyEcho(audio, { delaySeconds: op.delaySeconds, feedback: op.feedback, mix: op.mix })
    case 'chorus':
      return applyChorus(audio, op.depth, op.mix)
    case 'distortion':
      return applyDistortion(audio, op.amount)
    case 'compress':
      return applyCompression(audio, {
        thresholdDb: op.thresholdDb, ratio: op.ratio, attackMs: 8, releaseMs: 120, makeupDb: op.makeupDb,
      })
    case 'limit':
      return applyLimiter(audio, op.ceiling)
    case 'denoise':
      return reduceNoise(audio, op.strength)
    case 'eq':
      return equalize(audio, [
        { type: 'lowShelf', freq: 200, gainDb: op.lowDb },
        { type: 'peaking', freq: 1200, q: 0.9, gainDb: op.midDb },
        { type: 'highShelf', freq: 5000, gainDb: op.highDb },
      ])
    case 'telephone':
      return equalize(audio, [
        { type: 'highPass', freq: 500, q: 0.8 },
        { type: 'lowPass', freq: 3000, q: 0.8 },
        { type: 'peaking', freq: 1500, q: 1.4, gainDb: 6 },
      ])
    case 'megaphone':
      return applyDistortion(
        equalize(audio, [
          { type: 'highPass', freq: 400, q: 0.9 },
          { type: 'lowPass', freq: 4000, q: 0.9 },
          { type: 'peaking', freq: 2000, q: 2, gainDb: 9 },
        ]),
        0.55,
      )
    case 'radio':
      return equalize(applyDistortion(audio, 0.2), [
        { type: 'highPass', freq: 300, q: 0.7 },
        { type: 'lowPass', freq: 5000, q: 0.7 },
        { type: 'peaking', freq: 900, q: 1.1, gainDb: 4 },
      ])
  }
}

function handle(id: number, request: WorkerRequest): WorkerResult {
  switch (request.kind) {
    case 'generate': {
      progress(id, 0.02, 'Writing the arrangement')
      const spec = buildSpec(request.prompt, request.overrides)
      const score = composeSong(spec)
      progress(id, 0.08, 'Rendering audio')
      const sampleRate = QUALITY_SAMPLE_RATES[request.quality]
      const rendered = renderScore(score, {
        sampleRate,
        keepStems: request.keepStems,
        singStyle: request.singStylePreset ? SING_PRESETS[request.singStylePreset] : undefined,
        onProgress: (value) => progress(id, 0.08 + value * 0.9, 'Rendering audio'),
      })
      return {
        kind: 'generate',
        score,
        audio: { channels: [rendered.left, rendered.right], sampleRate },
        stems: (rendered.stems ?? []).map((stem) => ({
          id: stem.id,
          name: stem.name,
          audio: { channels: [stem.left, stem.right], sampleRate },
        })),
        loudnessDb: rendered.loudnessDb,
        peak: rendered.peak,
      }
    }

    case 'rerender': {
      const sampleRate = QUALITY_SAMPLE_RATES[request.quality]
      const rendered = renderScore(request.score, {
        sampleRate,
        keepStems: request.keepStems ?? false,
        excludeTrackIds: request.excludeTrackIds,
        includeDrums: request.includeDrums,
        singStyle: request.singStylePreset ? SING_PRESETS[request.singStylePreset] : undefined,
        onProgress: (value) => progress(id, value, 'Rendering audio'),
      })
      return {
        kind: 'generate',
        score: request.score,
        audio: { channels: [rendered.left, rendered.right], sampleRate },
        stems: (rendered.stems ?? []).map((stem) => ({
          id: stem.id,
          name: stem.name,
          audio: { channels: [stem.left, stem.right], sampleRate },
        })),
        loudnessDb: rendered.loudnessDb,
        peak: rendered.peak,
      }
    }

    case 'lyrics':
      progress(id, 0.5, 'Writing lyrics')
      return { kind: 'lyrics', lyrics: generateLyrics(request.request) }

    case 'separate': {
      const audio = toAudioData(request.audio)
      if (request.mode === 'vocals') {
        const result = splitVocals(audio, {
          strength: request.strength,
          onProgress: (value, stage) => progress(id, value, stage),
        })
        return {
          kind: 'separate',
          stems: [
            { name: 'vocals', audio: toTransfer(result.vocals) },
            { name: 'instrumental', audio: toTransfer(result.instrumental) },
          ],
        }
      }
      const result = separateStems(audio, {
        vocalStrength: request.strength,
        onProgress: (value, stage) => progress(id, value, stage),
      })
      return {
        kind: 'separate',
        stems: [
          { name: 'vocals', audio: toTransfer(result.stems.vocals) },
          { name: 'drums', audio: toTransfer(result.stems.drums) },
          { name: 'bass', audio: toTransfer(result.stems.bass) },
          { name: 'other', audio: toTransfer(result.stems.other) },
          { name: 'instrumental', audio: toTransfer(result.instrumental) },
        ],
      }
    }

    case 'process':
      return { kind: 'process', audio: toTransfer(applyOps(toAudioData(request.audio), request.ops, id)) }

    case 'cover': {
      const audio = toAudioData(request.audio)
      progress(id, 0.05, 'Separating the vocal')
      const split = splitVocals(audio, {
        strength: request.separationStrength,
        onProgress: (value, stage) => progress(id, 0.05 + value * 0.55, stage),
      })

      progress(id, 0.62, 'Transforming the vocal')
      const ops: ProcessOp[] = []
      if (request.semitones !== 0 || request.formantSemitones !== 0) {
        ops.push({
          op: 'pitch',
          semitones: request.semitones,
          preserveFormants: true,
          formantSemitones: request.semitones + request.formantSemitones,
        })
      }
      ops.push(...request.vocalOps)
      const vocal = ops.length > 0 ? applyOps(split.vocals, ops, id) : split.vocals

      progress(id, 0.9, 'Rebuilding the mix')
      const mixed = applyLimiter(
        normalizePeak(
          mixDown([
            { audio: split.instrumental },
            { audio: vocal, gainDb: request.vocalGainDb },
          ]),
          -1,
        ),
        0.97,
      )

      return {
        kind: 'cover',
        mix: toTransfer(mixed),
        vocal: toTransfer(vocal),
        instrumental: toTransfer(split.instrumental),
      }
    }

    case 'analyze': {
      const audio = toAudioData(request.audio)
      progress(id, 0.2, 'Detecting tempo')
      const tempo = detectTempo(audio)
      progress(id, 0.6, 'Detecting key')
      const key = detectKey(audio)
      progress(id, 0.9, 'Measuring loudness')
      const loudness = measureLoudness(audio)
      return { kind: 'analyze', tempo, key, loudness }
    }

    case 'speak': {
      progress(id, 0.2, 'Synthesising speech')
      let audio = synthesizeSpeech(request.text, { ...request.options, voice: request.voice })
      if (request.ops && request.ops.length > 0) {
        audio = applyOps(audio, request.ops, id)
      }
      return { kind: 'speak', audio: toTransfer(audio) }
    }

    case 'sing': {
      // Sing user-supplied lyrics: compose a song, then replace its lyric text.
      progress(id, 0.05, 'Writing the melody')
      const lines = request.text.split(/\n+/).map((l) => l.trim()).filter(Boolean)
      // Fit the arrangement to the lyric rather than the other way round: one
      // melodic phrase per line, at roughly four and a half seconds each.
      const suggestedSeconds = Math.max(30, Math.min(420, Math.round(lines.length * 4.5)))
      const spec = buildSpec(request.prompt, {
        durationSeconds: suggestedSeconds,
        ...request.overrides,
        vocals: 'sung',
      })
      const score = composeSong(spec)
      const vocal = score.tracks.find((t) => t.id === 'vocal')
      if (vocal && lines.length > 0 && score.lyrics) {
        replaceLyricText(score.lyrics.lines, lines)
        score.lyrics.formatted = lines.join('\n')
        applyLyricsToTrack(score, lines)
      }
      progress(id, 0.15, 'Rendering audio')
      const sampleRate = QUALITY_SAMPLE_RATES[request.quality]
      const rendered = renderScore(score, {
        sampleRate,
        singStyle: request.style,
        onProgress: (value) => progress(id, 0.15 + value * 0.83, 'Rendering audio'),
      })
      return {
        kind: 'generate',
        score,
        audio: { channels: [rendered.left, rendered.right], sampleRate },
        stems: [],
        loudnessDb: rendered.loudnessDb,
        peak: rendered.peak,
      }
    }
  }
}

/** Overwrites the generated lyric lines with the user's own, cycling if short. */
function replaceLyricText(target: { text: string }[], lines: string[]): void {
  for (let i = 0; i < target.length; i++) {
    target[i]!.text = lines[i % lines.length]!
  }
}

/**
 * Re-places syllables on the vocal track after the lyric text has changed.
 *
 * Phrase boundaries come from the marks the composer left, so a phrase that
 * ends legato is still recognised as one. Lines longer than their phrase split
 * its notes; shorter lines are held across the spare ones — the same fitting
 * the composer uses, so a user-written line is treated no differently from a
 * generated one.
 */
function applyLyricsToTrack(score: Score, lines: string[]): void {
  const track = score.tracks.find((t) => t.id === 'vocal')
  if (!track || track.notes.length === 0 || lines.length === 0) return

  const phrases: ScoreNote[][] = []
  let current: ScoreNote[] = []
  for (let i = 0; i < track.notes.length; i++) {
    const note = track.notes[i]!
    if (i > 0 && note.phraseStart) {
      phrases.push(current)
      current = []
    }
    current.push(note)
  }
  if (current.length > 0) phrases.push(current)

  const rebuilt: ScoreNote[] = []
  phrases.forEach((phraseNotes, index) => {
    const line = lines[index % lines.length] ?? ''
    const placed = fitSyllablesToNotes(phraseNotes, lineSyllables(line))
    if (placed[0]) placed[0].phraseStart = true
    rebuilt.push(...placed)
  })

  track.notes = rebuilt.sort((a, b) => a.start - b.start)

  // Harmonies double the lead, so they have to be rebuilt from it.
  const harmony = score.tracks.find((t) => t.id === 'vocalHarmony')
  if (harmony && harmony.notes.length > 0) {
    const interval = harmony.notes[0]!.midi - track.notes[0]!.midi
    const harmonised = rebuilt
      .filter((note) => note.start >= harmony.notes[0]!.start && note.start <= harmony.notes[harmony.notes.length - 1]!.start)
      .map((note) => ({ ...note, midi: note.midi + interval, velocity: note.velocity * 0.55 }))
    harmony.notes = harmonised
  }
}


/** Runs one job, reporting progress through `onProgress`. */
export function handleRequest(request: WorkerRequest, onProgress: ProgressReporter): WorkerResult {
  reportProgress = onProgress
  try {
    return handle(0, request)
  } finally {
    reportProgress = () => {}
  }
}
