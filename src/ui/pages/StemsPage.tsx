/**
 * Stem Splitter — vocal removal and four-way separation.
 */

import { useCallback, useState } from 'react'
import { Icon } from '../components/Icon'
import { Empty, Field, Panel, Progress, Segmented, Slider } from '../components/controls'
import { FileDrop } from '../components/FileDrop'
import { isCancellation, useJob } from '../useJob'
import { useStudio } from '../../state/store'
import { decodeAudioFile, downloadBlob, encodeAudio, safeFilename } from '../../lib/files'
import { formatDuration } from '../../engine/core/units'
import type { AudioData } from '../../engine/audio/wav'
import type { SeparateResult } from '../../workers/protocol'

/**
 * Separation holds every stem in memory at full length, so the ceiling is set
 * by what a phone can allocate rather than by the algorithm.
 */
const MAX_SECONDS = 8 * 60

const STEM_LABELS: Record<string, { label: string; blurb: string }> = {
  vocals: { label: 'Vocals', blurb: 'The centred lead and its harmonies' },
  instrumental: { label: 'Instrumental', blurb: 'Everything except the vocal — your karaoke track' },
  drums: { label: 'Drums', blurb: 'Transients and percussion' },
  bass: { label: 'Bass', blurb: 'Sustained low end' },
  other: { label: 'Other', blurb: 'Guitars, keys, pads and the rest' },
}

