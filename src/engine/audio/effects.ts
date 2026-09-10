/** Editing and effect operations on decoded audio. */

import { clamp, dbToGain } from '../core/units'
import { Biquad, saturate } from '../synth/dsp'
import { Chorus, Compressor, Limiter, PingPongDelay, Reverb } from '../synth/fx'
import { measureLoudness } from './analyze'
import { istft, stft } from './stft'
import { blockwise } from './blockwise'
import type { AudioData } from './wav'

function mapChannels(audio: AudioData, fn: (channel: Float32Array, index: number) => Float32Array): AudioData {
  return { channels: audio.channels.map(fn), sampleRate: audio.sampleRate }
}

/** Keeps only the region between two times, in seconds. */
export function trim(audio: AudioData, startSeconds: number, endSeconds: number): AudioData {
  const length = audio.channels[0]?.length ?? 0
  const start = clamp(Math.floor(startSeconds * audio.sampleRate), 0, length)
  const end = clamp(Math.ceil(endSeconds * audio.sampleRate), start, length)
  return mapChannels(audio, (channel) => channel.slice(start, end))
}

/** Applies linear fades to the head and tail. */
export function fade(audio: AudioData, fadeInSeconds: number, fadeOutSeconds: number): AudioData {
  const rate = audio.sampleRate
  const inSamples = Math.max(0, Math.round(fadeInSeconds * rate))
  const outSamples = Math.max(0, Math.round(fadeOutSeconds * rate))
  return mapChannels(audio, (channel) => {
    const out = channel.slice()
    const length = out.length
    for (let i = 0; i < Math.min(inSamples, length); i++) out[i]! *= i / inSamples
    for (let i = 0; i < Math.min(outSamples, length); i++) {
      out[length - 1 - i]! *= i / outSamples
    }
    return out
  })
}

export function reverse(audio: AudioData): AudioData {
  return mapChannels(audio, (channel) => channel.slice().reverse())
}

export function gain(audio: AudioData, db: number): AudioData {
  const multiplier = dbToGain(db)
  return mapChannels(audio, (channel) => {
    const out = new Float32Array(channel.length)
    for (let i = 0; i < channel.length; i++) out[i] = channel[i]! * multiplier
    return out
  })
}

/** Scales so the loudest sample sits at `targetDb` below full scale. */
export function normalizePeak(audio: AudioData, targetDb = -1): AudioData {
  let peak = 0
  for (const channel of audio.channels) {
    for (let i = 0; i < channel.length; i++) {
      const magnitude = Math.abs(channel[i]!)
      if (magnitude > peak) peak = magnitude
    }
  }
  if (peak < 1e-7) return mapChannels(audio, (c) => c.slice())
  const target = dbToGain(targetDb)
  return gain(audio, 20 * Math.log10(target / peak))
}

/** Scales toward a target integrated loudness, then guards against clipping. */
export function normalizeLoudness(audio: AudioData, targetLufs = -14): AudioData {
  const measured = measureLoudness(audio)
  if (!Number.isFinite(measured.lufs)) return mapChannels(audio, (c) => c.slice())
  const adjusted = gain(audio, targetLufs - measured.lufs)
  const peak = measureLoudness(adjusted).peak
  return peak > 0.98 ? normalizePeak(adjusted, -0.3) : adjusted
}

/** Concatenates clips, resampling nothing — callers must match sample rates. */
export function concat(clips: AudioData[]): AudioData {
  const valid = clips.filter((c) => (c.channels[0]?.length ?? 0) > 0)
  if (valid.length === 0) return { channels: [new Float32Array(0), new Float32Array(0)], sampleRate: 44100 }
  const sampleRate = valid[0]!.sampleRate
  const channelCount = Math.max(...valid.map((c) => c.channels.length))
  const totalLength = valid.reduce((sum, c) => sum + (c.channels[0]?.length ?? 0), 0)

  const channels = Array.from({ length: channelCount }, () => new Float32Array(totalLength))
  let offset = 0
  for (const clip of valid) {
    const length = clip.channels[0]?.length ?? 0
    for (let c = 0; c < channelCount; c++) {
      const source = clip.channels[Math.min(c, clip.channels.length - 1)]!
      channels[c]!.set(source.subarray(0, length), offset)
    }
    offset += length
  }
  return { channels, sampleRate }
}

