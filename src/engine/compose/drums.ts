/**
 * Drum programming. Each style is a 16th-note grid per bar; the generator adds
 * intensity-driven layers, humanised timing/velocity, and fills at section
 * boundaries.
 */

import { Rng } from '../core/rng'
import type { DrumHit, DrumName, DrumTrack } from './types'
import type { DrumStyle, GenreDef } from './genres'
import type { FormSlot } from './arrangement'

/** Velocity per 16th step; 0 means no hit. Length must equal stepsPerBar. */
type Grid = Partial<Record<DrumName, number[]>>

const _ = 0

/** Patterns are written for 16 steps (one 4/4 bar of 16ths). */
const PATTERNS: Record<DrumStyle, { core: Grid; extra: Grid }> = {
  fourFloor: {
    core: {
      kick: [1, _, _, _, 1, _, _, _, 1, _, _, _, 1, _, _, _],
      hatClosed: [_, _, 0.5, _, _, _, 0.5, _, _, _, 0.5, _, _, _, 0.5, _],
      hatOpen: [_, _, _, _, 0.7, _, _, _, _, _, _, _, 0.7, _, _, _],
      clap: [_, _, _, _, 0.9, _, _, _, _, _, _, _, 0.9, _, _, _],
    },
    extra: {
      shaker: [0.4, 0.25, 0.4, 0.25, 0.4, 0.25, 0.4, 0.25, 0.4, 0.25, 0.4, 0.25, 0.4, 0.25, 0.4, 0.25],
      ride: [_, _, _, _, _, _, 0.35, _, _, _, _, _, _, _, 0.35, _],
    },
  },
  disco: {
    core: {
      kick: [1, _, _, _, 1, _, _, _, 1, _, _, _, 1, _, _, _],
      snare: [_, _, _, _, 0.85, _, _, _, _, _, _, _, 0.85, _, _, _],
      hatClosed: [0.5, _, 0.35, _, 0.5, _, 0.35, _, 0.5, _, 0.35, _, 0.5, _, 0.35, _],
      hatOpen: [_, _, _, 0.7, _, _, _, 0.7, _, _, _, 0.7, _, _, _, 0.7],
    },
    extra: {
      tambourine: [_, _, 0.4, _, _, _, 0.4, _, _, _, 0.4, _, _, _, 0.4, _],
      conga: [_, _, _, _, _, 0.4, _, 0.3, _, _, _, _, _, 0.4, _, 0.3],
    },
  },
  pop: {
    core: {
      kick: [1, _, _, _, _, _, _, _, _, _, 0.9, _, _, _, _, _],
      snare: [_, _, _, _, 0.9, _, _, _, _, _, _, _, 0.9, _, _, _],
      hatClosed: [0.55, _, 0.35, _, 0.5, _, 0.35, _, 0.55, _, 0.35, _, 0.5, _, 0.4, _],
    },
    extra: {
      clap: [_, _, _, _, 0.6, _, _, _, _, _, _, _, 0.6, _, _, _],
      shaker: [_, 0.3, _, 0.3, _, 0.3, _, 0.3, _, 0.3, _, 0.3, _, 0.3, _, 0.35],
      hatOpen: [_, _, _, _, _, _, _, 0.5, _, _, _, _, _, _, _, 0.5],
    },
  },
  rock: {
    core: {
      kick: [1, _, _, _, _, _, 0.85, _, _, _, 0.9, _, _, _, _, _],
      snare: [_, _, _, _, 0.95, _, _, _, _, _, _, _, 0.95, _, _, _],
      hatClosed: [0.6, _, 0.45, _, 0.6, _, 0.45, _, 0.6, _, 0.45, _, 0.6, _, 0.45, _],
    },
    extra: {
      ride: [0.5, _, 0.35, _, 0.5, _, 0.35, _, 0.5, _, 0.35, _, 0.5, _, 0.35, _],
      crash: [0.8, _, _, _, _, _, _, _, _, _, _, _, _, _, _, _],
    },
  },
  punk: {
    core: {
      kick: [1, _, _, _, 1, _, _, _, 1, _, _, _, 1, _, _, _],
      snare: [_, _, _, _, 0.95, _, _, _, _, _, _, _, 0.95, _, _, _],
      hatClosed: [0.7, _, 0.7, _, 0.7, _, 0.7, _, 0.7, _, 0.7, _, 0.7, _, 0.7, _],
    },
    extra: {
      crash: [0.85, _, _, _, _, _, _, _, 0.6, _, _, _, _, _, _, _],
      tomLow: [_, _, _, _, _, _, _, _, _, _, _, _, _, _, 0.5, 0.6],
    },
  },
  metal: {
    core: {
      kick: [1, 0.8, _, 0.8, 1, _, 0.8, _, 1, 0.8, _, 0.8, 1, _, 0.8, 0.8],
      snare: [_, _, _, _, 1, _, _, _, _, _, _, _, 1, _, _, _],
      hatClosed: [0.6, _, 0.6, _, 0.6, _, 0.6, _, 0.6, _, 0.6, _, 0.6, _, 0.6, _],
    },
    extra: {
      crash: [0.9, _, _, _, _, _, _, _, _, _, _, _, _, _, _, _],
      ride: [0.5, _, 0.5, _, 0.5, _, 0.5, _, 0.5, _, 0.5, _, 0.5, _, 0.5, _],
      tomLow: [_, _, _, _, _, _, _, _, _, _, _, _, _, 0.6, 0.6, 0.7],
    },
  },
  boomBap: {
    core: {
      kick: [1, _, _, _, _, _, 0.7, _, _, _, 0.9, _, _, _, _, _],
      snare: [_, _, _, _, 0.9, _, _, _, _, _, _, _, 0.9, _, _, _],
      hatClosed: [0.5, _, 0.4, _, 0.5, _, 0.4, _, 0.5, _, 0.4, _, 0.5, _, 0.4, _],
    },
    extra: {
      hatOpen: [_, _, _, _, _, _, _, 0.45, _, _, _, _, _, _, _, 0.45],
      rim: [_, _, 0.3, _, _, _, _, _, _, _, _, 0.3, _, _, _, _],
      shaker: [_, 0.25, _, 0.25, _, 0.25, _, 0.25, _, 0.25, _, 0.25, _, 0.25, _, 0.25],
    },
  },
  trap: {
    core: {
      kick: [1, _, _, _, _, _, _, 0.85, _, _, 0.9, _, _, _, _, _],
      snare: [_, _, _, _, _, _, _, _, 0.95, _, _, _, _, _, _, _],
      hatClosed: [0.6, 0.4, 0.6, 0.4, 0.6, 0.4, 0.6, 0.4, 0.6, 0.4, 0.6, 0.4, 0.6, 0.4, 0.6, 0.4],
    },
    extra: {
      clap: [_, _, _, _, _, _, _, _, 0.7, _, _, _, _, _, _, _],
      hatOpen: [_, _, _, _, _, _, 0.5, _, _, _, _, _, _, _, 0.5, _],
      perc: [_, _, _, 0.35, _, _, _, _, _, _, _, 0.35, _, _, _, _],
    },
  },
  drill: {
    core: {
      kick: [1, _, _, _, _, _, 0.8, _, _, 0.85, _, _, _, _, _, _],
      snare: [_, _, _, _, _, _, _, _, 0.95, _, _, _, _, _, 0.6, _],
      hatClosed: [0.55, _, 0.45, 0.35, 0.55, _, 0.45, _, 0.55, 0.35, 0.45, _, 0.55, _, 0.45, 0.35],
    },
    extra: {
      rim: [_, _, _, _, 0.5, _, _, _, _, _, _, _, 0.5, _, _, _],
      hatOpen: [_, _, _, _, _, _, _, 0.45, _, _, _, _, _, _, _, _],
    },
  },
  phonk: {
    core: {
      kick: [1, _, _, _, _, _, 0.8, _, _, _, 0.9, _, _, _, _, _],
      snare: [_, _, _, _, 0.9, _, _, _, _, _, _, _, 0.9, _, _, _],
      hatClosed: [0.5, 0.35, 0.5, 0.35, 0.5, 0.35, 0.5, 0.35, 0.5, 0.35, 0.5, 0.35, 0.5, 0.35, 0.5, 0.35],
    },
    extra: {
      cowbell: [0.6, _, _, 0.45, _, _, 0.6, _, _, 0.45, _, _, 0.6, _, _, _],
      perc: [_, _, _, _, _, 0.3, _, _, _, _, _, 0.3, _, _, _, _],
    },
  },
  halfTime: {
    core: {
      kick: [1, _, _, _, _, _, _, _, _, _, 0.8, _, _, _, _, _],
      snare: [_, _, _, _, _, _, _, _, 0.95, _, _, _, _, _, _, _],
      hatClosed: [0.45, _, 0.35, _, 0.45, _, 0.35, _, 0.45, _, 0.35, _, 0.45, _, 0.35, _],
    },
    extra: {
      rim: [_, _, _, _, 0.35, _, _, _, _, _, _, _, 0.35, _, _, _],
      shaker: [_, 0.25, _, 0.25, _, 0.25, _, 0.25, _, 0.25, _, 0.25, _, 0.25, _, 0.3],
    },
  },
  breakbeat: {
    core: {
      kick: [1, _, _, 0.6, _, _, 0.8, _, _, _, 0.7, _, _, _, _, _],
      snare: [_, _, _, _, 0.9, _, _, _, _, 0.5, _, _, 0.9, _, _, 0.5],
      hatClosed: [0.5, 0.3, 0.5, 0.3, 0.5, 0.3, 0.5, 0.3, 0.5, 0.3, 0.5, 0.3, 0.5, 0.3, 0.5, 0.3],
    },
    extra: {
      ride: [_, _, _, _, _, _, 0.35, _, _, _, _, _, _, _, 0.35, _],
      tomMid: [_, _, _, _, _, _, _, _, _, _, _, 0.45, _, _, _, _],
    },
  },
  dnb: {
    core: {
      kick: [1, _, _, _, _, _, _, _, _, _, 0.85, _, _, _, _, _],
      snare: [_, _, _, _, 0.95, _, _, _, _, _, _, _, 0.95, _, _, _],
      hatClosed: [0.45, 0.3, 0.45, 0.3, 0.45, 0.3, 0.45, 0.3, 0.45, 0.3, 0.45, 0.3, 0.45, 0.3, 0.45, 0.3],
    },
    extra: {
      ride: [_, _, 0.35, _, _, _, 0.35, _, _, _, 0.35, _, _, _, 0.35, _],
      rim: [_, _, 0.25, _, _, 0.25, _, _, _, 0.25, _, _, _, 0.25, _, _],
    },
  },
  shuffle: {
    core: {
      kick: [1, _, _, _, _, _, 0.7, _, _, _, 0.85, _, _, _, _, _],
      snare: [_, _, _, _, 0.9, _, _, _, _, _, _, _, 0.9, _, _, _],
      hatClosed: [0.55, _, _, 0.4, 0.55, _, _, 0.4, 0.55, _, _, 0.4, 0.55, _, _, 0.4],
    },
    extra: {
      ride: [0.5, _, _, 0.35, 0.5, _, _, 0.35, 0.5, _, _, 0.35, 0.5, _, _, 0.35],
      tambourine: [_, _, _, _, 0.4, _, _, _, _, _, _, _, 0.4, _, _, _],
    },
  },
  jazzSwing: {
    core: {
      ride: [0.7, _, _, 0.45, 0.6, _, 0.5, 0.45, 0.7, _, _, 0.45, 0.6, _, 0.5, 0.45],
      hatPedal: [_, _, _, _, 0.5, _, _, _, _, _, _, _, 0.5, _, _, _],
      kick: [0.45, _, _, _, _, _, _, _, _, _, 0.35, _, _, _, _, _],
    },
    extra: {
      snare: [_, _, 0.3, _, _, _, _, 0.35, _, _, 0.3, _, _, 0.25, _, _],
    },
  },
  latin: {
    core: {
      kick: [1, _, _, 0.6, _, _, 0.8, _, 1, _, _, 0.6, _, _, 0.8, _],
      conga: [0.5, _, 0.35, 0.4, 0.5, _, 0.35, 0.4, 0.5, _, 0.35, 0.4, 0.5, _, 0.35, 0.4],
      shaker: [0.35, 0.25, 0.35, 0.25, 0.35, 0.25, 0.35, 0.25, 0.35, 0.25, 0.35, 0.25, 0.35, 0.25, 0.35, 0.25],
    },
    extra: {
      rim: [_, _, _, 0.5, _, _, 0.5, _, _, _, 0.5, _, _, 0.5, _, _],
      cowbell: [0.4, _, _, _, 0.4, _, _, _, 0.4, _, _, _, 0.4, _, _, _],
    },
  },
  reggaeton: {
    core: {
      kick: [1, _, _, _, _, _, _, _, 1, _, _, _, _, _, _, _],
      snare: [_, _, _, 0.85, _, _, 0.8, _, _, _, _, 0.85, _, _, 0.8, _],
      hatClosed: [0.45, _, 0.45, _, 0.45, _, 0.45, _, 0.45, _, 0.45, _, 0.45, _, 0.45, _],
    },
    extra: {
      perc: [_, 0.3, _, _, _, 0.3, _, _, _, 0.3, _, _, _, 0.3, _, _],
      shaker: [_, 0.25, _, 0.25, _, 0.25, _, 0.25, _, 0.25, _, 0.25, _, 0.25, _, 0.25],
    },
  },
  afrobeat: {
    core: {
      kick: [1, _, _, _, _, _, 0.7, _, _, 0.8, _, _, _, _, 0.6, _],
      rim: [_, _, _, 0.6, _, _, _, _, _, _, 0.6, _, _, _, _, _],
      shaker: [0.4, 0.3, 0.4, 0.3, 0.4, 0.3, 0.4, 0.3, 0.4, 0.3, 0.4, 0.3, 0.4, 0.3, 0.4, 0.3],
    },
    extra: {
      conga: [_, _, 0.4, _, 0.35, _, _, 0.4, _, _, 0.4, _, 0.35, _, _, 0.4],
      clap: [_, _, _, _, 0.5, _, _, _, _, _, _, _, 0.5, _, _, _],
      hatClosed: [_, 0.3, _, 0.3, _, 0.3, _, 0.3, _, 0.3, _, 0.3, _, 0.3, _, 0.3],
    },
  },
  bossa: {
    core: {
      kick: [0.7, _, _, 0.5, _, _, 0.6, _, 0.7, _, _, 0.5, _, _, 0.6, _],
      rim: [0.5, _, _, 0.45, _, _, 0.5, _, _, 0.45, _, _, 0.5, _, _, _],
      shaker: [0.3, 0.25, 0.3, 0.25, 0.3, 0.25, 0.3, 0.25, 0.3, 0.25, 0.3, 0.25, 0.3, 0.25, 0.3, 0.25],
    },
    extra: {
      ride: [0.35, _, 0.3, _, 0.35, _, 0.3, _, 0.35, _, 0.3, _, 0.35, _, 0.3, _],
    },
  },
  march: {
    core: {
      kick: [1, _, _, _, 0.7, _, _, _, 1, _, _, _, 0.7, _, _, _],
      snare: [_, _, _, _, 0.8, _, 0.4, 0.4, _, _, _, _, 0.8, _, 0.5, 0.5],
      tomLow: [0.6, _, _, _, _, _, _, _, 0.6, _, _, _, _, _, _, _],
    },
    extra: {
      crash: [0.7, _, _, _, _, _, _, _, _, _, _, _, _, _, _, _],
      impact: [0.8, _, _, _, _, _, _, _, _, _, _, _, _, _, _, _],
      tomMid: [_, _, _, _, _, _, _, _, _, _, 0.5, _, _, _, _, _],
    },
  },
  chiptune: {
    core: {
      kick: [1, _, _, _, _, _, _, _, 0.9, _, _, _, _, _, _, _],
      snare: [_, _, _, _, 0.85, _, _, _, _, _, _, _, 0.85, _, _, _],
      hatClosed: [0.5, 0.35, 0.5, 0.35, 0.5, 0.35, 0.5, 0.35, 0.5, 0.35, 0.5, 0.35, 0.5, 0.35, 0.5, 0.35],
    },
    extra: {
      perc: [_, _, _, _, _, _, _, 0.4, _, _, _, _, _, _, _, 0.4],
    },
  },
  waltz: {
    core: {
      kick: [1, _, _, _, _, _, _, _, _, _, _, _, _, _, _, _],
      hatClosed: [_, _, _, _, 0.45, _, _, _, 0.45, _, _, _, _, _, _, _],
      rim: [_, _, _, _, 0.35, _, _, _, 0.35, _, _, _, _, _, _, _],
    },
    extra: {
      shaker: [_, _, 0.2, _, _, _, 0.2, _, _, _, 0.2, _, _, _, _, _],
    },
  },
  ambient: {
    core: {
      perc: [0.35, _, _, _, _, _, _, _, _, _, _, _, _, _, _, _],
    },
    extra: {
      shaker: [_, _, _, _, _, _, _, _, 0.2, _, _, _, _, _, _, _],
      reverseCymbal: [_, _, _, _, _, _, _, _, _, _, _, _, _, _, _, _],
    },
  },
  none: { core: {}, extra: {} },
}

