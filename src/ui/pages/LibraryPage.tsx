/** Library — everything made on this device. */

import { useCallback, useEffect, useState } from 'react'
import { Icon } from '../components/Icon'
import { Empty, Panel, Stat } from '../components/controls'
import { useStudio } from '../../state/store'
import {
  clearLibrary, deleteProject, listProjects, loadProject, storageEstimate,
  type ProjectSummary,
} from '../../lib/library'
import { decodeAudioFile, downloadBlob, formatBytes, safeFilename } from '../../lib/files'
import { formatDuration } from '../../engine/core/units'
import { GENRES } from '../../engine/compose/genres'
import { linkProps } from '../../lib/router'

export default function LibraryPage() {
  const setCurrent = useStudio((s) => s.setCurrent)
  const notify = useStudio((s) => s.notify)
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null)
  const [storage, setStorage] = useState<{ usage: number; quota: number } | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const load = useCallback(async () => {
    const summaries = await listProjects()
    const estimate = await storageEstimate()
    return { summaries, estimate }
  }, [])

  const refresh = useCallback(async () => {
    try {
      const { summaries, estimate } = await load()
      setProjects(summaries)
      setStorage(estimate)
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Could not open the library.', 'error')
      setProjects([])
    }
  }, [load, notify])

  useEffect(() => {
    // The library lives in IndexedDB — an external store, read once on mount.
    let cancelled = false
    load()
      .then(({ summaries, estimate }) => {
        if (cancelled) return
        setProjects(summaries)
        setStorage(estimate)
      })
      .catch(() => {
        if (!cancelled) setProjects([])
      })
    return () => {
      cancelled = true
    }
  }, [load])

  const open = useCallback(async (id: string) => {
    setBusy(id)
    try {
      const project = await loadProject(id)
      if (!project) {
        notify('That project is no longer in the library.', 'error')
        return
      }
      const audio = await decodeAudioFile(project.audio)
      setCurrent({
        title: project.title,
        subtitle: `${GENRES.find((g) => g.id === project.genreId)?.label ?? project.genreId} · ${project.bpm} BPM`,
        audio,
        score: project.score,
        lyrics: project.lyrics,
        source: 'song',
      })
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Could not open that project.', 'error')
    } finally {
      setBusy(null)
    }
  }, [notify, setCurrent])

  const download = useCallback(async (project: ProjectSummary) => {
    setBusy(project.id)
    try {
      const stored = await loadProject(project.id)
      if (!stored) return
      const extension = stored.audioType.includes('mpeg') ? 'mp3' : 'wav'
      downloadBlob(stored.audio, `${safeFilename(stored.title)}.${extension}`)
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Could not export that project.', 'error')
    } finally {
      setBusy(null)
    }
  }, [notify])

  const remove = useCallback(async (id: string) => {
    try {
      await deleteProject(id)
      await refresh()
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Could not delete that project.', 'error')
    }
  }, [notify, refresh])

  return (
    <div className="grid gap-4">
      <header className="grid gap-2">
        <p className="t-label">Library</p>
        <h1 className="t-display max-w-2xl">Saved on this device.</h1>
        <p className="max-w-2xl text-[13.5px] leading-relaxed text-[var(--text-dim)]">
          Nothing here has ever left your browser. Clearing your site data clears the library,
          so download anything you want to keep.
        </p>
      </header>

      {storage && storage.quota > 0 && (
        <Panel title="Storage">
          <div className="grid gap-3 sm:grid-cols-3">
            <Stat label="Used" value={formatBytes(storage.usage)} />
            <Stat label="Available" value={formatBytes(Math.max(0, storage.quota - storage.usage))} />
            <Stat label="Projects" value={`${projects?.length ?? 0}`} />
          </div>
        </Panel>
      )}

      <Panel
        title="Projects"
        action={
          projects && projects.length > 0 && (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => {
                if (!window.confirm('Delete every saved project? This cannot be undone.')) return
                void clearLibrary().then(refresh).then(() => notify('Library cleared.', 'success'))
              }}
            >
              Clear all
            </button>
          )
        }
      >
        {projects === null ? (
          <p className="py-6 text-center text-[13px] text-[var(--text-dim)]">Opening the library…</p>
        ) : projects.length === 0 ? (
          <Empty
            title="Nothing saved yet"
            body="Generate a song in the Song Studio and press Save to library. It stays on this device — no account required."
            action={<a className="btn btn-sm" {...linkProps('/')}>Open the Song Studio</a>}
          />
        ) : (
          <ul className="grid gap-1.5">
            {projects.map((project) => (
              <li
                key={project.id}
                className="flex items-center justify-between gap-3 border-b border-[var(--line)] py-2.5 last:border-0"
              >
                <div className="min-w-0">
                  <p className="truncate text-[13.5px] font-medium">{project.title}</p>
                  <p className="t-num truncate text-[11px] text-[var(--text-faint)]">
                    {GENRES.find((g) => g.id === project.genreId)?.label ?? project.genreId} ·{' '}
                    {project.bpm} BPM · {formatDuration(project.durationSeconds)} ·{' '}
                    {new Date(project.createdAt).toLocaleDateString()}
                    {project.hasLyrics ? ' · lyrics' : ''}
                  </p>
                </div>
                <div className="flex shrink-0 gap-1.5">
                  <button
                    type="button"
                    className="btn btn-sm"
                    disabled={busy === project.id}
                    onClick={() => void open(project.id)}
                  >
                    <Icon name="play" size={11} />
                    <span className="hidden sm:inline">Open</span>
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm"
                    aria-label={`Download ${project.title}`}
                    disabled={busy === project.id}
                    onClick={() => void download(project)}
                  >
                    <Icon name="download" size={13} />
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm"
                    aria-label={`Delete ${project.title}`}
                    onClick={() => {
                      if (window.confirm(`Delete “${project.title}”?`)) void remove(project.id)
                    }}
                  >
                    <Icon name="trash" size={13} />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  )
}
