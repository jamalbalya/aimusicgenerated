/** Global application state. Small on purpose — pages own their own forms. */

import { create } from 'zustand'
import type { RenderQuality } from '../workers/protocol'
import type { Score } from '../engine/compose/types'
import type { AudioData } from '../engine/audio/wav'
import * as player from '../lib/player'

export type Theme = 'dark' | 'light'

export interface LoadedTrack {
  /** What is currently in the player. */
  title: string
  subtitle: string
  audio: AudioData
  score?: Score
  lyrics?: string
  stems?: { id: string; name: string; audio: AudioData }[]
  /** Where it came from, for the download filename. */
  source: 'song' | 'speech' | 'stem' | 'edit'
}

interface StudioState {
  theme: Theme
  quality: RenderQuality
  current: LoadedTrack | null
  /** Non-null while a background job is running. */
  job: { label: string; progress: number; stage: string } | null
  toast: { message: string; tone: 'info' | 'error' | 'success' } | null

  setTheme: (theme: Theme) => void
  setQuality: (quality: RenderQuality) => void
  setCurrent: (track: LoadedTrack | null) => void
  setJob: (job: { label: string; progress: number; stage: string } | null) => void
  notify: (message: string, tone?: 'info' | 'error' | 'success') => void
  dismissToast: () => void
}

const THEME_KEY = 'resonant.theme'
const QUALITY_KEY = 'resonant.quality'

function readStored<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const value = localStorage.getItem(key)
    if (value && (allowed as readonly string[]).includes(value)) return value as T
  } catch {
    // Private browsing can block storage entirely; the default is fine.
  }
  return fallback
}

function persist(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    // Nothing to do — the preference just will not survive a reload.
  }
}

export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme
  const meta = document.querySelector('meta[name="theme-color"]')
  if (meta) meta.setAttribute('content', theme === 'dark' ? '#0b0c0e' : '#f6f5f2')
}

export const useStudio = create<StudioState>((set) => ({
  theme: readStored(THEME_KEY, ['dark', 'light'] as const, 'dark'),
  quality: readStored(QUALITY_KEY, ['draft', 'balanced', 'studio'] as const, 'balanced'),
  current: null,
  job: null,
  toast: null,

  setTheme: (theme) => {
    persist(THEME_KEY, theme)
    applyTheme(theme)
    set({ theme })
  },

  setQuality: (quality) => {
    persist(QUALITY_KEY, quality)
    set({ quality })
  },

  setCurrent: (track) => {
    if (track) player.load(track.audio.channels, track.audio.sampleRate)
    else player.stop()
    set({ current: track })
  },

  setJob: (job) => set({ job }),

  notify: (message, tone = 'info') => set({ toast: { message, tone } }),

  dismissToast: () => set({ toast: null }),
}))
