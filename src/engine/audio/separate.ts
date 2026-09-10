/**
 * Source separation.
 *
 * Two classical techniques do most of the work and need no trained model:
 *
 *  - **Harmonic/percussive separation** via median filtering of the magnitude
 *    spectrogram. Sustained tones form horizontal ridges (median along time
 *    keeps them); transients form vertical ridges (median along frequency
 *    keeps those). Drums fall out of the percussive side.
 *  - **Centre-channel analysis.** Lead vocals are almost always panned dead
 *    centre, so bins where the left and right channels agree in magnitude and
 *    phase are vocal candidates and bins where they differ are not.
 *
 * The masks are soft (Wiener-style) rather than binary, which avoids the
 * "underwater" artefacts hard masking produces.
 */

import { istft, stft, type Spectrogram } from './stft'
import type { AudioData } from './wav'

export type StemName = 'vocals' | 'drums' | 'bass' | 'other'

export interface SeparationResult {
  stems: Record<StemName, AudioData>
  /** Everything except the vocals — the karaoke track. */
  instrumental: AudioData
  sampleRate: number
}

export interface SeparationOptions {
  frameSize?: number
  hopSize?: number
  /** 0..1 — how aggressively vocals are pulled out of the centre. */
  vocalStrength?: number
  onProgress?: (progress: number, stage: string) => void
}

/** Median of a small window, using insertion sort — fastest for n < 32. */
function medianOf(values: Float32Array, count: number): number {
  for (let i = 1; i < count; i++) {
    const value = values[i]!
    let j = i - 1
    while (j >= 0 && values[j]! > value) {
      values[j + 1] = values[j]!
      j--
    }
    values[j + 1] = value
  }
  return values[count >> 1]!
}

/** Median filter along the time axis — keeps sustained, harmonic content. */
function medianAlongTime(frames: Float32Array[], length: number): Float32Array[] {
  const half = length >> 1
  const binCount = frames[0]?.length ?? 0
  const out = frames.map(() => new Float32Array(binCount))
  const scratch = new Float32Array(length)

  for (let bin = 0; bin < binCount; bin++) {
    for (let f = 0; f < frames.length; f++) {
      let count = 0
      for (let k = -half; k <= half; k++) {
        const index = f + k
        if (index < 0 || index >= frames.length) continue
        scratch[count++] = frames[index]![bin]!
      }
      out[f]![bin] = medianOf(scratch, count)
    }
  }
  return out
}

/** Median filter along the frequency axis — keeps broadband transients. */
function medianAlongFrequency(frames: Float32Array[], length: number): Float32Array[] {
  const half = length >> 1
  const binCount = frames[0]?.length ?? 0
  const out = frames.map(() => new Float32Array(binCount))
  const scratch = new Float32Array(length)

  for (let f = 0; f < frames.length; f++) {
    const frame = frames[f]!
    const target = out[f]!
    for (let bin = 0; bin < binCount; bin++) {
      let count = 0
      for (let k = -half; k <= half; k++) {
        const index = bin + k
        if (index < 0 || index >= binCount) continue
        scratch[count++] = frame[index]!
      }
      target[bin] = medianOf(scratch, count)
    }
  }
  return out
}

/** Builds a spectrogram whose magnitudes are `source` scaled by `mask`. */
function applyMask(source: Spectrogram, mask: Float32Array[]): Float32Array[] {
  return source.magnitude.map((frame, f) => {
    const out = new Float32Array(frame.length)
    const frameMask = mask[f]!
    for (let bin = 0; bin < frame.length; bin++) out[bin] = frame[bin]! * frameMask[bin]!
    return out
  })
}

function emptyMask(frames: number, bins: number, value = 0): Float32Array[] {
  return Array.from({ length: frames }, () => new Float32Array(bins).fill(value))
}

/**
 * Separates a track into vocals, drums, bass and other, plus the instrumental
 * mix. Mono input still works — the centre analysis simply contributes nothing
 * and separation falls back to harmonic/percussive plus frequency banding.
 */
