/**
 * The neural path, tested against ACE-Step's real contract.
 *
 * No model runs here — that is what `scripts/test-ace-step-bos-toxic.mjs` is
 * for, and it needs a GPU and several gigabytes of weights. What these tests
 * hold is everything that can go wrong *before* the model sees the request and
 * *after* it answers: a style flattened into a genre, a lyric sheet quietly
 * trimmed, a response shape guessed rather than read, and — the one that would
 * be hardest to notice — a neural request silently served by the offline
 * engine.
 *
 * The `/query_result` fixtures in `fixtures/acestep/query-result.json` were not
 * written by hand. They were produced by running ACE-Step's own response
 * builders (`acestep/api/http/query_result_service.py` at commit ca1e85f), so
 * the parser is tested against what the server emits rather than a guess at it.
 */

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  AceStepProvider, ProceduralMusicProvider, EngineUnavailableError, GenerationCancelledError,
  ENGINE_UNAVAILABLE_MESSAGE, resolveProvider, engineLabel,
  buildAceStepTask, verifyLyricsPreserved, structureTags, lyricLines,
  parseResultItems, DEFAULT_MODELS, INSTRUMENTAL_MARKER,
  type MusicGenerationProvider, type MusicGenerationRequest,
} from '../../src/engine/providers'
import { BOS_TOXIC_LYRICS, BOS_TOXIC_STYLE } from './fixtures/bos-toxic'

const GOLDEN = JSON.parse(readFileSync(
  new URL('./fixtures/acestep/query-result.json', import.meta.url), 'utf8')) as Record<
    string, { data: { task_id: string; result: string; status: number; progress_text?: string }[] }>

const BOS_TOXIC: MusicGenerationRequest = {
  style: BOS_TOXIC_STYLE,
  lyrics: BOS_TOXIC_LYRICS,
  language: 'id',
  vocalGender: 'male',
  instrumental: false,
}

/* ------------------------------------------------------- the fake server --- */

interface ServerScript {
  /** Statuses returned by successive `/query_result` calls. */
  poll: (keyof typeof GOLDEN)[]
  health?: unknown
  healthStatus?: number
}

/** Records what the client sent, and replies with ACE-Step's own shapes. */
function fakeAceStep(script: ServerScript) {
  const calls: { url: string; body?: unknown }[] = []
  let pollIndex = 0
  const wrap = (data: unknown) => new Response(
    JSON.stringify({ data, code: 200, error: null, timestamp: 1 }),
    { status: 200, headers: { 'Content-Type': 'application/json' } })

  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const body = init?.body ? JSON.parse(String(init.body)) as unknown : undefined
    calls.push({ url, ...(body !== undefined ? { body } : {}) })

    if (url.endsWith('/health')) {
      if (script.healthStatus && script.healthStatus !== 200) {
        return new Response('nope', { status: script.healthStatus })
      }
      return wrap(script.health ?? {
        status: 'ok', service: 'ACE-Step API', version: '1.0',
        models_initialized: true, llm_initialized: true,
        loaded_model: 'acestep-v15-turbo', loaded_lm_model: 'acestep-5Hz-lm-0.6B',
      })
    }
    if (url.endsWith('/release_task')) {
      return wrap({ task_id: 'task-done', status: 'queued', queue_position: 2 })
    }
    if (url.endsWith('/query_result')) {
      const key = script.poll[Math.min(pollIndex, script.poll.length - 1)]!
      pollIndex++
      // The golden payloads carry their own task ids; the client matches on
      // the id it asked for, so rewrite just that field.
      const asked = (body as { task_id_list: string[] }).task_id_list[0]
      const items = GOLDEN[key]!.data.map((item) => ({ ...item, task_id: asked }))
      return wrap(items)
    }
    if (url.includes('/v1/audio')) {
      return new Response(new Uint8Array([0x52, 0x49, 0x46, 0x46]), {
        status: 200, headers: { 'Content-Type': 'audio/wav' },
      })
    }
    return new Response('not found', { status: 404 })
  }) as typeof fetch

  return { fetchImpl, calls }
}

