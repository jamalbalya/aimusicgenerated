/**
 * The library: projects saved in IndexedDB.
 *
 * Everything stays on the device. There is no account, no upload and no
 * server — which is also why there is nothing to pay for.
 */

import type { Score } from '../engine/compose/types'

const DB_NAME = 'resonant-studio'
const DB_VERSION = 1
const STORE = 'projects'

export interface SavedProject {
  id: string
  title: string
  prompt: string
  genreId: string
  bpm: number
  createdAt: number
  durationSeconds: number
  score: Score
  /** Encoded audio, stored as a blob so large renders do not bloat memory. */
  audio: Blob
  audioType: string
  lyrics?: string
}

export interface ProjectSummary {
  id: string
  title: string
  prompt: string
  genreId: string
  bpm: number
  createdAt: number
  durationSeconds: number
  hasLyrics: boolean
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('This browser has no local storage available for the library.'))
      return
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'id' })
        store.createIndex('createdAt', 'createdAt')
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('Could not open the library.'))
  })
}

async function withStore<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await openDatabase()
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = db.transaction(STORE, mode)
      const request = run(transaction.objectStore(STORE))
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error ?? new Error('Library operation failed.'))
      transaction.onabort = () => reject(transaction.error ?? new Error('Library operation aborted.'))
    })
  } finally {
    db.close()
  }
}

export function newProjectId(): string {
  return `p_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

export async function saveProject(project: SavedProject): Promise<void> {
  await withStore('readwrite', (store) => store.put(project))
}

export async function listProjects(): Promise<ProjectSummary[]> {
  const all = await withStore<SavedProject[]>('readonly', (store) => store.getAll() as IDBRequest<SavedProject[]>)
  return all
    .map((project) => ({
      id: project.id,
      title: project.title,
      prompt: project.prompt,
      genreId: project.genreId,
      bpm: project.bpm,
      createdAt: project.createdAt,
      durationSeconds: project.durationSeconds,
      hasLyrics: Boolean(project.lyrics),
    }))
    .sort((a, b) => b.createdAt - a.createdAt)
}

export async function loadProject(id: string): Promise<SavedProject | undefined> {
  return withStore<SavedProject | undefined>('readonly', (store) => store.get(id) as IDBRequest<SavedProject | undefined>)
}

export async function deleteProject(id: string): Promise<void> {
  await withStore('readwrite', (store) => store.delete(id))
}

export async function clearLibrary(): Promise<void> {
  await withStore('readwrite', (store) => store.clear())
}

/** Rough storage use, when the browser will tell us. */
export async function storageEstimate(): Promise<{ usage: number; quota: number } | null> {
  if (typeof navigator === 'undefined' || !navigator.storage?.estimate) return null
  const estimate = await navigator.storage.estimate()
  return { usage: estimate.usage ?? 0, quota: estimate.quota ?? 0 }
}
