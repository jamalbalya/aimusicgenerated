/** Radix-2 FFT and the window functions the analysers use. */

/** In-place iterative Cooley-Tukey FFT. `size` must be a power of two. */
export class Fft {
  private readonly cosTable: Float64Array
  private readonly sinTable: Float64Array
  private readonly reverseTable: Uint32Array

  constructor(readonly size: number) {
    if (size < 2 || (size & (size - 1)) !== 0) {
      throw new Error(`FFT size must be a power of two, got ${size}`)
    }
    const half = size >> 1
    this.cosTable = new Float64Array(half)
    this.sinTable = new Float64Array(half)
    for (let i = 0; i < half; i++) {
      this.cosTable[i] = Math.cos((-2 * Math.PI * i) / size)
      this.sinTable[i] = Math.sin((-2 * Math.PI * i) / size)
    }

    this.reverseTable = new Uint32Array(size)
    const bits = Math.log2(size)
    for (let i = 0; i < size; i++) {
      let reversed = 0
      for (let b = 0; b < bits; b++) {
        reversed = (reversed << 1) | ((i >> b) & 1)
      }
      this.reverseTable[i] = reversed
    }
  }

  /** Forward transform. `real` and `imag` are modified in place. */
  forward(real: Float64Array, imag: Float64Array): void {
    this.transform(real, imag, false)
  }

  /** Inverse transform, scaled by 1/N. */
  inverse(real: Float64Array, imag: Float64Array): void {
    this.transform(real, imag, true)
    const scale = 1 / this.size
    for (let i = 0; i < this.size; i++) {
      real[i]! *= scale
      imag[i]! *= scale
    }
  }

  private transform(real: Float64Array, imag: Float64Array, invert: boolean): void {
    const n = this.size
    for (let i = 0; i < n; i++) {
      const j = this.reverseTable[i]!
      if (j > i) {
        const tr = real[i]!; real[i] = real[j]!; real[j] = tr
        const ti = imag[i]!; imag[i] = imag[j]!; imag[j] = ti
      }
    }

    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1
      const step = n / size
      for (let i = 0; i < n; i += size) {
        for (let j = i, k = 0; j < i + half; j++, k += step) {
          const cos = this.cosTable[k]!
          const sin = invert ? -this.sinTable[k]! : this.sinTable[k]!
          const a = j + half
          const tre = real[a]! * cos - imag[a]! * sin
          const tim = real[a]! * sin + imag[a]! * cos
          real[a] = real[j]! - tre
          imag[a] = imag[j]! - tim
          real[j]! += tre
          imag[j]! += tim
        }
      }
    }
  }
}

/** Periodic Hann window — the right choice for overlap-add resynthesis. */
export function hannWindow(size: number): Float32Array {
  const window = new Float32Array(size)
  for (let i = 0; i < size; i++) {
    window[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / size))
  }
  return window
}

/** Blackman-Harris — lower side lobes, for spectral analysis and display. */
export function blackmanHarrisWindow(size: number): Float32Array {
  const window = new Float32Array(size)
  const [a0, a1, a2, a3] = [0.35875, 0.48829, 0.14128, 0.01168]
  for (let i = 0; i < size; i++) {
    const x = (2 * Math.PI * i) / size
    window[i] = a0 - a1 * Math.cos(x) + a2 * Math.cos(2 * x) - a3 * Math.cos(3 * x)
  }
  return window
}

/** Next power of two at or above `value`. */
export function nextPowerOfTwo(value: number): number {
  let size = 1
  while (size < value) size <<= 1
  return size
}
