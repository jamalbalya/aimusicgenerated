/**
 * The Song Studio: a prompt in, a finished track out.
 */

import { useCallback, useState } from 'react'
import { Icon } from '../components/Icon'
import { Empty, Field, Panel, Progress, Segmented, Slider, Stat } from '../components/controls'
import { useJob, isCancellation } from '../useJob'
import { useStudio } from '../../state/store'
import { GENRES } from '../../engine/compose/genres'
import { MOODS, type Mood } from '../../engine/compose/prompt'
import { NOTE_NAMES, SCALE_NAMES, type ScaleName } from '../../engine/theory/pitch'
import { chordChart } from '../../engine/compose/composer'
import { formatDuration } from '../../engine/core/units'
import { SING_PRESET_NAMES } from '../../engine/voice/singer'
import {
  QUALITY_LABELS, QUALITY_SAMPLE_RATES,
  type GenerateResult, type RenderQuality,
} from '../../workers/protocol'
import { INSTRUMENT_LABELS, type Score, type SectionKind } from '../../engine/compose/types'
import { downloadText, encodeAudio, downloadBlob, safeFilename } from '../../lib/files'
import { newProjectId, saveProject } from '../../lib/library'
import { linkProps } from '../../lib/router'

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
  const [singStyle, setSingStyle] = useState('')
  const [seed, setSeed] = useState('')
  const [keepStems, setKeepStems] = useState(true)

  const [result, setResult] = useState<GenerateResult | null>(null)
  const [tab, setTab] = useState<'lyrics' | 'chords' | 'stems'>('lyrics')
  const [saving, setSaving] = useState(false)
  const [renderedAt, setRenderedAt] = useState<RenderQuality>(quality)

  const score = result?.score ?? null

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
        singStylePreset: singStyle || undefined,
        overrides: {
          ...(genreId ? { genreId } : {}),
          ...(mood ? { mood } : {}),
          ...(bpm > 0 ? { bpm } : {}),
          ...(tonic >= 0 ? { tonic } : {}),
          ...(scale ? { scale } : {}),
          ...(duration > 0 ? { durationSeconds: duration } : {}),
          ...(vocals !== 'auto' ? { vocals } : {}),
          seed: usedSeed || `${text}|${Date.now()}`,
        },
      })
      setResult(output)
      setRenderedAt(quality)
      setSeed(output.score.seed)
      setCurrent({
        title: output.score.title,
        subtitle: describeScore(output.score),
        audio: { channels: output.audio.channels, sampleRate: output.audio.sampleRate },
        score: output.score,
        lyrics: output.score.lyrics?.formatted,
        stems: output.stems.map((stem) => ({
          id: stem.id,
          name: stem.name,
          audio: { channels: stem.audio.channels, sampleRate: stem.audio.sampleRate },
        })),
        source: 'song',
      })
      setTab(output.score.lyrics ? 'lyrics' : 'chords')
    } catch (error) {
      if (!isCancellation(error)) {
        // useJob already surfaced the message.
      }
    }
  }, [prompt, genreId, mood, bpm, tonic, scale, duration, vocals, singStyle, seed, quality, keepStems, job, notify, setCurrent])

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
      setResult(output)
      setRenderedAt(quality)
      setCurrent({
        title: output.score.title,
        subtitle: describeScore(output.score),
        audio: { channels: output.audio.channels, sampleRate: output.audio.sampleRate },
        score: output.score,
        lyrics: output.score.lyrics?.formatted,
        stems: output.stems.map((stem) => ({
          id: stem.id,
          name: stem.name,
          audio: { channels: stem.audio.channels, sampleRate: stem.audio.sampleRate },
        })),
        source: 'song',
      })
    } catch (error) {
      if (!isCancellation(error)) { /* reported by useJob */ }
    }
  }, [result, quality, keepStems, singStyle, job, setCurrent])

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
          <Field label="What should it sound like?" htmlFor="prompt">
            <textarea
              id="prompt"
              className="textarea"
              placeholder="a warm lo-fi beat for studying, no vocals"
              value={prompt}
              rows={3}
              onChange={(event) => setPrompt(event.target.value)}
              onKeyDown={(event) => {
                if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') void generate()
              }}
            />
          </Field>

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

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              className="btn btn-primary min-w-[150px]"
              disabled={job.running}
              onClick={() => void generate()}
            >
              {job.running ? 'Generating…' : 'Generate song'}
            </button>
            {job.running ? (
              <button type="button" className="btn" onClick={job.cancel}>Cancel</button>
            ) : (
              <button
                type="button"
                className="btn"
                disabled={!result}
                title="Same settings, a different take"
                onClick={() => void generate(`${Date.now()}-${Math.random()}`)}
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

              <Field label="Tempo" value={bpm > 0 ? `${bpm} BPM` : 'Auto'}>
                <Slider min={0} max={220} value={bpm} onChange={setBpm} ariaLabel="Tempo in beats per minute" />
              </Field>

              <Field label="Length" value={duration > 0 ? formatDuration(duration) : 'Auto'}>
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

      {!result && !job.running && (
        <Panel>
          <Empty
            title="Nothing generated yet"
            body="Describe a song above, or tap one of the examples. Everything happens on this device — the first render takes a few seconds and there is no limit on how many you make."
          />
        </Panel>
      )}

      {score && result && (
        <>
          <Panel
            title="Result"
            action={
              <div className="flex items-center gap-1.5">
                {renderedAt !== quality && (
                  <button
                    type="button"
                    className="btn btn-sm"
                    disabled={job.running}
                    title={`Render this take again at ${QUALITY_LABELS[quality]}`}
                    onClick={() => void rerender()}
                  >
                    Re-render at {QUALITY_LABELS[quality].split(' · ')[0]}
                  </button>
                )}
                <button type="button" className="btn btn-sm" disabled={saving || job.running} onClick={() => void saveToLibrary()}>
                  {saving ? 'Saving…' : 'Save to library'}
                </button>
              </div>
            }
          >
            <div className="grid gap-4">
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
                {(['lyrics', 'chords', 'stems'] as const).map((option) => (
                  <button
                    key={option}
                    type="button"
                    aria-pressed={tab === option}
                    onClick={() => setTab(option)}
                  >
                    {option === 'lyrics' ? 'Lyrics' : option === 'chords' ? 'Chords' : 'Stems'}
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
                      onClick={() => downloadText(score.lyrics!.formatted, `${safeFilename(score.title)}-lyrics.txt`)}
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
                  body="Set Vocals to Sung or Rap in the controls above, or write your own words in the Lyric Writer."
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
                            ).then((blob) =>
                              downloadBlob(blob, `${safeFilename(score.title)}-${safeFilename(stem.name)}.wav`))
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
                  body="Turn on “Render stems” in the controls and generate again to get every instrument as a separate file."
                />
              )
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
