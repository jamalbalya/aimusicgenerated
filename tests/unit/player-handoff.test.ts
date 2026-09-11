/**
 * The handoff from a finished generation to the transport at the bottom of the
 * screen.
 *
 * Production generated a full 271-second song on ZeroGPU, filled in the result
 * panel — engine, length, both model names, the seed — and left the player
 * saying "Nothing loaded" with Play disabled. The song was decoded and in hand;
 * `setCurrent` threw it away because `player.load` had raised.
 *
 * These tests fix the contract that failure exposed: the track is committed
 * whatever the audio graph does, the player is handed real PCM and never
 * `undefined`, and a player that refuses the audio says so instead of leaving
 * a finished song unreachable.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const load = vi.fn<(channels: Float32Array[], sampleRate: number) => void>()
const stop = vi.fn<() => void>()

// The real module reaches for `window.AudioContext`, which is the browser's
// job and not this test's subject.
vi.mock('../../src/lib/player', () => ({
  load: (channels: Float32Array[], sampleRate: number) => load(channels, sampleRate),
  stop: () => stop(),
}))

const { useStudio } = await import('../../src/state/store')

/** A neural take as `StudioPage.openNeuralTake` builds one, decoded and real. */
function neuralTrack(seconds = 271, sampleRate = 48000) {
  const frames = Math.round(seconds * sampleRate)
  const channel = () => {
    const data = new Float32Array(frames)
    for (let i = 0; i < frames; i += 997) data[i] = 0.4
    return data
  }
  return {
    title: 'Pagi datang hati berdebar',
    subtitle: 'Engine: ACE-Step 1.5 — Neural · acestep-v15-turbo',
    audio: { channels: [channel(), channel()], sampleRate },
    lyrics: '[Intro]\nPagi datang hati berdebar',
    source: 'song' as const,
  }
}

beforeEach(() => {
  load.mockReset()
  stop.mockReset()
  useStudio.setState({ current: null, toast: null, playbackError: null })
})

describe('a finished neural take reaches the player', () => {
  it('leaves no playback error behind on a good load', () => {
    useStudio.setState({ playbackError: 'stale' })
    useStudio.getState().setCurrent(neuralTrack(2))
    expect(useStudio.getState().playbackError).toBeNull()
  })

  it('puts the track in the store and the PCM in the player', () => {
    const track = neuralTrack(2)
    useStudio.getState().setCurrent(track)

    const current = useStudio.getState().current
    expect(current, 'the transport reads this; null is "Nothing loaded"').not.toBeNull()
    expect(current!.title).toBe('Pagi datang hati berdebar')

    expect(load).toHaveBeenCalledTimes(1)
    const [channels, sampleRate] = load.mock.calls[0]!
    expect(channels).toBe(track.audio.channels)
    expect(sampleRate).toBe(48000)
  })

  it('never hands the player an undefined or empty source', () => {
    useStudio.getState().setCurrent(neuralTrack(2))

    const [channels, sampleRate] = load.mock.calls[0]!
    expect(channels).toBeDefined()
    expect(Array.isArray(channels)).toBe(true)
    expect(channels.length).toBe(2)
    for (const channel of channels) {
      expect(channel).toBeInstanceOf(Float32Array)
      expect(channel.length).toBeGreaterThan(0)
    }
    expect(sampleRate).toBeGreaterThan(0)
    expect(Number.isFinite(sampleRate)).toBe(true)
  })

  it('keeps the song when the audio graph refuses it, and says why', () => {
    // What a browser does when it will not allocate a four-minute stereo
    // buffer. Before the fix this discarded the track and produced the
    // reported state: a full result panel above an empty player.
    load.mockImplementation(() => {
      throw new DOMException('memory', 'NotSupportedError')
    })

    const track = neuralTrack(2)
    expect(() => useStudio.getState().setCurrent(track)).not.toThrow()

    const state = useStudio.getState()
    expect(state.current, 'the generated song must not be discarded').not.toBeNull()
    expect(state.current!.audio.channels[0]!.length).toBeGreaterThan(0)
    // Recorded as state, not as a toast: the generation that follows raises
    // its own, and the reason has to still be there when Play does nothing.
    expect(state.playbackError).toContain('NotSupportedError')
    expect(state.playbackError).toContain('memory')
  })

  it('clears the player when the track is cleared', () => {
    useStudio.getState().setCurrent(neuralTrack(2))
    load.mockReset()
    useStudio.getState().setCurrent(null)

    expect(useStudio.getState().current).toBeNull()
    expect(useStudio.getState().playbackError).toBeNull()
    expect(stop).toHaveBeenCalledTimes(1)
    expect(load).not.toHaveBeenCalled()
  })

  it('is not vacuous: the old order loses the track on the same throw', () => {
    // The behaviour that shipped, written out, so this file fails if anyone
    // restores it. `set` after `load` never runs when `load` raises.
    load.mockImplementation(() => {
      throw new DOMException('memory', 'NotSupportedError')
    })
    const oldSetCurrent = (track: ReturnType<typeof neuralTrack>): void => {
      load(track.audio.channels, track.audio.sampleRate)
      useStudio.setState({ current: track })
    }

    expect(() => oldSetCurrent(neuralTrack(2))).toThrow()
    expect(useStudio.getState().current, 'the old order is what produced "Nothing loaded"').toBeNull()
  })
})
