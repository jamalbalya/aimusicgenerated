/**
 * The existing composition engine, behind the same boundary as the neural one.
 *
 * This is the offline engine: it composes, arranges, sings and mixes entirely
 * in this tab, needs no server, and costs nothing to run. It is also, by its
 * own measurement, a synthesised singer rather than a recorded one — see
 * `docs/quality/bos-toxic-evaluation.md`. It is offered as what it is.
 *
 * `generate` satisfies `MusicGenerationProvider` so that the two engines are
 * genuinely interchangeable at the boundary. It also returns the engine's own
 * richer output — the score, the stems, the validation — because the studio's
 * lyric sheets, chord charts, MIDI export and stem export are all built on
 * that, and throwing it away to fit a smaller interface would cost real
 * features for no gain.
 */

import { runJob } from '../../workers/client'
import { encodeWav } from '../audio/wav'
import { QUALITY_SAMPLE_RATES, type GenerateResult, type RenderQuality, type SongTake } from '../../workers/protocol'
import type { PromptOverrides } from '../compose/prompt'
import type { LanguageId } from '../lang'
import {
  GenerationCancelledError,
  type GenerateOptions, type MusicGenerationProvider,
  type MusicGenerationRequest, type MusicGenerationResult,
} from './types'

export const PROCEDURAL_PROVIDER_ID = 'procedural'

/** What the offline engine returns on top of the shared shape. */
export interface ProceduralGenerationResult extends MusicGenerationResult {
  engine: 'procedural'
  /** Every take from the run, with score, stems and validation intact. */
  takes: SongTake[]
}

export interface ProceduralProviderOptions {
  quality?: RenderQuality
  keepStems?: boolean
  singStylePreset?: string
  takes?: number
  /** Extra prompt overrides the studio already knows, e.g. genre or BPM. */
  overrides?: PromptOverrides
  /** Injectable so a result can be turned into a URL outside a browser. */
  toObjectUrl?: (blob: Blob) => string
}

export class ProceduralMusicProvider implements MusicGenerationProvider {
  readonly id = PROCEDURAL_PROVIDER_ID
  readonly name = 'Resonant Procedural'
  readonly type = 'procedural' as const
  readonly description = 'Composes and sings in this tab. No server, no account, works offline.'

  constructor(private readonly defaults: ProceduralProviderOptions = {}) {}

  /** Always: the engine is the page it is running in. */
  async isAvailable(): Promise<boolean> {
    return true
  }

  async generate(
    request: MusicGenerationRequest, options: GenerateOptions = {},
  ): Promise<ProceduralGenerationResult> {
    const { onStatus, signal } = options
    const quality = this.defaults.quality ?? 'balanced'
    const sampleRate = QUALITY_SAMPLE_RATES[quality]

    onStatus?.({ state: 'generating', detail: 'Writing the arrangement' })

    const overrides: PromptOverrides = {
      ...this.defaults.overrides,
      ...(request.lyrics.trim() ? { customLyrics: request.lyrics } : {}),
      ...(request.language ? { language: request.language as LanguageId } : {}),
      ...(request.vocalGender && request.vocalGender !== 'mixed'
        ? { vocalGender: request.vocalGender }
        : {}),
      ...(request.duration && request.duration > 0 ? { durationSeconds: request.duration } : {}),
      ...(request.instrumental ? { vocals: 'none' as const } : {}),
      ...(request.seed !== undefined ? { seed: String(request.seed) } : {}),
    }

    const result = await runJob<GenerateResult>({
      kind: 'generate',
      prompt: request.style,
      quality,
      keepStems: this.defaults.keepStems ?? true,
      ...(this.defaults.takes ? { takes: this.defaults.takes } : {}),
      ...(this.defaults.singStylePreset ? { singStylePreset: this.defaults.singStylePreset } : {}),
      overrides,
    }, {
      ...(signal ? { signal } : {}),
      onProgress: (progress, stage) => onStatus?.({ state: 'generating', detail: stage, progress }),
    }).catch((error: unknown) => {
      if (error instanceof Error && error.message === 'Cancelled') throw new GenerationCancelledError()
      throw error
    })

    const first = result.takes[0]!
    const toUrl = this.defaults.toObjectUrl ?? ((blob: Blob) => URL.createObjectURL(blob))
    const wav = encodeWav({ channels: first.audio.channels, sampleRate: first.audio.sampleRate }, 16)
    const audioUrl = toUrl(new Blob([wav], { type: 'audio/wav' }))

    onStatus?.({ state: 'completed', detail: 'Song generated' })
    return {
      id: first.score.seed,
      engine: 'procedural',
      audioUrl,
      duration: (first.score.lengthBeats * 60) / first.score.bpm,
      sampleRate,
      takes: result.takes,
      metadata: {
        ...(request.seed !== undefined ? { seed: request.seed } : {}),
        language: first.score.language,
        style: request.style,
        bpm: first.score.bpm,
      },
    }
  }
}
