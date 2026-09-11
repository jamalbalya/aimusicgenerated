/**
 * The neural engine never quietly becomes the offline one.
 *
 * This is the property the whole two-engine design exists to hold. Someone who
 * asks for a neural song and is handed a procedural one has no way to tell:
 * they would listen to a synthesised vocal and conclude that is what ACE-Step
 * sounds like. A failure that announces itself is recoverable; a substitution
 * that does not is a wrong answer with a green tick next to it.
 *
 * So these tests do not check that the right error message appears. They check
 * that the procedural singer is never *called* — by spying on the only two
 * functions that can reach it, and asserting zero invocations across every way
 * a neural generation can fail.
 *
 * The reachability argument they back up:
 *
 *   ProceduralVocalRenderer.render
 *     ← selectVocalRenderer()          engine/voice/renderer.ts
 *     ← renderSong()                   engine/synth/pipeline.ts
 *     ← handleRequest()                workers/handler.ts
 *     ← runJob()                       workers/client.ts       ← the only gateway
 *     ← ProceduralMusicProvider.generate() and ui/useJob.ts
 *
 * `AceStepProvider` imports none of that: its whole transitive closure is
 * aceStepClient, aceStepRequest, config, types and audioCheck.
 */

import { describe, expect, it, vi } from 'vitest'
import {
  AceStepProvider, ProceduralMusicProvider, EngineUnavailableError, GenerationCancelledError,
  ZeroGpuProvider, createNeuralProvider, resolveProvider,
} from '../../src/engine/providers'
import { ProceduralVocalRenderer } from '../../src/engine/voice/procedural'
import * as workerClient from '../../src/workers/client'
import { BOS_TOXIC_LYRICS, BOS_TOXIC_STYLE } from './fixtures/bos-toxic'
import { EVENT_ID, FILE_DATA, METADATA, TEST_CONFIG, completed, failed, sse, wav, zeroGpu, type SpaceScript } from './helpers/fakeSpace'
import type { MusicGenerationRequest, ZeroGpuConfig, ZeroGpuProviderOptions } from '../../src/engine/providers'

const REQUEST: MusicGenerationRequest = {
  style: BOS_TOXIC_STYLE,
  lyrics: BOS_TOXIC_LYRICS,
  language: 'id',
  vocalGender: 'male',
  instrumental: false,
}

/**
 * Watches both ways into the procedural engine at once.
 *
 * `runJob` is the only entry to the worker, and the worker is the only caller
 * of the render pipeline; `ProceduralVocalRenderer.render` is the singer
 * itself. Either one firing during a neural generation is the bug.
 */
function watchProceduralEngine() {
  const runJob = vi.spyOn(workerClient, 'runJob')
  const sing = vi.spyOn(ProceduralVocalRenderer.prototype, 'render')
  return {
    runJob,
    sing,
    expectUntouched() {
      expect(runJob, 'the worker was entered').not.toHaveBeenCalled()
      expect(sing, 'the procedural singer was invoked').not.toHaveBeenCalled()
    },
    restore() {
      runJob.mockRestore()
      sing.mockRestore()
    },
  }
}

/** A neural provider wired to a backend that behaves however the test says. */
function neuralProvider(handler: (url: string) => Response | Promise<Response>) {
  const fetchImpl = (async (input: RequestInfo | URL) => handler(String(input))) as typeof fetch
  return new AceStepProvider({
    baseUrl: 'http://127.0.0.1:8001',
    fetchImpl,
    pollIntervalMs: 0,
    sleep: async () => {},
    toObjectUrl: () => 'blob:neural',
  })
}

const wrap = (data: unknown) => new Response(
  JSON.stringify({ data, code: 200, error: null, timestamp: 1 }),
  { status: 200, headers: { 'Content-Type': 'application/json' } })

const HEALTHY = {
  status: 'ok', service: 'ACE-Step API', version: '1.0',
  models_initialized: true, llm_initialized: true,
  loaded_model: 'acestep-v15-turbo', loaded_lm_model: 'acestep-5Hz-lm-0.6B',
}

