/**
 * Worker protocol.
 *
 * Every expensive job — composing, rendering, separation, DSP, speech — runs
 * off the main thread so the interface never freezes, and reports progress so
 * the user always knows what is happening.
 */

import type { Score } from '../engine/compose/types'
import type { PromptOverrides } from '../engine/compose/prompt'
import type { LyricsRequest } from '../engine/lyrics/generator'
import type { SongLyrics } from '../engine/compose/types'
import type { SpeakOptions, SpeechVoice } from '../engine/voice/speech'
import type { SingStyle } from '../engine/voice/singer'
import type { StemName } from '../engine/audio/separate'
import type { KeyResult, LoudnessResult, TempoResult } from '../engine/audio/analyze'

/** Plain audio that survives structured cloning between threads. */
export interface TransferAudio {
  channels: Float32Array[]
  sampleRate: number
}

export type RenderQuality = 'draft' | 'balanced' | 'studio'

export const QUALITY_SAMPLE_RATES: Record<RenderQuality, number> = {
  draft: 22050,
  balanced: 32000,
  studio: 44100,
}

export const QUALITY_LABELS: Record<RenderQuality, string> = {
  draft: 'Draft · 22 kHz',
  balanced: 'Balanced · 32 kHz',
  studio: 'Studio · 44.1 kHz',
}

export const QUALITY_HINTS: Record<RenderQuality, string> = {
  draft: 'Fastest — good for auditioning ideas',
  balanced: 'A good trade-off on most devices',
  studio: 'Full quality, slowest to render',
}

export interface GenerateRequest {
  kind: 'generate'
  prompt: string
  overrides: PromptOverrides
  quality: RenderQuality
  singStylePreset?: string
  /** Render every track separately so stems can be exported. */
  keepStems: boolean
}

export interface GenerateResult {
  kind: 'generate'
  score: Score
  audio: TransferAudio
  stems: { id: string; name: string; audio: TransferAudio }[]
  loudnessDb: number
  peak: number
}

export interface RerenderRequest {
  kind: 'rerender'
  score: Score
  quality: RenderQuality
  singStylePreset?: string
  excludeTrackIds?: string[]
  includeDrums?: boolean
  keepStems?: boolean
}

export interface LyricsWorkerRequest {
  kind: 'lyrics'
  request: LyricsRequest
}

export interface LyricsWorkerResult {
  kind: 'lyrics'
  lyrics: SongLyrics
}

export interface SeparateRequest {
  kind: 'separate'
  audio: TransferAudio
  mode: 'vocals' | 'stems'
  strength: number
}

export interface SeparateResult {
  kind: 'separate'
  stems: { name: StemName | 'instrumental'; audio: TransferAudio }[]
}

export type ProcessOp =
  | { op: 'pitch'; semitones: number; preserveFormants: boolean; formantSemitones: number }
  | { op: 'tempo'; ratio: number }
  | { op: 'varispeed'; ratio: number }
  | { op: 'trim'; startSeconds: number; endSeconds: number }
  | { op: 'fade'; inSeconds: number; outSeconds: number }
  | { op: 'reverse' }
  | { op: 'gain'; db: number }
  | { op: 'normalize'; targetLufs: number }
  | { op: 'normalizePeak'; targetDb: number }
  | { op: 'reverb'; size: number; damping: number; mix: number }
  | { op: 'echo'; delaySeconds: number; feedback: number; mix: number }
  | { op: 'chorus'; depth: number; mix: number }
  | { op: 'distortion'; amount: number }
  | { op: 'compress'; thresholdDb: number; ratio: number; makeupDb: number }
  | { op: 'limit'; ceiling: number }
  | { op: 'denoise'; strength: number }
  | { op: 'eq'; lowDb: number; midDb: number; highDb: number }
  | { op: 'telephone' }
  | { op: 'megaphone' }
  | { op: 'radio' }

export interface ProcessRequest {
  kind: 'process'
  audio: TransferAudio
  ops: ProcessOp[]
}

export interface ProcessResult {
  kind: 'process'
  audio: TransferAudio
}

export interface AnalyzeRequest {
  kind: 'analyze'
  audio: TransferAudio
}

export interface AnalyzeResult {
  kind: 'analyze'
  tempo: TempoResult
  key: KeyResult
  loudness: LoudnessResult
}

export interface SpeakRequest {
  kind: 'speak'
  text: string
  voice: SpeechVoice
  options: Omit<SpeakOptions, 'voice'>
  /** Optional post-processing chain, e.g. for a robot or telephone effect. */
  ops?: ProcessOp[]
}

export interface SpeakResult {
  kind: 'speak'
  audio: TransferAudio
}

export interface SingRequest {
  kind: 'sing'
  /** Lyric text; each line is sung on one phrase of the generated melody. */
  text: string
  prompt: string
  overrides: PromptOverrides
  quality: RenderQuality
  style: SingStyle
}

export type WorkerRequest =
  | GenerateRequest | RerenderRequest | LyricsWorkerRequest | SeparateRequest
  | ProcessRequest | AnalyzeRequest | SpeakRequest | SingRequest

export type WorkerResult =
  | GenerateResult | LyricsWorkerResult | SeparateResult | ProcessResult
  | AnalyzeResult | SpeakResult

export interface WorkerMessage {
  id: number
  payload: WorkerRequest
}

export type WorkerResponse =
  | { id: number; type: 'progress'; progress: number; stage: string }
  | { id: number; type: 'done'; result: WorkerResult }
  | { id: number; type: 'error'; message: string }

/** Collects every ArrayBuffer in a result so it can be transferred, not copied. */
export function collectTransferables(result: WorkerResult): Transferable[] {
  const out: Transferable[] = []
  const push = (audio: TransferAudio | undefined): void => {
    if (!audio) return
    for (const channel of audio.channels) out.push(channel.buffer as ArrayBuffer)
  }
  switch (result.kind) {
    case 'generate':
      push(result.audio)
      for (const stem of result.stems) push(stem.audio)
      break
    case 'separate':
      for (const stem of result.stems) push(stem.audio)
      break
    case 'process':
    case 'speak':
      push(result.audio)
      break
    default:
      break
  }
  return out
}
