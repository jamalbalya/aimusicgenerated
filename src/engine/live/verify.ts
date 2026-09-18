/**
 * Measuring the one song that came back, once.
 *
 * This runs after ACE-Step returns audio and it never causes another
 * generation. That is the whole design constraint and it changes what the
 * module is for: a gate that can trigger a retry is a filter, and a gate that
 * cannot is a *report*. So every measurement here exists to be told to the
 * person, not to decide their song's fate behind their back.
 *
 * Which is also why the verdicts differ from the offline engine's. Offline,
 * `REGENERATION_REQUIRED` is actionable — the composer can write another plan
 * for nothing. Here nothing is free and nothing is automatic, so the verdicts
 * say what was found and stop:
 *
 *   PASS                  every measurable property is within tolerance
 *   PASS_WITH_LIMITATIONS  usable, with named caveats — the normal outcome
 *   FAILED_VERIFICATION    a measured technical defect: silence, clipping,
 *                          a truncated file, a dead channel
 *   ANALYSIS_UNAVAILABLE   the audio could not be measured at all
 *
 * Two honesty rules are load-bearing and tested. A property that could not be
 * measured is listed in `notMeasured`, never quietly counted as passing. And
 * `PASS` is reserved for a song with nothing at all to report — the moment
 * anything is unmeasurable, the verdict is PASS_WITH_LIMITATIONS, because a
 * song labelled fully verified on a partial measurement is the specific lie
 * this project keeps finding in its own history.
 *
 * What none of this can do is judge the music. There is no separated vocal
 * stem in a browser, so "does the singing fit the chords" is unanswerable here
 * — and a full-mix answer to it is not a weaker answer but an inverted one, on
 * real songs by up to 9 standard deviations. Nothing below pretends otherwise.
 */

import { detectTempo, measureLoudness } from '../audio/analyze'
import { toMono, type AudioData } from '../audio/wav'
import { stft } from '../audio/stft'
import { checkTempo, tempoRequirement, type TempoCheck } from '../quality/tempo'

export type LiveVerdict = 'PASS' | 'PASS_WITH_LIMITATIONS' | 'FAILED_VERIFICATION' | 'ANALYSIS_UNAVAILABLE'

/** A sample at or above this magnitude is at full scale. */
const CLIP_LEVEL = 0.999

/** Below this, a sample counts as silence. About -60 dBFS. */
const SILENCE_LEVEL = 0.001

/** A run of clipped samples this long is audible distortion rather than a peak. */
const CLIP_RUN_SAMPLES = 8

/** Dead air longer than this, inside the song, is a defect worth naming. */
export const MAX_INTERNAL_SILENCE_SECONDS = 5

/** More of the file than this being silent means the generation mostly failed. */
export const MAX_SILENT_SHARE = 0.5

/** Above this share of clipped samples the master is distorting, not just loud. */
export const MAX_CLIPPED_SHARE = 0.001

/** The band a sung voice's formants and consonants live in. */
const VOICE_BAND_HZ = [1500, 4000] as const

export interface LiveMeasurements {
  durationSeconds: number
  sampleRate: number
  channels: number
  /** True when a stereo file's two channels are sample-identical. */
  dualMono: boolean
  /** True when any channel is entirely silent. */
  deadChannel: boolean
  peak: number
  peakDb: number
  rmsDb: number
  lufs: number
  /** Peak minus RMS, in dB. A master with no dynamics sits under about 6. */
  crestFactorDb: number
  /** Share of samples at full scale, 0..1. */
  clippedShare: number
  /** Longest consecutive run of clipped samples, in samples. */
  longestClipRun: number
  /** Share of the file below the silence floor, 0..1. */
  silentShare: number
  /** Longest single silent stretch, in seconds. */
  longestSilenceSeconds: number
  /** Estimated tempo, and how strongly it beat the alternatives. */
  bpm: number
  bpmConfidence: number
  /** Share of the song's energy in the voice band, 0..1. */
  voiceBandShare: number
  /** Share of frames whose voice-band energy stands above the frame's own mean. */
  voiceActivityShare: number
  /** Band energies as shares of the total: low, mid, high. */
  spectralBalance: { low: number; mid: number; high: number }
}