const STEPS_PER_BAR = 16

export interface DrumOptions {
  genre: GenreDef
  beatsPerBar: number
  slots: FormSlot[]
  /** Absolute start beat of each slot, same length as `slots`. */
  slotStarts: number[]
  rng: Rng
  /** 0..1 global energy from the mood. */
  energy: number
}

export function generateDrums(options: DrumOptions): DrumTrack {
  const { genre, beatsPerBar, slots, slotStarts, rng, energy } = options
  const pattern = PATTERNS[genre.drumStyle] ?? PATTERNS.pop
  const hits: DrumHit[] = []

  if (genre.drumStyle === 'none') {
    return { hits, swing: 0, gainDb: -60 }
  }

  // Patterns are written as 16th notes, so one step is always a quarter beat.
  // A 3/4 bar simply uses the first 12 steps of the row.
  const stepBeats = 4 / STEPS_PER_BAR

  for (let s = 0; s < slots.length; s++) {
    const slot = slots[s]!
    const startBeat = slotStarts[s]!
    const intensity = slot.intensity
    // Sparse sections drop the kit down to a skeleton.
    const layerChance = Math.min(1, intensity * 0.9 + energy * 0.3)
    const silent = slot.kind === 'breakdown' && rng.chance(0.35)

    for (let bar = 0; bar < slot.bars; bar++) {
      const barStart = startBeat + bar * beatsPerBar
      const isLastBar = bar === slot.bars - 1
      const isFillBar = isLastBar && slot.bars >= 4 && rng.chance(0.75)

      if (!silent) {
        emitGrid(hits, pattern.core, barStart, stepBeats, beatsPerBar, 1, rng, intensity)
        if (rng.chance(layerChance)) {
          emitGrid(hits, pattern.extra, barStart, stepBeats, beatsPerBar, 0.85, rng, intensity)
        }
      }

      // A crash marks the downbeat of every new section that has energy.
      if (bar === 0 && intensity > 0.55 && genre.drumStyle !== 'ambient') {
        hits.push({ start: barStart, drum: 'crash', velocity: Math.min(1, 0.55 + intensity * 0.35), duration: 4 })
      }
      if (isFillBar) {
        addFill(hits, barStart, beatsPerBar, stepBeats, rng, intensity, genre.drumStyle)
      }
    }
  }

  hits.sort((a, b) => a.start - b.start)
  return {
    hits,
    swing: genre.swing,
    gainDb: 0,
  }
}

