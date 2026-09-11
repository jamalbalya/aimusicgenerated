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
import { isVocalStem, sumStems } from '../../lib/mixdown'
import { scoreToMidi } from '../../engine/export/midi'
import { scoreToLrc, scoreToSrt } from '../../engine/export/subtitles'
import { newProjectId, saveProject } from '../../lib/library'
import { linkProps } from '../../lib/router'
import { useNeuralEngine } from '../useNeuralEngine'
import { decodeWav } from '../../engine/audio/wav'
import {
  createNeuralProvider, EngineUnavailableError, GenerationCancelledError, QuotaExceededError,
  engineLabel, resolveEngineMode, VERIFIED_ZEROGPU_DURATION,
  type EngineMode, type GenerationStatus, type NeuralBackend,
} from '../../engine/providers'

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

/** The host of an address, for display; the address itself when it is not one. */
function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

/** Two lines of a lyric, to show the shape rather than to be sung. */
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
  const [engineError, setEngineError] = useState<string | null>(null)
  const neural = useNeuralEngine()

  // Move onto the neural engine once the backend has answered, and stay: a
  // later failed check must not flip the control back to the offline engine
  // under someone who saw Neural selected. This decides the position of a
  // control the user can see; it is never a fallback applied to a request.
  const engineMode: EngineMode = resolveEngineMode(engineChoice, neural.hasAnswered)

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
  const generateNeural = useCallback(async (overrideSeed?: string) => {
    const style = prompt.trim()
    const lyrics = customLyrics.trim()
    if (!style) {
      notify('Describe the song you want.', 'error')
      return
    }
    if (!lyrics) {
      notify('The neural engine sings the lyrics you write. Add some, or switch to Offline Procedural Mode.', 'error')
      return
    }

    const controller = new AbortController()
    // The controller is this generation's identity from here on: every write
    // below is addressed to it, so a write that arrives after it has been
    // superseded is dropped rather than applied to whatever is running now.
    startNeural(controller)
    setEngineError(null)
    updateNeural(controller, { status: { state: 'initializing' } })

    const provider = createNeuralProvider()
    const baseSeed = Number.parseInt(overrideSeed ?? seed.trim(), 10)
    const collected: NeuralTake[] = []

    // Each take is its own generation, so each take's failure is its own too:
    // one that fails must not discard the ones that already worked, and the
    // person needs to be told *which* one it was.
    const failures: string[] = []
    try {
      // The capped count, never the control's: a stale or tampered value must
      // not be able to put four jobs on a free GPU from one press.
      for (let index = 0; index < effectiveTakes; index++) {
        const label = effectiveTakes > 1 ? ` (take ${index + 1} of ${effectiveTakes})` : ''
        try {
          const result = await provider.generate({
            style,
            lyrics,
            language: language === 'auto' ? (detectLanguage(lyrics) as string) : language,
            ...(duration > 0 ? { duration } : {}),
            ...(vocalGender !== 'auto' ? { vocalGender } : {}),
            ...(vocals === 'none' ? { instrumental: true } : {}),
            ...(Number.isFinite(baseSeed) ? { seed: baseSeed + index } : {}),
          }, {
            signal: controller.signal,
            onStatus: (status) => updateNeural(controller, {
              status: { ...status, ...(status.detail ? { detail: `${status.detail}${label}` } : {}) },
            }),
          })

          // The object URL is only a way to hand the file across; once it has
          // been read, the decoded audio is what the player and every export
          // use. Releasing it frees the whole download — about 52 MB for a
          // 271-second song — instead of holding it until the tab closes.
          let buffer: ArrayBuffer
          try {
            buffer = await (await fetch(result.audioUrl)).arrayBuffer()
          } finally {
            URL.revokeObjectURL(result.audioUrl)
          }
          const decoded = decodeWav(buffer)
          collected.push({ result, audio: decoded })
          updateNeural(controller, { takes: [...collected] })
          if (collected.length === 1) {
            updateNeural(controller, { index: 0 })
            openNeuralTake(collected[0]!)
          }
        } catch (error) {
          // A cancellation or a backend that has gone away applies to the whole
          // run, not to one take: there is nothing to be gained by asking a
          // dead backend three more times.
          if (error instanceof GenerationCancelledError) throw error
          if (error instanceof EngineUnavailableError) throw error
          const message = error instanceof Error ? error.message : String(error)
          failures.push(`Take ${index + 1}: ${message}`)
          // A spent allowance is spent for every take after this one too, and
          // asking again would only be refused again. Stop, and keep what
          // already worked.
          if (error instanceof QuotaExceededError) break
        }
      }

      if (collected.length === 0) {
        updateNeural(controller, { status: { state: 'failed' } })
        notify(failures[0] ?? 'ACE-Step produced nothing.', 'error')
        return
      }
      updateNeural(controller, { status: { state: 'completed' } })
      if (failures.length > 0) {
        notify(
          `${collected.length} of ${effectiveTakes} takes generated. ${failures.join(' · ')}`,
          'error',
        )
      } else {
        notify(`Song generated by ${engineLabel('ace-step').replace('Engine: ', '')}.`, 'success')
      }
    } catch (error) {
      if (error instanceof GenerationCancelledError) {
        updateNeural(controller, { status: { state: 'cancelled' } })
        // ACE-Step has no cancellation endpoint, so this is the honest wording.
        notify(collected.length > 0
          ? `Stopped after ${collected.length} take(s). The backend may still be finishing the next one.`
          : 'Stopped waiting. The backend may still be finishing this song.', 'info')
        return
      }
      updateNeural(controller, { status: { state: 'failed' } })
      const message = error instanceof Error ? error.message : String(error)
      if (error instanceof EngineUnavailableError) setEngineError(message)
      notify(message, 'error')
    } finally {
      // Only ends the job if it is still this one.
      updateNeural(controller, { controller: null })
    }
  }, [prompt, customLyrics, language, duration, vocalGender, vocals, seed, effectiveTakes,
      notify, openNeuralTake, startNeural, updateNeural])

  const generate = useCallback(async (overrideSeed?: string) => {
    const text = prompt.trim()
    if (!text && !genreId) {
      notify('Describe the song you want, or pick a genre.', 'error')
      return
    }
    const usedSeed = overrideSeed ?? seed.trim() ?? ''
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
          seed: usedSeed || `${text}|${Date.now()}`,
        },
      })
      const first = output.takes[0]!
      setTakes(output.takes)
      setTakeIndex(0)
      setRenderedAt(quality)
      setSeed(first.score.seed)
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
        setTakes([])
        await generateNeural(overrideSeed)
        return
      }
      clearNeural()
      await generate(overrideSeed)
    } finally {
      inFlight.current = false
    }
  }, [busy, engineMode, generate, generateNeural, clearNeural])

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
                  <Toggle
                    label="Instrumental"
                    checked={vocals === 'none'}
                    onChange={(on) => setVocals(on ? 'none' : 'auto')}
                  />
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
                hint="The singer uses this language\u2019s own vowels and consonants, not English ones."
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

          {engineError && (
            <div className="grid gap-2 rounded-[10px] border border-[var(--line)] p-3" role="alert">
              <p className="text-[13px]">{engineError}</p>
              <div className="flex flex-wrap gap-2">
                <button type="button" className="btn btn-sm" onClick={neural.recheck}>
                  Re-check the backend
                </button>
                <button type="button" className="btn btn-sm btn-primary"
                  onClick={() => chooseEngine('procedural')}>
                  Use Offline Procedural Mode
                </button>
              </div>
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
              <Field label="Genre">
                <select className="select" value={genreId} onChange={(e) => setGenreId(e.target.value)}>
                  <option value="">Detect from the description</option>
                  {GENRES.map((genre) => (
                    <option key={genre.id} value={genre.id}>{genre.label}</option>
                  ))}
                </select>
              </Field>

              <Field label="Mood">
                <select className="select" value={mood} onChange={(e) => setMood(e.target.value as Mood | '')}>
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
                <Slider min={0} max={220} value={bpm} onChange={setBpm} ariaLabel="Tempo in beats per minute" />
              </Field>

              {/* On a backend that has to be told a length, say which one Auto
                  is, rather than let it look like the engine will choose — and
                  do not let a longer song look verified when it is not. */}
              <Field
                label="Length"
                value={duration > 0 ? formatDuration(duration)
                  : engineMode === 'neural' && neural.autoDuration !== undefined
                    ? `Auto (${formatDuration(neural.autoDuration)})`
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
                    onChange={(e) => setScale(e.target.value as ScaleName | '')}
                  >
                    <option value="">Auto</option>
                    {SCALE_NAMES.map((name) => (
                      <option key={name} value={name}>{humanizeScale(name)}</option>
                    ))}
                  </select>
                </div>
              </Field>

              <Field label="Singing voice">
                <select className="select" value={singStyle} onChange={(e) => setSingStyle(e.target.value)}>
                  <option value="">Match the genre</option>
                  {SING_PRESET_NAMES.map((name) => (
                    <option key={name} value={name}>{name.charAt(0).toUpperCase() + name.slice(1)}</option>
                  ))}
                </select>
              </Field>

              <Field label="Seed" hint="The same seed and settings always produce the same song.">
                <input
                  className="input t-num"
                  value={seed}
                  placeholder="random"
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
                    + 'and a visitor\u2019s daily allowance covers about one.'
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

              <Field label="Stems" hint="Render every instrument separately so you can export them.">
                <Segmented
                  ariaLabel="Render stems"
                  value={keepStems ? 'on' : 'off'}
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

            <dl className="grid gap-1 text-[12.5px] text-[var(--text-dim)]">
              <div className="flex gap-2">
                <dt className="min-w-[7rem]">DiT model</dt>
                <dd className="t-num">{neuralTakes[neuralIndex]!.result.metadata?.model ?? '—'}</dd>
              </div>
              <div className="flex gap-2">
                <dt className="min-w-[7rem]">Language model</dt>
                <dd className="t-num">{neuralTakes[neuralIndex]!.result.metadata?.lmModel ?? '—'}</dd>
              </div>
              {neuralTakes[neuralIndex]!.result.metadata?.seed !== undefined && (
                <div className="flex gap-2">
                  <dt className="min-w-[7rem]">Seed</dt>
                  <dd className="t-num">{neuralTakes[neuralIndex]!.result.metadata!.seed}</dd>
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