const provider = (script: ServerScript) => {
  const server = fakeAceStep(script)
  return {
    server,
    instance: new AceStepProvider({
      baseUrl: 'http://127.0.0.1:8001',
      fetchImpl: server.fetchImpl,
      pollIntervalMs: 0,
      sleep: async () => {},
      toObjectUrl: () => 'blob:generated',
    }),
  }
}

/* ------------------------------------------------------------- the tests --- */

describe('the request that reaches ACE-Step', () => {
  it('sends the whole style, not a genre tag', () => {
    const body = buildAceStepTask(BOS_TOXIC)
    expect(body.prompt).toContain('Indonesian dangdut koplo')
    expect(body.prompt).toContain('powerful kendang')
    expect(body.prompt).toContain('explosive sing-along chorus')
    // Every word the user wrote survives.
    expect(body.prompt.startsWith(BOS_TOXIC_STYLE)).toBe(true)
  })

  it('sends every lyric line and every section tag, unchanged', () => {
    const body = buildAceStepTask(BOS_TOXIC)
    const check = verifyLyricsPreserved(BOS_TOXIC_LYRICS, body.lyrics)
    expect(check.missingLines).toEqual([])
    expect(check.missingTags).toEqual([])
    expect(check.preserved).toBe(true)

    expect(lyricLines(body.lyrics)).toHaveLength(68)
    expect(structureTags(body.lyrics)).toEqual([
      'Intro', 'Verse 1', 'Pre-Chorus', 'Chorus', 'Verse 2', 'Pre-Chorus',
      'Chorus', 'Bridge', 'Instrumental Break', 'Final Chorus', 'Outro', 'End',
    ])
    // No transliteration, no phonetic respelling: the words are the words.
    expect(body.lyrics).toContain('Bos toxic, jangan sok berkuasa')
    expect(body.lyrics).toContain('Belajarlah menghargai manusia')
  })

  it('keeps a tag qualifier meaningful rather than flattening it', () => {
    const sheet = '[Chorus, Full Koplo]\nBos toxic\n\n[Break, Kendang Call And Response]\nKalau salah?'
    const body = buildAceStepTask({ ...BOS_TOXIC, lyrics: sheet })
    expect(structureTags(body.lyrics)).toEqual(['Chorus, Full Koplo', 'Break, Kendang Call And Response'])
    expect(verifyLyricsPreserved(sheet, body.lyrics).preserved).toBe(true)
  })

  it('asks for Indonesian, a male vocal, and a sung song', () => {
    const body = buildAceStepTask(BOS_TOXIC)
    expect(body.vocal_language).toBe('id')
    expect(body.prompt).toMatch(/male/i)
    // `thinking` is what puts the 5 Hz LM in the chain, which is what sings.
    expect(body.thinking).toBe(true)
    expect(body.lyrics).not.toBe(INSTRUMENTAL_MARKER)
    // Letting the LM "enhance" the input would rewrite the user's lyrics.
    expect(body.use_format).toBe(false)
  })

  it('does not repeat a vocal gender the style already states', () => {
    const body = buildAceStepTask(BOS_TOXIC)
    expect(body.prompt.match(/male/gi)).toHaveLength(1)
  })

  it('starts on turbo and the 0.6B language model', () => {
    const body = buildAceStepTask(BOS_TOXIC)
    expect(body.model).toBe('acestep-v15-turbo')
    expect(body.lm_model_path).toBe('acestep-5Hz-lm-0.6B')
    expect(DEFAULT_MODELS).toEqual({ model: 'acestep-v15-turbo', lmModel: 'acestep-5Hz-lm-0.6B' })
  })

  it('uses the instrumental marker only when a backing track was asked for', () => {
    const body = buildAceStepTask({ ...BOS_TOXIC, instrumental: true })
    expect(body.lyrics).toBe(INSTRUMENTAL_MARKER)
    expect(body.thinking).toBe(false)
  })
})

