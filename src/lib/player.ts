/**
 * Playback.
 *
 * A single shared AudioContext drives every page. The context is created
 * lazily on the first user gesture, because mobile browsers refuse to start
 * one otherwise, and the transport keeps its own clock so the playhead stays
 * accurate without polling the graph.
 */

export interface PlayerState {
  playing: boolean
  /** Seconds. */
  position: number
  duration: number
  volume: number
  /** 0..1 output level for the meter, one per channel. */
  levels: [number, number]
}

type Listener = (state: PlayerState) => void

let context: AudioContext | null = null
let buffer: AudioBuffer | null = null
let source: AudioBufferSourceNode | null = null
let gainNode: GainNode | null = null
let analyser: AnalyserNode | null = null
let analyserData: Float32Array<ArrayBuffer> | null = null

let startedAt = 0
let offset = 0
let playing = false
let volume = 0.85
let rafId = 0

const listeners = new Set<Listener>()

function getContext(): AudioContext {
  if (!context) {
    const Ctor: typeof AudioContext =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
    context = new Ctor()
  }
  return context
}

function snapshot(): PlayerState {
  return {
    playing,
    position: currentPosition(),
    duration: buffer?.duration ?? 0,
    volume,
    levels: readLevels(),
  }
}

function emit(): void {
  const state = snapshot()
  for (const listener of listeners) listener(state)
}

function currentPosition(): number {
  if (!buffer) return 0
  if (!playing) return Math.min(offset, buffer.duration)
  const elapsed = getContext().currentTime - startedAt
  return Math.min(offset + elapsed, buffer.duration)
}

function readLevels(): [number, number] {
  if (!analyser || !analyserData || !playing) return [0, 0]
  analyser.getFloatTimeDomainData(analyserData)
  let peak = 0
  for (let i = 0; i < analyserData.length; i++) {
    const magnitude = Math.abs(analyserData[i]!)
    if (magnitude > peak) peak = magnitude
  }
  return [peak, peak]
}

function tick(): void {
  if (!playing) return
  emit()
  if (currentPosition() >= (buffer?.duration ?? 0) - 0.02) {
    stop()
    return
  }
  rafId = requestAnimationFrame(tick)
}

export function subscribe(listener: Listener): () => void {
  listeners.add(listener)
  listener(snapshot())
  return () => listeners.delete(listener)
}

/** Loads PCM into the player. Playback stops and the playhead returns to zero. */
export function load(channels: Float32Array[], sampleRate: number): void {
  stop()
  const ctx = getContext()
  const length = channels[0]?.length ?? 0
  if (length === 0) {
    buffer = null
    offset = 0
    emit()
    return
  }
  const audioBuffer = ctx.createBuffer(Math.max(1, channels.length), length, sampleRate)
  for (let channel = 0; channel < channels.length; channel++) {
    // The engine only ever produces ArrayBuffer-backed arrays, never shared
    // memory, so this narrowing is safe and avoids copying whole channels.
    audioBuffer.copyToChannel(channels[channel]! as Float32Array<ArrayBuffer>, channel)
  }
  buffer = audioBuffer
  offset = 0
  emit()
}

export function hasAudio(): boolean {
  return buffer !== null
}

export async function play(): Promise<void> {
  if (!buffer || playing) return
  const ctx = getContext()
  // Autoplay policies suspend the context until a gesture resumes it.
  if (ctx.state === 'suspended') await ctx.resume()

  gainNode = ctx.createGain()
  gainNode.gain.value = volume
  analyser = ctx.createAnalyser()
  analyser.fftSize = 1024
  analyserData = new Float32Array(new ArrayBuffer(analyser.fftSize * 4))

  source = ctx.createBufferSource()
  source.buffer = buffer
  source.connect(analyser)
  analyser.connect(gainNode)
  gainNode.connect(ctx.destination)

  if (offset >= buffer.duration - 0.02) offset = 0
  startedAt = ctx.currentTime
  source.start(0, offset)
  source.onended = () => {
    // Only a natural end should reset the transport; `stop` clears the handler.
    if (playing) stop()
  }
  playing = true
  emit()
  rafId = requestAnimationFrame(tick)
}

export function pause(): void {
  if (!playing) return
  offset = currentPosition()
  teardown()
  playing = false
  cancelAnimationFrame(rafId)
  emit()
}

export function stop(): void {
  const wasPlaying = playing
  teardown()
  playing = false
  offset = 0
  cancelAnimationFrame(rafId)
  if (wasPlaying || buffer) emit()
}

function teardown(): void {
  if (source) {
    source.onended = null
    try {
      source.stop()
    } catch {
      // Already stopped — nothing to do.
    }
    source.disconnect()
    source = null
  }
  analyser?.disconnect()
  analyser = null
  analyserData = null
  gainNode?.disconnect()
  gainNode = null
}

export function seek(seconds: number): void {
  if (!buffer) return
  const target = Math.max(0, Math.min(seconds, buffer.duration))
  if (playing) {
    teardown()
    playing = false
    offset = target
    void play()
  } else {
    offset = target
    emit()
  }
}

export function setVolume(value: number): void {
  volume = Math.max(0, Math.min(1, value))
  if (gainNode) gainNode.gain.value = volume
  emit()
}

export function toggle(): void {
  if (playing) pause()
  else void play()
}

/** Releases the audio context; used when the app unmounts. */
export function dispose(): void {
  stop()
  buffer = null
  void context?.close()
  context = null
}