/** Layers clips on top of one another, starting at optional offsets. */
export function mixDown(clips: { audio: AudioData; offsetSeconds?: number; gainDb?: number }[]): AudioData {
  const valid = clips.filter((c) => (c.audio.channels[0]?.length ?? 0) > 0)
  if (valid.length === 0) return { channels: [new Float32Array(0), new Float32Array(0)], sampleRate: 44100 }
  const sampleRate = valid[0]!.audio.sampleRate
  const channelCount = Math.max(...valid.map((c) => c.audio.channels.length), 2)

  let totalLength = 0
  for (const clip of valid) {
    const offset = Math.round((clip.offsetSeconds ?? 0) * sampleRate)
    totalLength = Math.max(totalLength, offset + (clip.audio.channels[0]?.length ?? 0))
  }

  const channels = Array.from({ length: channelCount }, () => new Float32Array(totalLength))
  for (const clip of valid) {
    const offset = Math.round((clip.offsetSeconds ?? 0) * sampleRate)
    const multiplier = dbToGain(clip.gainDb ?? 0)
    for (let c = 0; c < channelCount; c++) {
      const source = clip.audio.channels[Math.min(c, clip.audio.channels.length - 1)]!
      const target = channels[c]!
      for (let i = 0; i < source.length; i++) {
        const index = offset + i
        if (index >= 0 && index < totalLength) target[index]! += source[i]! * multiplier
      }
    }
  }
  return { channels, sampleRate }
}

export interface EqBand {
  type: 'lowShelf' | 'highShelf' | 'peaking' | 'lowPass' | 'highPass'
  freq: number
  gainDb?: number
  q?: number
}

export function equalize(audio: AudioData, bands: EqBand[]): AudioData {
  if (bands.length === 0) return mapChannels(audio, (c) => c.slice())
  return mapChannels(audio, (channel) => {
    const out = channel.slice()
    for (const band of bands) {
      const filter = new Biquad(audio.sampleRate)
      switch (band.type) {
        case 'lowShelf': filter.lowShelf(band.freq, band.gainDb ?? 0); break
        case 'highShelf': filter.highShelf(band.freq, band.gainDb ?? 0); break
        case 'peaking': filter.peaking(band.freq, band.q ?? 1, band.gainDb ?? 0); break
        case 'lowPass': filter.lowpass(band.freq, band.q ?? 0.707); break
        case 'highPass': filter.highpass(band.freq, band.q ?? 0.707); break
      }
      filter.processBuffer(out)
    }
    return out
  })
}

export interface ReverbOptions {
  /** 0..1 room size. */
  size: number
  /** 0..1 damping of the high frequencies. */
  damping: number
  /** 0..1 wet/dry balance. */
  mix: number
}

export function applyReverb(audio: AudioData, options: ReverbOptions): AudioData {
  const reverb = new Reverb(audio.sampleRate, options.size, options.damping)
  const length = audio.channels[0]?.length ?? 0
  const tail = Math.round(audio.sampleRate * (1 + options.size * 3))
  const total = length + tail

  const left = new Float32Array(total)
  const right = new Float32Array(total)
  const sourceLeft = audio.channels[0] ?? new Float32Array(0)
  const sourceRight = audio.channels[1] ?? sourceLeft

  const wet = clamp(options.mix, 0, 1)
  const dry = 1 - wet * 0.6

  for (let i = 0; i < total; i++) {
    const l = i < length ? sourceLeft[i]! : 0
    const r = i < length ? (sourceRight[i] ?? l) : 0
    const [wetL, wetR] = reverb.process((l + r) * 0.5)
    left[i] = l * dry + wetL * wet * 2.2
    right[i] = r * dry + wetR * wet * 2.2
  }
  return { channels: [left, right], sampleRate: audio.sampleRate }
}

export interface EchoOptions {
  delaySeconds: number
  feedback: number
  mix: number
}

export function applyEcho(audio: AudioData, options: EchoOptions): AudioData {
  const delay = new PingPongDelay(audio.sampleRate, options.delaySeconds, clamp(options.feedback, 0, 0.9))
  const length = audio.channels[0]?.length ?? 0
  const tail = Math.round(audio.sampleRate * options.delaySeconds * 8)
  const total = length + tail
  const left = new Float32Array(total)
  const right = new Float32Array(total)
  const sourceLeft = audio.channels[0] ?? new Float32Array(0)
  const sourceRight = audio.channels[1] ?? sourceLeft
  const wet = clamp(options.mix, 0, 1)

  for (let i = 0; i < total; i++) {
    const l = i < length ? sourceLeft[i]! : 0
    const r = i < length ? (sourceRight[i] ?? l) : 0
    const [echoL, echoR] = delay.process((l + r) * 0.5)
    left[i] = l + echoL * wet
    right[i] = r + echoR * wet
  }
  return { channels: [left, right], sampleRate: audio.sampleRate }
}

