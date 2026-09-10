/**
 * Block processing for spectral algorithms.
 *
 * A spectrogram of a three-minute stereo track is hundreds of megabytes, and
 * separation needs several of them at once — enough to exhaust a phone.
 * Processing overlapping blocks and cross-fading the joins keeps peak memory
 * bounded by the block length instead of the file length, while producing
 * output indistinguishable from whole-file processing: the median filters
 * involved span a fifth of a second, far less than the overlap.
 */

import type { AudioData } from './wav'

export interface BlockOptions {
  /** Length of each processed block, in seconds. */
  blockSeconds?: number
  /** Overlap between neighbouring blocks, in seconds. */
  overlapSeconds?: number
  onProgress?: (progress: number) => void
}

/** Files shorter than this are processed whole — blocking would only add joins. */
const MIN_BLOCKING_SECONDS = 45

export function shouldBlock(audio: AudioData, blockSeconds: number): boolean {
  const seconds = (audio.channels[0]?.length ?? 0) / audio.sampleRate
  return seconds > Math.max(MIN_BLOCKING_SECONDS, blockSeconds * 1.25)
}

function sliceAudio(audio: AudioData, start: number, end: number): AudioData {
  return {
    channels: audio.channels.map((channel) => channel.slice(start, end)),
    sampleRate: audio.sampleRate,
  }
}

/**
 * Runs `process` over overlapping blocks and reassembles the results.
 *
 * `process` must return the same number of outputs, each the same length as
 * the block it was given. Outputs are cross-faded across the overlap, which
 * removes the discontinuity at every join.
 */
export function blockwise(
  audio: AudioData,
  outputCount: number,
  process: (block: AudioData, blockIndex: number, blockCount: number) => AudioData[],
  options: BlockOptions = {},
): AudioData[] {
  const sampleRate = audio.sampleRate
  const length = audio.channels[0]?.length ?? 0
  const channelCount = Math.max(1, audio.channels.length)
  const blockSeconds = options.blockSeconds ?? 30
  const overlapSeconds = options.overlapSeconds ?? 2

  if (length === 0) {
    return Array.from({ length: outputCount }, () => ({
      channels: Array.from({ length: channelCount }, () => new Float32Array(0)),
      sampleRate,
    }))
  }

  if (!shouldBlock(audio, blockSeconds)) {
    options.onProgress?.(0)
    const result = process(audio, 0, 1)
    options.onProgress?.(1)
    return result
  }

  const blockSamples = Math.round(blockSeconds * sampleRate)
  const overlapSamples = Math.round(overlapSeconds * sampleRate)
  const strideSamples = blockSamples - overlapSamples

  const outputs: Float32Array[][] = Array.from({ length: outputCount }, () =>
    Array.from({ length: channelCount }, () => new Float32Array(length)))
  // Summed cross-fade weights, so the joins normalise back to unity.
  const weights = new Float32Array(length)

  const blockCount = Math.max(1, Math.ceil((length - overlapSamples) / strideSamples))

  for (let index = 0; index < blockCount; index++) {
    const start = index * strideSamples
    const end = Math.min(length, start + blockSamples)
    if (start >= end) break

    const block = sliceAudio(audio, start, end)
    const results = process(block, index, blockCount)
    const blockLength = end - start

    for (let i = 0; i < blockLength; i++) {
      // Triangular window across the overlap regions only.
      let weight = 1
      if (index > 0 && i < overlapSamples) weight = i / overlapSamples
      if (end < length && i >= blockLength - overlapSamples) {
        weight = Math.min(weight, (blockLength - i) / overlapSamples)
      }
      weights[start + i]! += weight

      for (let o = 0; o < outputCount; o++) {
        const result = results[o]
        if (!result) continue
        for (let c = 0; c < channelCount; c++) {
          const source = result.channels[Math.min(c, result.channels.length - 1)]
          if (!source) continue
          outputs[o]![c]![start + i]! += (source[i] ?? 0) * weight
        }
      }
    }

    options.onProgress?.((index + 1) / blockCount)
  }

  for (let i = 0; i < length; i++) {
    const weight = weights[i]!
    if (weight <= 1e-6 || Math.abs(weight - 1) < 1e-6) continue
    const scale = 1 / weight
    for (let o = 0; o < outputCount; o++) {
      for (let c = 0; c < channelCount; c++) outputs[o]![c]![i]! *= scale
    }
  }

  return outputs.map((channels) => ({ channels, sampleRate }))
}
