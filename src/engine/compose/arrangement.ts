/** Builds the song form: which sections, in what order, and how long. */

import { Rng } from '../core/rng'
import type { GenreDef } from './genres'
import type { SectionKind } from './types'

export interface FormSlot {
  kind: SectionKind
  /** Length in bars. */
  bars: number
  intensity: number
}

const INTENSITY: Record<SectionKind, number> = {
  intro: 0.28,
  verse: 0.5,
  prechorus: 0.66,
  chorus: 0.92,
  bridge: 0.55,
  solo: 0.78,
  drop: 1,
  breakdown: 0.34,
  outro: 0.3,
}

/** Section order templates per form style, before length fitting. */
const TEMPLATES: Record<GenreDef['formStyle'], SectionKind[][]> = {
  song: [
    ['intro', 'verse', 'prechorus', 'chorus', 'verse', 'prechorus', 'chorus', 'bridge', 'chorus', 'outro'],
    ['intro', 'verse', 'chorus', 'verse', 'chorus', 'bridge', 'chorus', 'outro'],
    ['verse', 'chorus', 'verse', 'chorus', 'bridge', 'chorus', 'chorus', 'outro'],
  ],
  edm: [
    ['intro', 'breakdown', 'prechorus', 'drop', 'breakdown', 'prechorus', 'drop', 'outro'],
    ['intro', 'verse', 'prechorus', 'drop', 'breakdown', 'prechorus', 'drop', 'outro'],
  ],
  loop: [
    ['intro', 'verse', 'chorus', 'verse', 'chorus', 'bridge', 'chorus', 'outro'],
    ['intro', 'verse', 'verse', 'chorus', 'verse', 'chorus', 'outro'],
  ],
  through: [
    ['intro', 'verse', 'chorus', 'solo', 'verse', 'chorus', 'outro'],
    ['intro', 'verse', 'bridge', 'solo', 'chorus', 'outro'],
  ],
  ambient: [
    ['intro', 'verse', 'bridge', 'verse', 'breakdown', 'chorus', 'outro'],
    ['intro', 'verse', 'verse', 'bridge', 'outro'],
  ],
}

/** Default bar counts. Short sections keep short songs from feeling stubby. */
function defaultBars(kind: SectionKind, scale: number): number {
  const base: Record<SectionKind, number> = {
    intro: 4, verse: 8, prechorus: 4, chorus: 8, bridge: 4,
    solo: 8, drop: 8, breakdown: 4, outro: 4,
  }
  const bars = Math.round((base[kind] * scale) / 2) * 2
  return Math.max(2, bars)
}

/**
 * Chooses a form that lands close to `targetSeconds`. Sections are added or
 * dropped from the middle of the template, so the song always keeps its
 * intro, first chorus and outro no matter how short the target.
 */
export function buildForm(
  genre: GenreDef,
  bpm: number,
  beatsPerBar: number,
  targetSeconds: number,
  rng: Rng,
): FormSlot[] {
  const secondsPerBar = (beatsPerBar * 60) / bpm
  const targetBars = Math.max(4, Math.round(targetSeconds / secondsPerBar))

  const templates = TEMPLATES[genre.formStyle]
  const template = rng.pick(templates)

  // Start from full-length sections and shrink or extend to fit.
  let scale = 1
  let slots = template.map((kind) => ({ kind, bars: defaultBars(kind, scale), intensity: INTENSITY[kind] }))
  let total = slots.reduce((sum, s) => sum + s.bars, 0)

  // Very short targets: shrink section lengths first, then drop sections.
  while (total > targetBars * 1.15 && scale > 0.5) {
    scale -= 0.25
    slots = template.map((kind) => ({ kind, bars: defaultBars(kind, scale), intensity: INTENSITY[kind] }))
    total = slots.reduce((sum, s) => sum + s.bars, 0)
  }
  while (total > targetBars * 1.15 && slots.length > 3) {
    const dropIndex = findDroppableIndex(slots)
    if (dropIndex < 0) break
    slots.splice(dropIndex, 1)
    total = slots.reduce((sum, s) => sum + s.bars, 0)
  }

  // Long targets: repeat the verse/chorus core before stretching sections.
  let guard = 0
  while (total < targetBars * 0.85 && guard++ < 24) {
    const insertAt = Math.max(1, slots.length - 1)
    const kind: SectionKind = slots.some((s) => s.kind === 'drop') ? 'drop' : 'chorus'
    const verseKind: SectionKind = slots.some((s) => s.kind === 'verse') ? 'verse' : 'breakdown'
    slots.splice(insertAt, 0,
      { kind: verseKind, bars: defaultBars(verseKind, scale), intensity: INTENSITY[verseKind] },
      { kind, bars: defaultBars(kind, scale), intensity: INTENSITY[kind] },
    )
    total = slots.reduce((sum, s) => sum + s.bars, 0)
  }

  // Final trim: adjust the last repeated section so we land near the target.
  const diff = targetBars - total
  if (diff !== 0 && slots.length > 0) {
    const last = slots[slots.length - 1]!
    last.bars = Math.max(2, last.bars + diff)
  }

  ensureStrongEnding(slots)
  applyIntensityArc(slots)
  return slots
}

