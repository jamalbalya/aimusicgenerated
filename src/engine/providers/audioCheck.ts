/**
 * Deciding whether what came back is actually an audio file.
 *
 * A 200 response with a body is not a song. A backend can hand back an HTML
 * error page, a truncated download, a zero-length file, or a correctly formed
 * WAV containing nothing but silence — and every one of those would otherwise
 * reach the player as "generated".
 *
 * What this establishes is narrow and worth stating plainly: that a valid,
 * non-empty, non-silent audio artifact exists. It says **nothing** about
 * whether the music is any good, whether anyone is singing, or what language
 * they are singing in. Those are listening questions.
 */

export interface AudioCheck {
  valid: boolean
  /** Why it is not usable, when it is not. */
  problem?: string
  byteLength: number
  /** Present when the container declared one. */
  sampleRate?: number
  channels?: number
  /** Seconds, from the container's own header. 0 when it could not be read. */
  durationSeconds: number
  /** True when the decoded samples are all (near) zero. */
  silent?: boolean
  /** Peak sample magnitude 0..1, when the samples could be read. */
  peak?: number
  /**
   * True when the audio stops dead rather than ending: full level one moment,
   * digital silence a few hundredths of a second later, silent to the end.
   *
   * This detects one specific technical failure — a generation cut off at a
   * budget — and nothing else. It says nothing about whether the lyrics were
   * finished, and a song can be cut off mid-word with this false.
   */
  endsAbruptly?: boolean
}

/** Smaller than this is not a song by any reading. */
const MINIMUM_BYTES = 1024

const ascii = (view: DataView, offset: number, length: number): string => {
  let out = ''
  for (let i = 0; i < length; i++) out += String.fromCharCode(view.getUint8(offset + i))
  return out
}

/**
 * Reads a RIFF/WAVE header and measures the samples.
 *
 * Only WAV is parsed, because WAV is what this integration asks ACE-Step for.
 * Another container is not treated as a failure — it is reported as unmeasured,
 * with the size check still applied, so switching to MP3 later degrades to a
 * weaker check rather than a false negative.
 */
export function checkWavBuffer(buffer: ArrayBuffer): AudioCheck {
  const byteLength = buffer.byteLength
  const base: AudioCheck = { valid: false, byteLength, durationSeconds: 0 }

  if (byteLength < MINIMUM_BYTES) {
    return { ...base, problem: `the file is ${byteLength} bytes` }
  }

  const view = new DataView(buffer)
  if (ascii(view, 0, 4) !== 'RIFF' || ascii(view, 8, 4) !== 'WAVE') {
    // Not a WAV. Could be MP3 or FLAC; report it as unmeasured rather than bad.
    return { ...base, valid: true, problem: undefined }
  }

  let offset = 12
  let channels = 0
  let sampleRate = 0
  let bitDepth = 0
  let format = 1
  let dataOffset = -1
  let dataSize = 0

  while (offset + 8 <= byteLength) {
    const id = ascii(view, offset, 4)
    const size = view.getUint32(offset + 4, true)
    const body = offset + 8
    if (id === 'fmt ' && body + 16 <= byteLength) {
      format = view.getUint16(body, true)
      channels = view.getUint16(body + 2, true)
      sampleRate = view.getUint32(body + 4, true)
      bitDepth = view.getUint16(body + 14, true)
      if (format === 0xfffe && size >= 40 && body + 26 <= byteLength) {
        format = view.getUint16(body + 24, true)
      }
    } else if (id === 'data') {
      dataOffset = body
      dataSize = Math.min(size, byteLength - body)
      break
    }
    // Chunks are word-aligned, and a zero size would loop forever.
    offset = body + size + (size % 2)
    if (size === 0) break
  }

  if (dataOffset < 0) return { ...base, problem: 'the WAV file has no data chunk' }
  if (!sampleRate || !channels || !bitDepth) {
    return { ...base, problem: 'the WAV header does not declare a usable format' }
  }

  const bytesPerSample = bitDepth / 8
  const frames = Math.floor(dataSize / (bytesPerSample * channels))
  const durationSeconds = frames / sampleRate
  if (!(durationSeconds > 0)) {
    return { ...base, sampleRate, channels, problem: 'the WAV file contains no samples' }
  }

  // Peak over a sample of the file rather than all of it: a few thousand
  // readings spread across the whole thing is plenty to tell music from
  // silence, and avoids walking tens of megabytes to learn that.
  const step = Math.max(1, Math.floor(frames / 4000))
  let peak = 0
  for (let frame = 0; frame < frames; frame += step) {
    const at = dataOffset + frame * bytesPerSample * channels
    if (at + bytesPerSample > byteLength) break
    let value = 0
    if (format === 3 && bitDepth === 32) value = view.getFloat32(at, true)
    else if (bitDepth === 16) value = view.getInt16(at, true) / 32768
    else if (bitDepth === 32) value = view.getInt32(at, true) / 2147483648
    else if (bitDepth === 24) {
      const raw = view.getUint8(at) | (view.getUint8(at + 1) << 8) | (view.getUint8(at + 2) << 16)
      value = ((raw & 0x800000) ? raw - 0x1000000 : raw) / 8388608
    } else if (bitDepth === 8) value = (view.getUint8(at) - 128) / 128
    const magnitude = Math.abs(value)
    if (magnitude > peak) peak = magnitude
  }

  // −60 dBFS. Below that nobody would call it audible.
  const silent = peak < 0.001
  const abrupt = !silent && endsAbruptly(
    { view, byteLength, dataOffset, frames, channels, sampleRate, bitDepth, format })
  return {
    valid: !silent,
    ...(silent ? { problem: 'the audio is silent' } : {}),
    byteLength,
    sampleRate,
    channels,
    durationSeconds,
    silent,
    peak,
    ...(abrupt ? { endsAbruptly: true } : {}),
  }
}

