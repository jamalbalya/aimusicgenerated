/**
 * Deterministic pseudo-random number generation.
 *
 * Every generative stage of the studio is seeded, so the same prompt + seed
 * always yields the exact same song. That makes results reproducible for the
 * user ("give me that again but slower") and makes the engine unit-testable.
 */

/** FNV-1a — turns an arbitrary string into a well-distributed 32-bit seed. */
export function hashString(input: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

export class Rng {
  private state: number

  constructor(seed: number | string) {
    const numeric = typeof seed === 'string' ? hashString(seed) : Math.floor(seed)
    // A zero state would lock mulberry32 into a degenerate sequence.
    this.state = (numeric >>> 0) || 0x9e3779b9
  }

  /** Uniform float in [0, 1). mulberry32. */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0
    let t = this.state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }

  /** Uniform float in [min, max). */
  float(min: number, max: number): number {
    return min + this.next() * (max - min)
  }

  /** Uniform integer in [min, max] inclusive. */
  int(min: number, max: number): number {
    if (max < min) return min
    return min + Math.floor(this.next() * (max - min + 1))
  }

  /** True with the given probability. */
  chance(probability: number): boolean {
    return this.next() < probability
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error('Rng.pick: empty list')
    return items[this.int(0, items.length - 1)]!
  }

  /** Picks an index using per-item weights. Weights must be non-negative. */
  weightedIndex(weights: readonly number[]): number {
    let total = 0
    for (const w of weights) total += Math.max(0, w)
    if (total <= 0) return 0
    let roll = this.next() * total
    for (let i = 0; i < weights.length; i++) {
      roll -= Math.max(0, weights[i]!)
      if (roll < 0) return i
    }
    return weights.length - 1
  }

  weighted<T>(items: readonly T[], weights: readonly number[]): T {
    return items[this.weightedIndex(weights)]!
  }

  /** Fisher-Yates, returning a new array. */
  shuffle<T>(items: readonly T[]): T[] {
    const out = items.slice()
    for (let i = out.length - 1; i > 0; i--) {
      const j = this.int(0, i)
      const tmp = out[i]!
      out[i] = out[j]!
      out[j] = tmp
    }
    return out
  }

  /** Approximately normal (Irwin–Hall, n=4), clamped to ±3 sigma. */
  normal(mean = 0, stdDev = 1): number {
    const sum = this.next() + this.next() + this.next() + this.next()
    const unit = (sum - 2) * 1.732050808 // scale Irwin-Hall(4) to ~unit variance
    return mean + Math.max(-3, Math.min(3, unit)) * stdDev
  }

  /** Derives an independent child generator — keeps stages from interfering. */
  fork(label: string): Rng {
    return new Rng((this.state ^ hashString(label)) >>> 0)
  }
}