export interface LiveVerification {
  verdict: LiveVerdict
  measurements: LiveMeasurements | null
  /** Technical defects found. Any entry makes the verdict FAILED_VERIFICATION. */
  failures: string[]
  /** Things worth saying that are not defects. */
  notes: string[]
  /** Properties that could not be measured here, and why. */
  notMeasured: string[]
  /** The requested-versus-measured tempo check, when a tempo was requested. */
  tempo?: TempoCheck
  /**
   * The tempo that was asked for against the one that came back.
   *
   * Reported as a deviation rather than a pass or a fail, because ACE-Step has
   * no tempo input: the number in the caption was a description, and a song
   * that ignored it has not malfunctioned. `deviationBpm` is signed — positive
   * means the song came back faster than requested.
   */
  tempoDeviation?: {
    requestedBpm: number
    measuredBpm: number | null
    deviationBpm: number | null
    deviationPercent: number | null
    confidence: number
    /** True when the person wrote the tempo rather than the planner inferring it. */
    requestedByUser: boolean
  }
  /** True only for PASS and PASS_WITH_LIMITATIONS. */
  usable: boolean
}

/** Everything that cannot be measured from one mixed file in a browser. */
export const UNMEASURABLE_IN_BROWSER: readonly string[] = [
  'Whether the sung melody fits the chords under it — that needs the vocal separated from the '
  + 'band, and no separator that runs in a browser is good enough. A full-mix answer to this '
  + 'question is not less accurate, it is inverted: on a real song the mix reported +6.46 where '
  + 'the separated stems reported -2.49.',
  'Whether every written word was actually sung — that needs transcription and forced alignment.',
  'Intonation of the voice — it cannot be separated from the instruments that share its register.',
  'Where each section starts — ACE-Step returns no timings and no aligner runs here.',
  'Mixing and mastering quality as a listener hears it — the numbers below describe the master, '
  + 'they do not judge it.',
] as const

/**
 * How much of the song the tempo estimate is taken from, in seconds.
 *
 * Tempo detection is the most expensive thing here by a wide margin — measured
 * at 3.2 of 5.3 seconds on a 271-second song, because it runs its own STFT at a
 * 256-sample hop. It is also the measurement that needs the least material: a
 * fixed-tempo song reports the same BPM from ninety seconds as from four and a
 * half minutes, and this takes them from the middle, which skips a rubato intro
 * and a fading outro rather than averaging them in.
 *
 * A song whose tempo genuinely changes is measured over this window and nowhere
 * else, and the confidence figure says when the answer was weak. That is the
 * same trade the windowed detector in the Python analyser makes.
 */
const TEMPO_WINDOW_SECONDS = 90

/** Band-limited energy shares from one STFT pass. */
function spectralShares(mono: Float32Array, sampleRate: number): {
  low: number; mid: number; high: number; voice: number; voiceActivity: number
} {
  const frameSize = 1024
  // A four-frame hop rather than a half-frame one. These are band *averages*
  // over thousands of frames, so a quarter of the frames gives the same shares
  // to several decimal places and costs a quarter as much — 359 ms against
  // 1405 ms on a full-length song. Overlap buys resolution, and nothing here
  // needs resolution.
  const hop = 2048
  if (mono.length < frameSize * 4) {
    return { low: 0, mid: 0, high: 0, voice: 0, voiceActivity: 0 }
  }
  const spectrum = stft(mono, frameSize, hop, sampleRate)
  const binHz = sampleRate / frameSize
  const bin = (hz: number) => Math.min(frameSize / 2, Math.max(0, Math.round(hz / binHz)))
  const lowEnd = bin(250)
  const midEnd = bin(4000)
  const voiceFrom = bin(VOICE_BAND_HZ[0])
  const voiceTo = bin(VOICE_BAND_HZ[1])

  let low = 0, mid = 0, high = 0, voice = 0, total = 0
  let voiceFrames = 0
  const frames = spectrum.magnitude.length

  for (const frame of spectrum.magnitude) {
    let frameTotal = 0
    let frameVoice = 0
    for (let index = 0; index < frame.length; index++) {
      const energy = frame[index]! * frame[index]!
      frameTotal += energy
      if (index < lowEnd) low += energy
      else if (index < midEnd) mid += energy
      else high += energy
      if (index >= voiceFrom && index < voiceTo) frameVoice += energy
    }
    total += frameTotal
    voice += frameVoice
    // A frame carries voice-band activity when that band holds appreciably
    // more than its proportional share of the frame. Presence, not identity:
    // a saxophone would count too, which is why this is never used to say the
    // singing is good — only that something is there.
    const proportional = frameTotal * ((voiceTo - voiceFrom) / frame.length)
    if (frameTotal > 0 && frameVoice > proportional * 1.5) voiceFrames++
  }

  if (total <= 0) return { low: 0, mid: 0, high: 0, voice: 0, voiceActivity: 0 }
  return {
    low: low / total, mid: mid / total, high: high / total, voice: voice / total,
    voiceActivity: frames > 0 ? voiceFrames / frames : 0,
  }
}