/**
 * A song should not end on its bridge. If trimming has left a weak section
 * immediately before the outro, it becomes the last chorus instead — the
 * length is unchanged, the shape is not.
 */
function ensureStrongEnding(slots: FormSlot[]): void {
  const payoff: SectionKind | undefined = slots.some((s) => s.kind === 'drop')
    ? 'drop'
    : slots.some((s) => s.kind === 'chorus')
      ? 'chorus'
      : undefined
  if (!payoff) return

  const lastIndex = slots[slots.length - 1]?.kind === 'outro' ? slots.length - 2 : slots.length - 1
  const last = slots[lastIndex]
  if (!last) return
  const weak: SectionKind[] = ['bridge', 'prechorus', 'breakdown', 'solo']
  if (!weak.includes(last.kind)) return
  slots[lastIndex] = { kind: payoff, bars: last.bars, intensity: INTENSITY[payoff] }
}

/**
 * Prefers dropping the *last* repeat of a section rather than the first, so a
 * shortened song keeps its verse-chorus alternation instead of collapsing into
 * a run of choruses at the end.
 */
function findDroppableIndex(slots: FormSlot[]): number {
  const protectedKinds = new Set<SectionKind>(['intro', 'outro'])
  const firstIndex = new Map<SectionKind, number>()
  for (let i = 0; i < slots.length; i++) {
    const kind = slots[i]!.kind
    if (!firstIndex.has(kind)) firstIndex.set(kind, i)
  }
  for (let i = slots.length - 1; i >= 0; i--) {
    const kind = slots[i]!.kind
    if (protectedKinds.has(kind)) continue
    if (firstIndex.get(kind) !== i) return i
  }
  // Nothing repeated — drop the least essential section instead.
  const order: SectionKind[] = ['solo', 'bridge', 'breakdown', 'prechorus', 'verse']
  for (const kind of order) {
    const idx = slots.findIndex((s) => s.kind === kind)
    if (idx >= 0) return idx
  }
  return -1
}

/**
 * Nudges repeated sections upward in intensity so the song builds rather than
 * plateauing — the second chorus should hit harder than the first.
 */
function applyIntensityArc(slots: FormSlot[]): void {
  const counts = new Map<SectionKind, number>()
  for (const slot of slots) {
    const seen = counts.get(slot.kind) ?? 0
    counts.set(slot.kind, seen + 1)
    slot.intensity = Math.min(1, slot.intensity + seen * 0.06)
  }
  const last = slots[slots.length - 1]
  if (last && last.kind === 'outro') last.intensity = Math.min(last.intensity, 0.4)
}

/** Labels sections as "Verse 1", "Chorus 2" and so on. */
export function labelSlots(slots: FormSlot[]): string[] {
  const counts = new Map<SectionKind, number>()
  const totals = new Map<SectionKind, number>()
  for (const slot of slots) totals.set(slot.kind, (totals.get(slot.kind) ?? 0) + 1)

  return slots.map((slot) => {
    const n = (counts.get(slot.kind) ?? 0) + 1
    counts.set(slot.kind, n)
    const pretty = slot.kind.charAt(0).toUpperCase() + slot.kind.slice(1)
    const name = slot.kind === 'prechorus' ? 'Pre-Chorus' : pretty
    return (totals.get(slot.kind) ?? 1) > 1 ? `${name} ${n}` : name
  })
}
