/**
 * The Song Studio: a prompt in, a finished track out.
 */

import { useCallback, useMemo, useRef, useState } from 'react'
import { Icon } from '../components/Icon'
import { Empty, Field, Panel, Progress, Segmented, Slider, Stat, Toggle } from '../components/controls'
import { useJob, isCancellation } from '../useJob'
import { useStudio, type NeuralTake } from '../../state/store'
import { GENRES } from '../../engine/compose/genres'
import { MOODS, type Mood } from '../../engine/compose/prompt'
import { NOTE_NAMES, SCALE_NAMES, type ScaleName } from '../../engine/theory/pitch'
import { chordChart } from '../../engine/compose/composer'
import { formatDuration } from '../../engine/core/units'
import { SING_PRESET_NAMES } from '../../engine/voice/singer'
import { countLineSyllables, detectLanguage, LANGUAGE_CHOICES, type LanguageId } from '../../engine/lang'
import { describeResult } from '../../engine/synth/validate'
import { checkSingability, STRUCTURE_TAGS } from '../../engine/lyrics/structure'
import {
  QUALITY_LABELS, QUALITY_SAMPLE_RATES,
  MAX_TAKES, type GenerateResult, type RenderQuality, type SongTake,
} from '../../workers/protocol'
import { INSTRUMENT_LABELS, type Score, type SectionKind } from '../../engine/compose/types'
import { downloadText, encodeAudio, downloadBlob, safeFilename } from '../../lib/files'
import { VOCAL_PRESETS, composeStyle, togglePreset } from '../../lib/vocalPresets'
import { isVocalStem, sumStems } from '../../lib/mixdown'
import { scoreToMidi } from '../../engine/export/midi'
import { scoreToLrc, scoreToSrt } from '../../engine/export/subtitles'
import { newProjectId, saveProject } from '../../lib/library'
import { linkProps } from '../../lib/router'
import { useNeuralEngine } from '../useNeuralEngine'
import {
  planLiveGeneration, compilePrompt, mintRequestTicket, aceStepKeyscale,
  buildTargetMelody, melodyPayload, anchorNotes, checkTargetMelody,
  type LivePlan, type CompiledPrompt, type LiveVerification,
} from '../../engine/live'
import { useAuth } from '../useAuth'
import { authorizationHeader, signOut } from '../../auth/hfOAuth'
import { reportQuota } from '../../state/quota'
import { decodeWav } from '../../engine/audio/wav'
import {
  AuthenticationRequiredError, createNeuralProvider,
  GenerationCancelledError, QuotaExceededError,
  engineLabel, resolveEngineMode, VERIFIED_ZEROGPU_DURATION, ACE_STEP_TEXT_LIMITS,
  describeFailure, STAGE_LABELS,
  type EngineMode, type GenerationFailure, type GenerationStatus, type NeuralBackend,
} from '../../engine/providers'
import {
  gateScoreTake, gateNeuralTake, describeAttempt,
  tempoRequirement, InvalidTempoRequest, type QualityReport,
} from '../../engine/quality'

/**
 * A title for a neural result.
 *
 * ACE-Step returns audio, not a name. The first sung line is what people
 * actually call a song by, so use that and fall back to the style.
 */
function songTitle(style: string, lyrics: string): string {
  const firstLine = lyrics.split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0 && !/^\[[^\]]+\]$/.test(line))
  const source = firstLine ?? style.trim()
  const words = source.split(/\s+/).slice(0, 6).join(' ')
  return words.replace(/[.,;:!?]+$/, '') || 'Untitled'
}

/**
 * What each generation state is called on screen.
 *
 * `idle` and `completed` say nothing, because the absence of a message is the
 * message. None of these carry a percentage: ACE-Step reports a stage, and a
 * bar that moved on a timer would be inventing the rest.
 */
const NEURAL_STATE_TEXT: Partial<Record<GenerationStatus['state'], string>> = {
  initializing: 'Preparing neural music engine…',
  queued: 'Waiting for the neural music engine…',
  generating: 'Generating song…',
  failed: 'Generation failed.',
  cancelled: 'Stopped waiting.',
}

/**
 * How many takes a run may actually write.
 *
 * Every neural take is its own generation. On the free ZeroGPU Space that means
 * its own slice of an allowance that covers about one song a day, so a run of
 * four would spend the day to return one song and three refusals — and hold
 * four decoded songs in memory while it tried.
 *
 * The cap is by backend, not by engine: a paid Space or an ACE-Step server on
 * your own machine has neither limit and keeps the takes it was asked for. The
 * offline engine is untouched, because its takes cost nothing but time.
 */
export function effectiveTakeCount(
  takeCount: number, engineMode: EngineMode, backend: NeuralBackend,
): number {
  return engineMode === 'neural' && backend === 'zerogpu' ? 1 : takeCount
}

/**
 * Where a live request is, from the person's point of view.
 *
 * The first three stages happen on this machine and cost nothing. Naming them
 * separately is the point: "rejected" has to be visibly different from
 * "failed", because one means the request never left and the other means it
 * did and something went wrong out there.
 */
export type LiveStage =
  | 'idle'
  /** Reading the Style and Lyrics into a musical plan. Local, free. */
  | 'planning'
  /** Refused before the network. No request was sent and no GPU was spent. */
  | 'rejected'
  /** The one request is on its way. */
  | 'sending'
  /** ACE-Step is generating. */
  | 'generating'
  /** Audio is back and is being decoded and measured. */
  | 'processing'
  /** Done, and the verification report is worth reading. */
  | 'completed'
  /** Audio came back with a measured technical defect. Not regenerated. */
  | 'failed-verification'
  /** The request itself failed. Nothing is retried automatically. */
  | 'failed'
  | 'cancelled'

/** What the interface says at each stage, in the words the requirement asks for. */
export const LIVE_STAGE_LABELS: Record<LiveStage, string> = {
  idle: '',
  planning: 'Preparing and validating locally — nothing sent yet',
  rejected: 'Pre-generation validation failed. No request was sent and no GPU time was used.',
  sending: 'One ACE-Step generation request started. No automatic regeneration will be performed.',
  generating: 'Generating — one request, one song',
  processing: 'Processing the result',
  completed: 'Audio verification completed',
  'failed-verification': 'Audio verification failed. The song was not regenerated.',
  failed: 'The generation request failed. Nothing was retried automatically.',
  cancelled: 'Stopped waiting.',
}

/**
 * Field names a person can read, for the failure panel.
 *
 * The keys are what the code carries; these are what they mean. An
 * unrecognised key is shown as-is rather than hidden, because a detail nobody
 * named is still evidence.
 */
export const DETAIL_LABELS: Record<string, string> = {
  httpStatus: 'HTTP status',
  spaceResponse: 'Space response',
  requestId: 'Request ID',
  errorName: 'Exception',
  cause: 'Underlying cause',
  engine: 'Engine',
  remainingSeconds: 'GPU seconds left',
  requestedSeconds: 'GPU seconds asked for',
  retryAt: 'Allowance resets at',
  detail: 'Space response',
  checks: 'Failed checks',
  syllables: 'Syllables',
  syllablesPerSecond: 'Syllables per second',
  minimumSeconds: 'Minimum seconds needed',
}

/**
 * A validation refusal, in the same shape as a failure from the Space.
 *
 * The person does not care which side of the network caught it; they care what
 * is wrong and whether pressing the button again could help. So this carries
 * the same stage, code, details and retryability as everything else that
 * reaches the failure panel — and `retryable: false`, always, because a request
 * the planner refused is refused identically every time it is sent.
 */
export function planFailure(plan: LivePlan): GenerationFailure {
  const errors = plan.problems.filter((problem) => problem.severity === 'error')
  const first = errors[0]
  const code: GenerationFailure['code'] =
    first?.code === 'TOO_LONG_FOR_DURATION' ? 'UNSUPPORTED_DURATION'
      : first?.code === 'EMPTY' || first?.code === 'NO_SUNG_LINES' ? 'LYRICS_TOO_LONG'
        : 'UNKNOWN'
  return {
    stage: 'request',
    code,
    message: errors.map((problem) => problem.message).join(' '),
    details: {
      checks: errors.map((problem) => problem.code).join(', '),
      syllables: plan.lyrics.syllables,
      ...(plan.lyrics.density > 0
        ? { syllablesPerSecond: Number(plan.lyrics.density.toFixed(2)) } : {}),
      ...(plan.lyrics.minimumDurationSeconds > 0
        ? { minimumSeconds: Math.ceil(plan.lyrics.minimumDurationSeconds) } : {}),
    },
    retryable: false,
  }
}

/** The host of an address, for display; the address itself when it is not one. */
function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

/** Two lines of a lyric, to show the shape rather than to be sung. */
/**
 * A MIDI note as a musician would say it: "A3", "C#4".
 *
 * Spelled with sharps throughout, which is wrong in a flat key and right
 * enough here — this labels the two ends of a vocal range, not a chord chart.
 * `songHarmony.ts` spells chords in the key's own accidentals, where it
 * matters.
 */
const NOTE_NAME = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
const noteLabel = (midi: number): string =>
  `${NOTE_NAME[((midi % 12) + 12) % 12]}${Math.floor(midi / 12) - 1}`

const LYRIC_PLACEHOLDER = `Aku masih di sini menunggu
Sampai malam berganti pagi`

/** The genres offered before the list is expanded — the ones people ask for most. */
const POPULAR_GENRES = ['pop', 'rock', 'edm', 'hiphop', 'rnb', 'jazz', 'lofi', 'folk']

/** The result panel's tabs, named once so a label can never drift from its tab. */
const DETAIL_TABS = [
  { id: 'lyrics', label: 'Lyrics' },
  { id: 'chords', label: 'Chords' },
  { id: 'stems', label: 'Stems' },
  { id: 'export', label: 'Export' },
] as const

type DetailTab = (typeof DETAIL_TABS)[number]['id']

const EXAMPLES = [
  'a warm lo-fi beat for studying, no vocals',
  'an upbeat pop song about the summer we almost had',
  'dark trap at 140 bpm with sliding 808s',
  'epic cinematic trailer music, minor key',
  'a sad acoustic folk song about leaving home',
  'k-pop dance track, bright and fast',
  'ambient music for sleep, four minutes',
  'a funk disco groove with brass stabs',
]

const SECTION_TONE: Record<SectionKind, string> = {
  intro: 'var(--text-faint)',
  verse: 'var(--signal)',
  prechorus: 'var(--text-dim)',
  chorus: 'var(--accent)',
  bridge: 'var(--text-dim)',
  solo: 'var(--signal)',
  drop: 'var(--accent)',
  breakdown: 'var(--text-faint)',
  outro: 'var(--text-faint)',
}

type VocalChoice = 'auto' | 'sung' | 'rap' | 'none'

/**
 * The neural engine's vocal gender. Auto asks for nothing: the style's own
 * words decide, which is what the validated Bos Toxic request relied on.
 */
type VocalGenderChoice = 'auto' | 'male' | 'female'