export default function StemsPage() {
  const job = useJob()
  const setCurrent = useStudio((s) => s.setCurrent)
  const notify = useStudio((s) => s.notify)

  const [file, setFile] = useState<{ name: string; size: number } | null>(null)
  const [source, setSource] = useState<AudioData | null>(null)
  const [mode, setMode] = useState<'vocals' | 'stems'>('vocals')
  const [strength, setStrength] = useState(0.85)
  const [stems, setStems] = useState<SeparateResult['stems'] | null>(null)

  const load = useCallback(async (picked: File) => {
    try {
      const audio = await decodeAudioFile(picked)
      const duration = (audio.channels[0]?.length ?? 0) / audio.sampleRate
      if (duration < 0.5) {
        notify('That file is too short to separate.', 'error')
        return
      }
      if (duration > MAX_SECONDS) {
        notify(
          `Files longer than ${Math.round(MAX_SECONDS / 60)} minutes are not supported — trim it first in the Audio Toolkit.`,
          'error',
        )
        return
      }
      setSource(audio)
      setStems(null)
      setFile({ name: picked.name, size: picked.size })
      setCurrent({
        title: picked.name.replace(/\.[^.]+$/, ''),
        subtitle: `Source · ${formatDuration(duration)} · ${(audio.sampleRate / 1000).toFixed(1)} kHz`,
        audio,
        source: 'edit',
      })
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Could not read that file.', 'error')
    }
  }, [notify, setCurrent])

  const separate = useCallback(async () => {
    if (!source) return
    try {
      const output = await job.run<SeparateResult>('Separating', {
        kind: 'separate',
        audio: { channels: source.channels, sampleRate: source.sampleRate },
        mode,
        strength,
      })
      setStems(output.stems)
      const first = output.stems.find((s) => s.name === 'instrumental') ?? output.stems[0]
      if (first) {
        setCurrent({
          title: `${file?.name.replace(/\.[^.]+$/, '') ?? 'Track'} — ${STEM_LABELS[first.name]?.label ?? first.name}`,
          subtitle: 'Separated stem',
          audio: { channels: first.audio.channels, sampleRate: first.audio.sampleRate },
          source: 'stem',
        })
      }
    } catch (error) {
      if (!isCancellation(error)) { /* reported by useJob */ }
    }
  }, [source, mode, strength, job, file, setCurrent])

  const duration = source ? (source.channels[0]?.length ?? 0) / source.sampleRate : 0

  return (
    <div className="grid gap-4">
      <header className="grid gap-2">
        <p className="t-label">Stem Splitter</p>
        <h1 className="t-display max-w-2xl">Take the track apart.</h1>
        <p className="max-w-2xl text-[13.5px] leading-relaxed text-[var(--text-dim)]">
          Vocals sit in the centre of a stereo mix and sustain; drums are transient and broadband.
          Separating on those two facts gets you a usable acapella and a clean backing track
          without uploading anything anywhere.
        </p>
      </header>

      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,360px)_minmax(0,1fr)]">
        <div className="grid content-start gap-4">
          <Panel title="Source">
            <FileDrop
              onFile={(picked) => void load(picked)}
              currentName={file?.name}
              currentSize={file?.size}
              disabled={job.running}
            />
            {source && (
              <p className="t-num mt-2.5 text-[11px] text-[var(--text-faint)]">
                {formatDuration(duration)} · {source.channels.length === 1 ? 'mono' : 'stereo'} ·{' '}
                {(source.sampleRate / 1000).toFixed(1)} kHz
              </p>
            )}
          </Panel>

          <Panel title="Settings">
            <div className="grid gap-3.5">
              <Field label="Mode">
                <Segmented
                  ariaLabel="Separation mode"
                  value={mode}
                  onChange={setMode}
                  options={[
                    { value: 'vocals', label: 'Vocal + backing', title: 'Two stems, faster' },
                    { value: 'stems', label: 'Four stems', title: 'Vocals, drums, bass, other' },
                  ]}
                />
              </Field>

              <Field
                label="Separation strength"
                value={`${Math.round(strength * 100)}%`}
                hint="Higher removes more of the vocal, at the cost of some artefacts in the backing."
              >
                <Slider min={0.3} max={1} step={0.05} value={strength} onChange={setStrength} ariaLabel="Separation strength" />
              </Field>

              <button
                type="button"
                className="btn btn-primary"
                disabled={!source || job.running}
                onClick={() => void separate()}
              >
                {job.running ? 'Separating…' : mode === 'vocals' ? 'Split vocal & backing' : 'Split four stems'}
              </button>
              {job.running && <Progress value={job.progress} stage={job.stage} label="Separating" />}
              {!job.running && source && (
                <p className="text-[11.5px] leading-snug text-[var(--text-faint)]">
                  A {formatDuration(duration)} track takes roughly{' '}
                  {formatDuration(Math.max(4, duration * (mode === 'stems' ? 0.9 : 0.35)))} to process on a
                  desktop, longer on a phone. Four-stem mode is the heavier of the two.
                </p>
              )}
            </div>
          </Panel>
        </div>

        <Panel title="Stems">
          {stems ? (
            <div className="grid gap-1.5">
              {stems.map((stem) => {
                const meta = STEM_LABELS[stem.name] ?? { label: stem.name, blurb: '' }
                return (
                  <div
                    key={stem.name}
                    className="flex items-center justify-between gap-3 border-b border-[var(--line)] py-2.5 last:border-0"
                  >
                    <div className="min-w-0">
                      <p className="text-[13px] font-medium">{meta.label}</p>
                      <p className="text-[11.5px] text-[var(--text-faint)]">{meta.blurb}</p>
                    </div>
                    <div className="flex shrink-0 gap-1.5">
                      <button
                        type="button"
                        className="btn btn-sm"
                        onClick={() =>
                          setCurrent({
                            title: `${file?.name.replace(/\.[^.]+$/, '') ?? 'Track'} — ${meta.label}`,
                            subtitle: 'Separated stem',
                            audio: { channels: stem.audio.channels, sampleRate: stem.audio.sampleRate },
                            source: 'stem',
                          })
                        }
                      >
                        <Icon name="play" size={11} />
                        Play
                      </button>
                      <button
                        type="button"
                        className="btn btn-sm"
                        aria-label={`Download ${meta.label}`}
                        onClick={() => {
                          void encodeAudio(
                            { channels: stem.audio.channels, sampleRate: stem.audio.sampleRate },
                            'wav16',
                          )
                            .then((blob) =>
                              downloadBlob(blob, `${safeFilename(file?.name ?? 'track')}-${stem.name}.wav`))
                            .catch((error: unknown) =>
                              notify(error instanceof Error ? error.message : 'Download failed.', 'error'))
                        }}
                      >
                        <Icon name="download" size={13} />
                      </button>
                    </div>
                  </div>
                )
              })}
            </div>
          ) : (
            <Empty
              title={source ? 'Ready when you are' : 'No file loaded'}
              body={
                source
                  ? 'Choose a mode and press the button. Nothing is uploaded — the separation runs on this device.'
                  : 'Drop in a song to pull the vocals out of it, or to isolate the drums, bass and everything else.'
              }
            />
          )}
        </Panel>
      </div>
    </div>
  )
}
