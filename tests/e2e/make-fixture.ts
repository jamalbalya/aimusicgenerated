/**
 * Builds the audio fixture the upload tests use, so the repository does not
 * carry a binary blob and the fixture always matches the decoder under test.
 */

import { writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { encodeWav } from '../../src/engine/audio/wav'

const SAMPLE_RATE = 22050
const SECONDS = 4

/** A centred "vocal" tone plus a hard-panned "instrument", with a beat. */
export function buildFixture(): ArrayBuffer {
  const length = SAMPLE_RATE * SECONDS
  const left = new Float32Array(length)
  const right = new Float32Array(length)
  const beatPeriod = Math.round(SAMPLE_RATE * 0.5) // 120 BPM

  for (let i = 0; i < length; i++) {
    const t = i / SAMPLE_RATE
    const vocal = Math.sin(2 * Math.PI * 330 * t) * 0.32
    const guitar = Math.sin(2 * Math.PI * 1200 * t) * 0.22
    const sinceBeat = i % beatPeriod
    const kick = Math.sin(2 * Math.PI * 60 * (sinceBeat / SAMPLE_RATE)) * Math.exp(-sinceBeat / 900) * 0.4
    left[i] = vocal + guitar + kick
    right[i] = vocal - guitar + kick
  }

  return encodeWav({ channels: [left, right], sampleRate: SAMPLE_RATE }, 16)
}

const here = dirname(fileURLToPath(import.meta.url))
export const FIXTURE_PATH = resolve(here, 'fixtures/test-mix.wav')

export function writeFixture(): string {
  writeFileSync(FIXTURE_PATH, Buffer.from(buildFixture()))
  return FIXTURE_PATH
}
