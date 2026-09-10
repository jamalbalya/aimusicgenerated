/** WAV encoding and decoding — the universal, dependency-free audio format. */

export interface AudioData {
  /** One Float32Array per channel, all the same length. */
  channels: Float32Array[]
  sampleRate: number
}

export function audioDuration(audio: AudioData): number {
  const length = audio.channels[0]?.length ?? 0
  return length / audio.sampleRate
}

/**
 * Encodes PCM as a RIFF/WAVE file. 16-bit is the compatible default; 24- and
 * 32-bit float are offered for users exporting into a DAW.
 */
export function encodeWav(audio: AudioData, bitDepth: 16 | 24 | 32 = 16): ArrayBuffer {
  const channels = audio.channels.length > 0 ? audio.channels : [new Float32Array(0)]
  const frames = channels[0]!.length
  const channelCount = channels.length
  const isFloat = bitDepth === 32
  const bytesPerSample = bitDepth / 8
  const blockAlign = channelCount * bytesPerSample
  const dataSize = frames * blockAlign
  const buffer = new ArrayBuffer(44 + dataSize)
  const view = new DataView(buffer)

  const writeString = (offset: number, text: string): void => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i))
  }

  writeString(0, 'RIFF')
  view.setUint32(4, 36 + dataSize, true)
  writeString(8, 'WAVE')
  writeString(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, isFloat ? 3 : 1, true) // 3 = IEEE float, 1 = PCM
  view.setUint16(22, channelCount, true)
  view.setUint32(24, audio.sampleRate, true)
  view.setUint32(28, audio.sampleRate * blockAlign, true)
  view.setUint16(32, blockAlign, true)
  view.setUint16(34, bitDepth, true)
  writeString(36, 'data')
  view.setUint32(40, dataSize, true)

  let offset = 44
  for (let frame = 0; frame < frames; frame++) {
    for (let channel = 0; channel < channelCount; channel++) {
      const raw = channels[channel]![frame] ?? 0
      const sample = raw > 1 ? 1 : raw < -1 ? -1 : raw
      if (isFloat) {
        view.setFloat32(offset, sample, true)
        offset += 4
      } else if (bitDepth === 24) {
        const value = Math.round(sample * 8388607)
        view.setUint8(offset, value & 0xff)
        view.setUint8(offset + 1, (value >> 8) & 0xff)
        view.setUint8(offset + 2, (value >> 16) & 0xff)
        offset += 3
      } else {
        view.setInt16(offset, Math.round(sample * 32767), true)
        offset += 2
      }
    }
  }

  return buffer
}

/**
 * Decodes a RIFF/WAVE file. Handles 8/16/24/32-bit PCM and 32/64-bit float,
 * and skips unknown chunks (LIST, fact, ...) rather than assuming a 44-byte
 * header — plenty of real-world files are not that simple.
 */
export function decodeWav(buffer: ArrayBuffer): AudioData {
  const view = new DataView(buffer)
  const readString = (offset: number, length: number): string => {
    let text = ''
    for (let i = 0; i < length; i++) text += String.fromCharCode(view.getUint8(offset + i))
    return text
  }

  if (buffer.byteLength < 12 || readString(0, 4) !== 'RIFF' || readString(8, 4) !== 'WAVE') {
    throw new Error('Not a WAV file')
  }

  let offset = 12
  let format = 1
  let channelCount = 2
  let sampleRate = 44100
  let bitDepth = 16
  let dataOffset = -1
  let dataSize = 0

  while (offset + 8 <= buffer.byteLength) {
    const id = readString(offset, 4)
    const size = view.getUint32(offset + 4, true)
    const body = offset + 8

    if (id === 'fmt ') {
      format = view.getUint16(body, true)
      channelCount = view.getUint16(body + 2, true)
      sampleRate = view.getUint32(body + 4, true)
      bitDepth = view.getUint16(body + 14, true)
      if (format === 0xfffe && size >= 40) {
        // WAVE_FORMAT_EXTENSIBLE: the real format sits in the GUID's first word.
        format = view.getUint16(body + 24, true)
      }
    } else if (id === 'data') {
      dataOffset = body
      dataSize = Math.min(size, buffer.byteLength - body)
    }

    offset = body + size + (size % 2) // chunks are word-aligned
  }

  if (dataOffset < 0) throw new Error('WAV file has no data chunk')
  if (channelCount < 1) throw new Error('WAV file declares no channels')

  const bytesPerSample = bitDepth / 8
  const frames = Math.floor(dataSize / (bytesPerSample * channelCount))
  const channels = Array.from({ length: channelCount }, () => new Float32Array(frames))

  for (let frame = 0; frame < frames; frame++) {
    for (let channel = 0; channel < channelCount; channel++) {
      const position = dataOffset + (frame * channelCount + channel) * bytesPerSample
      let sample = 0
      if (format === 3) {
        sample = bitDepth === 64 ? view.getFloat64(position, true) : view.getFloat32(position, true)
      } else if (bitDepth === 8) {
        sample = (view.getUint8(position) - 128) / 128
      } else if (bitDepth === 16) {
        sample = view.getInt16(position, true) / 32768
      } else if (bitDepth === 24) {
        const value = view.getUint8(position) | (view.getUint8(position + 1) << 8) | (view.getInt8(position + 2) << 16)
        sample = value / 8388608
      } else if (bitDepth === 32) {
        sample = view.getInt32(position, true) / 2147483648
      }
      channels[channel]![frame] = sample
    }
  }

  return { channels, sampleRate }
}

/** Sums to mono — used by analysers that do not care about the stereo image. */
export function toMono(audio: AudioData): Float32Array {
  const [first] = audio.channels
  if (!first) return new Float32Array(0)
  if (audio.channels.length === 1) return first.slice()
  const out = new Float32Array(first.length)
  for (let i = 0; i < out.length; i++) {
    let sum = 0
    for (const channel of audio.channels) sum += channel[i] ?? 0
    out[i] = sum / audio.channels.length
  }
  return out
}

/** Ensures exactly two channels, duplicating mono if needed. */
export function toStereo(audio: AudioData): AudioData {
  if (audio.channels.length >= 2) {
    return { channels: [audio.channels[0]!, audio.channels[1]!], sampleRate: audio.sampleRate }
  }
  const mono = audio.channels[0] ?? new Float32Array(0)
  return { channels: [mono, mono.slice()], sampleRate: audio.sampleRate }
}