describe('a failed neural generation never reaches the procedural engine', () => {
  /** Every distinct way ACE-Step can let a generation down. */
  const failures: [string, (url: string) => Response, RegExp][] = [
    [
      'the backend is not running',
      () => { throw new TypeError('fetch failed') },
      /Neural music engine is unavailable/,
    ],
    [
      'the backend answers but is not healthy',
      (url) => url.endsWith('/health')
        ? wrap({ ...HEALTHY, status: 'starting' })
        : new Response('', { status: 500 }),
      /Neural music engine is unavailable/,
    ],
    [
      'the backend swapped the language model',
      (url) => url.endsWith('/health')
        ? wrap({ ...HEALTHY, loaded_lm_model: 'acestep-5Hz-lm-1.7B' })
        : new Response('', { status: 500 }),
      /asked for acestep-5Hz-lm-0\.6B/,
    ],
    [
      'no language model is loaded, so nothing would sing',
      (url) => url.endsWith('/health')
        ? wrap({ ...HEALTHY, llm_initialized: false, loaded_lm_model: null })
        : new Response('', { status: 500 }),
      /cannot sing the lyrics/,
    ],
    [
      'the queue is full',
      (url) => url.endsWith('/health') ? wrap(HEALTHY) : new Response('busy', { status: 429 }),
      /429/,
    ],
    [
      'generation failed on the backend',
      (url) => {
        if (url.endsWith('/health')) return wrap(HEALTHY)
        if (url.endsWith('/release_task')) return wrap({ task_id: 't', status: 'queued' })
        return wrap([{
          task_id: 't', status: 2,
          result: JSON.stringify([{ error: 'CUDA out of memory' }]),
        }])
      },
      /CUDA out of memory/,
    ],
    [
      'the backend vanished mid-generation',
      (url) => {
        if (url.endsWith('/health')) return wrap(HEALTHY)
        if (url.endsWith('/release_task')) return wrap({ task_id: 't', status: 'queued' })
        throw new TypeError('socket hang up')
      },
      /Lost contact with ACE-Step/,
    ],
    [
      'the job finished but returned no file',
      (url) => {
        if (url.endsWith('/health')) return wrap(HEALTHY)
        if (url.endsWith('/release_task')) return wrap({ task_id: 't', status: 'queued' })
        return wrap([{ task_id: 't', status: 1, result: JSON.stringify([{ file: '' }]) }])
      },
      /no audio file/,
    ],
    [
      'the audio that came back is not audio',
      (url) => {
        if (url.endsWith('/health')) return wrap(HEALTHY)
        if (url.endsWith('/release_task')) return wrap({ task_id: 't', status: 'queued' })
        if (url.endsWith('/query_result')) {
          return wrap([{
            task_id: 't', status: 1,
            result: JSON.stringify([{ file: '/v1/audio?path=x', metas: { duration: 10 } }]),
          }])
        }
        return new Response('<html>error</html>', {
          status: 200, headers: { 'Content-Type': 'text/html' },
        })
      },
      /rather than audio/,
    ],
  ]

  for (const [name, handler, message] of failures) {
    it(`fails loudly when ${name}`, async () => {
      const watch = watchProceduralEngine()
      try {
        const provider = neuralProvider(handler)
        let thrown: unknown = null
        try {
          await provider.generate(REQUEST)
        } catch (error) {
          thrown = error
        }

        // It failed…
        expect(thrown, 'a neural failure must not resolve').not.toBeNull()
        expect((thrown as Error).message).toMatch(message)
        // …with no procedural audio produced on the way.
        watch.expectUntouched()
      } finally {
        watch.restore()
      }
    })
  }

  it('the timeout is a failure too, not a handover', async () => {
    const watch = watchProceduralEngine()
    try {
      const provider = new AceStepProvider({
        baseUrl: 'http://127.0.0.1:8001',
        pollIntervalMs: 0,
        jobTimeoutMs: -1, // already expired, so the first poll gives up
        sleep: async () => {},
        toObjectUrl: () => 'blob:neural',
        fetchImpl: (async (input: RequestInfo | URL) => {
          const url = String(input)
          if (url.endsWith('/health')) return wrap(HEALTHY)
          if (url.endsWith('/release_task')) return wrap({ task_id: 't', status: 'queued' })
          return wrap([{ task_id: 't', status: 0, result: '[]' }])
        }) as typeof fetch,
      })
      await expect(provider.generate(REQUEST)).rejects.toThrow(/within the time allowed/)
      watch.expectUntouched()
    } finally {
      watch.restore()
    }
  })

  it('an unavailable neural engine is refused by its own error type', async () => {
    const watch = watchProceduralEngine()
    try {
      const provider = neuralProvider(() => { throw new TypeError('fetch failed') })
      await expect(provider.generate(REQUEST)).rejects.toBeInstanceOf(EngineUnavailableError)
      watch.expectUntouched()
    } finally {
      watch.restore()
    }
  })

  it('the neural provider cannot reach the procedural engine even in principle', async () => {
    // The import closure, asserted rather than described: nothing the neural
    // provider pulls in leads to the worker, the render pipeline or the singer.
    const { readFileSync } = await import('node:fs')
    const seen = new Set<string>()
    const forbidden = /from '\.\.\/\.\.\/workers|from '\.\.\/synth|from '\.\.\/voice|from '\.\.\/compose/
    const walk = (file: string) => {
      if (seen.has(file)) return
      seen.add(file)
      const source = readFileSync(new URL(`../../src/engine/providers/${file}.ts`, import.meta.url), 'utf8')
      expect(source, `${file}.ts reaches outside the provider boundary`).not.toMatch(forbidden)
      for (const match of source.matchAll(/from '\.\/([a-zA-Z]+)'/g)) walk(match[1]!)
    }
    walk('aceStepProvider')
    expect([...seen].sort()).toEqual(
      ['aceStepClient', 'aceStepProvider', 'aceStepRequest', 'audioCheck', 'config', 'types'])
  })
})

