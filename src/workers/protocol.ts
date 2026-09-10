/**
 * Worker protocol.
 *
 * Every expensive job — composing, rendering, separation, DSP, speech — runs
 * off the main thread so the interface never freezes, and reports progress so
 * the user always knows what is happening.
 */

import type { Score } from '../engine/compose/types'
import type { RenderValidation } from '../engine/synth/validate'
import type { LanguageId } from '../engine/lang'
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
  /**
   * How many different songs to write from the same brief, 1..MAX_TAKES.
   * Every take is a fresh composition, not a re-mix of one arrangement: the
   * melody, the fills and the words' placement all differ.
   */
  takes?: number
}

/** Most takes a single run will write; every one of them is a full render. */
export const MAX_TAKES = 4

/** One finished song. A run produces at least one of these. */
export interface SongTake {
  score: Score
  audio: TransferAudio
  /** Only the take that is opened carries stems; see `GenerateRequest.takes`. */
  stems: { id: string; name: string; audio: TransferAudio }[]
  loudnessDb: number
  peak: number
  /** What actually came out, checked against what was asked for. */
  validation: RenderValidation
}

export interface GenerateResult {
  kind: 'generate'
  /** Every take from this run, in the order they were written. Never empty. */
  takes: SongTake[]
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

/**
 * "Cover": separate the vocal out of a finished song, transform it, and put
 * the song back together around it. It is the stem splitter and the voice
 * changer used together, which is a common enough job to be one action.
 */
export interface CoverRequest {
  kind: 'cover'
  audio: TransferAudio
  /** 0..1 — how aggressively the vocal is pulled out before transforming. */
  separationStrength: number
  semitones: number
  /** Vocal-tract shift, relative to the pitch shift. */
  formantSemitones: number
  /** Extra treatment applied to the isolated vocal only. */
  vocalOps: ProcessOp[]
  /** Level of the transformed vocal against the backing, in dB. */
  vocalGainDb: number
}

export interface CoverResult {
  kind: 'cover'
  mix: TransferAudio
  vocal: TransferAudio
  instrumental: TransferAudio
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
  /** How to pronounce the lyric; `auto` reads it off the words themselves. */
  language?: LanguageId | 'auto'
}

export type WorkerRequest =
  | GenerateRequest | RerenderRequest | LyricsWorkerRequest | SeparateRequest
  | ProcessRequest | AnalyzeRequest | SpeakRequest | SingRequest | CoverRequest

export type WorkerResult =
  | GenerateResult | LyricsWorkerResult | SeparateResult | ProcessResult
  | AnalyzeResult | SpeakResult | CoverResult

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
      for (const take of result.takes) {
        push(take.audio)
        for (const stem of take.stems) push(stem.audio)
      }
      break
    case 'separate':
      for (const stem of result.stems) push(stem.audio)
      break
    case 'process':
    case 'speak':
      push(result.audio)
      break
    case 'cover':
      push(result.mix)
      push(result.vocal)
      push(result.instrumental)
      break
    default:
      break
  }
  return out
}