export function applyChorus(audio: AudioData, depth: number, mix: number): AudioData {
  const chorus = new Chorus(audio.sampleRate, clamp(depth, 0, 1))
  const length = audio.channels[0]?.length ?? 0
  const left = new Float32Array(length)
  const right = new Float32Array(length)
  const sourceLeft = audio.channels[0] ?? new Float32Array(0)
  const sourceRight = audio.channels[1] ?? sourceLeft
  const wet = clamp(mix, 0, 1)

  for (let i = 0; i < length; i++) {
    const l = sourceLeft[i]!
    const r = sourceRight[i] ?? l
    const [wetL, wetR] = chorus.process((l + r) * 0.5)
    left[i] = l * (1 - wet * 0.5) + wetL * wet
    right[i] = r * (1 - wet * 0.5) + wetR * wet
  }
  return { channels: [left, right], sampleRate: audio.sampleRate }
}

export function applyDistortion(audio: AudioData, amount: number): AudioData {
  return mapChannels(audio, (channel) => {
    const out = new Float32Array(channel.length)
    for (let i = 0; i < channel.length; i++) out[i] = saturate(channel[i]!, clamp(amount, 0, 1))
    return out
  })
}

export interface CompressOptions {
  thresholdDb: number
  ratio: number
  attackMs: number
  releaseMs: number
  makeupDb: number
}

export function applyCompression(audio: AudioData, options: CompressOptions): AudioData {
  const compressor = new Compressor(audio.sampleRate, options)
  const length = audio.channels[0]?.length ?? 0
  const channels = audio.channels.map(() => new Float32Array(length))
  for (let i = 0; i < length; i++) {
    let sum = 0
    for (const channel of audio.channels) sum += channel[i] ?? 0
    const multiplier = compressor.gainFor(sum / Math.max(1, audio.channels.length))
    for (let c = 0; c < audio.channels.length; c++) {
      channels[c]![i] = (audio.channels[c]![i] ?? 0) * multiplier
    }
  }
  return { channels, sampleRate: audio.sampleRate }
}

/** Final safety limiting, for exports. */
export function applyLimiter(audio: AudioData, ceiling = 0.97): AudioData {
  const limiter = new Limiter(audio.sampleRate, ceiling)
  const length = audio.channels[0]?.length ?? 0
  const left = new Float32Array(length)
  const right = new Float32Array(length)
  const sourceLeft = audio.channels[0] ?? new Float32Array(0)
  const sourceRight = audio.channels[1] ?? sourceLeft
  for (let i = 0; i < length; i++) {
    const [l, r] = limiter.process(sourceLeft[i]!, sourceRight[i] ?? sourceLeft[i]!)
    left[i] = l
    right[i] = r
  }
  return { channels: [left, right], sampleRate: audio.sampleRate }
}

/**
 * Spectral-subtraction noise reduction. The quietest frames are taken as a
 * noise profile and subtracted from every frame, with a floor so the result
 * ducks rather than punching holes in the signal.
 */
export function reduceNoise(audio: AudioData, strength = 0.7): AudioData {
  // Blocked for the same reason separation is: a spectrogram of a whole track
  // is far larger than a phone will tolerate. A per-block noise profile also
  // tracks a noise floor that changes over the recording.
  const [result] = blockwise(
    audio,
    1,
    (block) => [mapChannels(block, (channel) => denoiseChannel(channel, block.sampleRate, strength))],
    { blockSeconds: 20, overlapSeconds: 1 },
  )
  return result!
}

function denoiseChannel(signal: Float32Array, sampleRate: number, strength: number): Float32Array {
  if (signal.length < 4096) return signal.slice()
  const frameSize = 1024
  const hop = frameSize / 4
  const spectrum = stft(signal, frameSize, hop, sampleRate)

  // Noise profile: the 10th-percentile magnitude in each bin.
  const bins = spectrum.binCount
  const profile = new Float32Array(bins)
  const column = new Float32Array(spectrum.magnitude.length)
  for (let bin = 0; bin < bins; bin++) {
    for (let f = 0; f < spectrum.magnitude.length; f++) column[f] = spectrum.magnitude[f]![bin]!
    const sorted = column.slice().sort()
    profile[bin] = sorted[Math.floor(sorted.length * 0.1)] ?? 0
  }

  const floor = 1 - clamp(strength, 0, 1) * 0.92
  const magnitude = spectrum.magnitude.map((frame) => {
    const out = new Float32Array(frame.length)
    for (let bin = 0; bin < frame.length; bin++) {
      const value = frame[bin]!
      const noise = profile[bin]! * (1 + strength * 1.6)
      const cleaned = Math.max(value - noise, value * floor)
      out[bin] = cleaned
    }
    return out
  })

  return istft(spectrum, magnitude)
}
