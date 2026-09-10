/**
 * Style and lyrics in, finished song out.
 *
 * This is the whole generation chain in one place, and the order of it is the
 * point:
 *
 *   composition  →  vocal performance  →  vocal renderer  →  mix  →  master
 *
 * The composition engine decides what is sung. The performance describes it
 * without saying who sings. The renderer turns that into audio. The mixer
 * treats the result as a track like any other. Each step hands the next one a
 * plain description rather than a decision, which is what lets the singer be
 * swapped without any of the rest moving.
 */

import { getGenre } from '../compose/genres'
import type { Score } from '../compose/types'
import { buildVocalPerformance, type VocalPerformance, type VocalProfile } from '../voice/performance'
import { selectVocalRenderer, type VocalRenderer } from '../voice/renderer'
import '../voice/procedural'
import { renderScore, type RenderOptions, type RenderResult } from './render'
import { validateRender, type RenderValidation } from './validate'

export interface SongRenderOptions extends RenderOptions {
  /** Which singer to use; falls back to the local one when unavailable. */
  vocalRendererId?: string
}

export interface SongRenderResult extends RenderResult {
  validation: RenderValidation
  /** The singer that actually sang it, which may not be the one asked for. */
  vocalRenderer: { id: string; label: string; quality: string }
  performance: VocalPerformance
}

/** How the voice should sound, read off the score and the genre. */
export function vocalProfileFor(score: Score): VocalProfile {
  const genre = getGenre(score.genreId)
  const register = score.vocalGender === 'female'
    ? (genre.density > 0.7 ? 'soprano' : 'alto')
    : score.vocalGender === 'male'
      ? (genre.density > 0.7 ? 'tenor' : 'baritone')
      : 'androgynous'

  return {
    gender: score.vocalGender,
    register,
    power: 0.45 + genre.density * 0.4,
    breathiness: genre.id === 'lofi' || genre.id === 'ambient' ? 0.35 : 0.2,
    expressiveness: genre.id === 'koplo' || genre.id === 'gospel' ? 0.85 : 0.55,
    description: `${genre.label} lead vocal`,
  }
}

/**
 * Renders a composed score into a finished song.
 *
 * Asynchronous because a renderer may not be local: a neural model has to be
 * loaded, a hosted one has to be called. The procedural singer returns
 * immediately, so nothing waits for anything in the default path.
 */
export async function renderSong(
  score: Score, options: SongRenderOptions = {},
): Promise<SongRenderResult> {
  const renderer: VocalRenderer = await selectVocalRenderer(options.vocalRendererId)

  const performance = buildVocalPerformance(score, {
    profile: vocalProfileFor(score),
    labels: score.sections.map((section) => section.label),
  })

  // Nothing sung means nothing for the renderer to do, and the mixer falls
  // through to its own path — which is also how an instrumental renders.
  let vocalStems
  if (performance.phrases.length > 0) {
    const sampleRate = options.sampleRate ?? 44100
    const totalSamples = Math.ceil(
      ((score.lengthBeats * 60) / score.bpm + 3.5) * sampleRate)
    vocalStems = await renderer.render(performance, {
      sampleRate,
      totalSamples,
      seed: score.seed,
      ...(options.onProgress ? { onProgress: (f: number) => options.onProgress!(f * 0.35) } : {}),
    })
  }

  const rendered = renderScore(score, {
    ...options,
    ...(vocalStems ? { vocalStems } : {}),
    ...(options.onProgress
      ? { onProgress: (f: number) => options.onProgress!(0.35 + f * 0.65) }
      : {}),
  })

  return {
    ...rendered,
    validation: validateRender(score, rendered),
    vocalRenderer: { id: renderer.id, label: renderer.label, quality: renderer.quality },
    performance,
  }
}