describe('reading what ACE-Step sends back', () => {
  it('unpacks the doubly-encoded result field', () => {
    const items = parseResultItems(GOLDEN.succeeded!.data[0]!)
    expect(items).toHaveLength(1)
    expect(items[0]!.file).toContain('/v1/audio?path=')
    expect(items[0]!.metas?.duration).toBe(158.4)
    expect(items[0]!.metas?.bpm).toBe(112)
  })

  it('treats an empty result as "not started yet", not as a failure', () => {
    expect(parseResultItems(GOLDEN.unknown_task!.data[0]!)).toEqual([])
    expect(parseResultItems(null)).toEqual([])
  })

  it('surfaces the server error rather than a generic one', async () => {
    const { instance } = provider({ poll: ['failed'] })
    await expect(instance.generate(BOS_TOXIC)).rejects.toThrow(/CUDA out of memory/)
  })
})

describe('the Bos Toxic request, end to end against the API contract', () => {
  it('reaches ACE-Step and comes back as a playable neural result', async () => {
    const { instance, server } = provider({ poll: ['queued', 'running', 'succeeded'] })
    const states: string[] = []

    const result = await instance.generate(BOS_TOXIC, {
      onStatus: (status) => states.push(status.state),
    })

    // 1. The request reached ACE-Step.
    const submitted = server.calls.find((call) => call.url.endsWith('/release_task'))
    expect(submitted).toBeDefined()
    const body = submitted!.body as ReturnType<typeof buildAceStepTask>

    // 2. Style preserved. 3. Lyrics preserved.
    expect(body.prompt.startsWith(BOS_TOXIC_STYLE)).toBe(true)
    expect(verifyLyricsPreserved(BOS_TOXIC_LYRICS, body.lyrics).preserved).toBe(true)

    // 4. Indonesian. 5. Male vocal. 6. Not instrumental.
    expect(body.vocal_language).toBe('id')
    expect(body.prompt).toMatch(/male/i)
    expect(body.lyrics).not.toBe(INSTRUMENTAL_MARKER)
    expect(body.thinking).toBe(true)

    // 7. A valid audio result. 8. A valid duration.
    expect(result.audioUrl).toBeTruthy()
    expect(result.duration).toBeGreaterThan(0)
    expect(server.calls.some((call) => call.url.includes('/v1/audio'))).toBe(true)

    // 9. The metadata identifies ACE-Step and the models that ran.
    expect(result.engine).toBe('ace-step')
    expect(result.metadata?.model).toBe('acestep-v15-turbo')
    expect(result.metadata?.lmModel).toBe('acestep-5Hz-lm-0.6B')
    expect(result.metadata?.language).toBe('id')
    expect(engineLabel(result.engine)).toBe('Engine: ACE-Step 1.5 — Neural')

    // 10. No procedural fallback happened.
    expect(result.engine).not.toBe('procedural')
    expect(states).toContain('queued')
    expect(states).toContain('generating')
    expect(states.at(-1)).toBe('completed')
  })

  it('reports only the states the server actually reported', async () => {
    const { instance } = provider({ poll: ['queued', 'running', 'succeeded'] })
    const seen: { state: string; progress?: number; detail?: string }[] = []
    await instance.generate(BOS_TOXIC, { onStatus: (status) => seen.push(status) })

    // The running fixture carries stage "diffusion" and progress 0.42, and
    // that is exactly what comes out — nothing is invented for the queued one.
    const queued = seen.find((status) => status.state === 'queued')!
    expect(queued.progress).toBeUndefined()
    const generating = seen.find((status) => status.state === 'generating')!
    expect(generating.detail).toBe('diffusion')
    expect(generating.progress).toBeCloseTo(0.42, 5)
  })
})