export function separateStems(audio: AudioData, options: SeparationOptions = {}): SeparationResult {
  const frameSize = options.frameSize ?? 2048
  const hopSize = options.hopSize ?? frameSize / 4
  const vocalStrength = options.vocalStrength ?? 0.85
  const report = options.onProgress ?? (() => {})

  const sampleRate = audio.sampleRate
  const left = audio.channels[0] ?? new Float32Array(0)
  const right = audio.channels[1] ?? left
  const isStereo = audio.channels.length >= 2 && audio.channels[1] !== audio.channels[0]

  report(0.05, 'Analysing spectrum')
  const specLeft = stft(left, frameSize, hopSize, sampleRate)
  const specRight = isStereo ? stft(right, frameSize, hopSize, sampleRate) : specLeft

  const frames = specLeft.magnitude.length
  const bins = specLeft.binCount

  report(0.25, 'Separating harmonic and percussive')
  // Mid magnitude drives the harmonic/percussive split.
  const midMagnitude: Float32Array[] = specLeft.magnitude.map((frame, f) => {
    const out = new Float32Array(frame.length)
    const rightFrame = specRight.magnitude[f]!
    for (let bin = 0; bin < frame.length; bin++) out[bin] = (frame[bin]! + rightFrame[bin]!) * 0.5
    return out
  })

  const harmonic = medianAlongTime(midMagnitude, 17)
  report(0.5, 'Separating harmonic and percussive')
  const percussive = medianAlongFrequency(midMagnitude, 17)

  report(0.65, 'Building masks')
  const vocalMask = emptyMask(frames, bins)
  const drumMask = emptyMask(frames, bins)
  const bassMask = emptyMask(frames, bins)
  const otherMask = emptyMask(frames, bins)

  const binHz = sampleRate / frameSize
  const bassCutoffBin = Math.floor(250 / binHz)
  const vocalLowBin = Math.floor(180 / binHz)
  const vocalHighBin = Math.min(bins - 1, Math.ceil(7000 / binHz))

  for (let f = 0; f < frames; f++) {
    const leftFrame = specLeft.magnitude[f]!
    const rightFrame = specRight.magnitude[f]!
    const leftPhase = specLeft.phase[f]!
    const rightPhase = specRight.phase[f]!
    const harmonicFrame = harmonic[f]!
    const percussiveFrame = percussive[f]!

    for (let bin = 0; bin < bins; bin++) {
      const h = harmonicFrame[bin]!
      const p = percussiveFrame[bin]!
      // Wiener-style soft masks: each source gets its share of the energy.
      const total = h * h + p * p + 1e-12
      const harmonicShare = (h * h) / total
      const percussiveShare = (p * p) / total

      // Centre-ness: 1 when the two channels agree, 0 when they are unrelated.
      let centre = 1
      if (isStereo) {
        const l = leftFrame[bin]!
        const r = rightFrame[bin]!
        const magnitudeAgreement = 1 - Math.abs(l - r) / (l + r + 1e-9)
        let phaseDelta = Math.abs(leftPhase[bin]! - rightPhase[bin]!)
        if (phaseDelta > Math.PI) phaseDelta = 2 * Math.PI - phaseDelta
        const phaseAgreement = 1 - phaseDelta / Math.PI
        centre = Math.max(0, magnitudeAgreement * 0.65 + phaseAgreement * 0.35)
        centre = Math.pow(centre, 1 + vocalStrength * 3)
      }

      const inVocalBand = bin >= vocalLowBin && bin <= vocalHighBin
      const vocal = inVocalBand ? harmonicShare * centre * vocalStrength : 0
      const drums = percussiveShare * (bin > bassCutoffBin ? 1 : 0.45)
      const bass = bin <= bassCutoffBin ? harmonicShare : 0
      const rest = Math.max(0, 1 - vocal - drums - bass)

      vocalMask[f]![bin] = vocal
      drumMask[f]![bin] = drums
      bassMask[f]![bin] = bass
      otherMask[f]![bin] = rest
    }
  }

  report(0.78, 'Resynthesising stems')

  const resynth = (mask: Float32Array[]): AudioData => {
    const channels: Float32Array[] = []
    channels.push(istft(specLeft, applyMask(specLeft, mask)))
    if (isStereo) channels.push(istft(specRight, applyMask(specRight, mask)))
    else channels.push(channels[0]!.slice())
    return { channels, sampleRate }
  }

  const vocals = resynth(vocalMask)
  report(0.84, 'Resynthesising stems')
  const drums = resynth(drumMask)
  report(0.9, 'Resynthesising stems')
  const bass = resynth(bassMask)
  report(0.95, 'Resynthesising stems')
  const other = resynth(otherMask)

  // The instrumental is the original minus the vocal estimate, which keeps
  // more of the backing intact than summing the other three stems does.
  const instrumentalChannels = [left, right].map((channel, index) => {
    const vocalChannel = vocals.channels[index] ?? vocals.channels[0]!
    const out = new Float32Array(channel.length)
    for (let i = 0; i < channel.length; i++) {
      out[i] = channel[i]! - (vocalChannel[i] ?? 0)
    }
    return out
  })

  report(1, 'Done')
  return {
    stems: { vocals, drums, bass, other },
    instrumental: { channels: instrumentalChannels, sampleRate },
    sampleRate,
  }
}