/** Clipping and silence, counted in one pass over the mono sum. */
function levelStats(mono: Float32Array, sampleRate: number): {
  clippedShare: number; longestClipRun: number; silentShare: number; longestSilenceSeconds: number
} {
  let clipped = 0
  let silent = 0
  let clipRun = 0
  let longestClipRun = 0
  let silenceRun = 0
  let longestSilenceRun = 0

  for (let index = 0; index < mono.length; index++) {
    const magnitude = Math.abs(mono[index]!)
    if (magnitude >= CLIP_LEVEL) {
      clipped++
      clipRun++
      if (clipRun > longestClipRun) longestClipRun = clipRun
    } else {
      clipRun = 0
    }
    if (magnitude < SILENCE_LEVEL) {
      silent++
      silenceRun++
      if (silenceRun > longestSilenceRun) longestSilenceRun = silenceRun
    } else {
      silenceRun = 0
    }
  }

  const length = Math.max(1, mono.length)
  return {
    clippedShare: clipped / length,
    longestClipRun,
    silentShare: silent / length,
    longestSilenceSeconds: longestSilenceRun / sampleRate,
  }
}

export interface VerifyOptions {
  /** The tempo that was asked for, when one was. */
  targetBpm?: number
  /** True when that tempo was written by the person, not inferred. */
  targetBpmStated?: boolean
  /** True when the request asked for no vocals. */
  instrumental?: boolean
  /** The length that was asked for, when one was. Undefined means Auto. */
  requestedDurationSeconds?: number
}

/**
 * Measures the returned song and classifies it. Runs exactly once per song.
 *
 * Never throws: audio it cannot measure comes back ANALYSIS_UNAVAILABLE with
 * the reason, because a thrown error at this point would lose a song that has
 * already been paid for.
 */
