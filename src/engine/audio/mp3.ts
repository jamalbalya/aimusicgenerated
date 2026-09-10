/** MP3 encoding, so exports are not WAV-only. */

import { Mp3Encoder } from '@breezystack/lamejs'
import type { AudioData } from './wav'

export type Mp3Bitrate = 96 | 128 | 160 | 192 | 256 | 320

/** Sample rates the MPEG-1/2 layer III bitstream supports. */
const SUPPORTED_RATES = [8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000]

export function isMp3SampleRate(sampleRate: number): boolean {
  return SUPPORTED_RATES.includes(sampleRate)
}

function floatToInt16(channel: Float32Array): Int16Array {
  const out = new Int16Array(channel.length)
  for (let i = 0; i < channel.length; i++) {
    const sample = channel[i]!
    const clamped = sample > 1 ? 1 : sample < -1 ? -1 : sample
    out[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff
  }
  return out
}

/**
 * Encodes to MP3. Stereo input stays stereo; anything else is folded to mono,
 * which is what the encoder expects.
 */
export function encodeMp3(audio: AudioData, bitrate: Mp3Bitrate = 192): Uint8Array {
  if (!isMp3SampleRate(audio.sampleRate)) {
    throw new Error(`MP3 does not support ${audio.sampleRate} Hz. Use 44100, 32000 or 22050.`)
  }

  const stereo = audio.channels.length >= 2
  const left = floatToInt16(audio.channels[0] ?? new Float32Array(0))
  const right = stereo ? floatToInt16(audio.channels[1]!) : left

  const encoder = new Mp3Encoder(stereo ? 2 : 1, audio.sampleRate, bitrate)
  const blocks: Uint8Array[] = []
  // 1152 samples is one MPEG granule pair — the encoder's natural block size.
  const blockSize = 1152

  for (let offset = 0; offset < left.length; offset += blockSize) {
    const leftChunk = left.subarray(offset, offset + blockSize)
    const encoded = stereo
      ? encoder.encodeBuffer(leftChunk, right.subarray(offset, offset + blockSize))
      : encoder.encodeBuffer(leftChunk)
    if (encoded.length > 0) blocks.push(encoded)
  }

  const tail = encoder.flush()
  if (tail.length > 0) blocks.push(tail)

  const total = blocks.reduce((sum, block) => sum + block.length, 0)
  const out = new Uint8Array(total)
  let position = 0
  for (const block of blocks) {
    out.set(block, position)
    position += block.length
  }
  return out
}
