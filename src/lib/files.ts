/** Reading audio files in, and getting finished audio back out. */

import { decodeWav, encodeWav, type AudioData } from '../engine/audio/wav'
import type { Mp3Bitrate } from '../engine/audio/mp3'

export type ExportFormat = 'wav16' | 'wav24' | 'wav32' | 'mp3-192' | 'mp3-320' | 'mp3-128'

export const EXPORT_FORMATS: { id: ExportFormat; label: string; extension: string }[] = [
  { id: 'mp3-320', label: 'MP3 · 320 kbps', extension: 'mp3' },
  { id: 'mp3-192', label: 'MP3 · 192 kbps', extension: 'mp3' },
  { id: 'mp3-128', label: 'MP3 · 128 kbps', extension: 'mp3' },
  { id: 'wav16', label: 'WAV · 16-bit', extension: 'wav' },
  { id: 'wav24', label: 'WAV · 24-bit', extension: 'wav' },
  { id: 'wav32', label: 'WAV · 32-bit float', extension: 'wav' },
]

/**
 * Turns finished audio into a downloadable blob.
 *
 * The MP3 encoder is a sizeable dependency that is only needed when someone
 * actually exports, so it is loaded on demand rather than shipped in the
 * initial bundle.
 */
export async function encodeAudio(audio: AudioData, format: ExportFormat): Promise<Blob> {
  if (format.startsWith('mp3')) {
    const { encodeMp3, isMp3SampleRate } = await import('../engine/audio/mp3')
    if (!isMp3SampleRate(audio.sampleRate)) {
      throw new Error(
        `MP3 cannot store ${audio.sampleRate} Hz audio. Export as WAV instead.`,
      )
    }
    const bitrate = Number(format.split('-')[1]) as Mp3Bitrate
    const bytes = encodeMp3(audio, bitrate)
    return new Blob([bytes as unknown as BlobPart], { type: 'audio/mpeg' })
  }
  const depth = format === 'wav24' ? 24 : format === 'wav32' ? 32 : 16
  return new Blob([encodeWav(audio, depth)], { type: 'audio/wav' })
}

export function extensionFor(format: ExportFormat): string {
  return EXPORT_FORMATS.find((f) => f.id === format)?.extension ?? 'wav'
}

/** Makes a filename safe for every operating system. */
export function safeFilename(name: string, fallback = 'resonant'): string {
  const cleaned = name
    .normalize('NFKD')
    .replace(/[^\w\s.-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 80)
  return cleaned.length > 0 ? cleaned : fallback
}

/**
 * A host that mediates saving on the page's behalf.
 *
 * Some sandboxed embeds refuse downloads a page starts itself, and offer an
 * API instead. Detecting one lets a refused save say so, rather than looking
 * like a button that does nothing.
 */
interface SaveHost {
  use(name: 'downloads'): Promise<{
    save(request: { filename: string; data: Blob }): Promise<{ status: string }>
  } | null>
}

function saveHost(): SaveHost | null {
  const host = (window as unknown as { claude?: SaveHost }).claude
  return host && typeof host.use === 'function' ? host : null
}

/** True when the page is embedded somewhere that mediates saving. */
export function savingIsMediated(): boolean {
  return saveHost() !== null
}

/**
 * Hands a file to the viewer.
 *
 * Normally that is an anchor click. Inside a mediating embed it goes through
 * the host, which may refuse the file type outright — audio, in practice — and
 * the caller is told why instead of the click quietly doing nothing.
 */
export async function downloadBlob(blob: Blob, filename: string): Promise<void> {
  const host = saveHost()
  if (host) {
    const downloads = await host.use('downloads')
    if (!downloads) {
      throw new Error('This preview cannot save files. Open the full version to download.')
    }
    try {
      await downloads.save({ filename, data: blob })
      return
    } catch (error) {
      const code = (error as { code?: string } | null)?.code
      if (code === 'declined') throw new Error('Download cancelled.', { cause: error })
      if (code === 'rejected_extension' || code === 'extension_not_enabled') {
        throw new Error(
          'This preview cannot save audio files. Open the full version to download.',
          { cause: error },
        )
      }
      throw new Error('The download was refused by the app this page is embedded in.', { cause: error })
    }
  }

  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.rel = 'noopener'
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
  // Revoking immediately can cancel the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 20_000)
}

export async function downloadText(text: string, filename: string): Promise<void> {
  await downloadBlob(new Blob([text], { type: 'text/plain;charset=utf-8' }), filename)
}

/**
 * Decodes an uploaded file. WAV is decoded directly so it works everywhere;
 * everything else (MP3, M4A, OGG, FLAC, WebM) goes through the browser's own
 * decoder, which supports whatever that browser supports.
 */
export async function decodeAudioFile(file: File | Blob): Promise<AudioData> {
  const buffer = await file.arrayBuffer()
  if (looksLikeWav(buffer)) {
    try {
      return decodeWav(buffer)
    } catch {
      // Fall through to the platform decoder for unusual WAV variants.
    }
  }

  const Ctor: typeof AudioContext =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
  if (!Ctor) throw new Error('This browser cannot decode audio files.')

  const context = new Ctor()
  try {
    const decoded = await context.decodeAudioData(buffer.slice(0))
    const channels: Float32Array[] = []
    for (let channel = 0; channel < decoded.numberOfChannels; channel++) {
      channels.push(decoded.getChannelData(channel).slice())
    }
    return { channels, sampleRate: decoded.sampleRate }
  } catch {
    throw new Error('That file could not be decoded. Try a WAV, MP3, M4A, OGG or FLAC file.')
  } finally {
    void context.close()
  }
}

function looksLikeWav(buffer: ArrayBuffer): boolean {
  if (buffer.byteLength < 12) return false
  const view = new DataView(buffer)
  const read = (offset: number): string =>
    String.fromCharCode(view.getUint8(offset), view.getUint8(offset + 1), view.getUint8(offset + 2), view.getUint8(offset + 3))
  return read(0) === 'RIFF' && read(8) === 'WAVE'
}

/** Human-readable file size. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