/** Everything needed to read samples back out of a parsed WAV. */
interface Pcm {
  view: DataView
  byteLength: number
  dataOffset: number
  frames: number
  channels: number
  sampleRate: number
  bitDepth: number
  format: number
}

/** One channel's sample at a frame, as -1..1. */
function sampleAt(pcm: Pcm, frame: number): number {
  const bytesPerSample = pcm.bitDepth / 8
  const at = pcm.dataOffset + frame * bytesPerSample * pcm.channels
  if (at + bytesPerSample > pcm.byteLength) return 0
  const { view, bitDepth, format } = pcm
  if (format === 3 && bitDepth === 32) return view.getFloat32(at, true)
  if (bitDepth === 16) return view.getInt16(at, true) / 32768
  if (bitDepth === 32) return view.getInt32(at, true) / 2147483648
  if (bitDepth === 24) {
    const raw = view.getUint8(at) | (view.getUint8(at + 1) << 8) | (view.getUint8(at + 2) << 16)
    return ((raw & 0x800000) ? raw - 0x1000000 : raw) / 8388608
  }
  if (bitDepth === 8) return (view.getUint8(at) - 128) / 128
  return 0
}

/** Seconds of the tail worth looking at; everything before it is the song. */
const TAIL_SECONDS = 4
/** Frame size for the level trace, in seconds. */
const STEP_SECONDS = 0.02
/**
 * Clearly audible, about −26 dBFS. A song fading out passes through this level
 * on its way down; the point is never the level, only how fast it is left.
 */
const AUDIBLE = 0.05
/** About −54 dBFS: nothing a listener would hear under a played-out room. */
const SILENT = 0.002
/** The whole collapse has to happen inside this, or it is a decay, not a cut. */
const COLLAPSE_SECONDS = 0.12
/** Shorter trailing silence than this is a pause, not a truncation. */
const MIN_TRAILING_SILENCE = 0.4

/**
 * Whether the audio stops dead at the end.
 *
 * The signature this looks for was measured on a real truncated generation: the
 * band playing at −21 dBFS, then digital silence 60 ms later, then two seconds
 * of nothing. A hard budget had ended the generation mid-performance while the
 * file still ran to its full declared length.
 *
 * Everything here is built to leave real endings alone. A fade-out takes
 * seconds to cross the same distance, a final chord rings out through its
 * reverb tail, and a quiet outro never reaches the audible threshold on the way
 * down — none of them collapse from clearly audible to silent inside 120 ms and
 * then stay silent. Only that shape is reported, and even then it is reported,
 * not enforced: a generation that cost a day's quota is not thrown away on a
 * measurement of its last two seconds.
 */
function endsAbruptly(pcm: Pcm): boolean {
  const { sampleRate, frames } = pcm
  const step = Math.max(1, Math.round(sampleRate * STEP_SECONDS))
  const from = Math.max(0, frames - Math.round(sampleRate * TAIL_SECONDS))
  if (frames - from < step * 4) return false

  // Peak per step across the tail. Peak rather than mean: a single loud sample
  // is enough to prove the audio had not stopped yet.
  const levels: number[] = []
  for (let frame = from; frame + step <= frames; frame += step) {
    let level = 0
    for (let i = frame; i < frame + step; i++) {
      const magnitude = Math.abs(sampleAt(pcm, i))
      if (magnitude > level) level = magnitude
    }
    levels.push(level)
  }
  if (levels.length < 4) return false

  // The tail has to actually end in silence, and stay there.
  let silentFrom = levels.length
  while (silentFrom > 0 && levels[silentFrom - 1]! < SILENT) silentFrom--
  if (silentFrom === levels.length) return false
  if ((levels.length - silentFrom) * STEP_SECONDS < MIN_TRAILING_SILENCE) return false

  // Walk back from the silence: how long did it take to get there from a level
  // anyone would have heard? A decay takes its time; a cut does not.
  const allowed = Math.ceil(COLLAPSE_SECONDS / STEP_SECONDS)
  for (let back = 1; back <= allowed && silentFrom - back >= 0; back++) {
    if (levels[silentFrom - back]! >= AUDIBLE) return true
  }
  return false
}

/** The same check, for a Blob straight off the network. */
export async function describeAudio(blob: Blob): Promise<AudioCheck> {
  if (blob.size === 0) {
    return { valid: false, problem: 'the download was empty', byteLength: 0, durationSeconds: 0 }
  }
  // An error page served with a 200 is the case this catches.
  if (blob.type && /^text\/|^application\/json/i.test(blob.type)) {
    return {
      valid: false,
      problem: `the backend returned ${blob.type} rather than audio`,
      byteLength: blob.size,
      durationSeconds: 0,
    }
  }
  return checkWavBuffer(await blob.arrayBuffer())
}