export interface VocalSplitOptions {
  /** 0..1 — higher removes more, at the cost of more artefacts. */
  strength?: number
  frameSize?: number
  onProgress?: (progress: number, stage: string) => void
}

/** Fast path when only the karaoke track and the acapella are wanted. */
export function splitVocals(audio: AudioData, options: VocalSplitOptions = {}): {
  vocals: AudioData
  instrumental: AudioData
} {
  const frameSize = options.frameSize ?? 2048
  const hopSize = frameSize / 4
  const strength = options.strength ?? 0.85
  const report = options.onProgress ?? (() => {})
  const sampleRate = audio.sampleRate

  const left = audio.channels[0] ?? new Float32Array(0)
  const right = audio.channels[1] ?? left
  const isStereo = audio.channels.length >= 2

  report(0.1, 'Analysing spectrum')
  const specLeft = stft(left, frameSize, hopSize, sampleRate)
  const specRight = isStereo ? stft(right, frameSize, hopSize, sampleRate) : specLeft

  const frames = specLeft.magnitude.length
  const bins = specLeft.binCount
  const binHz = sampleRate / frameSize
  const lowBin = Math.floor(160 / binHz)
  const highBin = Math.min(bins - 1, Math.ceil(8000 / binHz))

  report(0.35, 'Isolating the centre')
  const harmonic = medianAlongTime(
    specLeft.magnitude.map((frame, f) => {
      const out = new Float32Array(frame.length)
      const rightFrame = specRight.magnitude[f]!
      for (let bin = 0; bin < frame.length; bin++) out[bin] = (frame[bin]! + rightFrame[bin]!) * 0.5
      return out
    }),
    13,
  )

  const vocalMask = emptyMask(frames, bins)
  for (let f = 0; f < frames; f++) {
    const leftFrame = specLeft.magnitude[f]!
    const rightFrame = specRight.magnitude[f]!
    const leftPhase = specLeft.phase[f]!
    const rightPhase = specRight.phase[f]!
    const harmonicFrame = harmonic[f]!
    for (let bin = lowBin; bin <= highBin; bin++) {
      const mid = (leftFrame[bin]! + rightFrame[bin]!) * 0.5
      const harmonicShare = mid > 1e-9 ? Math.min(1, harmonicFrame[bin]! / mid) : 0
      let centre = 1
      if (isStereo) {
        const l = leftFrame[bin]!
        const r = rightFrame[bin]!
        const magnitudeAgreement = 1 - Math.abs(l - r) / (l + r + 1e-9)
        let phaseDelta = Math.abs(leftPhase[bin]! - rightPhase[bin]!)
        if (phaseDelta > Math.PI) phaseDelta = 2 * Math.PI - phaseDelta
        centre = Math.max(0, magnitudeAgreement * 0.65 + (1 - phaseDelta / Math.PI) * 0.35)
        centre = Math.pow(centre, 1 + strength * 3)
      }
      vocalMask[f]![bin] = Math.min(1, harmonicShare * centre * (0.6 + strength * 0.5))
    }
  }

  report(0.7, 'Resynthesising')
  const vocalLeft = istft(specLeft, applyMask(specLeft, vocalMask))
  const vocalRight = isStereo ? istft(specRight, applyMask(specRight, vocalMask)) : vocalLeft.slice()

  const instrumentalLeft = new Float32Array(left.length)
  const instrumentalRight = new Float32Array(right.length)
  for (let i = 0; i < left.length; i++) instrumentalLeft[i] = left[i]! - (vocalLeft[i] ?? 0)
  for (let i = 0; i < right.length; i++) instrumentalRight[i] = right[i]! - (vocalRight[i] ?? 0)

  report(1, 'Done')
  return {
    vocals: { channels: [vocalLeft, vocalRight], sampleRate },
    instrumental: { channels: [instrumentalLeft, instrumentalRight], sampleRate },
  }
}