export default function StudioPage() {
  const job = useJob()
  const quality = useStudio((s) => s.quality)
  const setCurrent = useStudio((s) => s.setCurrent)
  const notify = useStudio((s) => s.notify)

  const [prompt, setPrompt] = useState('')
  const [advanced, setAdvanced] = useState(false)
  const [genreId, setGenreId] = useState('')
  const [mood, setMood] = useState<Mood | ''>('')
  const [bpm, setBpm] = useState(0)
  const [tonic, setTonic] = useState(-1)
  const [scale, setScale] = useState<ScaleName | ''>('')
  const [duration, setDuration] = useState(0)
  const [vocals, setVocals] = useState<VocalChoice>('auto')
  const [vocalGender, setVocalGender] = useState<VocalGenderChoice>('auto')
  const [singStyle, setSingStyle] = useState('')
  /**
   * Vocal hints, kept apart from what the person typed.
   *
   * Never written into the Style box. Their text stays theirs, the selection
   * lives here, and the two are joined only when a request is built — which is
   * what makes unticking a chip remove exactly its own words and nothing else.
   */
  const [vocalHints, setVocalHints] = useState<string[]>([])
  const [seed, setSeed] = useState('')
  const [allGenres, setAllGenres] = useState(false)
  const [customLyrics, setCustomLyrics] = useState('')
  const [language, setLanguage] = useState<LanguageId | 'auto'>('auto')

  // Read the lyric the way a singer would and surface what will not work, while
  // there is still time to change it.
  const lyricWarnings = useMemo(
    () => (customLyrics.trim()
      ? checkSingability(customLyrics, (line) =>
        countLineSyllables(line, language === 'auto' ? detectLanguage(customLyrics) : language))
      : []),
    [customLyrics, language],
  )

  const lyricCount = useMemo(
    () => customLyrics.split(/\r?\n/).filter((line) => line.trim().length > 0).length,
    [customLyrics],
  )
  // Shown next to the automatic option so it is obvious which language the
  // singer settled on before anything is rendered.
  const detectedName = useMemo(() => {
    if (!customLyrics.trim()) return undefined
    const detected = detectLanguage(customLyrics)
    return LANGUAGE_CHOICES.find((choice) => choice.id === detected)?.label
  }, [customLyrics])
  const [keepStems, setKeepStems] = useState(true)

  // Which engine makes the song. Never changed for the user: a neural request
  // that cannot be served fails and says so, rather than arriving as a
  // procedural song they would reasonably mistake for a neural one.
  // Derived rather than stored: until the user picks, the mode simply *is*
  // whatever the backend probe says, so there is no second copy of that fact
  // to fall out of step with the first.
  const [engineChoice, setEngineChoice] = useState<EngineMode | null>(null)
  // The neural generation lives in the store, not here: it keeps running when
  // this page unmounts, and a remount has to find it again rather than show an
  // idle studio above a job still on the GPU.
  const neuralJob = useStudio((s) => s.neural)
  const startNeural = useStudio((s) => s.startNeural)
  const updateNeural = useStudio((s) => s.updateNeural)
  const selectNeuralTake = useStudio((s) => s.selectNeuralTake)
  const clearNeural = useStudio((s) => s.clearNeural)
  const { takes: neuralTakes, index: neuralIndex, status: neuralStatus, controller: neuralController } = neuralJob
  /**
   * The last failure, in full.
   *
   * A string was not enough. The engine already knows which stage a request
   * died at and which code it died with, and throwing that away left "it
   * failed" as the only thing anyone could report — including from production,
   * where there is no console to read.
   */
  const [engineError, setEngineError] = useState<GenerationFailure | null>(null)
  const neural = useNeuralEngine()
  const auth = useAuth()

  // Move onto the neural engine once the backend has answered, and stay: a
  // later failed check must not flip the control back to the offline engine
  // under someone who saw Neural selected. This decides the position of a
  // control the user can see; it is never a fallback applied to a request.
  const engineMode: EngineMode = resolveEngineMode(engineChoice, neural.hasAnswered)
  // What the model will be sent. The hints only reach ACE-Step, so the offline
  // engine composes nothing and sees the caption exactly as written.
  const composedStyle = engineMode === 'neural' ? composeStyle(prompt, vocalHints) : prompt

  /**
   * Controls the neural request cannot carry.
   *
   * ACE-Step 1.5's endpoint takes a caption, a lyric sheet, a language, a
   * voice, an instrumental flag and a length. Genre, mood, tempo, key, singing
   * voice, seed and stems are read only by the offline engine — `generateNeural`
   * never looks at them. Left live in Neural Mode they are controls that do
   * nothing, and Seed was worse than nothing: it promised that the same seed
   * reproduces the same song, was accepted, was dropped by `planZeroGpuRequest`,
   * and a different, randomly drawn seed was then shown back with the result.
   *
   * They stay on screen — a control that vanishes teaches nothing, which is the
   * same reason Takes stays visible when it is capped — but disabled, and
   * saying why.
   */
  const neuralIgnores = engineMode === 'neural'
  const IGNORED_BY_NEURAL =
    'The neural engine takes its direction from the Style text. Write the tempo, key or mood there.'

  const chooseEngine = useCallback((mode: EngineMode) => {
    setEngineChoice(mode)
    setEngineError(null)
  }, [])

  const [takeCount, setTakeCount] = useState(1)
  // What the run will actually do, which on the free GPU is one take whatever
  // the control says. Computed here so the action and the control cannot
  // disagree — the action is the one that matters.
  const effectiveTakes = effectiveTakeCount(takeCount, engineMode, neural.backend)
  // Whether this backend caps takes at all — asked of the same rule rather
  // than restated here, so the control and the action can never disagree.
  const takesCapped = effectiveTakeCount(MAX_TAKES, engineMode, neural.backend) < MAX_TAKES
  // A run can write more than one song from the same brief. They are all kept
  // so the two can be compared without generating twice; `takeIndex` is the
  // one on screen and in the player.
  const [takes, setTakes] = useState<SongTake[]>([])
  /** The gate's verdict on what is currently open, or null before anything is. */
  const [qualityReport, setQualityReport] = useState<QualityReport | null>(null)
  /** One line per attempt, so a run that regenerated says so rather than just taking longer. */
  const [attemptLog, setAttemptLog] = useState<string[]>([])
  /**
   * The live pipeline's own state, one stage at a time.
   *
   * Separate from the neural job's `status` because they answer different
   * questions. The job's status is what the Space is doing; this is where the
   * request is in a pipeline whose first three stages never reach the Space at
   * all. Someone whose request was refused in validation needs to see that it
   * never left the machine.
   */
  const [liveStage, setLiveStage] = useState<LiveStage>('idle')
  const [livePlan, setLivePlan] = useState<LivePlan | null>(null)
  const [compiledPrompt, setCompiledPrompt] = useState<CompiledPrompt | null>(null)
  /**
   * What the vocal will be measured against, summarised for the panel.
   *
   * Shown because it is the one part of this pipeline that is easiest to
   * mistake for a control. ACE-Step has no melody input; this is a reference
   * the Space corrects the *returned* vocal against, and the panel says so in
   * those words rather than letting a row of notes imply otherwise.
   */
  const [melodySummary, setMelodySummary] = useState<{
    notes: number; anchors: number; phrases: number; key: string
    progressions: string; bars: number; lowest: number; highest: number
    usable: boolean; problems: string[]; checksPassed: number
  } | null>(null)
  const [liveVerification, setLiveVerification] = useState<LiveVerification | null>(null)
  /** Which press of Generate authorised the request in flight. */
  const [ticketId, setTicketId] = useState<string | null>(null)
  const [takeIndex, setTakeIndex] = useState(0)
  const result = takes[takeIndex] ?? null
  const [tab, setTab] = useState<DetailTab>('lyrics')
  const [saving, setSaving] = useState(false)
  const [renderedAt, setRenderedAt] = useState<RenderQuality>(quality)

  const score = result?.score ?? null

  /**
   * Says what actually came out.
   *
   * A file being returned is not the same as the song being made: a request for
   * a sung song that comes back as an instrumental, or with the voice buried
   * under the arrangement, has not succeeded and should not be reported as if
   * it had.
   */
  const reportResult = useCallback((validation: SongTake['validation']) => {
    if (validation.problems.length > 0) {
      notify(validation.problems[0]!, 'error')
      return
    }
    notify(describeResult(validation), 'success')
  }, [notify])

  /** Puts one take in the player and in the panels below it. */
  const openTake = useCallback((take: SongTake) => {
    setCurrent({
      title: take.score.title,
      subtitle: describeScore(take.score),
      audio: { channels: take.audio.channels, sampleRate: take.audio.sampleRate },
      score: take.score,
      lyrics: take.score.lyrics?.formatted,
      stems: take.stems.map((stem) => ({
        id: stem.id,
        name: stem.name,
        audio: { channels: stem.audio.channels, sampleRate: stem.audio.sampleRate },
      })),
      source: 'song',
    })
  }, [setCurrent])

  /** Puts one neural take in the player. */
  const openNeuralTake = useCallback((take: NeuralTake) => {
    const meta = take.result.metadata
    setCurrent({
      title: songTitle(prompt, customLyrics),
      subtitle: [
        engineLabel('ace-step'),
        meta?.model,
        meta?.bpm ? `${meta.bpm} BPM` : null,
        meta?.keyScale,
      ].filter(Boolean).join(' · '),
      audio: take.audio,
      lyrics: customLyrics,
      source: 'song',
    })
  }, [setCurrent, prompt, customLyrics])

  const chooseNeuralTake = useCallback((index: number) => {
    const take = neuralTakes[index]
    if (!take) return
    selectNeuralTake(index)
    openNeuralTake(take)
  }, [neuralTakes, selectNeuralTake, openNeuralTake])

  const chooseTake = useCallback((index: number) => {
    const take = takes[index]
    if (!take) return
    setTakeIndex(index)
    setSeed(take.score.seed)
    openTake(take)
  }, [takes, openTake])

  /**
   * Generates with ACE-Step.
   *
   * Every take is its own generation with its own seed — the model is asked
   * afresh each time rather than one file being varied, because a variation of
   * one render is not a second take of anything.
   */
  /**
   * One press of Generate, one ACE-Step request, one song.
   *
   * The order below is the guarantee, not a style choice. Everything that can
   * be decided or refused locally happens first, while it is still free:
   *
   *   1. plan       — genre, tempo, key, form, voice, arrangement, from the
   *                   Style and Lyrics, deterministically and offline.
   *   2. validate   — is this sheet singable in the time asked for? A request
   *                   that cannot be served is refused HERE, and no GPU is
   *                   spent on it.
   *   3. compile    — the plan becomes one caption inside ACE-Step's 512
   *                   characters, with what did not fit recorded rather than
   *                   silently dropped.
   *   4. ticket     — one permission to send, minted once, spent by the
   *                   provider before it opens a socket.
   *   5. generate   — exactly one call. There is no loop around it and no
   *                   second iteration is possible: the ticket is spent.
   *   6. verify     — measured once, reported, and never acted on by
   *                   generating again.
   *
   * There is deliberately no path from step 6 back to step 5.
   */
  const generateNeural = useCallback(async () => {
    const style = composedStyle.trim()
    const lyrics = customLyrics.trim()
    const instrumental = vocals === 'none'

    setLiveVerification(null)
    setCompiledPrompt(null)
    setMelodySummary(null)
    setLiveStage('planning')

    // ---------------------------------------------------- 1 and 2: plan ---
    const plan = planLiveGeneration({
      style,
      lyrics,
      ...(duration > 0 ? { durationSeconds: duration } : {}),
      instrumental,
      vocalGender,
      language,
    })
    setLivePlan(plan)

    if (!plan.valid) {
      // Refused before the network. Nothing was sent and no GPU was spent.
      //
      // Reported through the same panel as a failure from the Space rather than
      // as a toast, and for the same reason the Space's failures are: a toast
      // clears itself and takes the stage, the code and the numbers with it,
      // and it floats over the buttons someone needs to act. The stage is
      // `request`, because that is where this was caught, and nothing here is
      // retryable — a sheet too long for its length is too long however many
      // times it is sent.
      setLiveStage('rejected')
      setEngineError(planFailure(plan))
      return
    }

    // -------------------------------------------------------- 3: compile ---
    // The melody the vocal will be measured and corrected against. Written
    // from the plan, never from the audio: the audio is the thing being
    // judged, so it cannot also be the standard.
    const melody = buildTargetMelody(plan, vocalGender)
    // Checked before it is used, because of what it is used *for*. The
    // correction stage moves a real vocal onto this melody, so a melody that is
    // merely odd produces a vocal that is confidently and audibly wrong — every
    // structural note dragged onto it. The failure to prevent is not "no
    // correction", it is "correct pitch, wrong melody", which sounds worse than
    // the untouched take and reports success.
    //
    // A melody that fails is not sent. The song then comes back exactly as
    // ACE-Step made it, which is a real and safe outcome: it is where this
    // project started, and it is strictly better than correcting toward
    // something wrong.
    const melodyCheck = checkTargetMelody(melody)
    const melodyUsable = melodyCheck.usable && melody.notes.length > 0
    const sung = melody.notes.filter((note) => note.role !== 'rest')
    setMelodySummary(sung.length === 0 ? null : {
      usable: melodyUsable,
      problems: melodyCheck.problems.filter((problem) => problem.severity === 'error')
        .map((problem) => problem.message),
      checksPassed: melodyCheck.passed.length,
      notes: sung.length,
      anchors: anchorNotes(melody).length,
      phrases: new Set(sung.map((note) => note.phrase)).size,
      key: `${plan.music.keyName}`,
      progressions: [...new Set(melody.harmony.progressionIds)].join(', '),
      bars: melody.harmony.bars.length,
      lowest: Math.min(...sung.map((note) => note.midi)),
      highest: Math.max(...sung.map((note) => note.midi)),
    })
    const compiled = compilePrompt(plan, style)
    setCompiledPrompt(compiled)
    const controller = new AbortController()
    // The controller is this generation's identity from here on: every write
    // below is addressed to it, so a write that arrives after it has been
    // superseded is dropped rather than applied to whatever is running now.
    startNeural(controller)
    setEngineError(null)
    setLiveStage('sending')
    updateNeural(controller, { status: { state: 'initializing' } })

    // The bearer is borrowed at send time, so a token that arrives or is
    // dropped between presses is honoured without rebuilding anything.
    const provider = createNeuralProvider(undefined, { authorization: authorizationHeader })

    // --------------------------------------------------------- 4: ticket ---
    // One press, one ticket. The provider spends it before it opens a socket,
    // so nothing downstream can send a second request under this press —
    // a retry, a second candidate and a regeneration are all the same
    // impossible thing from here.
    const ticket = mintRequestTicket()
    setTicketId(ticket.id)

    try {
      // ------------------------------------------------------ 5: generate ---
      // One call. Not the first of a series — the only one.
      const result = await provider.generate({
        style: compiled.caption,
        // ACE-Step 1.5's own metadata fields, not prose in the caption. The
        // tempo and key the planner settled on are sent through the parameters
        // built to carry them, where the model's own estimate cannot overwrite
        // them. The caption no longer mentions either, so nothing is said
        // twice and less precisely.
        bpm: plan.music.targetBpm,
        keyscale: aceStepKeyscale(plan.music.tonic, plan.music.scale),
        // The melody the planner wrote, for the Space to correct the returned
        // vocal against. ACE-Step never sees it — there is no melody input —
        // so this is the reference, not a request.
        ...(melodyUsable ? { melody: JSON.stringify(melodyPayload(melody)) } : {}),
        // The parsed payload, not the raw box: identical to what was typed
        // except that an [End] marker and anything after it are left off,
        // which is what the marker means. Every line, header and direction of
        // the song itself travels exactly as written.
        lyrics: plan.lyrics.text,
        language: plan.music.language,
        ...(duration > 0 ? { duration } : {}),
        ...(vocalGender !== 'auto' ? { vocalGender } : {}),
        ...(instrumental ? { instrumental: true } : {}),
      }, {
        ticket,
        signal: controller.signal,
        onStatus: (status) => {
          if (status.state === 'generating') setLiveStage('generating')
          updateNeural(controller, { status })
        },
      })

      setLiveStage('processing')

      // The object URL is only a way to hand the file across; once it has been
      // read, the decoded audio is what the player and every export use.
      // Releasing it frees the whole download — about 52 MB for a 271-second
      // song — instead of holding it until the tab closes.
      let buffer: ArrayBuffer
      try {
        buffer = await (await fetch(result.audioUrl)).arrayBuffer()
      } finally {
        URL.revokeObjectURL(result.audioUrl)
      }
      const decoded = decodeWav(buffer)
      const take: NeuralTake = { result, audio: decoded }

      // -------------------------------------------------------- 6: verify ---
      // Measured once. Whatever it finds, it never causes another generation:
      // there is no ticket left and no code path that would mint one.
      // Run in the worker, not here. Measured at 1.8 seconds on a 271-second
      // stereo song — two seconds of a frozen tab, arriving at the exact moment
      // the song does, is the worst place in the whole flow to block.
      const measured = await job.run<{ kind: 'verify'; verification: LiveVerification }>(
        'Verifying the song', {
          kind: 'verify',
          audio: { channels: decoded.channels, sampleRate: decoded.sampleRate },
          options: {
            targetBpm: plan.music.targetBpm,
            targetBpmStated: plan.music.bpmStated,
            ...(duration > 0 ? { requestedDurationSeconds: duration } : {}),
            instrumental,
          },
        })
      setLiveVerification(measured.verification)
      const verification = measured.verification

      // The song is opened whichever way verification went, and labelled
      // accordingly. Withholding it would leave someone who has already spent
      // their GPU allowance with nothing at all; describing a failed one as a
      // success would be the lie this whole pipeline exists to avoid. So it is
      // handed over, with the verdict on it.
      updateNeural(controller, { takes: [take], index: 0 })
      openNeuralTake(take)
      // A neural take is one mixed file, and nothing in a browser can separate
      // the voice from the band well enough to ask whether the melody fits the
      // chords. The harmonic gate says so rather than guessing.
      setQualityReport(gateNeuralTake())
      setAttemptLog([])

      if (verification.verdict === 'FAILED_VERIFICATION') {
        setLiveStage('failed-verification')
        updateNeural(controller, { status: { state: 'completed' } })
        notify(`Audio verification failed: ${verification.failures[0]}`, 'error')
        return
      }
      setLiveStage('completed')
      updateNeural(controller, { status: { state: 'completed' } })
      notify('One ACE-Step request, one song. Verification report below.', 'success')
    } catch (error) {
      if (error instanceof GenerationCancelledError) {
        setLiveStage('cancelled')
        updateNeural(controller, { status: { state: 'cancelled' } })
        // ACE-Step has no cancellation endpoint, so this is the honest wording.
        notify('Stopped waiting. The backend may still be finishing this song.', 'info')
        return
      }
      // The Space has just refused this sign-in, so the session this page is
      // holding is worthless: end it, rather than keep saying "Signed in" above
      // a button that can only fail. Carried out of the session, because ending
      // it closes this page: the login screen shows this sentence instead of
      // appearing for no stated reason.
      if (error instanceof AuthenticationRequiredError) {
        signOut(error.message)
      }
      setLiveStage('failed')
      updateNeural(controller, { status: { state: 'failed' } })
      if (error instanceof QuotaExceededError && error.quota) reportQuota(error.quota)
      // Every failure lands here. The stage and the code are what make a
      // failure reportable, and a toast that clears itself takes them with it —
      // so this is the one report, and it stays until it is dealt with.
      // Nothing here generates again: a failed request cost one press, and the
      // next request costs another press.
      setEngineError(describeFailure(error))
    } finally {
      // Only ends the job if it is still this one.
      updateNeural(controller, { controller: null })
    }
  }, [composedStyle, customLyrics, language, duration, vocalGender, vocals,
      job, notify, openNeuralTake, startNeural, updateNeural])

  /**
   * One press, one render, one song.
   *
   * There is no regeneration loop here any more, and that is not a relaxation —
   * it is the consequence of moving the check to where it belongs. A score is a
   * list of notes and the chords under them, so whether the melody fits is
   * decided while composing, before a sample exists, and a note that does not
   * fit is moved to one the chord contains. `repairMelody` does that as the last
   * step of `composeSong`.
   *
   * The gate still runs, on the score that was actually rendered. It is a
   * check that the plan was sound rather than a filter deciding which of
   * several rolls to keep: 90 of 90 generated songs clear it after repair,
   * against 57 of 90 before. When it does fail, the studio says so and delivers
   * nothing, because a take that failed is still not something to hand over.
   */
  const generate = useCallback(async (overrideSeed?: string) => {
    const text = prompt.trim()
    if (!text && !genreId) {
      notify('Describe the song you want, or pick a genre.', 'error')
      return
    }
    // A tempo typed into the control is a requirement, not a hint. Zero means
    // none was asked for, which is not the same as one that passed.
    let wanted: ReturnType<typeof tempoRequirement> = null
    try {
      wanted = tempoRequirement(bpm > 0 ? bpm : null)
    } catch (error) {
      notify(error instanceof InvalidTempoRequest ? error.message : String(error), 'error')
      return
    }
    setQualityReport(null)
    setAttemptLog([])

    try {
      const output = await job.run<GenerateResult>('Generating song', {
        kind: 'generate',
        prompt: text,
        quality,
        keepStems,
        takes: takeCount,
        singStylePreset: singStyle || undefined,
        overrides: {
          ...(genreId ? { genreId } : {}),
          ...(mood ? { mood } : {}),
          ...(bpm > 0 ? { bpm } : {}),
          ...(tonic >= 0 ? { tonic } : {}),
          ...(scale ? { scale } : {}),
          ...(duration > 0 ? { durationSeconds: duration } : {}),
          ...(vocals !== 'auto' ? { vocals } : {}),
          ...(customLyrics.trim() ? { customLyrics } : {}),
          language,
          seed: overrideSeed ?? seed.trim() ?? `${text}|${Date.now()}`,
        },
      })

      const reports = output.takes.map((take) => gateScoreTake(take.score, { tempo: wanted }))
      const passing = reports.findIndex((report) => report.verdict === 'PASS')
      setAttemptLog([describeAttempt({
        attempt: 1,
        verdict: reports[passing >= 0 ? passing : 0]!.verdict,
        report: reports[passing >= 0 ? passing : 0]!,
        durationMs: 0,
      })])

      if (passing < 0) {
        // Nothing is opened. The repair is meant to make this unreachable, and
        // when it is reached the honest thing is to say the plan was unsound
        // rather than quietly hand over the song it produced.
        setQualityReport(reports[0]!)
        notify('The song did not pass the musical quality gate, so it was not opened. '
          + 'Press Generate to write a different one.', 'error')
        return
      }

      // Only takes that passed. A chooser is a list of things a person presses
      // play on, so a rejected take sitting in it is one that gets played.
      const kept = output.takes.filter((_, index) => reports[index]!.verdict === 'PASS')
      const first = output.takes[passing]!
      setTakes(kept)
      setTakeIndex(Math.max(0, kept.indexOf(first)))
      setRenderedAt(quality)
      setSeed(first.score.seed)
      setQualityReport(reports[passing]!)
      reportResult(first.validation)
      openTake(first)
      setTab(first.score.lyrics ? 'lyrics' : 'chords')
    } catch (error) {
      if (!isCancellation(error)) {
        // useJob already surfaced the message.
      }
    }
  }, [prompt, genreId, mood, bpm, tonic, scale, duration, vocals, customLyrics, language,
      singStyle, seed, quality, keepStems, takeCount, job, notify, reportResult, openTake])

  const busy = job.running || Boolean(neuralController)

  /**
   * Held from the moment a generation is asked for until it has finished.
   *
   * `busy` is derived from React state, and state has not necessarily flushed
   * between two keystrokes a tenth of a second apart — a held ⌘/Ctrl + Enter
   * repeats faster than that. This is set synchronously, so the second press is
   * refused by a value that has already changed.
   */
  const inFlight = useRef(false)

  /** One button, two engines. Which one is on screen, and never a substitute. */
  const generateSong = useCallback(async (overrideSeed?: string) => {
    // Every way in arrives here — both buttons and both ⌘/Ctrl + Enter
    // handlers — so the refusal belongs here rather than at each call site.
    // A second generation started while one is running would submit a second
    // job to the Space and spend a second slice of an allowance measured in
    // minutes a day, and it would leave the first one uncancellable: the
    // controller the Cancel button holds would have been overwritten by it.
    if (busy || inFlight.current) return
    inFlight.current = true
    try {
      if (engineMode === 'neural') {
        // The neural engine is for signed-in visitors only. The Space refuses
        // anyone it cannot name — this is the same refusal, said earlier and
        // more clearly, and it is the last of three: the button is disabled,
        // the panel above says why, and a keyboard shortcut arrives here.
        // Not a substitute for the Space's check, which is the one that counts.
        if (auth.status !== 'signed-in') {
          notify('Sign in with Hugging Face to use the neural engine.', 'error')
          return
        }
        setTakes([])
        await generateNeural()
        return
      }
      clearNeural()
      await generate(overrideSeed)
    } finally {
      inFlight.current = false
    }
  }, [busy, engineMode, generate, generateNeural, clearNeural, auth.status, notify])

  const cancelGeneration = useCallback(() => {
    if (neuralController) {
      neuralController.abort()
      return
    }
    job.cancel()
  }, [neuralController, job])

  /**
   * Renders the same score again at the selected quality. Auditioning in Draft
   * and exporting in Studio is the normal way to work, and recomposing would
   * throw away the take you just decided you liked.
   */
  const rerender = useCallback(async () => {
    if (!result) return
    try {
      const output = await job.run<GenerateResult>('Re-rendering', {
        kind: 'rerender',
        score: result.score,
        quality,
        keepStems,
        singStylePreset: singStyle || undefined,
      })
      const take = output.takes[0]!
      // Re-rendering replaces the take it came from, so switching back and
      // forth does not lose the stems that were just rendered for it.
      setTakes((current) => current.map((existing, index) => index === takeIndex ? take : existing))
      setRenderedAt(quality)
      reportResult(take.validation)
      openTake(take)
    } catch (error) {
      if (!isCancellation(error)) { /* reported by useJob */ }
    }
  }, [result, takeIndex, quality, keepStems, singStyle, job, reportResult, openTake])

  const saveToLibrary = useCallback(async () => {
    if (!result) return
    setSaving(true)
    try {
      const blob = await encodeAudio(
        { channels: result.audio.channels, sampleRate: result.audio.sampleRate },
        result.audio.sampleRate === 44100 || result.audio.sampleRate === 32000 || result.audio.sampleRate === 22050
          ? 'mp3-192'
          : 'wav16',
      )
      await saveProject({
        id: newProjectId(),
        title: result.score.title,
        prompt: prompt.trim() || result.score.genreId,
        genreId: result.score.genreId,
        bpm: result.score.bpm,
        createdAt: Date.now(),
        durationSeconds: (result.score.lengthBeats * 60) / result.score.bpm,
        score: result.score,
        audio: blob,
        audioType: blob.type,
        lyrics: result.score.lyrics?.formatted,
      })
      notify('Saved to your library on this device.', 'success')
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Could not save.', 'error')
    } finally {
      setSaving(false)
    }
  }, [result, prompt, notify])

  const playStem = useCallback((stemId: string) => {
    if (!result) return
    const stem = result.stems.find((s) => s.id === stemId)
    if (!stem) return
    setCurrent({
      title: `${result.score.title} — ${stem.name}`,
      subtitle: `Stem · ${describeScore(result.score)}`,
      audio: { channels: stem.audio.channels, sampleRate: stem.audio.sampleRate },
      score: result.score,
      source: 'stem',
    })
  }, [result, setCurrent])

  /**
   * Exports built from what the render already produced.
   *
   * The instrumental and the vocal-only version are the mix's own stems added
   * back together, so they match the finished song exactly and cost no time.
   */
  const exportMix = useCallback(async (which: 'instrumental' | 'vocals') => {
    if (!result) return
    const stems = result.stems.map((stem) => ({
      id: stem.id,
      name: stem.name,
      audio: { channels: stem.audio.channels, sampleRate: stem.audio.sampleRate },
    }))
    const mixed = sumStems(stems, (stem) =>
      which === 'vocals' ? isVocalStem(stem.id) : !isVocalStem(stem.id))
    if (!mixed) {
      notify(
        which === 'vocals'
          ? 'This song has no vocal track.'
          : 'This take has no stems. Render them from the Result panel first.',
        'error',
      )
      return
    }
    try {
      const blob = await encodeAudio(mixed, 'wav16')
      await downloadBlob(blob, `${safeFilename(result.score.title)}-${which}.wav`)
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Could not export.', 'error')
    }
  }, [result, notify])

  const exportMidi = useCallback(async () => {
    if (!result) return
    try {
      const bytes = scoreToMidi(result.score)
      await downloadBlob(
        new Blob([bytes as BlobPart], { type: 'audio/midi' }),
        `${safeFilename(result.score.title)}.mid`,
      )
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Could not write the MIDI file.', 'error')
    }
  }, [result, notify])

  const exportSubtitles = useCallback(async (format: 'srt' | 'lrc') => {
    if (!result) return
    const text = format === 'srt' ? scoreToSrt(result.score) : scoreToLrc(result.score)
    if (!text) {
      notify('This song has no sung lyrics to time.', 'error')
      return
    }
    await downloadText(text, `${safeFilename(result.score.title)}.${format}`)
  }, [result, notify])

  const hasVocalStem = result?.stems.some((stem) => isVocalStem(stem.id)) ?? false
  // A run that writes several takes hands them back without stems, because a
  // set per take is more memory than a phone has. Whichever take is kept can
  // have them rendered on its own.
  const stemsMissing = Boolean(result) && keepStems && result!.stems.length === 0

  return (
    <div className="grid gap-4">
      <header className="grid gap-2">
        <p className="t-label">Song Studio</p>
        <h1 className="t-display max-w-2xl">
          Describe a song. Get the whole thing.
        </h1>
        <p className="max-w-2xl text-[13.5px] leading-relaxed text-[var(--text-dim)]">
          Arrangement, chords, drums, instruments, a sung lead with lyrics and a full mix —
          composed and rendered on this device. Unlimited, unwatermarked, free.
        </p>
      </header>

      <Panel>
        <div className="grid gap-3">
          {/*
            Style and lyrics are the two things a song is made of, so they sit
            side by side and both are visible from the start: nobody should have
            to find a disclosure triangle to write their own words.
          */}
          <div className="grid gap-4 lg:grid-cols-2">
            <div className="grid content-start gap-3">
              <Field
                label="Style"
                htmlFor="prompt"
                hint="Genre, instruments, tempo, mood — whatever matters."
                action={
                  <div className="flex items-center gap-3">
                    {/*
                      ACE-Step's caption holds 512 characters. That is a model
                      limit, and a model limit is not a user limit: a longer
                      Style is compiled down to a caption rather than refused,
                      and the text here is kept whole. So this says what will
                      happen to it, not that something is wrong with it — a
                      counter shouting "945 over the limit" at somebody who has
                      done nothing wrong is the implementation leaking into the
                      product. It appears only in Neural Mode and only once the
                      compiler will have work to do.
                    */}
                    {engineMode === 'neural' && composedStyle.length > ACE_STEP_TEXT_LIMITS.style - 96 && (
                      <span className="flex items-center">
                        <span
                          className="t-num text-[11px] text-[var(--text-dim)]"
                          data-testid="style-length"
                          // "1457 slash 512" is not a sentence. The digits are
                          // for the eye; the span below says the same thing in
                          // words, and is the one a screen reader reads.
                          aria-hidden="true"
                        >
                          {composedStyle.length > ACE_STEP_TEXT_LIMITS.style
                            ? `${composedStyle.length} → ${ACE_STEP_TEXT_LIMITS.style}`
                            : `${composedStyle.length}/${ACE_STEP_TEXT_LIMITS.style}`}
                        </span>
                        {/*
                          Deliberately not an aria-label on the element above:
                          that would make a second thing on this row answer to
                          the name "Style", which is both a worse reading order
                          and an ambiguity for anything selecting by label.
                        */}
                        <span className="sr-only" role="status" aria-live="polite"
                          data-testid="style-length-detail">
                          {composedStyle.length > ACE_STEP_TEXT_LIMITS.style
                            ? `${composedStyle.length} characters. Your text is kept in full; a `
                              + `${ACE_STEP_TEXT_LIMITS.style} character caption will be compiled `
                              + 'from it for the model, and the studio will show you which parts '
                              + 'of it were sent.'
                            : `${composedStyle.length} of ${ACE_STEP_TEXT_LIMITS.style} characters`}
                        </span>
                      </span>
                    )}
                    <Toggle
                      label="Instrumental"
                      checked={vocals === 'none'}
                      onChange={(on) => setVocals(on ? 'none' : 'auto')}
                    />
                  </div>
                }
              >
                <textarea
                  id="prompt"
                  className="textarea"
                  placeholder="indie rock, soft punchy drums, 86 BPM, modern mix"
                  value={prompt}
                  rows={5}
                  onChange={(event) => setPrompt(event.target.value)}
                  onKeyDown={(event) => {
                    // generateSong, not generate: the second is the offline
                    // engine, and reaching it from here would hand someone in
                    // Neural Mode a procedural song without ever saying so.
                    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') void generateSong()
                  }}
                />
              </Field>

              {/*
                A genre is the one thing almost every request starts with, so
                it gets a row of its own rather than being buried in the panel
                of controls. The chips set the genre outright; the description
                above is still free to say anything else about the sound.
              */}
              <div className="flex flex-wrap items-center gap-1.5">
                <button
                  type="button"
                  className="chip shrink-0 !px-2"
                  aria-expanded={allGenres}
                  aria-label={allGenres ? 'Show fewer genres' : 'Show every genre'}
                  onClick={() => setAllGenres((open) => !open)}
                >
                  <Icon name="chevron" size={12} className={allGenres ? 'rotate-180' : ''} />
                </button>
                {(allGenres ? GENRES : GENRES.filter((genre) => POPULAR_GENRES.includes(genre.id)))
                  .map((genre) => (
                    <button
                      key={genre.id}
                      type="button"
                      className="chip shrink-0"
                      aria-pressed={genreId === genre.id}
                      onClick={() => setGenreId(genreId === genre.id ? '' : genre.id)}
                    >
                      {genre.label}
                    </button>
                  ))}
              </div>

              <div className="scroll-x scroll-fade -mx-1 flex gap-1.5 px-1 pb-1">
                {EXAMPLES.map((example) => (
                  <button
                    key={example}
                    type="button"
                    className="chip shrink-0"
                    onClick={() => setPrompt(example)}
                  >
                    {example}
                  </button>
                ))}
              </div>

              {/*
                Vocal hints. Neural mode only, because the caption is the only
                thing they travel in and the offline engine does not read it the
                same way — a chip that did nothing here would be exactly the
                inert control the Seed field used to be.

                They are never written into the Style box. The box stays the
                person's, the selection lives beside it, and the two are joined
                when the request is built, which is why unticking one takes its
                own words away and leaves everything else alone.
              */}
              {engineMode === 'neural' && (
                <div className="grid gap-1.5">
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="t-label">Vocal hints</span>
                    <span className="text-[11px] text-[var(--text-faint)]">optional</span>
                  </div>
                  <div className="scroll-x scroll-fade -mx-1 flex gap-1.5 px-1 pb-1">
                    {VOCAL_PRESETS.map((preset) => (
                      <button
                        key={preset.id}
                        type="button"
                        className="chip shrink-0"
                        aria-pressed={vocalHints.includes(preset.id)}
                        title={preset.description}
                        data-testid={`vocal-hint-${preset.id}`}
                        onClick={() => setVocalHints((chosen) => togglePreset(chosen, preset.id))}
                      >
                        {preset.label}
                      </button>
                    ))}
                  </div>
                  <p className="text-[11.5px] leading-snug text-[var(--text-faint)]">
                    Added to the end of your style when you generate; your own words are
                    left exactly as you wrote them. ACE-Step has no pitch, key or melody
                    control, so these describe the performance you want — they do not
                    make the model sing a particular note.
                  </p>
                  {vocalHints.length > 0 && (
                    <details className="text-[11.5px] text-[var(--text-faint)]">
                      <summary className="cursor-pointer">See the style that will be sent</summary>
                      <p className="mt-1 whitespace-pre-wrap break-words" data-testid="composed-style">
                        {composedStyle}
                      </p>
                    </details>
                  )}
                </div>
              )}
            </div>

            <div className="grid content-start gap-3">
              <Field
                label="Lyrics"
                htmlFor="own-lyrics"
                value={lyricCount > 0 ? `${lyricCount} lines` : 'Optional'}
                hint="One line per phrase, a blank line between sections. Leave it empty and the studio writes its own."
              >
                <div className="scroll-x scroll-fade -mx-1 flex gap-1.5 px-1 pb-1">
                  {STRUCTURE_TAGS.flatMap((group) => group.tags).map((tag) => (
                    <button
                      key={tag}
                      type="button"
                      className="chip shrink-0"
                      title={`Insert [${tag}]`}
                      onClick={() => setCustomLyrics((current) =>
                        `${current.replace(/\s*$/, '')}${current.trim() ? '\n\n' : ''}[${tag}]\n`)}
                    >
                      {tag}
                    </button>
                  ))}
                </div>
                <textarea
                  id="own-lyrics"
                  className="textarea"
                  rows={5}
                  placeholder={LYRIC_PLACEHOLDER}
                  value={customLyrics}
                  onChange={(event) => setCustomLyrics(event.target.value)}
                  onKeyDown={(event) => {
                    // generateSong, not generate: the second is the offline
                    // engine, and reaching it from here would hand someone in
                    // Neural Mode a procedural song without ever saying so.
                    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') void generateSong()
                  }}
                />
              </Field>

              {lyricWarnings.length > 0 && (
                <ul className="grid gap-1 text-[11.5px] leading-snug text-[var(--warn,var(--text-dim))]">
                  {lyricWarnings.slice(0, 3).map((warning) => (
                    <li key={`${warning.line}-${warning.reason}`}>
                      {warning.line > 0 ? `Line ${warning.line}: ` : ''}{warning.reason}
                    </li>
                  ))}
                </ul>
              )}

              <Field
                label="Pronunciation"
                htmlFor="lyric-language"
                value={language === 'auto' ? detectedName : undefined}
                hint="The singer uses this language’s own vowels and consonants, not English ones."
              >
                <select
                  id="lyric-language"
                  className="select"
                  value={language}
                  onChange={(event) => setLanguage(event.target.value as LanguageId | 'auto')}
                >
                  {LANGUAGE_CHOICES.map((choice) => (
                    <option key={choice.id} value={choice.id}>
                      {choice.id === 'auto' ? choice.label : `${choice.label} — ${choice.native}`}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
          </div>

          {/* Which engine, and whether the neural one is actually there. */}
          <div className="grid gap-2 rounded-[10px] border border-[var(--line)] p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Segmented
                ariaLabel="Generation engine"
                value={engineMode}
                onChange={(value) => chooseEngine(value as EngineMode)}
                options={[
                  { value: 'neural', label: 'Neural', title: 'ACE-Step 1.5 — needs the backend running' },
                  { value: 'procedural', label: 'Offline Procedural', title: 'Composes and sings in this tab' },
                ]}
              />
              <p className="flex items-center gap-1.5 text-[12px] text-[var(--text-dim)]">
                <span aria-hidden="true" style={{
                  color: neural.connection === 'connected' ? 'var(--good, #4ade80)'
                    : neural.connection === 'checking' ? 'var(--text-dim)' : 'var(--bad, #f87171)',
                }}>●</span>
                <span>
                  Neural Engine:{' '}
                  {neural.connection === 'connected' ? 'Connected'
                    : neural.connection === 'checking' ? 'Checking…' : 'Not Connected'}
                </span>
                <button type="button" className="btn btn-ghost btn-sm" onClick={neural.recheck}>
                  Re-check
                </button>
              </p>
              {/* Who the Space will be asked as. The sign-in itself happens at
                  the door — the application does not render at all without one
                  — so this is a reminder of which account is about to spend a
                  GPU allowance, not a control. Signing out is in the sidebar,
                  where it belongs: it closes every tool, not only this one. */}
              {engineMode === 'neural' && (
                <p className="flex flex-wrap items-center gap-2 text-[12px] text-[var(--text-dim)]"
                   data-testid="hf-auth">
                  <span>Generating as <strong>{auth.identity?.username}</strong> on Hugging Face.</span>
                  {auth.problem && <span className="text-[var(--bad,#f87171)]">{auth.problem}</span>}
                  <span className="opacity-70">Signing out does not stop a song already being made.</span>
                </p>
              )}
            </div>
            <p className="text-[12px] leading-relaxed text-[var(--text-dim)]">
              {engineMode !== 'neural'
                ? 'Composes, sings and mixes on this device. Works offline and costs nothing; the singer is synthesised.'
                : neural.blockedReason
                  ? neural.blockedReason
                  : neural.backend === 'zerogpu'
                    ? `ACE-Step 1.5 on a free Hugging Face ZeroGPU Space (${hostOf(neural.baseUrl)}). `
                      + 'Generates a complete song with a sung vocal in one request; each visitor has a daily GPU allowance.'
                      + (neural.connection === 'disconnected' && neural.detail ? ` Not reachable: ${neural.detail}.` : '')
                    : `ACE-Step 1.5 at ${neural.baseUrl}${neural.loadedModel ? ` — ${neural.loadedModel}` : ''}. Generates a complete song with a sung vocal.`}
            </p>
          </div>

          {/*
            The whole diagnosis, not a sentence. The stage says how far the
            request got, the code is stable enough to search for and to quote in
            a bug report, and the details are whatever the thrower actually knew
            — never a placeholder. Try again appears only where trying again
            could work: a style that is too long is too long every time.
          */}
          {engineError && (
            <div className="grid gap-2 rounded-[10px] border border-[var(--line)] p-3" role="alert"
              data-testid="engine-error">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="t-label text-[10px] text-[var(--text-dim)]">
                  {STAGE_LABELS[engineError.stage]}
                </span>
                <span className="t-num text-[10px] text-[var(--text-faint)]"
                  data-testid="engine-error-code">
                  {engineError.code}
                </span>
              </div>
              <p className="text-[13px]" data-testid="engine-error-message">{engineError.message}</p>
              {/*
                Said in words, not left to be inferred from whether a button
                appeared. "Nothing was retried automatically" tells a person
                what did not happen; this tells them what to do next.
              */}
              <p className="text-[11.5px] text-[var(--text-faint)]"
                data-testid="engine-error-retryable">
                {engineError.retryable
                  ? 'Pressing Generate again could work — this is worth one more attempt.'
                  : 'Pressing Generate again would fail the same way. Change the request first.'}
              </p>
              {Object.keys(engineError.details).length > 0 && (
                <dl className="grid gap-0.5 text-[11.5px] text-[var(--text-faint)]"
                  data-testid="engine-error-details">
                  {Object.entries(engineError.details).map(([name, value]) => (
                    <div key={name} className="flex gap-2">
                      <dt className="min-w-[9rem]">{DETAIL_LABELS[name] ?? name}</dt>
                      <dd className="t-num break-all">{String(value)}</dd>
                    </div>
                  ))}
                </dl>
              )}
              <div className="flex flex-wrap gap-2">
                {engineError.retryable && (
                  <button type="button" className="btn btn-sm btn-primary"
                    data-testid="engine-error-retry"
                    title="Starts a new generation. Nothing is retried automatically — this is a
                      second press of Generate and it costs a second request."
                    onClick={() => { setEngineError(null); void generateSong() }}>
                    Generate again
                  </button>
                )}
                <button type="button" className="btn btn-sm" onClick={neural.recheck}>
                  Re-check the backend
                </button>
                <button type="button" className="btn btn-sm"
                  onClick={() => chooseEngine('procedural')}>
                  Use Offline Procedural Mode
                </button>
              </div>
            </div>
          )}

          {engineMode === 'neural' && liveStage !== 'idle' && (
            <div
              className="grid gap-2 rounded-[var(--radius)] border p-3 text-[13px]"
              style={{
                borderColor: liveStage === 'rejected' || liveStage === 'failed'
                  || liveStage === 'failed-verification'
                  ? 'var(--bad, #a33)' : 'var(--line)',
              }}
              data-testid="live-pipeline"
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[11px] uppercase tracking-wide text-[var(--text-faint)]">
                  Live ACE-Step pipeline
                </span>
                {ticketId && (
                  <span className="t-num text-[10px] text-[var(--text-faint)]"
                    data-testid="live-ticket">{ticketId}</span>
                )}
              </div>
              <p className="text-[13px]" data-testid="live-stage">{LIVE_STAGE_LABELS[liveStage]}</p>

              {livePlan && (
                <>
                  <p className="text-[11.5px] text-[var(--text-dim)]" data-testid="live-validation">
                    {!livePlan.valid
                      ? 'Pre-generation validation failed. Nothing was sent to the Space.'
                      : livePlan.problems.some((problem) => problem.severity === 'conflict')
                        ? 'Pre-generation validation passed with a constraint conflict. '
                          + 'Your lyrics are being sent in full, exactly as written.'
                        : 'Pre-generation validation passed.'}
                  </p>
                  {livePlan.problems.length > 0 && (
                    <ul className="grid gap-1.5 text-[11.5px]" data-testid="live-problems">
                      {livePlan.problems.map((problem, index) => (
                        <li key={`${problem.code}-${index}`}
                          data-severity={problem.severity}
                          style={{ color: problem.severity === 'error'
                            ? 'var(--bad, #a33)'
                            : problem.severity === 'conflict'
                              ? 'var(--warn, #9a6b00)' : 'var(--text-faint)' }}>
                          <span className="t-num text-[10px]">{problem.code}</span> {problem.message}
                          {problem.consequence && (
                            // A conflict says what will happen, because the
                            // person is the one choosing whether to accept it.
                            <span className="mt-0.5 block text-[var(--text-faint)]"
                              data-testid="live-consequence">{problem.consequence}</span>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                  <dl className="grid gap-0.5 text-[11.5px] text-[var(--text-faint)]"
                    data-testid="live-plan">
                    <div className="flex gap-2"><dt className="min-w-[8rem]">Genre</dt>
                      <dd>{livePlan.music.genre}</dd></div>
                    <div className="flex gap-2"><dt className="min-w-[8rem]">Target tempo</dt>
                      <dd className="t-num">{livePlan.music.targetBpm} BPM</dd></div>
                    <div className="flex gap-2"><dt className="min-w-[8rem]">Key</dt>
                      <dd>{livePlan.music.keyName}</dd></div>
                    <div className="flex gap-2"><dt className="min-w-[8rem]">Form</dt>
                      <dd>{livePlan.music.form.map((section) => section.label).join(' · ')}</dd></div>
                    {!livePlan.music.instrumental && (
                      <div className="flex gap-2"><dt className="min-w-[8rem]">Lyric density</dt>
                        <dd className="t-num">
                          {livePlan.lyrics.syllables} syllables
                          {livePlan.lyrics.density > 0
                            ? `, ${livePlan.lyrics.density.toFixed(2)}/s` : ''}
                        </dd></div>
                    )}
                  </dl>
                </>
              )}

              {compiledPrompt && livePlan && (
                <details className="text-[11.5px]" data-testid="live-caption">
                  <summary className="cursor-pointer text-[var(--text-dim)]">
                    What you wrote, and what was sent ·{' '}
                    {compiledPrompt.characters}/{compiledPrompt.limit} caption characters
                  </summary>

                  {/* Two panes, labelled, so nobody has to guess which text the
                      model received. The left is theirs and is never edited;
                      the right is the compiled payload. */}
                  <div className="mt-2 grid gap-2 sm:grid-cols-2">
                    <div className="grid gap-1">
                      <span className="t-label text-[10px] text-[var(--text-faint)]">
                        Your input — kept exactly
                      </span>
                      <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded-[var(--radius)]
                        border border-[var(--line)] p-2 text-[11px] text-[var(--text-faint)]"
                        data-testid="live-original">{livePlan.lyrics.script.original || '(none)'}</pre>
                    </div>
                    <div className="grid gap-1">
                      <span className="t-label text-[10px] text-[var(--text-faint)]">
                        Sent to ACE-Step
                      </span>
                      <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded-[var(--radius)]
                        border border-[var(--line)] p-2 text-[11px] text-[var(--text-faint)]"
                        data-testid="live-payload">{livePlan.lyrics.text || '(instrumental)'}</pre>
                    </div>
                  </div>

                  <p className="mt-2 t-label text-[10px] text-[var(--text-faint)]">Compiled caption</p>
                  <p className="whitespace-pre-wrap text-[var(--text-faint)]"
                    data-testid="live-caption-text">{compiledPrompt.caption}</p>

                  {/* Planned, sent, dropped — stated as three counts, because
                      "planned" and "the model was told" are different claims. */}
                  <dl className="mt-2 grid gap-0.5 text-[11px] text-[var(--text-faint)]"
                    data-testid="live-constraints">
                    <div className="flex gap-2"><dt className="min-w-[5rem]">Planned</dt>
                      <dd>{compiledPrompt.included.length + compiledPrompt.dropped.length} directions
                        {livePlan.lyrics.script.directions.length > 0
                          ? `, plus ${livePlan.lyrics.script.directions.length} section direction(s) in the sheet`
                          : ''}</dd></div>
                    <div className="flex gap-2"><dt className="min-w-[5rem]">Sent</dt>
                      <dd>{compiledPrompt.included.join(', ') || 'none'}</dd></div>
                    <div className="flex gap-2"><dt className="min-w-[5rem]">Dropped</dt>
                      <dd data-testid="live-caption-dropped">
                        {compiledPrompt.dropped.length === 0 ? 'none'
                          : compiledPrompt.dropped.join(', ')}</dd></div>
                  </dl>
                  {compiledPrompt.dropped.length > 0 && (
                    <p className="mt-1 text-[var(--text-faint)]">
                      The dropped directions did not fit in ACE-Step&rsquo;s {compiledPrompt.limit}-character
                      caption. The model was never told about them, so nothing about them is enforced.
                      Your Style and Lyrics are unchanged.
                    </p>
                  )}
                  {livePlan.lyrics.script.directions.length > 0 && (
                    <p className="mt-1 text-[var(--text-faint)]" data-testid="live-section-directions">
                      Section directions travel inside the lyric sheet and were all sent:{' '}
                      {livePlan.lyrics.script.directions
                        .map((entry) => `${entry.section} — ${entry.direction}`).join(' · ')}.
                    </p>
                  )}

                  {/* The third category, and the one most easily assumed. "Sent"
                      and "enforced" are not the same thing: ACE-Step's endpoint
                      binds six inputs and every musical direction above rides
                      in a caption or a lyric sheet, which the model reads and
                      may ignore. Saying so here, next to the counts, is the
                      difference between a report and a sales pitch. */}
                  <div className="mt-2 grid gap-0.5 text-[11px]" data-testid="live-enforcement">
                    <span className="t-label text-[10px] text-[var(--text-faint)]">
                      Actually enforced by the API
                    </span>
                    <p className="text-[var(--text-faint)]">
                      Binding: the lyric text, the language, the instrumental flag, and the length
                      (as a token budget the decoder must end at). That is the whole list — the
                      endpoint takes six inputs.
                    </p>
                    <p className="text-[var(--text-faint)]">
                      Description only, and not enforced: tempo, key, chord movement, melody,
                      arrangement, section directions, mix and master. There is no parameter for
                      any of them, so each is a request the model may follow or ignore. Whether it
                      did is measured afterwards, not guaranteed beforehand.
                    </p>
                  </div>
                </details>
              )}

              {melodySummary && (
                <div className="grid gap-0.5 text-[11px]" data-testid="live-melody">
                  <span className="t-label text-[10px] text-[var(--text-faint)]">
                    The vocal reference
                  </span>
                  <p className="text-[var(--text-faint)]">
                    {melodySummary.notes} notes across {melodySummary.phrases} sung lines, over
                    {' '}{melodySummary.bars} bars of {melodySummary.key}
                    {melodySummary.progressions ? ` (${melodySummary.progressions})` : ''}, from
                    {' '}{noteLabel(melodySummary.lowest)} to {noteLabel(melodySummary.highest)}.
                    {' '}{melodySummary.anchors} of them are structural: the notes that have to be
                    right for the song to be in tune.
                  </p>
                  <p className="text-[var(--text-faint)]">
                    ACE-Step never sees this. It has no melody input, so this is not a request —
                    it is the reference the vocal that comes back is measured and corrected
                    against. Without it, "correct the pitch" would mean snapping every note to
                    its own nearest semitone, which leaves a wrong note exactly where it was and
                    reports success.
                  </p>
                  {melodySummary.usable ? (
                    <p className="text-[var(--text-faint)]" data-testid="live-melody-checks">
                      {melodySummary.checksPassed} musical checks passed — key, chords, range,
                      leaps, phrase endings, section joins, chorus lift, climax, note lengths,
                      overlap, melisma, breaths and suspensions.
                    </p>
                  ) : (
                    <div data-testid="live-melody-rejected">
                      <p style={{ color: 'var(--bad, #a33)' }}>
                        This melody did not pass its own musical checks, so it is not being sent
                        as a correction reference. The song will come back exactly as ACE-Step
                        makes it. Correcting a vocal onto a melody that is wrong sounds worse
                        than leaving it alone.
                      </p>
                      {melodySummary.problems.map((problem, index) => (
                        <p key={index} className="text-[var(--text-faint)]">{problem}</p>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {liveVerification && (
                <div className="grid gap-1" data-testid="live-verification">
                  <span className="t-num text-[11.5px] font-medium"
                    data-testid="live-verdict">{liveVerification.verdict}</span>
                  {liveVerification.failures.map((failure, index) => (
                    <p key={index} className="text-[11.5px]" style={{ color: 'var(--bad, #a33)' }}>
                      {failure}
                    </p>
                  ))}
                  {liveVerification.notes.map((note, index) => (
                    <p key={index} className="text-[11.5px] text-[var(--text-faint)]">{note}</p>
                  ))}
                  {liveVerification.measurements && (
                    <dl className="grid gap-0.5 text-[11.5px] text-[var(--text-faint)]"
                      data-testid="live-measurements">
                      <div className="flex gap-2"><dt className="min-w-[8rem]">Duration</dt>
                        <dd className="t-num">
                          {liveVerification.measurements.durationSeconds.toFixed(1)}s</dd></div>
                      <div className="flex gap-2"><dt className="min-w-[8rem]">Measured tempo</dt>
                        <dd className="t-num">
                          {liveVerification.measurements.bpm > 0
                            ? `${liveVerification.measurements.bpm.toFixed(1)} BPM`
                            : 'not measurable'}</dd></div>
                      {liveVerification.tempoDeviation && (
                        <div className="flex gap-2" data-testid="live-bpm-deviation">
                          <dt className="min-w-[8rem]">
                            {liveVerification.tempoDeviation.requestedByUser
                              ? 'Tempo you asked for' : 'Tempo planned'}
                          </dt>
                          <dd className="t-num">
                            {liveVerification.tempoDeviation.requestedBpm} BPM
                            {liveVerification.tempoDeviation.deviationBpm !== null
                              ? ` · off by ${liveVerification.tempoDeviation.deviationBpm > 0 ? '+' : ''}`
                                + `${liveVerification.tempoDeviation.deviationBpm.toFixed(1)} BPM `
                                + `(${liveVerification.tempoDeviation.deviationPercent!.toFixed(1)}%)`
                              : ' · deviation not measurable'}
                          </dd>
                        </div>
                      )}
                      <div className="flex gap-2"><dt className="min-w-[8rem]">Peak / RMS</dt>
                        <dd className="t-num">
                          {liveVerification.measurements.peakDb.toFixed(1)} /{' '}
                          {liveVerification.measurements.rmsDb.toFixed(1)} dBFS</dd></div>
                      <div className="flex gap-2"><dt className="min-w-[8rem]">Loudness</dt>
                        <dd className="t-num">
                          {liveVerification.measurements.lufs.toFixed(1)} LUFS</dd></div>
                      <div className="flex gap-2"><dt className="min-w-[8rem]">Clipped samples</dt>
                        <dd className="t-num">
                          {(liveVerification.measurements.clippedShare * 100).toFixed(3)}%</dd></div>
                      <div className="flex gap-2"><dt className="min-w-[8rem]">Silence</dt>
                        <dd className="t-num">
                          {(liveVerification.measurements.silentShare * 100).toFixed(1)}%, longest{' '}
                          {liveVerification.measurements.longestSilenceSeconds.toFixed(1)}s</dd></div>
                      <div className="flex gap-2"><dt className="min-w-[8rem]">Voice-band activity</dt>
                        <dd className="t-num">
                          {(liveVerification.measurements.voiceActivityShare * 100).toFixed(0)}%</dd></div>
                    </dl>
                  )}
                  <details className="text-[11.5px]">
                    <summary className="cursor-pointer text-[var(--text-dim)]">
                      Some musical properties cannot be deterministically guaranteed by ACE-Step
                    </summary>
                    <ul className="mt-1 grid gap-1 text-[var(--text-faint)]"
                      data-testid="live-not-measured">
                      {liveVerification.notMeasured.map((item, index) => (
                        <li key={index}>{item}</li>
                      ))}
                    </ul>
                  </details>
                </div>
              )}
            </div>
          )}

          {qualityReport && (
            <div
              className="grid gap-2 rounded-[var(--radius)] border p-3 text-[13px]"
              style={{
                borderColor: qualityReport.verdict === 'PASS'
                  ? 'var(--ok, #2f7d52)' : 'var(--line)',
              }}
              data-testid="quality-gate"
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[11px] uppercase tracking-wide text-[var(--text-faint)]">
                  Musical quality gate
                </span>
                <span className="t-num text-[11.5px] font-medium" data-testid="quality-verdict">
                  {qualityReport.verdict === 'PASS' ? 'Quality gate passed'
                    : qualityReport.verdict === 'REGENERATION_REQUIRED' ? 'Regeneration required'
                      : qualityReport.verdict === 'ANALYSIS_UNAVAILABLE'
                        ? 'Not verified — analysis unavailable'
                        : 'Not verified — review required'}
                </span>
              </div>
              <p className="text-[12.5px] font-medium" data-testid="quality-headline">
                {qualityReport.accepted
                  ? 'Audio generated and passed all required quality checks.'
                  : qualityReport.verdict === 'REGENERATION_REQUIRED'
                    ? 'Audio generated, but quality validation failed.'
                    : 'Audio generated, but quality validation could not be completed.'}
              </p>
              {qualityReport.rejectionReasons.length > 0 && (
                <ul className="flex flex-wrap gap-1" data-testid="quality-rejection-reasons">
                  {qualityReport.rejectionReasons.map((code) => (
                    <li key={code}
                      className="rounded border px-1.5 py-0.5 text-[10.5px] tracking-wide"
                      style={{ borderColor: 'var(--line)' }}>
                      {code}
                    </li>
                  ))}
                </ul>
              )}
              {qualityReport.tempo && qualityReport.tempo.requestedBpm !== null && (
                <dl className="grid gap-0.5 text-[11.5px] text-[var(--text-faint)]"
                  data-testid="quality-tempo">
                  <div className="flex gap-2">
                    <dt className="min-w-[13rem]">Requested tempo</dt>
                    <dd className="t-num">{qualityReport.tempo.requestedBpm} BPM</dd>
                  </div>
                  <div className="flex gap-2">
                    <dt className="min-w-[13rem]">Detected tempo</dt>
                    <dd className="t-num">
                      {qualityReport.tempo.detectedBpm === null
                        ? 'not measurable'
                        : `${qualityReport.tempo.detectedBpm.toFixed(1)} BPM`}
                    </dd>
                  </div>
                  <div className="flex gap-2">
                    <dt className="min-w-[13rem]">Difference</dt>
                    <dd className="t-num">
                      {qualityReport.tempo.differenceBpm === null
                        ? '—'
                        : `${qualityReport.tempo.differenceBpm.toFixed(1)} BPM `
                          + `(${qualityReport.tempo.toleranceBpm ?? 0} allowed)`}
                    </dd>
                  </div>
                </dl>
              )}
              {qualityReport.reasons.map((reason) => (
                <p key={reason} className="text-[12.5px] text-[var(--text-dim)]">{reason}</p>
              ))}
              {qualityReport.measurements && (
                <dl className="grid gap-0.5 text-[11.5px] text-[var(--text-faint)]"
                  data-testid="quality-measurements">
                  <div className="flex gap-2">
                    <dt className="min-w-[13rem]">Harmonic compatibility</dt>
                    <dd className="t-num">
                      {qualityReport.measurements.harmonicCompatibility.toFixed(3)}
                    </dd>
                  </div>
                  <div className="flex gap-2">
                    <dt className="min-w-[13rem]">Severe harmonic conflicts</dt>
                    <dd className="t-num">{qualityReport.measurements.severeConflicts}</dd>
                  </div>
                  <div className="flex gap-2">
                    <dt className="min-w-[13rem]">Notes clashing with the chord</dt>
                    <dd className="t-num">
                      {qualityReport.measurements.strongChordConflictPercent.toFixed(1)}%
                    </dd>
                  </div>
                  <div className="flex gap-2">
                    <dt className="min-w-[13rem]">Notes outside the key</dt>
                    <dd className="t-num">
                      {qualityReport.measurements.strongOutOfKeyPercent.toFixed(1)}%
                    </dd>
                  </div>
                  <div className="flex gap-2">
                    <dt className="min-w-[13rem]">Vocal analysis coverage</dt>
                    <dd className="t-num">
                      {qualityReport.evidence.source === 'score'
                        ? 'exact — judged from the score'
                        : `${(qualityReport.evidence.confidence * 100).toFixed(0)}%`}
                    </dd>
                  </div>
                </dl>
              )}
              {attemptLog.length > 0 && (
                <details className="text-[11.5px] text-[var(--text-faint)]">
                  <summary className="cursor-pointer">
                    {attemptLog.length === 1 ? '1 attempt' : `${attemptLog.length} attempts`}
                  </summary>
                  <ul className="mt-1 grid gap-0.5" data-testid="quality-attempts">
                    {attemptLog.map((line) => <li key={line} className="t-num">{line}</li>)}
                  </ul>
                </details>
              )}
              {qualityReport.worstMoments.length > 0 && (
                <details className="text-[11.5px] text-[var(--text-faint)]">
                  <summary className="cursor-pointer">Where it goes wrong</summary>
                  <ul className="mt-1 grid gap-0.5" data-testid="quality-worst-moments">
                    {qualityReport.worstMoments.slice(0, 6).map((moment) => (
                      <li key={`${moment.index}`} className="t-num">
                        {Math.floor(moment.atSeconds / 60)}:
                        {String(Math.floor(moment.atSeconds % 60)).padStart(2, '0')}
                        {' — '}{moment.reason}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              className="btn btn-primary min-w-[150px]"
              disabled={busy}
              onClick={() => void generateSong()}
            >
              {busy ? 'Generating…' : 'Generate song'}
            </button>
            {busy ? (
              <button type="button" className="btn" onClick={cancelGeneration}>Cancel</button>
            ) : (
              <button
                type="button"
                className="btn"
                disabled={engineMode === 'neural' ? neuralTakes.length === 0 : !result}
                title="Same settings, a different take"
                onClick={() => void generateSong(`${Date.now()}-${Math.random()}`)}
              >
                <Icon name="dice" size={14} />
                New take
              </button>
            )}
            <button
              type="button"
              className="btn btn-ghost"
              aria-expanded={advanced}
              onClick={() => setAdvanced((open) => !open)}
            >
              {advanced ? 'Hide' : 'Show'} controls
            </button>
            <span className="t-num ml-auto hidden text-[11px] text-[var(--text-faint)] sm:inline">
              ⌘/Ctrl + Enter
            </span>
          </div>

          {job.running && <Progress value={job.progress} stage={job.stage} label="Generating" />}
          {neuralStatus && NEURAL_STATE_TEXT[neuralStatus.state] && (
            neuralStatus.progress !== undefined
              ? <Progress
                  value={neuralStatus.progress}
                  stage={neuralStatus.detail ?? ''}
                  label={NEURAL_STATE_TEXT[neuralStatus.state]!}
                />
              : <p className="text-[13px] text-[var(--text-dim)]" role="status">
                  {NEURAL_STATE_TEXT[neuralStatus.state]}
                  {neuralStatus.detail ? ` — ${neuralStatus.detail}` : ''}
                  {neuralStatus.queuePosition ? ` (position ${neuralStatus.queuePosition} in the queue)` : ''}
                </p>
          )}

          {advanced && (
            <div className="grid gap-4 border-t border-[var(--line)] pt-4 sm:grid-cols-2 lg:grid-cols-3">
              {/* Said once, above the controls it applies to, rather than
                  repeated under each of them. */}
              {neuralIgnores && (
                <p
                  className="text-[11.5px] leading-snug text-[var(--text-faint)] sm:col-span-2 lg:col-span-3"
                  data-testid="neural-ignores-note"
                >
                  {IGNORED_BY_NEURAL}
                </p>
              )}
              <Field label="Genre">
                <select className="select" value={genreId} disabled={neuralIgnores}
                  onChange={(e) => setGenreId(e.target.value)}>
                  <option value="">Detect from the description</option>
                  {GENRES.map((genre) => (
                    <option key={genre.id} value={genre.id}>{genre.label}</option>
                  ))}
                </select>
              </Field>

              <Field label="Mood">
                <select className="select" value={mood} disabled={neuralIgnores}
                  onChange={(e) => setMood(e.target.value as Mood | '')}>
                  <option value="">Detect from the description</option>
                  {MOODS.map((option) => (
                    <option key={option.id} value={option.id}>{option.label}</option>
                  ))}
                </select>
              </Field>

              <Field label="Vocals">
                <Segmented
                  ariaLabel="Vocals"
                  value={vocals}
                  onChange={setVocals}
                  options={[
                    { value: 'auto', label: 'Auto' },
                    { value: 'sung', label: 'Sung' },
                    { value: 'rap', label: 'Rap' },
                    { value: 'none', label: 'None' },
                  ]}
                />
              </Field>

              {engineMode === 'neural' && (
                <Field label="Vocal gender">
                  <Segmented
                    ariaLabel="Vocal gender"
                    value={vocalGender}
                    onChange={setVocalGender}
                    options={[
                      { value: 'auto', label: 'Auto', title: 'Leave it to the style description' },
                      { value: 'male', label: 'Male' },
                      { value: 'female', label: 'Female' },
                    ]}
                  />
                </Field>
              )}

              <Field label="Tempo" value={bpm > 0 ? `${bpm} BPM` : 'Auto'}>
                <Slider min={0} max={220} value={bpm} onChange={setBpm} disabled={neuralIgnores}
                  ariaLabel="Tempo in beats per minute" />
              </Field>

              {/* Auto on the neural engine is ACE-Step reading the lyric sheet
                  and choosing, so the length is not knowable until the song
                  exists — saying a number here would be inventing one. Where a
                  deployment has pinned a fixed Auto length, that number is
                  real and is shown. A longer song must not look verified when
                  it is not. */}
              <Field
                label="Length"
                value={duration > 0 ? formatDuration(duration)
                  : engineMode === 'neural'
                    ? neural.autoDuration !== undefined
                      ? `Auto (${formatDuration(neural.autoDuration)})`
                      : 'Auto — ACE-Step chooses'
                    : 'Auto'}
                {...(engineMode === 'neural' && neural.backend === 'zerogpu'
                  && (duration > 0 ? duration : neural.autoDuration ?? 0) > VERIFIED_ZEROGPU_DURATION
                  ? { hint: `Longer than the ${formatDuration(VERIFIED_ZEROGPU_DURATION)} verified on the ZeroGPU backend. `
                      + 'It may need more GPU time than one request is allowed.' }
                  : {})}
              >
                <Slider min={0} max={420} step={15} value={duration} onChange={setDuration} ariaLabel="Song length in seconds" />
              </Field>

              <Field label="Key">
                <div className="flex gap-2">
                  <select
                    className="select"
                    value={tonic}
                    aria-label="Root note"
                    disabled={neuralIgnores}
                    onChange={(e) => setTonic(Number(e.target.value))}
                  >
                    <option value={-1}>Auto</option>
                    {NOTE_NAMES.map((name, index) => (
                      <option key={name} value={index}>{name}</option>
                    ))}
                  </select>
                  <select
                    className="select"
                    value={scale}
                    aria-label="Scale"
                    disabled={neuralIgnores}
                    onChange={(e) => setScale(e.target.value as ScaleName | '')}
                  >
                    <option value="">Auto</option>
                    {SCALE_NAMES.map((name) => (
                      <option key={name} value={name}>{humanizeScale(name)}</option>
                    ))}
                  </select>
                </div>
              </Field>

              <Field label="Singing voice"
                {...(neuralIgnores
                  ? { hint: 'ACE-Step sings in the voice the Style text describes. Use Vocal gender, or say it in the Style.' }
                  : {})}>
                <select className="select" value={singStyle} disabled={neuralIgnores}
                  onChange={(e) => setSingStyle(e.target.value)}>
                  <option value="">Match the genre</option>
                  {SING_PRESET_NAMES.map((name) => (
                    <option key={name} value={name}>{name.charAt(0).toUpperCase() + name.slice(1)}</option>
                  ))}
                </select>
              </Field>

              <Field
                label="Seed"
                hint={neuralIgnores
                  ? 'Not available on the neural engine: ACE-Step draws its own seed for every run and the '
                    + 'endpoint takes none, so a song cannot be repeated from one. The seed it used is shown '
                    + 'with the result.'
                  : 'The same seed and settings always produce the same song.'}
              >
                <input
                  className="input t-num"
                  value={seed}
                  disabled={neuralIgnores}
                  placeholder={neuralIgnores ? 'drawn by ACE-Step' : 'random'}
                  onChange={(event) => setSeed(event.target.value)}
                />
              </Field>

              {/* Shown rather than hidden when it is capped: a control that
                  quietly disappears teaches nothing, and the limit belongs to
                  this backend rather than to the studio. */}
              <Field
                label="Takes"
                hint={takesCapped
                  ? 'One song per run on the free GPU — each take is a separate generation, '
                    + 'and a visitor’s daily allowance covers about one.'
                  : engineMode === 'neural'
                    ? 'Each take is a different song from the same brief.'
                    : takeCount > 1
                      ? 'Each take is a different song from the same brief. Stems are rendered for whichever one you keep.'
                      : 'Write more than one song at once and pick the one you like.'}
              >
                <Segmented
                  ariaLabel="Takes per run"
                  value={String(effectiveTakes)}
                  disabled={takesCapped}
                  onChange={(value) => setTakeCount(Number(value))}
                  options={Array.from({ length: MAX_TAKES }, (_, index) => ({
                    value: String(index + 1),
                    label: String(index + 1),
                    title: index === 0 ? 'One song' : `${index + 1} songs from one brief`,
                  }))}
                />
              </Field>

              <Field
                label="Stems"
                hint={neuralIgnores
                  ? 'ACE-Step returns one finished mix. Separate it afterwards with the Stem Splitter.'
                  : 'Render every instrument separately so you can export them.'}
              >
                <Segmented
                  ariaLabel="Render stems"
                  value={keepStems ? 'on' : 'off'}
                  disabled={neuralIgnores}
                  onChange={(value) => setKeepStems(value === 'on')}
                  options={[{ value: 'on', label: 'Render stems' }, { value: 'off', label: 'Mix only' }]}
                />
              </Field>
            </div>
          )}
        </div>
      </Panel>

      {!result && neuralTakes.length === 0 && !busy && (
        <Panel>
          <Empty
            title="Nothing generated yet"
            body={engineMode === 'neural'
              ? 'Write a style and the lyrics you want sung, then generate. ACE-Step writes the whole song — melody, arrangement, instruments and a sung vocal.'
              : 'Describe a song above, or tap one of the examples. Everything happens on this device — the first render takes a few seconds and there is no limit on how many you make.'}
          />
        </Panel>
      )}

      {/* The neural result. Its own panel, because there is no score behind it:
          ACE-Step returns a finished recording, not an arrangement to inspect. */}
      {neuralTakes.length > 0 && neuralTakes[neuralIndex] && (
        <Panel title="Result">
          <div className="grid gap-4">
            <p className="t-label">{engineLabel('ace-step')}</p>

            {neuralTakes.length > 1 && (
              <div className="grid gap-1.5">
                <p className="t-label">{neuralTakes.length} takes from one brief</p>
                <div className="flex flex-wrap gap-1.5" role="group" aria-label="Choose a take">
                  {neuralTakes.map((take, index) => (
                    <button
                      key={take.result.id}
                      type="button"
                      className={`btn btn-sm ${index === neuralIndex ? 'btn-primary' : ''}`}
                      aria-pressed={index === neuralIndex}
                      disabled={busy}
                      onClick={() => chooseNeuralTake(index)}
                    >
                      Take {index + 1}
                      <span className="t-num text-[11px] opacity-70">
                        {formatDuration(take.result.duration)}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div>
              <h2 className="t-title text-[1.35rem] tracking-[-0.02em]">
                {songTitle(prompt, customLyrics)}
              </h2>
              <p className="mt-1 text-[12.5px] text-[var(--text-dim)]">
                Generated by ACE-Step 1.5 · {neuralTakes[neuralIndex]!.result.metadata?.model}
              </p>
            </div>

            <div className="grid grid-cols-2 gap-4 sm:grid-cols-4 lg:grid-cols-5">
              <Stat label="Engine" value="ACE-Step" tone="accent" />
              <Stat label="Length" value={formatDuration(neuralTakes[neuralIndex]!.result.duration)} />
              <Stat label="Language" value={neuralTakes[neuralIndex]!.result.metadata?.language ?? '—'} />
              <Stat
                label="Tempo"
                value={neuralTakes[neuralIndex]!.result.metadata?.bpm
                  ? String(neuralTakes[neuralIndex]!.result.metadata!.bpm) : '—'}
              />
              <Stat label="Key" value={neuralTakes[neuralIndex]!.result.metadata?.keyScale ?? '—'} />
            </div>

            {/* Measured from the file, and deliberately careful about what it
                claims: the audio stopping dead is a thing worth knowing, and
                it is not the same as knowing the words ran out. */}
            {neuralTakes[neuralIndex]!.result.endsAbruptly && (
              <p className="text-[12.5px] text-[var(--warn,var(--text-dim))]">
                This song stops abruptly rather than ending. Generating again usually
                gives a different, complete take.
              </p>
            )}

            <dl className="grid gap-1 text-[12.5px] text-[var(--text-dim)]">
              <div className="flex gap-2">
                <dt className="min-w-[7rem]">DiT model</dt>
                <dd className="t-num">{neuralTakes[neuralIndex]!.result.metadata?.model ?? '—'}</dd>
              </div>
              <div className="flex gap-2">
                <dt className="min-w-[7rem]">Language model</dt>
                <dd className="t-num">{neuralTakes[neuralIndex]!.result.metadata?.lmModel ?? '—'}</dd>
              </div>
              {/* The number ACE-Step reports it used, which is real — but the
                  endpoint takes no seed, so it cannot be given back. Saying so
                  here keeps the result panel agreeing with the disabled Seed
                  control above it, instead of inviting someone to copy a number
                  that will not do anything. */}
              {neuralTakes[neuralIndex]!.result.metadata?.seed !== undefined && (
                <div className="flex gap-2">
                  <dt className="min-w-[7rem]">Seed</dt>
                  <dd className="t-num" data-testid="neural-seed">
                    {neuralTakes[neuralIndex]!.result.metadata!.seed}
                    <span className="ml-2 t-label text-[10px] text-[var(--text-faint)]">
                      drawn by ACE-Step · cannot be reused
                    </span>
                  </dd>
                </div>
              )}
            </dl>

            <p className="text-[12.5px] text-[var(--text-dim)]">
              Play and download it from the player at the bottom of the screen.
            </p>
          </div>
        </Panel>
      )}

      {score && result && (
        <>
          <Panel
            title="Result"
            action={
              <div className="flex items-center gap-1.5">
                {(renderedAt !== quality || stemsMissing) && (
                  <button
                    type="button"
                    className="btn btn-sm"
                    disabled={job.running}
                    title={stemsMissing
                      ? 'Render this take again, keeping every instrument separately'
                      : `Render this take again at ${QUALITY_LABELS[quality]}`}
                    onClick={() => void rerender()}
                  >
                    {stemsMissing && renderedAt === quality
                      ? 'Render stems for this take'
                      : `Re-render at ${QUALITY_LABELS[quality].split(' · ')[0]}`}
                  </button>
                )}
                <button type="button" className="btn btn-sm" disabled={saving || job.running} onClick={() => void saveToLibrary()}>
                  {saving ? 'Saving…' : 'Save to library'}
                </button>
              </div>
            }
          >
            <div className="grid gap-4">
              {takes.length > 1 && (
                <div className="grid gap-1.5">
                  <p className="t-label">{takes.length} takes from one brief</p>
                  <div className="flex flex-wrap gap-1.5" role="group" aria-label="Choose a take">
                    {takes.map((take, index) => (
                      <button
                        key={take.score.seed}
                        type="button"
                        className={`btn btn-sm ${index === takeIndex ? 'btn-primary' : ''}`}
                        aria-pressed={index === takeIndex}
                        disabled={job.running}
                        onClick={() => chooseTake(index)}
                      >
                        Take {index + 1}
                        <span className="t-num text-[11px] opacity-70">
                          {take.score.bpm} BPM · {formatDuration((take.score.lengthBeats * 60) / take.score.bpm)}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              <div>
                <h2 className="t-title text-[1.35rem] tracking-[-0.02em]">{score.title}</h2>
                <p className="mt-1 text-[12.5px] text-[var(--text-dim)]">{describeScore(score)}</p>
              </div>

              <div className="grid grid-cols-2 gap-4 sm:grid-cols-4 lg:grid-cols-6">
                <Stat label="Tempo" value={`${score.bpm}`} tone="accent" />
                <Stat label="Key" value={`${NOTE_NAMES[score.key.tonic]} ${humanizeScale(score.key.scale)}`} />
                <Stat label="Length" value={formatDuration((score.lengthBeats * 60) / score.bpm)} />
                <Stat label="Sections" value={`${score.sections.length}`} />
                <Stat label="Tracks" value={`${score.tracks.length + 1}`} />
                <Stat label="Peak" value={`${(20 * Math.log10(Math.max(1e-6, result.peak))).toFixed(1)} dB`} tone="signal" />
              </div>

              <ArrangementMap score={score} />
            </div>
          </Panel>

          <Panel
            title="Details"
            action={
              <div className="segmented">
                {DETAIL_TABS.map(({ id, label }) => (
                  <button
                    key={id}
                    type="button"
                    aria-pressed={tab === id}
                    onClick={() => setTab(id)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            }
          >
            {tab === 'lyrics' && (
              score.lyrics ? (
                <div className="grid gap-3">
                  <div className="lyrics-body max-h-[420px] overflow-y-auto">
                    {renderLyrics(score.lyrics.formatted, score.lyrics.title)}
                  </div>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() => {
                        void downloadText(score.lyrics!.formatted, `${safeFilename(score.title)}-lyrics.txt`)
                          .catch((error: unknown) =>
                            notify(error instanceof Error ? error.message : 'Download failed.', 'error'))
                      }}
                    >
                      <Icon name="download" size={13} />
                      Download lyrics
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() => {
                        void navigator.clipboard?.writeText(score.lyrics!.formatted)
                          .then(() => notify('Lyrics copied.', 'success'))
                          .catch(() => notify('Could not copy — select the text instead.', 'error'))
                      }}
                    >
                      Copy
                    </button>
                  </div>
                </div>
              ) : (
                <Empty
                  title="This is an instrumental"
                  body="Turn the Instrumental switch off, or write your own words in the box next to Style."
                  action={<a className="btn btn-sm" {...linkProps('/lyrics')}>Open the Lyric Writer</a>}
                />
              )
            )}

            {tab === 'chords' && (
              <div className="grid gap-3">
                {chordChart(score).map((section, index) => (
                  <div key={`${section.label}-${index}`} className="grid gap-1.5">
                    <p className="t-label">{section.label}</p>
                    <div className="scroll-x flex gap-1.5 pb-1">
                      {section.chords.map((chord, barIndex) => (
                        <span
                          key={`${chord}-${barIndex}`}
                          className="panel-sunken t-num shrink-0 px-2.5 py-1.5 text-[12.5px]"
                        >
                          {chord}
                        </span>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}

            {tab === 'stems' && (
              result.stems.length > 0 ? (
                <div className="grid gap-1.5">
                  {result.stems.map((stem) => (
                    <div
                      key={stem.id}
                      className="flex items-center justify-between gap-3 border-b border-[var(--line)] py-2 last:border-0"
                    >
                      <div className="min-w-0">
                        <p className="truncate text-[13px]">{stem.name}</p>
                        <p className="t-num text-[11px] text-[var(--text-faint)]">
                          {stem.id === 'drums'
                            ? 'Synthesised kit'
                            : (() => {
                              const instrument = score.tracks.find((t) => t.id === stem.id)?.instrument
                              return instrument ? INSTRUMENT_LABELS[instrument] : 'Track'
                            })()}
                        </p>
                      </div>
                      <div className="flex shrink-0 gap-1.5">
                        <button type="button" className="btn btn-sm" onClick={() => playStem(stem.id)}>
                          <Icon name="play" size={11} />
                          Play
                        </button>
                        <button
                          type="button"
                          className="btn btn-sm"
                          onClick={() => {
                            void encodeAudio(
                              { channels: stem.audio.channels, sampleRate: stem.audio.sampleRate },
                              'wav16',
                            )
                              .then((blob) =>
                                downloadBlob(blob, `${safeFilename(score.title)}-${safeFilename(stem.name)}.wav`))
                              .catch((error: unknown) =>
                                notify(error instanceof Error ? error.message : 'Download failed.', 'error'))
                          }}
                        >
                          <Icon name="download" size={13} />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <Empty
                  title="Stems were not rendered"
                  body={stemsMissing
                    ? 'A run that writes several takes skips them, since a set per take is more memory than most devices have. Use “Render stems for this take” above to get every instrument as a separate file.'
                    : 'Turn on “Render stems” in the controls and generate again to get every instrument as a separate file.'}
                />
              )
            )}

            {tab === 'export' && (
              <div className="grid gap-4">
                <p className="text-[12.5px] leading-relaxed text-[var(--text-dim)]">
                  Everything here comes from the song that is already rendered, so nothing
                  has to be generated again. Audio downloads in the player at the bottom of
                  the screen, where the format is yours to pick.
                </p>

                <div className="grid gap-2 sm:grid-cols-2">
                  <ExportRow
                    title="Instrumental"
                    detail="The mix with every voice removed — WAV"
                    disabled={result.stems.length === 0}
                    onClick={() => void exportMix('instrumental')}
                  />
                  <ExportRow
                    title="Vocals only"
                    detail="The lead and its harmonies — WAV"
                    disabled={!hasVocalStem}
                    onClick={() => void exportMix('vocals')}
                  />
                  <ExportRow
                    title="MIDI"
                    detail="Every part as notes, for a DAW"
                    onClick={() => void exportMidi()}
                  />
                  <ExportRow
                    title="Lyric sheet"
                    detail="Plain text with section headings"
                    disabled={!score.lyrics}
                    onClick={() => {
                      if (score.lyrics) void downloadText(score.lyrics.formatted, `${safeFilename(score.title)}-lyrics.txt`)
                    }}
                  />
                  <ExportRow
                    title="Subtitles"
                    detail="Timed to the mix — SRT, for video"
                    disabled={!score.lyrics}
                    onClick={() => void exportSubtitles('srt')}
                  />
                  <ExportRow
                    title="Karaoke lyrics"
                    detail="Timed to the mix — LRC, for players"
                    disabled={!score.lyrics}
                    onClick={() => void exportSubtitles('lrc')}
                  />
                </div>
              </div>
            )}
          </Panel>
        </>
      )}

      <p className="text-[11.5px] leading-relaxed text-[var(--text-faint)]">
        Rendering at {(QUALITY_SAMPLE_RATES[quality] / 1000).toFixed(2).replace(/\.00$/, '')} kHz.
        Longer songs and higher quality take longer on slower devices — you can change this in the
        sidebar, or on the <a className="underline underline-offset-2" {...linkProps('/about')}>about page</a>.
      </p>
    </div>
  )
}

function ArrangementMap({ score }: { score: Score }) {
  const total = score.lengthBeats || 1
  return (
    <div className="grid gap-1.5">
      <p className="t-label">Arrangement</p>
      <div className="flex h-9 w-full overflow-hidden rounded-[2px] border border-[var(--line)]">
        {score.sections.map((section, index) => (
          <div
            key={`${section.label}-${index}`}
            className="grid place-items-center overflow-hidden border-r border-[var(--line)] last:border-r-0"
            style={{
              width: `${(section.lengthBeats / total) * 100}%`,
              background: `color-mix(in srgb, ${SECTION_TONE[section.kind]} ${Math.round(10 + section.intensity * 22)}%, transparent)`,
            }}
            title={`${section.label} · ${section.lengthBeats / score.beatsPerBar} bars`}
          >
            <span className="t-num truncate px-1 text-[10px]" style={{ color: SECTION_TONE[section.kind] }}>
              {section.label}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

/**
 * Renders the lyric sheet. The stored text opens with the title so downloads
 * are self-describing, but the panel already shows it, so it is dropped here.
 */
function renderLyrics(text: string, title: string) {
  const lines = text.split('\n')
  if (lines[0]?.trim() === title.trim()) {
    lines.shift()
    while (lines[0] !== undefined && lines[0]!.trim() === '') lines.shift()
  }
  return lines.map((line, index) => {
    if (/^\[.+\]$/.test(line.trim())) {
      return <span key={index} className="section-head">{line.trim().slice(1, -1)}</span>
    }
    return <span key={index}>{line}{'\n'}</span>
  })
}

function describeScore(score: Score): string {
  const genre = GENRES.find((g) => g.id === score.genreId)?.label ?? score.genreId
  const key = `${NOTE_NAMES[score.key.tonic]} ${humanizeScale(score.key.scale)}`
  const length = formatDuration((score.lengthBeats * 60) / score.bpm)
  return `${genre} · ${score.bpm} BPM · ${key} · ${length}`
}

export function humanizeScale(scale: string): string {
  return scale
    .replace(/([A-Z])/g, ' $1')
    .replace(/^./, (c) => c.toLowerCase())
    .trim()
}

export type { RenderQuality }

/** One line of the export list: what it is, what you get, and a button. */
function ExportRow(
  { title, detail, disabled, onClick }:
  { title: string; detail: string; disabled?: boolean; onClick: () => void },
) {
  return (
    <button
      type="button"
      className="panel-sunken flex items-center justify-between gap-3 px-3 py-2.5 text-left transition-opacity disabled:opacity-45"
      disabled={disabled}
      onClick={onClick}
    >
      <span className="min-w-0">
        <span className="block truncate text-[13px]">{title}</span>
        <span className="block truncate text-[11.5px] text-[var(--text-faint)]">{detail}</span>
      </span>
      <Icon name="download" size={14} />
    </button>
  )
}