describe('a failed ZeroGPU generation never reaches the procedural engine', () => {
  /**
   * Every distinct way the hosted Space can let a generation down. The request
   * is the validated Bos Toxic one; the fake Space is the one the contract
   * tests use, so these failures are the real failure shapes.
   */
  const failures: [string, SpaceScript, Partial<ZeroGpuConfig>, Partial<ZeroGpuProviderOptions>, Partial<MusicGenerationRequest>][] = [
    ['the Space is asleep', { config: new Response('sleeping', { status: 503 }) }, {}, {}, {}],
    ['the Space cannot be reached', { config: () => { throw new TypeError('Failed to fetch') } }, {}, {}, {}],
    ['no Space is configured', {}, { spaceUrl: '' }, {}, {}],
    ['the free GPU quota is spent',
      { stream: sse([failed('ZeroGPU quota exceeded', 'Try again in 1:23:45.')]) }, {}, {}, {}],
    ['the GPU duration is illegal',
      { stream: sse([failed('ZeroGPU illegal duration', 'larger than the maximum allowed')]) }, {}, {}, {}],
    ['the song outran the GPU budget', { stream: sse([failed('ZeroGPU worker error', 'GPU task aborted')]) }, {}, {}, {}],
    ['generation failed on the Space',
      { stream: sse([failed('Error', 'ACE-Step generation failed: CUDA out of memory')]) }, {}, {}, {}],
    ['the queue failed', {
      stream: sse([{ msg: 'unexpected_error', event_id: null, message: 'boom', session_not_found: false, success: false }]),
    }, {}, {}, {}],
    ['the Space refused the submission', { join: new Response('{"detail":"Queue is full."}', { status: 503 }) }, {}, {}, {}],
    ['the result is malformed', { stream: sse([completed([FILE_DATA])]) }, {}, {}, {}],
    ['no audio came back', { stream: sse([completed([null, JSON.stringify(METADATA)])]) }, {}, {}, {}],
    ['the Space ran a substituted model', {
      stream: sse([completed([FILE_DATA, JSON.stringify({ ...METADATA, loaded_lm_model: 'acestep-5Hz-lm-1.7B' })])]),
    }, {}, {}, {}],
    ['a clip came back where a song was asked for',
      { file: () => new Response(wav(30), { headers: { 'Content-Type': 'audio/wav' } }) }, {}, {}, {}],
    ['the file that came back is not a WAV',
      { file: () => new Response(new Uint8Array(8192).fill(7), { headers: { 'Content-Type': 'audio/wav' } }) }, {}, {}, {}],
    ['the job ran out of time', { stream: [], hang: true }, { jobTimeoutMs: 30 }, { heartbeatTimeoutMs: 10_000 }, {}],
    ['the connection went silent', {
      stream: sse([{ msg: 'estimation', event_id: EVENT_ID, rank: 0, queue_size: 1 }]), hang: true,
    }, {}, { heartbeatTimeoutMs: 25 }, {}],
    ['the requested length cannot be made', {}, {}, {}, { duration: 5 }],
  ]

  for (const [name, script, config, options, request] of failures) {
    it(`fails loudly when ${name}`, async () => {
      const watch = watchProceduralEngine()
      try {
        const { provider } = zeroGpu(script, config, options)
        let thrown: unknown = null
        try {
          await provider.generate({ ...REQUEST, duration: 271, ...request })
        } catch (error) {
          thrown = error
        }
        expect(thrown, 'a ZeroGPU failure must not resolve').not.toBeNull()
        watch.expectUntouched()
      } finally {
        watch.restore()
      }
    })
  }

  it('cancelling is not a handover either', async () => {
    const watch = watchProceduralEngine()
    try {
      const controller = new AbortController()
      const { provider } = zeroGpu({ stream: sse([{ msg: 'estimation', event_id: EVENT_ID, rank: 2, queue_size: 3 }]), hang: true })
      await expect(provider.generate({ ...REQUEST, duration: 271 }, {
        signal: controller.signal,
        onStatus: (status) => { if (status.queuePosition) controller.abort() },
      })).rejects.toBeInstanceOf(GenerationCancelledError)
      watch.expectUntouched()
    } finally {
      watch.restore()
    }
  })

  it('the registry refuses an unavailable Space rather than handing back the other engine', async () => {
    const watch = watchProceduralEngine()
    try {
      const down = new ZeroGpuProvider({ config: { ...TEST_CONFIG, spaceUrl: '' } })
      await expect(resolveProvider('neural', {}, down)).rejects.toBeInstanceOf(EngineUnavailableError)
      // Whatever the configuration says, the factory's answer is a neural engine.
      for (const choice of [{ backend: 'local' as const }, { backend: 'zerogpu' as const },
        { backend: 'local' as const, problem: 'misconfigured' }]) {
        expect(createNeuralProvider(choice).type).toBe('neural')
      }
      watch.expectUntouched()
    } finally {
      watch.restore()
    }
  })

  it('the ZeroGPU provider cannot reach the procedural engine even in principle', async () => {
    const { readFileSync } = await import('node:fs')
    const seen = new Set<string>()
    const forbidden = /from '\.\.\/\.\.\/workers|from '\.\.\/synth|from '\.\.\/voice|from '\.\.\/compose/
    const walk = (file: string) => {
      if (seen.has(file)) return
      seen.add(file)
      const source = readFileSync(new URL(`../../src/engine/providers/${file}.ts`, import.meta.url), 'utf8')
      expect(source, `${file}.ts reaches outside the provider boundary`).not.toMatch(forbidden)
      for (const match of source.matchAll(/from '\.\/([a-zA-Z]+)'/g)) walk(match[1]!)
    }
    walk('zeroGpuProvider')
    expect([...seen].sort()).toEqual(
      ['aceStepRequest', 'audioCheck', 'config', 'gradioClient', 'types', 'zeroGpuProvider'])
  })

  it('the Gradio transport knows nothing about ACE-Step', async () => {
    // The layering, asserted: protocol code stays generic, so it can neither
    // pick a model nor decide what a song is.
    const { readFileSync } = await import('node:fs')
    const source = readFileSync(new URL('../../src/engine/providers/gradioClient.ts', import.meta.url), 'utf8')
    const code = source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')
    expect(code).not.toMatch(/ace-?step|acestep|lyric|zerogpu|\bsong\b/i)
    expect(source).not.toMatch(/^import /m)
  })
})

