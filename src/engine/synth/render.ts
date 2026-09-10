/**
 * Offline renderer: turns a Score into stereo PCM.
 *
 * Everything runs in plain TypeScript rather than through the Web Audio graph,
 * which keeps renders deterministic, testable outside a browser, and usable
 * from a worker without an AudioContext.
 */

import { beatsToSeconds, clamp, dbToGain, SAMPLE_RATE } from '../core/units'
import { hashString } from '../core/rng'
import { getGenre } from '../compose/genres'
import type { DrumHit, Score, ScoreTrack } from '../compose/types'
import { renderDrum, drumLength } from './drumkit'
import { renderVoice } from './instruments'
import { applyDrive, applyTrackEq, buildSidechainEnvelope, Compressor, Limiter, PingPongDelay, Reverb } from './fx'
import { renderSungNote, SING_PRESETS, type SingStyle } from '../voice/singer'

export interface RenderOptions {
  sampleRate?: number
  /** Called with 0..1 as the render proceeds. */
  onProgress?: (progress: number) => void
  /** Keeps every track's audio for stem export. Costs memory. */
  keepStems?: boolean
  /** Overrides the singing style; defaults to one chosen from the genre. */
  singStyle?: SingStyle
  /** Master peak ceiling, linear. */
  ceiling?: number
  /** Track ids to exclude — used for instrumental and karaoke exports. */
  excludeTrackIds?: string[]
  /** Renders drums only when false. */
  includeDrums?: boolean
}

export interface RenderResult {
  left: Float32Array
  right: Float32Array
  sampleRate: number
  durationSeconds: number
  /** Present when `keepStems` was set. */
  stems?: { id: string; name: string; left: Float32Array; right: Float32Array }[]
  /** Integrated loudness estimate in dBFS RMS, for display. */
  loudnessDb: number
  peak: number
}

/** Nudges off-grid subdivisions later to create swing. */
export function swingBeat(beat: number, swing: number, subdivision: 8 | 16): number {
  if (swing <= 0) return beat
  const unit = 4 / subdivision
  const index = Math.round(beat / unit)
  if (Math.abs(beat - index * unit) > 0.02) return beat
  return index % 2 === 1 ? beat + swing * unit * 0.5 : beat
}

function trackSingStyle(score: Score, options: RenderOptions): SingStyle {
  if (options.singStyle) return options.singStyle
  const genre = getGenre(score.genreId)
  if (genre.vocalStyle === 'rap') return SING_PRESETS.rap!
  if (genre.vocalStyle === 'chant') return SING_PRESETS.choir!
  switch (genre.id) {
    case 'metal':
    case 'punk':
    case 'rock':
      return SING_PRESETS.power!
    case 'lullaby':
    case 'ambient':
    case 'lofi':
      return SING_PRESETS.soft!
    case 'gospel':
    case 'edm':
    case 'kpop':
      return SING_PRESETS.soprano!
    default:
      return SING_PRESETS.pop!
  }
}

