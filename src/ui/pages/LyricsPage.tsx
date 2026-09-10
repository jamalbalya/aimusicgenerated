/**
 * The Lyric Writer: structured, rhyming, metered lyrics — and the option to
 * hear them sung, which is the part most lyric tools stop short of.
 */

import { useCallback, useMemo, useState } from 'react'
import { Icon } from '../components/Icon'
import { Empty, Field, Panel, Progress, Segmented, Slider } from '../components/controls'
import { isCancellation, useJob } from '../useJob'
import { useStudio } from '../../state/store'
import { MOODS, type Mood } from '../../engine/compose/prompt'
import { GENRES } from '../../engine/compose/genres'
import { RHYME_SCHEMES, type RhymeScheme } from '../../engine/lyrics/generator'
import { syllablesInLine } from '../../engine/lyrics/syllables'
import { SING_PRESETS, SING_PRESET_NAMES } from '../../engine/voice/singer'
import { detectLanguage, LANGUAGE_CHOICES, type LanguageId } from '../../engine/lang'
import type { GenerateResult, LyricsWorkerResult } from '../../workers/protocol'
import type { SectionKind, SongLyrics } from '../../engine/compose/types'
import { downloadText, safeFilename } from '../../lib/files'

interface StructureRow {
  kind: SectionKind
  lines: number
}

const DEFAULT_STRUCTURE: StructureRow[] = [
  { kind: 'verse', lines: 4 },
  { kind: 'prechorus', lines: 2 },
  { kind: 'chorus', lines: 4 },
  { kind: 'verse', lines: 4 },
  { kind: 'chorus', lines: 4 },
  { kind: 'bridge', lines: 2 },
  { kind: 'chorus', lines: 4 },
]

const SECTION_KINDS: SectionKind[] = ['intro', 'verse', 'prechorus', 'chorus', 'bridge', 'outro']