describe('the offline engine still works exactly as before', () => {
  it('composes, sings and returns audio when it is the engine chosen', async () => {
    // No spies here: the procedural singer is *supposed* to run.
    const offline = new ProceduralMusicProvider({
      quality: 'draft', keepStems: false, toObjectUrl: () => 'blob:offline',
    })
    expect(await offline.isAvailable()).toBe(true)

    const result = await offline.generate({
      style: BOS_TOXIC_STYLE, lyrics: BOS_TOXIC_LYRICS, language: 'id', vocalGender: 'male',
    })

    expect(result.engine).toBe('procedural')
    expect(result.takes).toHaveLength(1)
    expect(result.takes[0]!.validation.kind).toBe('vocal-song')
    expect(result.takes[0]!.validation.problems).toEqual([])
    expect(result.takes[0]!.score.language).toBe('id')
    expect(result.takes[0]!.audio.channels[0]!.length).toBeGreaterThan(0)
    expect(result.duration).toBeGreaterThan(10)
  }, 120_000)

  it('really does drive the procedural singer, so the spies above mean something', async () => {
    // If ProceduralVocalRenderer.render were never called by this path, the
    // assertions in the neural tests would pass vacuously.
    const sing = vi.spyOn(ProceduralVocalRenderer.prototype, 'render')
    try {
      const offline = new ProceduralMusicProvider({
        quality: 'draft', keepStems: false, toObjectUrl: () => 'blob:offline',
      })
      await offline.generate({
        style: 'a short lo-fi loop', lyrics: '[Verse]\nPagi datang hati berdebar',
        language: 'id', duration: 20,
      })
      expect(sing).toHaveBeenCalled()
    } finally {
      sing.mockRestore()
    }
  }, 120_000)
})