export function renderScore(score: Score, options: RenderOptions = {}): RenderResult {
  const sampleRate = options.sampleRate ?? SAMPLE_RATE
  const genre = getGenre(score.genreId)
  const swing = score.drums.swing
  const subdivision = genre.swingSubdivision
  const brightness = genre.brightness

  const bodySeconds = beatsToSeconds(score.lengthBeats, score.bpm)
  // Tail room for reverb, cymbals and release envelopes.
  const totalSeconds = bodySeconds + 3.5
  const totalSamples = Math.ceil(totalSeconds * sampleRate)

  const masterLeft = new Float32Array(totalSamples)
  const masterRight = new Float32Array(totalSamples)
  const reverbBus = new Float32Array(totalSamples)
  const delayBus = new Float32Array(totalSamples)

  const excluded = new Set(options.excludeTrackIds ?? [])
  const tracks = score.tracks.filter((t) => !excluded.has(t.id))
  const includeDrums = options.includeDrums !== false && !excluded.has('drums')

  // Sidechain source: every kick, in seconds.
  const kickTimes = score.drums.hits
    .filter((h) => h.drum === 'kick')
    .map((h) => beatsToSeconds(swingBeat(h.start, swing, subdivision), score.bpm))
  const sidechain = buildSidechainEnvelope(kickTimes, totalSamples, sampleRate)

  const stems: RenderResult['stems'] = options.keepStems ? [] : undefined
  const singStyle = trackSingStyle(score, options)

  const cache = new VoiceCache()
  const totalStages = tracks.length + (includeDrums ? 1 : 0) + 1
  let stage = 0
  const report = () => options.onProgress?.(clamp(stage / totalStages, 0, 1))
  report()

  for (const track of tracks) {
    const mono = renderTrack(track, score, sampleRate, brightness, swing, subdivision, totalSamples, singStyle, cache)

    applyTrackEq(mono, sampleRate, {
      highPassHz: track.fx.highPassHz,
      lowShelfDb: track.fx.lowShelfDb,
      highShelfDb: track.fx.highShelfDb,
    })
    applyDrive(mono, track.fx.drive)

    const gain = dbToGain(track.gainDb)
    const duck = track.fx.sidechain
    const pan = clamp(track.pan, -1, 1)
    // Equal-power panning keeps perceived loudness constant across the field.
    const angle = ((pan + 1) / 2) * (Math.PI / 2)
    const leftGain = Math.cos(angle)
    const rightGain = Math.sin(angle)

    const stemLeft = stems ? new Float32Array(totalSamples) : null
    const stemRight = stems ? new Float32Array(totalSamples) : null

    for (let i = 0; i < totalSamples; i++) {
      const ducked = mono[i]! * gain * (1 - duck + duck * sidechain[i]!)
      const l = ducked * leftGain
      const r = ducked * rightGain
      masterLeft[i]! += l
      masterRight[i]! += r
      reverbBus[i]! += ducked * track.fx.reverbSend
      delayBus[i]! += ducked * track.fx.delaySend
      if (stemLeft && stemRight) {
        stemLeft[i] = l
        stemRight[i] = r
      }
    }

    if (stems && stemLeft && stemRight) {
      stems.push({ id: track.id, name: track.name, left: stemLeft, right: stemRight })
    }

    stage++
    report()
  }

  if (includeDrums) {
    const drumLeft = new Float32Array(totalSamples)
    const drumRight = new Float32Array(totalSamples)
    renderDrums(score.drums.hits, score, sampleRate, brightness, swing, subdivision, drumLeft, drumRight, genre.id)

    const gain = dbToGain(score.drums.gainDb)
    for (let i = 0; i < totalSamples; i++) {
      const l = drumLeft[i]! * gain
      const r = drumRight[i]! * gain
      masterLeft[i]! += l
      masterRight[i]! += r
      reverbBus[i]! += (l + r) * 0.5 * 0.08
    }
    if (stems) stems.push({ id: 'drums', name: 'Drums', left: drumLeft, right: drumRight })
    stage++
    report()
  }

  // --- Sends -------------------------------------------------------------
  const reverb = new Reverb(sampleRate, genre.space, 0.32 + (1 - brightness) * 0.28)
  const delayTime = beatsToSeconds(genre.drumStyle === 'jazzSwing' ? 1 : 0.75, score.bpm)
  const delay = new PingPongDelay(sampleRate, delayTime, 0.36)

  for (let i = 0; i < totalSamples; i++) {
    const [wetL, wetR] = reverb.process(reverbBus[i]!)
    const [echoL, echoR] = delay.process(delayBus[i]!)
    masterLeft[i]! += wetL * 1.6 + echoL * 0.6
    masterRight[i]! += wetR * 1.6 + echoR * 0.6
  }

  // --- Master bus --------------------------------------------------------
  const busCompressor = new Compressor(sampleRate, {
    thresholdDb: -14, ratio: 2.4, attackMs: 12, releaseMs: 180, makeupDb: 2.5,
  })
  const limiter = new Limiter(sampleRate, options.ceiling ?? 0.96)

  let peak = 0
  let sumSquares = 0
  for (let i = 0; i < totalSamples; i++) {
    const mid = (masterLeft[i]! + masterRight[i]!) * 0.5
    const gain = busCompressor.gainFor(mid)
    const [l, r] = limiter.process(masterLeft[i]! * gain, masterRight[i]! * gain)
    masterLeft[i] = l
    masterRight[i] = r
    const magnitude = Math.max(Math.abs(l), Math.abs(r))
    if (magnitude > peak) peak = magnitude
    sumSquares += (l * l + r * r) * 0.5
  }

  // Normalise to a consistent, non-clipping level.
  const targetPeak = 0.93
  if (peak > 1e-4) {
    const normalise = targetPeak / peak
    if (normalise < 1 || normalise > 1.05) {
      for (let i = 0; i < totalSamples; i++) {
        masterLeft[i]! *= normalise
        masterRight[i]! *= normalise
      }
      sumSquares *= normalise * normalise
      peak = targetPeak
    }
  }

  stage++
  report()
  options.onProgress?.(1)

  const rms = Math.sqrt(sumSquares / Math.max(1, totalSamples))
  return {
    left: masterLeft,
    right: masterRight,
    sampleRate,
    durationSeconds: totalSeconds,
    stems,
    loudnessDb: 20 * Math.log10(Math.max(1e-6, rms)),
    peak,
  }
}

/**
 * Voice cache.
 *
 * Arrangements repeat: a pad holds the same four notes every bar, a chorus
 * repeats note-for-note. Rendering each distinct note once and reusing the
 * buffer is the difference between a render that takes a minute and one that
 * takes a few seconds. Durations and velocities are bucketed at thresholds
 * well below audibility, so near-identical notes share one render.
 */
class VoiceCache {
  private readonly entries = new Map<string, Float32Array>()
  private cachedSamples = 0