function emitGrid(
  hits: DrumHit[],
  grid: Grid,
  barStart: number,
  stepBeats: number,
  beatsPerBar: number,
  scale: number,
  rng: Rng,
  intensity: number,
): void {
  const steps = Math.round(beatsPerBar / stepBeats)
  for (const key of Object.keys(grid) as DrumName[]) {
    const row = grid[key]
    if (!row) continue
    for (let step = 0; step < steps; step++) {
      const velocity = row[step % row.length] ?? 0
      if (velocity <= 0) continue
      // Ghost notes thin out in quiet sections.
      if (velocity < 0.45 && rng.chance(0.5 - intensity * 0.4)) continue
      const humanised = velocity * scale * (0.82 + intensity * 0.2) * rng.float(0.92, 1.06)
      const timingJitter = rng.normal(0, 0.008)
      hits.push({
        start: Math.max(0, barStart + step * stepBeats + timingJitter),
        drum: key,
        velocity: Math.max(0.05, Math.min(1, humanised)),
        duration: key === 'hatOpen' || key === 'crash' || key === 'ride' ? stepBeats * 2 : undefined,
      })
    }
  }
}

function addFill(
  hits: DrumHit[],
  barStart: number,
  beatsPerBar: number,
  stepBeats: number,
  rng: Rng,
  intensity: number,
  style: DrumStyle,
): void {
  // Clear the second half of the bar so the fill is audible.
  const fillStart = barStart + beatsPerBar / 2
  for (let i = hits.length - 1; i >= 0; i--) {
    const hit = hits[i]!
    if (hit.start >= fillStart - 1e-6 && hit.start < barStart + beatsPerBar) {
      if (hit.drum !== 'kick' || rng.chance(0.7)) hits.splice(i, 1)
    }
  }

  const isElectronic = ['trap', 'drill', 'phonk', 'fourFloor', 'dnb', 'chiptune'].includes(style)
  const toms: DrumName[] = isElectronic
    ? ['snare', 'snare', 'clap', 'tomHigh']
    : ['tomHigh', 'tomMid', 'tomMid', 'tomLow', 'snare']

  const steps = Math.round(beatsPerBar / 2 / stepBeats)
  const density = intensity > 0.7 ? 1 : 0.7
  for (let step = 0; step < steps; step++) {
    if (!rng.chance(density)) continue
    const drum = toms[Math.min(toms.length - 1, Math.floor((step / steps) * toms.length))]!
    hits.push({
      start: fillStart + step * stepBeats,
      drum,
      velocity: Math.min(1, 0.55 + (step / steps) * 0.4 + rng.float(-0.05, 0.05)),
    })
  }
}