export default function LyricsPage() {
  const job = useJob()
  const quality = useStudio((s) => s.quality)
  const setCurrent = useStudio((s) => s.setCurrent)
  const notify = useStudio((s) => s.notify)

  const [theme, setTheme] = useState('')
  const [mood, setMood] = useState<Mood>('nostalgic')
  const [style, setStyle] = useState<'sung' | 'rap'>('sung')
  const [scheme, setScheme] = useState<RhymeScheme | ''>('')
  const [syllables, setSyllables] = useState(8)
  const [structure, setStructure] = useState<StructureRow[]>(DEFAULT_STRUCTURE)
  const [lyrics, setLyrics] = useState<SongLyrics | null>(null)
  const [edited, setEdited] = useState('')

  const [singGenre, setSingGenre] = useState('pop')
  const [singVoice, setSingVoice] = useState('pop')
  const [singLanguage, setSingLanguage] = useState<LanguageId | 'auto'>('auto')

  const write = useCallback(async () => {
    if (!theme.trim()) {
      notify('Give the song something to be about.', 'error')
      return
    }
    try {
      const output = await job.run<LyricsWorkerResult>('Writing lyrics', {
        kind: 'lyrics',
        request: {
          theme: theme.trim(),
          mood,
          style,
          seed: `${theme}|${Date.now()}`,
          ...(scheme ? { rhymeScheme: scheme } : {}),
          structure: structure.map((row) => ({
            kind: row.kind,
            lines: row.lines,
            syllableTargets: new Array(row.lines).fill(syllables),
          })),
        },
      })
      setLyrics(output.lyrics)
      setEdited(output.lyrics.formatted)
    } catch (error) {
      if (!isCancellation(error)) { /* reported by useJob */ }
    }
  }, [theme, mood, style, scheme, structure, syllables, job, notify])

  const sing = useCallback(async () => {
    const text = edited.replace(/^\[.*\]$/gm, '').trim()
    if (!text) {
      notify('Write some lyrics first.', 'error')
      return
    }
    try {
      const output = await job.run<GenerateResult>('Singing your lyrics', {
        kind: 'sing',
        text,
        prompt: theme.trim() || 'a song',
        quality,
        style: SING_PRESETS[singVoice] ?? SING_PRESETS.pop!,
        language: singLanguage,
        overrides: { genreId: singGenre, mood, seed: `${theme}|sing|${Date.now()}` },
      })
      setCurrent({
        title: lyrics?.title ?? 'Your lyrics',
        subtitle: `Sung · ${GENRES.find((g) => g.id === singGenre)?.label ?? singGenre} · ${output.score.bpm} BPM`,
        audio: { channels: output.audio.channels, sampleRate: output.audio.sampleRate },
        score: output.score,
        lyrics: edited,
        source: 'song',
      })
      notify('Playing your lyrics. Use Export to download.', 'success')
    } catch (error) {
      if (!isCancellation(error)) { /* reported by useJob */ }
    }
  }, [edited, theme, quality, singGenre, singVoice, singLanguage, mood, lyrics, job, notify, setCurrent])

  // The lyric can be edited into any language after it is written, so the
  // reading is taken from what is in the box now, not from what was generated.
  const detectedName = useMemo(() => {
    const text = edited.replace(/^\[.*\]$/gm, '').trim()
    if (!text) return undefined
    return LANGUAGE_CHOICES.find((choice) => choice.id === detectLanguage(text))?.label
  }, [edited])

  const lineStats = edited
    .split('\n')
    .filter((line) => line.trim() && !/^\[.*\]$/.test(line.trim()))

  return (
    <div className="grid gap-4">
      <header className="grid gap-2">
        <p className="t-label">Lyric Writer</p>
        <h1 className="t-display max-w-2xl">Words that scan, rhyme and repeat.</h1>
        <p className="max-w-2xl text-[13.5px] leading-relaxed text-[var(--text-dim)]">
          Choose a structure and a syllable count; the writer fills it with grammatical lines
          that land the rhyme scheme and reuse the hook. Edit anything, then hear it sung.
        </p>
      </header>

      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,340px)_minmax(0,1fr)]">
        <div className="grid content-start gap-4">
          <Panel title="Brief">
            <div className="grid gap-3.5">
              <Field label="What is it about?" htmlFor="theme">
                <textarea
                  id="theme"
                  className="textarea !min-h-[70px]"
                  rows={2}
                  placeholder="the last summer before everyone moved away"
                  value={theme}
                  onChange={(event) => setTheme(event.target.value)}
                />
              </Field>

              <Field label="Mood">
                <select className="select" value={mood} onChange={(e) => setMood(e.target.value as Mood)}>
                  {MOODS.map((option) => (
                    <option key={option.id} value={option.id}>{option.label}</option>
                  ))}
                </select>
              </Field>

              <Field label="Delivery">
                <Segmented
                  ariaLabel="Delivery"
                  value={style}
                  onChange={setStyle}
                  options={[{ value: 'sung', label: 'Sung' }, { value: 'rap', label: 'Rap' }]}
                />
              </Field>

              <Field label="Rhyme scheme">
                <select className="select" value={scheme} onChange={(e) => setScheme(e.target.value as RhymeScheme | '')}>
                  <option value="">Fit the section</option>
                  {RHYME_SCHEMES.map((option) => (
                    <option key={option} value={option}>{option}</option>
                  ))}
                </select>
              </Field>

              <Field label="Syllables per line" value={`${syllables}`}>
                <Slider min={4} max={16} value={syllables} onChange={setSyllables} ariaLabel="Syllables per line" />
              </Field>

              <button type="button" className="btn btn-primary" disabled={job.running} onClick={() => void write()}>
                {job.running ? 'Working…' : 'Write lyrics'}
              </button>
              {job.running && <Progress value={job.progress} stage={job.stage} label="Working" />}
            </div>
          </Panel>

          <Panel
            title="Structure"
            action={
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => setStructure(DEFAULT_STRUCTURE)}
              >
                Reset
              </button>
            }
          >
            <div className="grid gap-1.5">
              {structure.map((row, index) => (
                <div key={index} className="flex items-center gap-1.5">
                  <select
                    className="select !py-1 text-[12.5px]"
                    aria-label={`Section ${index + 1} type`}
                    value={row.kind}
                    onChange={(event) => {
                      const next = structure.slice()
                      next[index] = { ...row, kind: event.target.value as SectionKind }
                      setStructure(next)
                    }}
                  >
                    {SECTION_KINDS.map((kind) => (
                      <option key={kind} value={kind}>{kind === 'prechorus' ? 'Pre-Chorus' : kind[0]!.toUpperCase() + kind.slice(1)}</option>
                    ))}
                  </select>
                  <input
                    type="number"
                    className="input t-num w-16 !py-1 text-[12.5px]"
                    aria-label={`Section ${index + 1} line count`}
                    min={1}
                    max={12}
                    value={row.lines}
                    onChange={(event) => {
                      const next = structure.slice()
                      next[index] = { ...row, lines: Math.max(1, Math.min(12, Number(event.target.value) || 1)) }
                      setStructure(next)
                    }}
                  />
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm !px-1.5"
                    aria-label={`Remove section ${index + 1}`}
                    disabled={structure.length <= 1}
                    onClick={() => setStructure(structure.filter((_row, i) => i !== index))}
                  >
                    <Icon name="close" size={13} />
                  </button>
                </div>
              ))}
              <button
                type="button"
                className="btn btn-sm mt-1"
                disabled={structure.length >= 12}
                onClick={() => setStructure([...structure, { kind: 'verse', lines: 4 }])}
              >
                Add section
              </button>
            </div>
          </Panel>
        </div>

        <div className="grid content-start gap-4">
          <Panel
            title="Lyrics"
            action={
              lyrics && (
                <div className="flex gap-1.5">
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={() => {
                      void navigator.clipboard?.writeText(edited)
                        .then(() => notify('Copied.', 'success'))
                        .catch(() => notify('Could not copy — select the text instead.', 'error'))
                    }}
                  >
                    Copy
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={() => {
                      void downloadText(edited, `${safeFilename(lyrics.title)}.txt`)
                        .catch((error: unknown) =>
                          notify(error instanceof Error ? error.message : 'Download failed.', 'error'))
                    }}
                  >
                    <Icon name="download" size={13} />
                  </button>
                </div>
              )
            }
          >
            {lyrics ? (
              <div className="grid gap-2.5">
                <textarea
                  className="textarea !min-h-[360px] font-[inherit] leading-[1.85]"
                  value={edited}
                  aria-label="Lyrics"
                  onChange={(event) => setEdited(event.target.value)}
                />
                <p className="t-num text-[11px] text-[var(--text-faint)]">
                  {lineStats.length} lines · {lineStats.reduce((sum, line) => sum + syllablesInLine(line), 0)} syllables
                  · average {lineStats.length > 0 ? (lineStats.reduce((sum, line) => sum + syllablesInLine(line), 0) / lineStats.length).toFixed(1) : '0'} per line
                </p>
              </div>
            ) : (
              <Empty
                title="No lyrics yet"
                body="Fill in the brief and press Write lyrics. You can edit every line afterwards — the singer follows whatever you leave in the box."
              />
            )}
          </Panel>

          {lyrics && (
            <Panel title="Hear it sung">
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[1fr_1fr_1fr_auto] lg:items-end">
                <Field label="Backing style">
                  <select className="select" value={singGenre} onChange={(e) => setSingGenre(e.target.value)}>
                    {GENRES.map((genre) => (
                      <option key={genre.id} value={genre.id}>{genre.label}</option>
                    ))}
                  </select>
                </Field>
                <Field label="Voice">
                  <select className="select" value={singVoice} onChange={(e) => setSingVoice(e.target.value)}>
                    {SING_PRESET_NAMES.map((name) => (
                      <option key={name} value={name}>{name.charAt(0).toUpperCase() + name.slice(1)}</option>
                    ))}
                  </select>
                </Field>
                <Field
                  label="Pronunciation"
                  htmlFor="sing-language"
                  value={singLanguage === 'auto' ? detectedName : undefined}
                >
                  <select
                    id="sing-language"
                    className="select"
                    value={singLanguage}
                    onChange={(e) => setSingLanguage(e.target.value as LanguageId | 'auto')}
                  >
                    {LANGUAGE_CHOICES.map((choice) => (
                      <option key={choice.id} value={choice.id}>
                        {choice.id === 'auto' ? choice.label : `${choice.label} — ${choice.native}`}
                      </option>
                    ))}
                  </select>
                </Field>
                <button type="button" className="btn btn-primary" disabled={job.running} onClick={() => void sing()}>
                  {job.running ? 'Working…' : 'Sing it'}
                </button>
              </div>
              <p className="mt-2.5 text-[11.5px] leading-snug text-[var(--text-faint)]">
                One line is sung per melodic phrase. Long lines are split across notes; short ones are held.
              </p>
            </Panel>
          )}
        </div>
      </div>
    </div>
  )
}