  /** Roughly 200 MB of Float32 audio before new entries stop being kept. */
  private static readonly MAX_SAMPLES = 50_000_000

  get(key: string): Float32Array | undefined {
    return this.entries.get(key)
  }

  set(key: string, buffer: Float32Array): void {
    if (this.cachedSamples + buffer.length > VoiceCache.MAX_SAMPLES) return
    this.entries.set(key, buffer)
    this.cachedSamples += buffer.length
  }
}

/** Duration bucket in seconds — 5 ms is far below the audible threshold. */
const DURATION_BUCKET = 0.005
/** Velocity bucket — 32 steps across the range. */
const VELOCITY_STEPS = 32

function renderTrack(
  track: ScoreTrack,
  score: Score,
  sampleRate: number,
  brightness: number,
  swing: number,
  subdivision: 8 | 16,
  totalSamples: number,
  singStyle: SingStyle,
  cache: VoiceCache,
): Float32Array {
  const mono = new Float32Array(totalSamples)
  const isVocal = track.instrument === 'vocal'

  for (let n = 0; n < track.notes.length; n++) {
    const note = track.notes[n]!
    const startBeat = swingBeat(note.start, swing, subdivision)
    const startSample = Math.round(beatsToSeconds(startBeat, score.bpm) * sampleRate)
    if (startSample >= totalSamples) continue

    const rawDuration = Math.max(0.03, beatsToSeconds(note.duration, score.bpm))
    const duration = Math.max(DURATION_BUCKET, Math.round(rawDuration / DURATION_BUCKET) * DURATION_BUCKET)
    const velocity = Math.max(1, Math.round(note.velocity * VELOCITY_STEPS)) / VELOCITY_STEPS
    const seed = hashString(`${track.instrument}:${note.midi}`)

    const key = isVocal
      ? `v|${note.midi}|${duration}|${velocity}|${note.syllable ?? ''}|${note.legato === true}`
      : `i|${track.instrument}|${note.midi}|${duration}|${velocity}`

    let buffer = cache.get(key)
    if (!buffer) {
      buffer = isVocal
        ? renderSungNote({
          midi: note.midi,
          duration,
          velocity,
          syllable: note.syllable ?? '',
          sampleRate,
          style: singStyle,
          seed,
          legato: note.legato === true,
        })
        : renderVoice({
          instrument: track.instrument,
          midi: note.midi,
          duration,
          velocity,
          sampleRate,
          brightness,
          seed,
        })
      cache.set(key, buffer)
    }

    const count = Math.min(buffer.length, totalSamples - startSample)
    for (let i = 0; i < count; i++) {
      mono[startSample + i]! += buffer[i]!
    }
  }

  return mono
}

/** Stereo positions for the kit, so it sits in a real room rather than mono. */
const DRUM_PAN: Partial<Record<DrumHit['drum'], number>> = {
  hatClosed: 0.22, hatOpen: 0.24, hatPedal: 0.18, ride: -0.28, crash: 0.34,
  tomLow: -0.3, tomMid: -0.05, tomHigh: 0.24, shaker: -0.2, tambourine: 0.3,
  cowbell: -0.24, conga: 0.16, perc: -0.18, rim: 0.1,
}

function renderDrums(
  hits: DrumHit[],
  score: Score,
  sampleRate: number,
  brightness: number,
  swing: number,
  subdivision: 8 | 16,
  left: Float32Array,
  right: Float32Array,
  genreId: string,
): void {
  const totalSamples = left.length
  const tune = genreId === 'trap' || genreId === 'drill' || genreId === 'phonk' ? -3
    : genreId === 'chiptune' ? 4
    : 0

  for (let h = 0; h < hits.length; h++) {
    const hit = hits[h]!
    const startBeat = swingBeat(hit.start, swing, subdivision)
    const startSample = Math.round(beatsToSeconds(startBeat, score.bpm) * sampleRate)
    if (startSample >= totalSamples || startSample < 0) continue

    const request = {
      drum: hit.drum,
      velocity: hit.velocity,
      sampleRate,
      duration: beatsToSeconds(hit.duration ?? 0.25, score.bpm),
      seed: hashString(`${hit.drum}:${h}`),
      brightness,
      tune: hit.drum === 'kick' || hit.drum.startsWith('tom') ? tune : 0,
    }
    const buffer = renderDrum(request)
    const pan = clamp(DRUM_PAN[hit.drum] ?? 0, -1, 1)
    const angle = ((pan + 1) / 2) * (Math.PI / 2)
    const leftGain = Math.cos(angle)
    const rightGain = Math.sin(angle)

    const count = Math.min(buffer.length, totalSamples - startSample)
    for (let i = 0; i < count; i++) {
      const sample = buffer[i]!
      left[startSample + i]! += sample * leftGain
      right[startSample + i]! += sample * rightGain
    }
  }
}

export { drumLength }