export function verifyLiveResult(audio: AudioData, options: VerifyOptions = {}): LiveVerification {
  const notMeasured = [...UNMEASURABLE_IN_BROWSER]
  const length = audio.channels[0]?.length ?? 0

  if (audio.channels.length === 0 || length === 0 || !(audio.sampleRate > 0)) {
    return {
      verdict: 'ANALYSIS_UNAVAILABLE', measurements: null,
      failures: [], notes: [],
      notMeasured: ['The file decoded to no audio at all, so nothing could be measured.', ...notMeasured],
      usable: false,
    }
  }

  const durationSeconds = length / audio.sampleRate
  const mono = toMono(audio)
  const loudness = measureLoudness(audio)
  const levels = levelStats(mono, audio.sampleRate)
  const bands = spectralShares(mono, audio.sampleRate)

  // Tempo detection needs enough signal to autocorrelate. Short files get a
  // stated non-measurement rather than a number nobody should trust.
  let bpm = 0
  let bpmConfidence = 0
  if (mono.length >= audio.sampleRate * 10) {
    const window = Math.round(TEMPO_WINDOW_SECONDS * audio.sampleRate)
    const from = mono.length > window ? Math.round((mono.length - window) / 2) : 0
    const slice = mono.length > window ? mono.subarray(from, from + window) : mono
    const tempo = detectTempo({ channels: [slice], sampleRate: audio.sampleRate })
    bpm = tempo.bpm
    bpmConfidence = tempo.confidence
  } else {
    notMeasured.push('Tempo — the file is under ten seconds, which is too short to estimate one from.')
  }

  const deadChannel = audio.channels.some((channel) => {
    for (let index = 0; index < channel.length; index++) {
      if (Math.abs(channel[index]!) >= SILENCE_LEVEL) return false
    }
    return true
  })
  const dualMono = audio.channels.length === 2
    && audio.channels[0]!.every((sample, index) => sample === audio.channels[1]![index])

  const measurements: LiveMeasurements = {
    durationSeconds,
    sampleRate: audio.sampleRate,
    channels: audio.channels.length,
    dualMono,
    deadChannel,
    peak: loudness.peak,
    peakDb: loudness.peakDb,
    rmsDb: loudness.rmsDb,
    lufs: loudness.lufs,
    crestFactorDb: Number.isFinite(loudness.peakDb) && Number.isFinite(loudness.rmsDb)
      ? loudness.peakDb - loudness.rmsDb : 0,
    clippedShare: levels.clippedShare,
    longestClipRun: levels.longestClipRun,
    silentShare: levels.silentShare,
    longestSilenceSeconds: levels.longestSilenceSeconds,
    bpm,
    bpmConfidence,
    voiceBandShare: bands.voice,
    voiceActivityShare: bands.voiceActivity,
    spectralBalance: { low: bands.low, mid: bands.mid, high: bands.high },
  }

  const failures: string[] = []
  const notes: string[] = []

  // ------------------------------------------------- technical failures ---
  if (measurements.silentShare >= MAX_SILENT_SHARE) {
    failures.push(`${Math.round(measurements.silentShare * 100)}% of the file is silence. `
      + 'That is not a song that generated.')
  }
  if (measurements.deadChannel) {
    failures.push('One channel is entirely silent, so the file plays on one side only.')
  }
  if (measurements.peak <= SILENCE_LEVEL) {
    failures.push('The file is silent from end to end.')
  }
  if (measurements.longestSilenceSeconds > MAX_INTERNAL_SILENCE_SECONDS
      && measurements.silentShare < MAX_SILENT_SHARE) {
    failures.push(`${measurements.longestSilenceSeconds.toFixed(1)} seconds of unbroken silence `
      + 'inside the song — a gap this long is a dropout, not an arrangement.')
  }
  if (measurements.clippedShare > MAX_CLIPPED_SHARE && measurements.longestClipRun >= CLIP_RUN_SAMPLES) {
    failures.push(`${(measurements.clippedShare * 100).toFixed(2)}% of samples are at full scale, `
      + `the longest run ${measurements.longestClipRun} samples. That is audible distortion.`)
  }
  if (options.requestedDurationSeconds !== undefined) {
    const shortfall = options.requestedDurationSeconds - durationSeconds
    if (shortfall > Math.max(2, options.requestedDurationSeconds * 0.02)) {
      failures.push(`Asked for ${Math.round(options.requestedDurationSeconds)} seconds and received `
        + `${Math.round(durationSeconds)}. A shortened song is not the song that was asked for.`)
    }
  }
  if (!options.instrumental && measurements.voiceActivityShare < 0.02) {
    // A vocal song with essentially no energy where a voice lives did not sing.
    // Deliberately far below any plausible sung song: this catches "the model
    // returned a backing track", not "the vocal is quiet".
    failures.push('Almost no energy in the 1.5–4 kHz band where a voice sits, across the whole '
      + 'file. A vocal song was asked for and this appears to be an instrumental.')
  }

  // ------------------------------------------------------------- notes ---
  if (measurements.crestFactorDb > 0 && measurements.crestFactorDb < 6) {
    notes.push(`Crest factor ${measurements.crestFactorDb.toFixed(1)} dB — heavily compressed, `
      + 'with little dynamic range left.')
  }
  if (measurements.dualMono) {
    notes.push('The two channels are identical: the file is stereo but the content is mono.')
  }
  if (measurements.spectralBalance.low > 0.85) {
    notes.push(`${Math.round(measurements.spectralBalance.low * 100)}% of the energy is below `
      + '250 Hz, which usually reads as muddy.')
  }
  if (measurements.spectralBalance.high > 0.4) {
    notes.push(`${Math.round(measurements.spectralBalance.high * 100)}% of the energy is above `
      + '4 kHz, which usually reads as harsh.')
  }
  if (Number.isFinite(measurements.lufs) && measurements.lufs < -20) {
    notes.push(`Integrated loudness ${measurements.lufs.toFixed(1)} LUFS — quiet for a finished master.`)
  }
  if (options.instrumental && measurements.voiceActivityShare > 0.5) {
    notes.push('An instrumental was asked for, and there is substantial energy in the vocal band. '
      + 'That may be a lead instrument in the same register rather than a voice; nothing here can '
      + 'tell the two apart.')
  }

  // -------------------------------------------------------- the tempo ---
  // `tempoRequirement` refuses a tempo that is not one, which is right for a
  // caller stating a target and wrong for a caller that has none. No target
  // means no check, so it is never asked.
  const requirement = options.targetBpm !== undefined && options.targetBpm > 0
    ? tempoRequirement(options.targetBpm) : null
  let tempo: TempoCheck | undefined
  if (requirement && bpm > 0) {
    tempo = checkTempo({ bpm }, requirement)
    if (!tempo.passed) {
      // Not a failure of the file. ACE-Step has no tempo input, so a tempo that
      // came back wrong is the model not following prose — which is worth
      // saying plainly and is not grounds for calling the audio defective.
      notes.push(`${tempo.detail} ACE-Step has no tempo parameter, so the BPM in the caption is `
        + 'a description the model may or may not follow.')
    }
  } else if (requirement && bpm <= 0) {
    notMeasured.push(`Whether the song is at the requested ${options.targetBpm} BPM — the tempo `
      + 'could not be estimated from this audio.')
  }

  if (bpmConfidence > 0 && bpmConfidence < 0.3) {
    notMeasured.push(`Tempo with any confidence — the estimate of ${bpm.toFixed(1)} BPM beat its `
      + 'alternatives only weakly, so it should not be relied on.')
  }

  // The deviation, reported whether or not the check passed, because "116 BPM
  // asked for, 122 measured, +5.2%" is the useful sentence and "tempo-mismatch"
  // is not.
  const tempoDeviation = options.targetBpm !== undefined && options.targetBpm > 0
    ? {
      requestedBpm: options.targetBpm,
      measuredBpm: bpm > 0 ? bpm : null,
      deviationBpm: bpm > 0 ? bpm - options.targetBpm : null,
      deviationPercent: bpm > 0 ? ((bpm - options.targetBpm) / options.targetBpm) * 100 : null,
      confidence: bpmConfidence,
      requestedByUser: options.targetBpmStated === true,
    }
    : undefined

  if (failures.length > 0) {
    return { verdict: 'FAILED_VERIFICATION', measurements, failures, notes, notMeasured,
      ...(tempo ? { tempo } : {}), ...(tempoDeviation ? { tempoDeviation } : {}), usable: false }
  }

  // PASS is for a song with nothing to report at all. `notMeasured` is never
  // empty in a browser, so in practice the honest outcome here is
  // PASS_WITH_LIMITATIONS — and saying so is the point rather than a defect.
  const verdict: LiveVerdict = notes.length === 0 && notMeasured.length === 0
    ? 'PASS' : 'PASS_WITH_LIMITATIONS'

  return { verdict, measurements, failures, notes, notMeasured,
    ...(tempo ? { tempo } : {}), ...(tempoDeviation ? { tempoDeviation } : {}), usable: true }
}
