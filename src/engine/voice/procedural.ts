/**
 * The local singer: a formant model that runs offline, for free, in a browser.
 *
 * It is honest synthesised singing — a glottal pulse shaped by the resonances
 * of a vocal tract. It pronounces any supported language and follows the
 * performance exactly, and it does not sound like a person. That ceiling is a
 * property of the model rather than of its settings, so it is described here as
 * what it is and kept as the renderer that always works.
 */

import { renderSungNote, SING_PRESETS, type SingStyle } from './singer'
import { Noise } from '../synth/dsp'
import { hashString, Rng } from '../core/rng'
import type { VocalPerformance, VocalRole } from './performance'
import {
  PROCEDURAL_RENDERER_ID, registerVocalRenderer,
  type VocalRenderer, type VocalRenderOptions, type VocalStems,
} from './renderer'

/** Maps the performance's requested voice onto one of the singer's presets. */
function styleFor(performance: VocalPerformance, role: VocalRole): SingStyle {
  const { profile } = performance
  const base = profile.gender === 'female'
    ? (profile.register === 'soprano' ? SING_PRESETS.soprano! : SING_PRESETS.pop!)
    : profile.gender === 'male'
      ? (profile.power > 0.75 ? SING_PRESETS.power! : SING_PRESETS.baritone!)
      : SING_PRESETS.pop!

  // A response is a crowd answering back: further away, less vibrato, blunter.
  if (role === 'response') {
    return { ...base, vibratoDepth: base.vibratoDepth * 0.4, breathiness: base.breathiness + 0.1, scoop: 0 }
  }
  if (role === 'harmony') {
    return { ...base, vibratoDepth: base.vibratoDepth * 0.7, power: base.power * 0.8 }
  }
  return {
    ...base,
    power: base.power * (0.75 + profile.power * 0.4),
    breathiness: profile.breathiness,
    humanize: 0.35 + profile.expressiveness * 0.5,
  }
}

/**
 * A breath before a phrase.
 *
 * Filtered noise, shaped to rise and fall. It is the smallest thing that stops
 * a run of phrases sounding like a machine playing one after another, because
 * a singer audibly takes air before a line.
 */
function addBreath(
  target: Float32Array, atSample: number, seconds: number, sampleRate: number, noise: Noise, level: number,
): void {
  const length = Math.min(Math.round(seconds * sampleRate), target.length - atSample)
  if (length <= 0) return
  for (let i = 0; i < length; i++) {
    const phase = i / length
    const envelope = Math.sin(Math.PI * phase) ** 2
    target[atSample + i]! += noise.next() * envelope * level
  }
}

export class ProceduralVocalRenderer implements VocalRenderer {
  readonly id = PROCEDURAL_RENDERER_ID
  readonly label = 'Local singer'
  readonly quality = 'procedural' as const
  readonly description =
    'Synthesised singing from a vocal-tract model. Runs offline, pronounces every supported '
    + 'language, and sounds like a synthesiser rather than a person.'

  isAvailable(): boolean {
    return true
  }

  async render(performance: VocalPerformance, options: VocalRenderOptions): Promise<VocalStems> {
    const { sampleRate, totalSamples } = options
    const stems: VocalStems = {}
    const noise = new Noise(hashString(options.seed) ^ 0x7a11)
    const rng = new Rng(`${options.seed}|breath`)

    const bufferFor = (role: VocalRole): Float32Array => {
      const existing = stems[role]
      if (existing) return existing
      const created = new Float32Array(totalSamples)
      stems[role] = created
      return created
    }

    const total = performance.phrases.length || 1
    for (let p = 0; p < total; p++) {
      const phrase = performance.phrases[p]!
      const target = bufferFor(phrase.role)
      const style = styleFor(performance, phrase.role)

      // Air before the line, so the singer is heard preparing to sing it.
      const first = phrase.notes[0]
      if (first) {
        const breathSeconds = 0.16 + rng.float(0, 0.08)
        const at = Math.round((first.startSeconds - breathSeconds) * sampleRate)
        if (at > 0) addBreath(target, at, breathSeconds, sampleRate, noise, 0.012 + style.breathiness * 0.02)
      }

      for (const note of phrase.notes) {
        const start = Math.round(note.startSeconds * sampleRate)
        if (start >= totalSamples) continue

        const noteStyle: SingStyle = {
          ...style,
          vibratoDepth: note.vibrato.depth,
          vibratoRate: note.vibrato.rate || style.vibratoRate,
          vibratoOnset: note.vibrato.onset,
          scoop: note.slide,
        }

        const buffer = renderSungNote({
          midi: note.midi,
          duration: note.durationSeconds,
          velocity: note.velocity * (0.75 + note.emphasis * 0.3),
          sounds: note.syllable,
          sampleRate,
          style: noteStyle,
          seed: hashString(`${options.seed}|${note.startSeconds}|${note.midi}`),
          legato: note.articulation !== 'attack',
        })

        const count = Math.min(buffer.length, totalSamples - start)
        for (let i = 0; i < count; i++) target[start + i]! += buffer[i]!
      }

      options.onProgress?.((p + 1) / total)
    }

    return stems
  }
}

registerVocalRenderer(new ProceduralVocalRenderer())
