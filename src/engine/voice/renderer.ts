/**
 * The seam between composing a song and singing it.
 *
 * Everything upstream of here decides what is sung; everything downstream
 * decides how it sounds. A renderer is handed a `VocalPerformance` and gives
 * back audio — it never writes lyrics, chooses chords, decides the structure or
 * generates a melody, because those are already settled by the time it is
 * called.
 *
 * That separation is what makes a better singer a drop-in replacement. The
 * procedural renderer below is the one that runs today: a formant model that
 * works offline and for free, and sounds like a synthesiser. A neural singing
 * model, or a hosted service, implements the same interface and is selected in
 * its place; nothing that composes has to change. See `docs/vocal-renderers.md`
 * for what integrating one actually involves.
 */

import type { AudioData } from '../audio/wav'
import type { VocalPerformance, VocalRole } from './performance'

/**
 * How lifelike a renderer's output is.
 *
 * Named honestly rather than aspirationally: `procedural` is synthesised
 * singing and should never be described as human, whatever it is compared to.
 */
export type VocalQuality = 'procedural' | 'neural' | 'external'

export interface VocalRenderOptions {
  sampleRate: number
  /** Length of the finished song, so stems line up with the instrumental. */
  totalSamples: number
  /** Seeds the per-note variation, keeping a render reproducible. */
  seed: string
  onProgress?: (fraction: number) => void
  signal?: AbortSignal
}

/** One mono buffer per role, so the mixer can treat them differently. */
export type VocalStems = Partial<Record<VocalRole, Float32Array>>

export interface VocalRenderer {
  readonly id: string
  readonly label: string
  readonly quality: VocalQuality
  /** One sentence for the UI, saying plainly what this sounds like. */
  readonly description: string
  /**
   * Whether this renderer can run right now — a neural one might need a model
   * that has not been downloaded, a hosted one might need a key.
   */
  isAvailable(): boolean | Promise<boolean>
  render(performance: VocalPerformance, options: VocalRenderOptions): Promise<VocalStems>
}

/* ------------------------------------------------------------- registry --- */

const renderers = new Map<string, VocalRenderer>()

export function registerVocalRenderer(renderer: VocalRenderer): void {
  renderers.set(renderer.id, renderer)
}

export function vocalRenderers(): VocalRenderer[] {
  return [...renderers.values()]
}

export function getVocalRenderer(id: string): VocalRenderer | undefined {
  return renderers.get(id)
}

/**
 * The renderer to use.
 *
 * Asking for nothing gets the local singer, always. A better one is opted into
 * by name rather than picked up because it happens to be registered — which
 * keeps a render reproducible and stops the result depending on which modules
 * a build pulled in.
 *
 * A named renderer that cannot run falls back to the local one, because a song
 * with a synthetic voice on it is a better answer than an error, and a far
 * better one than a silent instrumental.
 */
export async function selectVocalRenderer(preferred?: string): Promise<VocalRenderer> {
  const local = renderers.get(PROCEDURAL_RENDERER_ID)
  if (!local) throw new Error('No vocal renderer is registered.')
  if (!preferred || preferred === PROCEDURAL_RENDERER_ID) return local

  const wanted = renderers.get(preferred)
  if (wanted && await wanted.isAvailable()) return wanted
  return local
}

export const PROCEDURAL_RENDERER_ID = 'procedural'

/** Sums the roles into one buffer, for callers that just want "the vocal". */
export function mixVocalStems(stems: VocalStems, length: number): AudioData {
  const mono = new Float32Array(length)
  for (const buffer of Object.values(stems)) {
    if (!buffer) continue
    const count = Math.min(length, buffer.length)
    for (let i = 0; i < count; i++) mono[i]! += buffer[i]!
  }
  return { channels: [mono], sampleRate: 0 }
}
