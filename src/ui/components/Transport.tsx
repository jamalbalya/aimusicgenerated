/**
 * The transport bar: what is loaded, where the playhead is, and how to get the
 * audio out. It is the one component present on every page, so it doubles as
 * the app's status line.
 */

import { useEffect, useMemo, useState } from 'react'
import { Icon } from './Icon'
import { Waveform } from './Waveform'
import { formatDuration } from '../../engine/core/units'
import * as player from '../../lib/player'
import { useStudio } from '../../state/store'
import {
  downloadBlob, encodeAudio, EXPORT_FORMATS, extensionFor, safeFilename,
  type ExportFormat,
} from '../../lib/files'

export function Transport() {
  const current = useStudio((s) => s.current)
  const notify = useStudio((s) => s.notify)
  const [state, setState] = useState(() => ({ playing: false, position: 0, duration: 0, volume: 0.85, levels: [0, 0] as [number, number] }))
  const [format, setFormat] = useState<ExportFormat>('mp3-320')
  const [exporting, setExporting] = useState(false)
  const [showExport, setShowExport] = useState(false)

  useEffect(() => player.subscribe(setState), [])

  // Space toggles playback, unless the user is typing.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.code !== 'Space' || event.repeat) return
      const target = event.target as HTMLElement | null
      if (target && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'].includes(target.tagName))) return
      if (!player.hasAudio()) return
      event.preventDefault()
      player.toggle()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const markers = useMemo(() => {
    if (!current?.score) return undefined
    const total = current.score.lengthBeats || 1
    return current.score.sections.map((section) => ({
      position: section.startBeat / total,
      label: section.label,
    }))
  }, [current])

  const progress = state.duration > 0 ? state.position / state.duration : 0
  const disabled = !current

  const handleExport = async (): Promise<void> => {
    if (!current) return
    setExporting(true)
    try {
      const blob = await encodeAudio(current.audio, format)
      await downloadBlob(blob, `${safeFilename(current.title)}.${extensionFor(format)}`)
      setShowExport(false)
      notify('Download started.', 'success')
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Export failed.', 'error')
    } finally {
      setExporting(false)
    }
  }

  return (
    <div className="border-t border-[var(--line)] bg-[var(--bg-panel)]">
      <div className="mx-auto w-full max-w-[1180px] px-3 py-2.5 sm:px-5">
        <div className="flex items-center gap-3">
          <button
            type="button"
            className="btn btn-primary h-9 w-9 shrink-0 !px-0"
            disabled={disabled}
            aria-label={state.playing ? 'Pause' : 'Play'}
            onClick={() => player.toggle()}
          >
            <Icon name={state.playing ? 'pause' : 'play'} size={14} />
          </button>
          <button
            type="button"
            className="btn btn-ghost hidden h-9 w-9 shrink-0 !px-0 sm:inline-flex"
            disabled={disabled}
            aria-label="Stop"
            onClick={() => player.stop()}
          >
            <Icon name="stop" size={11} />
          </button>

          <div className="min-w-0 flex-1">
            <div className="flex items-baseline justify-between gap-3">
              <p className="truncate text-[13px] font-medium">
                {current ? current.title : 'Nothing loaded'}
              </p>
              <span className="t-num shrink-0 text-[11px] text-[var(--text-dim)]">
                {formatDuration(state.position)} / {formatDuration(state.duration)}
              </span>
            </div>
            <p className="truncate text-[11.5px] text-[var(--text-faint)]">
              {current ? current.subtitle : 'Generate a song, or open a tool to get started'}
            </p>
          </div>

          <div className="hidden w-28 shrink-0 items-center gap-2 md:flex">
            <Icon name="wave" size={13} className="text-[var(--text-faint)]" />
            <input
              type="range"
              className="range"
              min={0}
              max={1}
              step={0.01}
              value={state.volume}
              aria-label="Volume"
              onChange={(event) => player.setVolume(Number(event.target.value))}
            />
          </div>

          <div className="relative shrink-0">
            <button
              type="button"
              className="btn h-9"
              disabled={disabled}
              aria-expanded={showExport}
              aria-haspopup="dialog"
              onClick={() => setShowExport((open) => !open)}
            >
              <Icon name="download" size={14} />
              <span className="hidden sm:inline">Export</span>
            </button>

            {showExport && current && (
              <>
                <div
                  className="fixed inset-0 z-40"
                  aria-hidden="true"
                  onClick={() => setShowExport(false)}
                />
                <div
                  className="panel absolute bottom-full right-0 z-50 mb-2 w-64 p-3"
                  style={{ boxShadow: 'var(--shadow-pop)' }}
                  role="dialog"
                  aria-label="Export audio"
                >
                  <p className="t-label mb-2">Format</p>
                  <div className="grid gap-1">
                    {EXPORT_FORMATS.map((option) => (
                      <button
                        key={option.id}
                        type="button"
                        className="nav-item justify-between !border-l-0 !py-1.5 text-[12.5px]"
                        aria-current={format === option.id ? 'page' : undefined}
                        onClick={() => setFormat(option.id)}
                      >
                        <span>{option.label}</span>
                        {format === option.id && <Icon name="check" size={13} className="text-[var(--accent)]" />}
                      </button>
                    ))}
                  </div>
                  <button
                    type="button"
                    className="btn btn-primary mt-3 w-full"
                    disabled={exporting}
                    onClick={() => void handleExport()}
                  >
                    {exporting ? 'Preparing…' : 'Download'}
                  </button>
                  <p className="mt-2 text-[11px] leading-snug text-[var(--text-faint)]">
                    Free, unwatermarked, yours to use.
                  </p>
                </div>
              </>
            )}
          </div>
        </div>

        <div className="mt-2">
          <Waveform
            audio={current?.audio ?? null}
            progress={progress}
            height={46}
            markers={markers}
            onSeek={disabled ? undefined : (fraction) => player.seek(fraction * state.duration)}
          />
        </div>
      </div>
    </div>
  )
}
