/// <reference lib="webworker" />
/**
 * The studio worker. Everything expensive happens here.
 */

import { buildSpec } from '../engine/compose/prompt'
import { composeSong } from '../engine/compose/composer'
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
  equalize, fade, gain, normalizeLoudness, normalizePeak, reduceNoise, reverse, trim,
} from '../engine/audio/effects'
import {
  collectTransferables, QUALITY_SAMPLE_RATES,
  type ProcessOp, type TransferAudio, type WorkerMessage, type WorkerRequest,
  type WorkerResponse, type WorkerResult,
} from './protocol'
import type { AudioData } from '../engine/audio/wav'

const scope = self as unknown as DedicatedWorkerGlobalScope

function post(response: WorkerResponse, transfer: Transferable[] = []): void {
  scope.postMessage(response, transfer)
}

function progress(id: number, value: number, stage: string): void {
  post({ id, type: 'progress', progress: Math.max(0, Math.min(1, value)), stage })
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
      const spec = buildSpec(request.prompt, { ...request.overrides, vocals: 'sung' })
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
 * Notes are grouped back into phrases by their gaps, which is how the composer
 * laid them out in the first place.
 */
function applyLyricsToTrack(score: { tracks: { id: string; notes: { start: number; duration: number; syllable?: string; legato?: boolean }[] }[] }, lines: string[]): void {
  const track = score.tracks.find((t) => t.id === 'vocal')
  if (!track || track.notes.length === 0) return

  const phrases: number[][] = []
  let current: number[] = [0]
  for (let i = 1; i < track.notes.length; i++) {
    const previous = track.notes[i - 1]!
    const note = track.notes[i]!
    const gap = note.start - (previous.start + previous.duration)
    if (gap > 0.6) {
      phrases.push(current)
      current = []
    }
    current.push(i)
  }
  phrases.push(current)

  phrases.forEach((indices, phraseIndex) => {
    const line = lines[phraseIndex % lines.length] ?? ''
    const syllables = lineSyllables(line)
    indices.forEach((noteIndex, position) => {
      const note = track.notes[noteIndex]!
      if (position < syllables.length) {
        note.syllable = syllables[position]
        note.legato = false
      } else {
        note.syllable = undefined
        note.legato = true
      }
    })
  })
}

scope.onmessage = (event: MessageEvent<WorkerMessage>) => {
  const { id, payload } = event.data
  try {
    const result = handle(id, payload)
    post({ id, type: 'done', result }, collectTransferables(result))
  } catch (error) {
    post({ id, type: 'error', message: error instanceof Error ? error.message : String(error) })
  }
}