describe('a neural request is never quietly served by the offline engine', () => {
  it('refuses, with the message that names both ways out', async () => {
    const { instance } = provider({ poll: ['queued'], healthStatus: 503 })
    await expect(instance.generate(BOS_TOXIC)).rejects.toThrow(EngineUnavailableError)
    await expect(instance.generate(BOS_TOXIC)).rejects.toThrow(ENGINE_UNAVAILABLE_MESSAGE)
  })

  it('refuses at the registry too, rather than handing back the other engine', async () => {
    const down: MusicGenerationProvider = {
      id: 'ace-step', name: 'ACE-Step 1.5', type: 'neural', description: '',
      isAvailable: async () => false,
      generate: async () => { throw new Error('should never be called') },
    }
    await expect(resolveProvider('neural', {}, down)).rejects.toThrow(EngineUnavailableError)

    // Asking for the offline engine gets the offline engine, always.
    const offline = await resolveProvider('procedural')
    expect(offline.type).toBe('procedural')
    expect(offline).toBeInstanceOf(ProceduralMusicProvider)
  })

  it('says which engine made a song, in words, either way', () => {
    expect(engineLabel('ace-step')).toBe('Engine: ACE-Step 1.5 — Neural')
    expect(engineLabel('procedural')).toBe('Engine: Resonant Procedural — Offline')
  })
})

describe('cancelling', () => {
  it('stops polling and settles as cancelled', async () => {
    const controller = new AbortController()
    const { instance } = provider({ poll: ['queued', 'queued', 'queued'] })
    const promise = instance.generate(BOS_TOXIC, {
      signal: controller.signal,
      onStatus: (status) => { if (status.state === 'queued') controller.abort() },
    })
    await expect(promise).rejects.toThrow(GenerationCancelledError)
  })

  it('does not claim to stop work on the server, because it cannot', () => {
    // ACE-Step 1.5 exposes no cancellation endpoint (checked against the
    // repository at commit ca1e85f), so the provider does not offer one.
    const { instance } = provider({ poll: ['queued'] })
    const asProvider: MusicGenerationProvider = instance
    expect(asProvider.cancel).toBeUndefined()
  })
})

describe('the smoke-test script asks for the same thing the app does', () => {
  it('builds the same request body as the adapter', async () => {
    // The script runs without a TypeScript build, so it spells the request out
    // itself. This is what stops the two drifting apart unnoticed.
    const script = await import(
      /* @vite-ignore */ '../../scripts/test-ace-step-bos-toxic.mjs' as string
    ) as { bosToxicTaskBody: () => Record<string, unknown>; BOS_TOXIC_STYLE: string }
    expect(script.BOS_TOXIC_STYLE).toBe(BOS_TOXIC_STYLE)
    // The adapter appends a gender hint only when the style lacks one; this
    // style says "dramatic male vocal", so both must come out identical.
    expect(script.bosToxicTaskBody()).toEqual({ ...buildAceStepTask(BOS_TOXIC) })
  })
})

describe('the offline engine still is what it always was', () => {
  it('is always available and identifies itself as procedural', async () => {
    const offline = new ProceduralMusicProvider()
    expect(await offline.isAvailable()).toBe(true)
    expect(offline.type).toBe('procedural')
    expect(offline.id).toBe('procedural')
  })

  it('composes, sings and returns its own richer output', async () => {
    const offline = new ProceduralMusicProvider({
      quality: 'draft', keepStems: false, toObjectUrl: () => 'blob:offline',
    })
    const result = await offline.generate({
      style: BOS_TOXIC_STYLE, lyrics: BOS_TOXIC_LYRICS, language: 'id', vocalGender: 'male',
    })
    expect(result.engine).toBe('procedural')
    expect(result.duration).toBeGreaterThan(10)
    expect(result.takes).toHaveLength(1)
    expect(result.takes[0]!.validation.kind).toBe('vocal-song')
    expect(result.takes[0]!.score.language).toBe('id')
  }, 120_000)
})

describe('an address the browser cannot reach is not probed', () => {
  it('reports the real reason for an http backend on an https page', async () => {
    const { mixedContentReason } = await import('../../src/engine/providers/config')
    expect(mixedContentReason('https:', 'http://127.0.0.1:8001'))
      .toMatch(/served over HTTPS/)
    // Everything else is fine: a local page, or a backend that is itself HTTPS.
    expect(mixedContentReason('http:', 'http://127.0.0.1:8001')).toBeUndefined()
    expect(mixedContentReason('https:', 'https://ace.example.com')).toBeUndefined()
  })
})
