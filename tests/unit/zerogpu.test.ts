/**
 * The ZeroGPU backend, tested against the Space's real contract.
 *
 * No request here reaches Hugging Face and no GPU quota is spent. The fake in
 * `helpers/fakeSpace.ts` answers with the configuration and endpoint signature
 * the live Space actually returned, and speaks the queue protocol as Gradio
 * 6.2.0's source defines it. What these tests hold is everything that can go
 * wrong before the Space sees a request and after it answers — and above all
 * that the song asked for is the song that is sent: the whole style, every
 * lyric line, the language, the voice, the instrumental choice and the length.
 */

import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import {
  AceStepProvider, EngineUnavailableError, GenerationCancelledError, GradioClient, GradioProtocolError,
  MisconfiguredNeuralProvider, ProceduralMusicProvider, QuotaExceededError, SseParser,
  ZeroGpuError, ZeroGpuProvider, ENGINE_UNAVAILABLE_MESSAGE, ZEROGPU_UNAVAILABLE_MESSAGE,
  DEFAULT_ZEROGPU_AUTO_DURATION, DEFAULT_ZEROGPU_TIMEOUT_SECONDS,
  createNeuralProvider, createProvider, lyricLines, normalizeLyrics, parseNeuralBackend,
  parseZeroGpuConfig, planZeroGpuRequest, resolveEngineMode, resolveProvider, resolveZeroGpuDuration,
  spaceUrlProblem, structureTags, verifyLyricsPreserved, zeroGpuStyle, zeroGpuVocalGender,
  type GenerationStatus, type MusicGenerationProvider, type MusicGenerationRequest, type ZeroGpuErrorCode,
} from '../../src/engine/providers'
import { BOS_TOXIC_LYRICS, BOS_TOXIC_STYLE } from './fixtures/bos-toxic'
import {
  EVENT_ID, FILE_DATA, METADATA, SESSION, SPACE, SPACE_CONFIG, SPACE_INFO, SUCCESS_STREAM, TEST_CONFIG,
  completed, failed, json, sse, wav, zeroGpu,
} from './helpers/fakeSpace'

const BOS_TOXIC: MusicGenerationRequest = {
  style: BOS_TOXIC_STYLE,
  lyrics: BOS_TOXIC_LYRICS,
  language: 'id',
  vocalGender: 'male',
  instrumental: false,
  duration: 271,
}

/** Runs a generation that is expected to fail, and returns what it threw. */
async function failure(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise
  } catch (error) {
    return error as Error
  }
  throw new Error('the generation resolved, and it was expected to fail')
}

async function expectCode(promise: Promise<unknown>, code: ZeroGpuErrorCode): Promise<ZeroGpuError> {
  const error = await failure(promise)
  expect(error, `${error.name}: ${error.message}`).toBeInstanceOf(ZeroGpuError)
  expect((error as ZeroGpuError).code).toBe(code)
  return error as ZeroGpuError
}

/** A metadata payload with one field changed, as the completed message's second output. */
const withMetadata = (changes: Record<string, unknown>) =>
  sse([completed([FILE_DATA, JSON.stringify({ ...METADATA, ...changes })])])

/* ------------------------------------------------------------------------ */

describe('the request matches the endpoint the live Space declares', () => {
  const declared = SPACE_INFO.named_endpoints['/generate_music']!

  it('sends exactly its six inputs, in its order, with its types', async () => {
    const { server, provider } = zeroGpu()
    await provider.generate(BOS_TOXIC)
    const sent = server.joinBody()!.data

    expect(declared.parameters.map((p) => p.parameter_name))
      .toEqual(['style', 'lyrics', 'language', 'vocal_gender', 'instrumental', 'duration'])
    expect(sent).toHaveLength(declared.parameters.length)
    declared.parameters.forEach((parameter, index) => {
      const value = sent[index]
      const expected = parameter.type.type
      if (expected === 'string') expect(typeof value, parameter.parameter_name).toBe('string')
      if (expected === 'boolean') expect(typeof value, parameter.parameter_name).toBe('boolean')
      if (expected === 'integer') expect(Number.isInteger(value), parameter.parameter_name).toBe(true)
      if (parameter.type.enum) expect(parameter.type.enum, parameter.parameter_name).toContain(value)
    })
  })

  it('expects the two outputs the Space declares: an audio file and a metadata string', () => {
    expect(declared.returns.map((r) => r.component)).toEqual(['Audio', 'Code'])
    expect(declared.returns[0]!.properties).toEqual(expect.arrayContaining(['path', 'url']))
  })

  it('joins the queue the way Gradio does, and reads the stream for that session', async () => {
    const { server, provider } = zeroGpu()
    await provider.generate(BOS_TOXIC)

    expect(server.calls.map((call) => `${call.method} ${call.url.replace(SPACE, '')}`)).toEqual([
      'GET /config',
      'POST /gradio_api/queue/join',
      `GET /gradio_api/queue/data?session_hash=${SESSION}`,
      `GET /gradio_api/file=${FILE_DATA.path}`,
    ])
    const body = server.joinBody()!
    expect(body.fn_index).toBe(SPACE_CONFIG.dependencies[0]!.id)
    expect(body.session_hash).toBe(SESSION)
    expect(body.event_data).toBeNull()
    expect(body.trigger_id).toBeNull()
  })

  it('finds the endpoint by name, so a reordered app still gets the right function', async () => {
    const moved = { ...SPACE_CONFIG, dependencies: [{ id: 0, api_name: 'something_else' }, { id: 7, api_name: 'generate_music' }] }
    const { server, provider } = zeroGpu({ config: json(moved) })
    await provider.generate(BOS_TOXIC)
    expect(server.joinBody()!.fn_index).toBe(7)
  })

  it('refuses an app that speaks another protocol, before submitting anything', async () => {
    const { server, provider } = zeroGpu({ config: json({ ...SPACE_CONFIG, protocol: 'sse_v2' }) })
    const error = await failure(provider.generate(BOS_TOXIC))
    expect(error).toBeInstanceOf(EngineUnavailableError)
    expect(error.message).toMatch(/protocol "sse_v2"/)
    expect(server.joins()).toBe(0)
  })

  it('refuses an app that no longer has the endpoint, before submitting anything', async () => {
    const { server, provider } = zeroGpu({ config: json({ ...SPACE_CONFIG, dependencies: [] }) })
    const error = await failure(provider.generate(BOS_TOXIC))
    expect(error).toBeInstanceOf(EngineUnavailableError)
    expect(error.message).toMatch(/no endpoint named "generate_music"/)
    expect(server.joins()).toBe(0)
  })
})

describe('the Bos Toxic request reaches the Space intact', () => {
  const sent = async (request: MusicGenerationRequest, config = {}) => {
    const { server, provider } = zeroGpu({}, config)
    await provider.generate(request)
    return server.joinBody()!.data
  }

  it('sends the whole style, word for word', async () => {
    expect((await sent(BOS_TOXIC))[0]).toBe(BOS_TOXIC_STYLE)
  })

  it('sends every lyric line and every section tag, unchanged', async () => {
    const lyrics = (await sent(BOS_TOXIC))[1] as string
    expect(lyrics).toBe(normalizeLyrics(BOS_TOXIC_LYRICS))
    expect(verifyLyricsPreserved(BOS_TOXIC_LYRICS, lyrics)).toEqual({ preserved: true, missingLines: [], missingTags: [] })
    expect(lyricLines(lyrics)).toHaveLength(68)
    expect(structureTags(lyrics)).toEqual(structureTags(BOS_TOXIC_LYRICS))
    // The Space owns the instrumental marker; the sheet itself is never swapped here.
    expect(lyrics).not.toContain('[inst]')
  })

  it('keeps Windows line endings from changing a single line', async () => {
    const crlf = BOS_TOXIC_LYRICS.replace(/\n/g, '\r\n')
    expect((await sent({ ...BOS_TOXIC, lyrics: crlf }))[1]).toBe(normalizeLyrics(BOS_TOXIC_LYRICS))
  })

  it('sends the language', async () => {
    expect((await sent(BOS_TOXIC))[2]).toBe('id')
    // The Space echoes the language it sang in, and a mismatch is refused, so
    // this fake has to answer in Japanese too.
    const { server, provider } = zeroGpu({ stream: withMetadata({ vocal_language: 'ja' }) })
    await provider.generate({ ...BOS_TOXIC, language: 'ja' })
    expect(server.joinBody()!.data[2]).toBe('ja')
  })

  it('sends the vocal gender that was chosen, and never a male voice by default', async () => {
    expect((await sent({ ...BOS_TOXIC, vocalGender: 'male' }))[3]).toBe('male')
    expect((await sent({ ...BOS_TOXIC, vocalGender: 'female' }))[3]).toBe('female')
    expect((await sent({ ...BOS_TOXIC, vocalGender: 'mixed' }))[3]).toBe('mixed')
    const { vocalGender: _omitted, ...auto } = BOS_TOXIC
    // Auto adds nothing to the caption, so the style's own "dramatic male
    // vocal" decides — exactly what the validated request relied on.
    expect((await sent(auto))[3]).toBe('mixed')
    expect(zeroGpuVocalGender(undefined)).toBe('mixed')
  })

  it('sends the instrumental choice as the Space\'s own flag', async () => {
    expect((await sent(BOS_TOXIC))[4]).toBe(false)
    const { server, provider } = zeroGpu({ stream: withMetadata({ instrumental: true }) })
    await provider.generate({ ...BOS_TOXIC, instrumental: true })
    expect(server.joinBody()!.data[4]).toBe(true)
  })

  it('sends the requested length as a whole number of seconds', async () => {
    expect((await sent(BOS_TOXIC))[5]).toBe(271)
    const { server, provider } = zeroGpu({ stream: withMetadata({ requested_audio_duration_s: 180, audio_duration_s: 180 }),
      file: () => new Response(wav(180), { headers: { 'Content-Type': 'audio/wav' } }) })
    await provider.generate({ ...BOS_TOXIC, duration: 179.6 })
    expect(server.joinBody()!.data[5]).toBe(180)
  })
})

describe('the voice chosen is the voice the caption asks for', () => {
  /**
   * The Space's caption rule, line for line from `poc/zerogpu-space/app.py`
   * (the deployed code — the live Space's endpoint defaults were checked
   * byte-identical to that directory):
   *
   *   caption = style.strip()
   *   if not instrumental and vocal_gender in ("male", "female"):
   *       if vocal_gender not in caption.lower():
   *           caption = f"{caption.rstrip(',; ')}, {vocal_gender} lead vocal"
   */
  const spaceCaption = (style: string, gender: string, instrumental: boolean): string => {
    let caption = style.trim()
    if (!instrumental && (gender === 'male' || gender === 'female') && !caption.toLowerCase().includes(gender)) {
      caption = `${caption.replace(/[,; ]+$/, '')}, ${gender} lead vocal`
    }
    return caption
  }

  /** What ACE-Step ends up reading: the style sent, after the Space's rule. */
  const captionFor = (style: string, vocalGender: MusicGenerationRequest['vocalGender'], instrumental = false) => {
    const { data } = planZeroGpuRequest({ ...BOS_TOXIC, style, instrumental, ...(vocalGender ? { vocalGender } : { vocalGender: undefined }) }, TEST_CONFIG)
    return { sent: data[0], wire: data[3], caption: spaceCaption(data[0], data[3], instrumental) }
  }

  it('mirrors the rule the deployed Space actually runs', () => {
    const app = readFileSync(new URL('../../poc/zerogpu-space/app.py', import.meta.url), 'utf8')
    expect(app).toContain('if vocal_gender not in caption.lower():')
    expect(app).toContain('caption = f"{caption.rstrip(\',; \')}, {vocal_gender} lead vocal"')
  })

  it('leaves the validated Bos Toxic request byte for byte as it was', () => {
    for (const gender of ['male', undefined] as const) {
      const { sent, caption } = captionFor(BOS_TOXIC_STYLE, gender)
      expect(sent).toBe(BOS_TOXIC_STYLE)
      expect(caption).toBe(BOS_TOXIC_STYLE)
    }
    expect(captionFor(BOS_TOXIC_STYLE, 'male').wire).toBe('male')
    expect(captionFor(BOS_TOXIC_STYLE, undefined).wire).toBe('mixed')
  })

  it('sends Auto as mixed, Male as male and Female as female', () => {
    expect(captionFor('lo-fi beat', undefined).wire).toBe('mixed')
    expect(captionFor('lo-fi beat', 'male').wire).toBe('male')
    expect(captionFor('lo-fi beat', 'female').wire).toBe('female')
  })

  it('does not let "male" hide inside "female" or "malevolent"', () => {
    // Without the client-side check, the Space finds "male" inside these words
    // and adds nothing, so a Male choice would silently not happen.
    for (const style of ['soft female vocal, piano', 'malevolent dark trap', 'FEMALE choir, epic']) {
      expect(spaceCaption(style, 'male', false), 'the Space alone misses it').not.toMatch(/\bmale\b/i)
      expect(captionFor(style, 'male').caption).toMatch(/\bmale lead vocal$/)
    }
  })

  it('asks for the chosen voice as a whole word, whatever the style says', () => {
    const styles = [
      'lo-fi beat', 'dramatic male vocal', 'soft female vocal', 'malevolent dark trap', 'funky bass groove',
      'females and males in unison', 'ballad,; ', BOS_TOXIC_STYLE,
    ]
    for (const style of styles) {
      for (const gender of ['male', 'female'] as const) {
        const { caption } = captionFor(style, gender)
        expect(caption, `${gender} on "${style}"`).toMatch(new RegExp(`\\b${gender}\\b`, 'i'))
      }
      // Auto adds nothing, anywhere.
      expect(captionFor(style, undefined).caption).toBe(style.trim())
    }
  })

  it('changes nothing when the style already says it, or for an instrumental', () => {
    expect(captionFor('dramatic male vocal', 'male').sent).toBe('dramatic male vocal')
    expect(captionFor('soft female vocal', 'female').sent).toBe('soft female vocal')
    expect(captionFor('malevolent dark trap', 'male', true).caption).toBe('malevolent dark trap')
    expect(zeroGpuStyle('malevolent dark trap', 'male', true)).toBe('malevolent dark trap')
  })
})

describe('Auto length becomes a concrete, validated number before anything is sent', () => {
  it('uses the configured Auto length, 271 seconds by default', async () => {
    expect(DEFAULT_ZEROGPU_AUTO_DURATION).toBe(271)
    const { duration: _dropped, ...auto } = BOS_TOXIC
    const { server, provider } = zeroGpu()
    await provider.generate(auto)
    expect(server.joinBody()!.data[5]).toBe(271)
  })

  it('treats the studio\'s 0 as Auto too, and never sends -1', () => {
    expect(resolveZeroGpuDuration(0, TEST_CONFIG)).toBe(271)
    expect(resolveZeroGpuDuration(undefined, TEST_CONFIG)).toBe(271)
    for (const requested of [undefined, 0]) {
      expect(planZeroGpuRequest({ ...BOS_TOXIC, duration: requested }, TEST_CONFIG).data[5]).toBeGreaterThan(0)
    }
  })

  it('follows the configuration, so 271 is a default and not a rule', () => {
    expect(resolveZeroGpuDuration(undefined, { autoDuration: 180 })).toBe(180)
    expect(resolveZeroGpuDuration(240, { autoDuration: 180 })).toBe(240)
  })

  it('refuses a length ACE-Step cannot make, without contacting the Space', async () => {
    for (const duration of [5, 601, -30, Number.NaN, Number.POSITIVE_INFINITY]) {
      const { server, provider } = zeroGpu()
      await expectCode(provider.generate({ ...BOS_TOXIC, duration }), 'illegal-duration')
      expect(server.calls, `duration ${duration} reached the Space`).toHaveLength(0)
    }
  })

  it('refuses a length over the configured ceiling, without contacting the Space', async () => {
    const { server, provider } = zeroGpu({}, { maxDuration: 300 })
    const error = await expectCode(provider.generate({ ...BOS_TOXIC, duration: 420 }), 'illegal-duration')
    expect(error.message).toMatch(/limited to 5:00/)
    expect(server.calls).toHaveLength(0)
  })

  it('claims no ceiling when none is configured', () => {
    const config = parseZeroGpuConfig((key) => ({ VITE_ACE_STEP_SPACE_URL: SPACE } as Record<string, string>)[key], 'https:')
    expect(config.maxDuration).toBeUndefined()
    expect(resolveZeroGpuDuration(420, config)).toBe(420)
  })
})

describe('the ZeroGPU settings are read strictly', () => {
  const read = (env: Record<string, string>) => (key: string) => env[key]

  it('fills in the validated defaults and nothing else', () => {
    const config = parseZeroGpuConfig(read({ VITE_ACE_STEP_SPACE_URL: `${SPACE}/` }), 'https:')
    expect(config).toEqual({
      spaceUrl: SPACE, autoDuration: 271, jobTimeoutMs: DEFAULT_ZEROGPU_TIMEOUT_SECONDS * 1000,
    })
  })

  it('takes every setting from configuration', () => {
    const config = parseZeroGpuConfig(read({
      VITE_ACE_STEP_SPACE_URL: SPACE, VITE_ACE_STEP_SPACE_AUTO_DURATION: '180',
      VITE_ACE_STEP_SPACE_MAX_DURATION: '300', VITE_ACE_STEP_SPACE_TIMEOUT_SECONDS: '600',
      VITE_ACE_STEP_MODEL: 'acestep-v15-turbo', VITE_ACE_STEP_LM_MODEL: 'acestep-5Hz-lm-0.6B',
    }), 'https:')
    expect(config).toMatchObject({ autoDuration: 180, maxDuration: 300, jobTimeoutMs: 600_000 })
    expect(config.blockedReason).toBeUndefined()
  })

  it('reports a wrong setting instead of quietly using a default', () => {
    expect(parseZeroGpuConfig(read({ VITE_ACE_STEP_SPACE_URL: SPACE, VITE_ACE_STEP_SPACE_AUTO_DURATION: 'auto' }), 'https:')
      .blockedReason).toMatch(/ACE_STEP_SPACE_AUTO_DURATION is "auto"/)
    expect(parseZeroGpuConfig(read({
      VITE_ACE_STEP_SPACE_URL: SPACE, VITE_ACE_STEP_SPACE_AUTO_DURATION: '400', VITE_ACE_STEP_SPACE_MAX_DURATION: '300',
    }), 'https:').blockedReason).toMatch(/longer than ACE_STEP_SPACE_MAX_DURATION/)
    expect(parseZeroGpuConfig(read({ VITE_ACE_STEP_SPACE_URL: SPACE, VITE_ACE_STEP_SPACE_TIMEOUT_SECONDS: '5' }), 'https:')
      .blockedReason).toMatch(/TIMEOUT_SECONDS is "5"/)
  })

  it('accepts only the Space\'s own host, and says what to use instead', () => {
    expect(spaceUrlProblem(undefined, 'https:')).toMatch(/ACE_STEP_SPACE_URL is not set/)
    expect(spaceUrlProblem('https://huggingface.co/spaces/owner/space', 'https:')).toMatch(/hf\.space/)
    expect(spaceUrlProblem(`${SPACE}/gradio_api`, 'https:')).toMatch(/no path/)
    expect(spaceUrlProblem('ftp://example.com', 'https:')).toMatch(/http\(s\)/)
    expect(spaceUrlProblem('not a url', 'https:')).toMatch(/not a URL/)
    expect(spaceUrlProblem('http://127.0.0.1:7860', 'https:')).toMatch(/served over HTTPS/)
    expect(spaceUrlProblem(SPACE, 'https:')).toBeUndefined()
    expect(spaceUrlProblem(`${SPACE}/`, 'https:')).toBeUndefined()
  })
})

describe('a generation that works', () => {
  it('comes back as a playable neural result of the length asked for', async () => {
    const { provider } = zeroGpu()
    const result = await provider.generate(BOS_TOXIC)

    expect(result.engine).toBe('ace-step')
    expect(result.id).toBe(EVENT_ID)
    expect(result.audioUrl).toBe('blob:zerogpu')
    // Measured from the file's own header, not taken from the Space's word.
    expect(result.duration).toBeCloseTo(271, 5)
    expect(result.sampleRate).toBe(1000)
    expect(result.metadata).toEqual({
      model: 'acestep-v15-turbo', lmModel: 'acestep-5Hz-lm-0.6B',
      seed: METADATA.seed, language: 'id', style: BOS_TOXIC_STYLE,
    })
  })

  it('reports only what the Space said, in order, with no invented progress', async () => {
    const statuses: GenerationStatus[] = []
    const { provider } = zeroGpu()
    await provider.generate(BOS_TOXIC, { onStatus: (status) => statuses.push(status) })

    expect(statuses).toEqual([
      { state: 'initializing', detail: 'Reaching the ZeroGPU Space' },
      { state: 'queued', detail: 'Submitting to the ZeroGPU Space' },
      { state: 'queued', detail: 'Waiting in the Space\'s queue', queuePosition: 2 },
      { state: 'generating', detail: 'Generating on the GPU' },
      { state: 'generating', detail: 'Waiting for a GPU to become available' },
      { state: 'generating', detail: 'Downloading the song' },
      { state: 'completed', detail: 'Song generated' },
    ])
    expect(statuses.some((status) => status.progress !== undefined)).toBe(false)
  })

  it('passes on progress only when the Space reports some', async () => {
    const statuses: GenerationStatus[] = []
    const { provider } = zeroGpu({ stream: sse([
      { msg: 'process_starts', event_id: EVENT_ID },
      { msg: 'progress', event_id: EVENT_ID, progress_data: [{ index: 4, length: 8, unit: 'steps', progress: null, desc: 'Diffusion' }] },
      completed(),
    ]) })
    await provider.generate(BOS_TOXIC, { onStatus: (status) => statuses.push(status) })
    expect(statuses).toContainEqual({ state: 'generating', detail: 'Diffusion', progress: 0.5 })
  })

  it('reads a stream whose messages are split across chunks and CRLF-framed', async () => {
    const framed = sse(SUCCESS_STREAM).join('').replace(/\n/g, '\r\n')
    const chunks: string[] = []
    for (let at = 0; at < framed.length; at += 7) chunks.push(framed.slice(at, at + 7))
    const { provider } = zeroGpu({ stream: chunks })
    expect((await provider.generate(BOS_TOXIC)).duration).toBeCloseTo(271, 5)
  })

  it('ignores a message type newer than this client, rather than failing on it', async () => {
    const { provider } = zeroGpu({ stream: sse([{ msg: 'some_future_message', event_id: EVENT_ID }, completed()]) })
    await expect(provider.generate(BOS_TOXIC)).resolves.toMatchObject({ engine: 'ace-step' })
  })
})

describe('the answer the live Space actually gave is accepted', () => {
  // The metadata string from the validated 271-second run, exactly as the Space
  // returned it — `271.0`, not `271`, among other things — rather than a
  // shape written here. If the checks above were stricter than the real Space,
  // this is where it would show.
  const REAL = readFileSync(new URL('./fixtures/zerogpu/real-run-metadata.json', import.meta.url), 'utf8')

  it('passes every check on the real run and reports what it really ran', async () => {
    const real = JSON.parse(REAL) as Record<string, unknown>
    expect(real.requested_audio_duration_s).toBe(271)
    expect(REAL).toContain('"requested_audio_duration_s": 271.0')

    const { provider } = zeroGpu({
      stream: sse([completed([FILE_DATA, REAL])]),
      file: () => new Response(wav(271, { rate: 48000 }), { headers: { 'Content-Type': 'audio/wav' } }),
    })
    const result = await provider.generate(BOS_TOXIC)
    expect(result.duration).toBeCloseTo(271, 5)
    expect(result.sampleRate).toBe(48000)
    expect(result.metadata).toMatchObject({
      model: 'acestep-v15-turbo', lmModel: 'acestep-5Hz-lm-0.6B', seed: 101390300, language: 'id',
    })
  })
})

describe('the engine never switches itself back to procedural', () => {
  it('adopts the neural engine once it has answered, and keeps it', () => {
    expect(resolveEngineMode(null, false)).toBe('procedural')
    expect(resolveEngineMode(null, true)).toBe('neural')
  })

  it('always does what the person chose', () => {
    expect(resolveEngineMode('procedural', true)).toBe('procedural')
    expect(resolveEngineMode('neural', false)).toBe('neural')
  })

  it('is decided by "has answered", never by the latest check', () => {
    // A mode read from the latest check would flip to procedural the moment a
    // hosted backend missed one, under someone who saw Neural selected.
    const studio = readFileSync(new URL('../../src/ui/pages/StudioPage.tsx', import.meta.url), 'utf8')
    expect(studio).toContain('resolveEngineMode(engineChoice, neural.hasAnswered)')
    expect(studio).not.toMatch(/connection === 'connected' \? 'neural'/)
    const hook = readFileSync(new URL('../../src/ui/useNeuralEngine.ts', import.meta.url), 'utf8')
    // Monotonic: the only update is `answered || connected`, which can turn
    // true and can never turn back.
    expect(hook).toContain('setHasAnswered((answered) => answered || status.connected)')
    expect(hook.match(/setHasAnswered\(/g)).toHaveLength(1)
  })
})

describe('every way ZeroGPU can say no, named', () => {
  it('a spent quota is its own error, carries ZeroGPU\'s words, and is asked exactly once', async () => {
    const text = 'You have exceeded your free ZeroGPU quota (120s requested vs. 44s left). Try again in 23:14:07.'
    const { server, provider } = zeroGpu({ stream: sse([failed('ZeroGPU quota exceeded', text)]) })
    const error = await failure(provider.generate(BOS_TOXIC))
    expect(error).toBeInstanceOf(QuotaExceededError)
    expect(error.message).toContain('Try again in 23:14:07')
    expect(server.joins()).toBe(1)
  })

  it('the anonymous form of a spent quota is recognised too', async () => {
    const { provider } = zeroGpu({ stream: sse([failed('ZeroGPU quota exceeded', 'Space app has reached its GPU limit.')]) })
    expect(await failure(provider.generate(BOS_TOXIC))).toBeInstanceOf(QuotaExceededError)
  })

  it('too many GPU credits in flight counts as a spent quota', async () => {
    const { provider } = zeroGpu({ stream: sse([failed('ZeroGPU pending credits exceeded', 'Try again once some of those tasks have completed.')]) })
    expect(await failure(provider.generate(BOS_TOXIC))).toBeInstanceOf(QuotaExceededError)
  })

  it('an illegal GPU duration', async () => {
    const { provider } = zeroGpu({ stream: sse([failed('ZeroGPU illegal duration', 'The requested GPU duration (120s) is larger than the maximum allowed')]) })
    const error = await expectCode(provider.generate(BOS_TOXIC), 'illegal-duration')
    expect(error.message).toContain('larger than the maximum allowed')
  })

  it('a song that outran the Space\'s GPU time is an unsupported length, with advice', async () => {
    const { provider } = zeroGpu({ stream: sse([failed('ZeroGPU worker error', 'GPU task aborted')]) })
    const error = await expectCode(provider.generate(BOS_TOXIC), 'illegal-duration')
    expect(error.message).toMatch(/shorter song/)
  })

  it('any other worker failure is a failed generation', async () => {
    const { provider } = zeroGpu({ stream: sse([failed('ZeroGPU worker error', 'RuntimeError')]) })
    await expectCode(provider.generate(BOS_TOXIC), 'generation-failed')
  })

  it('waiting too long for a GPU is a timeout', async () => {
    const { provider } = zeroGpu({ stream: sse([failed('ZeroGPU queue timeout', '<b>No GPU was available</b>')]) })
    const error = await expectCode(provider.generate(BOS_TOXIC), 'timeout')
    expect(error.message).not.toContain('<b>')
  })

  it('the Space\'s own failure message is passed on', async () => {
    const { provider } = zeroGpu({ stream: sse([failed('Error', 'ACE-Step generation failed: CUDA out of memory')]) })
    const error = await expectCode(provider.generate(BOS_TOXIC), 'generation-failed')
    expect(error.message).toContain('CUDA out of memory')
  })

  it('a failure the Space did not explain is still a failure, not a silence', async () => {
    const { provider } = zeroGpu({ stream: sse([failed(null, null)]) })
    const error = await expectCode(provider.generate(BOS_TOXIC), 'generation-failed')
    expect(error.message).toMatch(/without saying why/)
  })

  it('a queue that failed outside the handler is an unexpected error', async () => {
    const { provider } = zeroGpu({ stream: sse([{ msg: 'unexpected_error', event_id: null, message: 'Session not found.', session_not_found: true, success: false }]) })
    const error = await expectCode(provider.generate(BOS_TOXIC), 'unexpected-error')
    expect(error.message).toContain('Session not found')
  })

  it('a server that stopped mid-job is an unexpected error', async () => {
    const { provider } = zeroGpu({ stream: sse([{ msg: 'Server stopped unexpectedly.', event_id: null }]) })
    await expectCode(provider.generate(BOS_TOXIC), 'unexpected-error')
  })
})

describe('HTTP and queue failures', () => {
  it('a Space that does not answer is unavailable, and says what it got', async () => {
    const { server, provider } = zeroGpu({ config: new Response('<html>Your space is sleeping</html>', { status: 503 }) })
    const error = await failure(provider.generate(BOS_TOXIC))
    expect(error).toBeInstanceOf(EngineUnavailableError)
    expect(error.message).toContain(ZEROGPU_UNAVAILABLE_MESSAGE)
    expect(error.message).toContain('HTTP 503')
    expect(server.joins()).toBe(0)
  })

  it('a Space that cannot be reached at all is unavailable', async () => {
    const { provider } = zeroGpu({ config: () => { throw new TypeError('Failed to fetch') } })
    const error = await failure(provider.generate(BOS_TOXIC))
    expect(error).toBeInstanceOf(EngineUnavailableError)
    expect(error.message).toContain('Failed to fetch')
  })

  it('a refused submission is an HTTP error with the Space\'s reason', async () => {
    const { provider } = zeroGpu({ join: json({ detail: 'Internal Server Error' }, 500) })
    const error = await expectCode(provider.generate(BOS_TOXIC), 'http-error')
    expect(error.message).toContain('HTTP 500')
  })

  it('a full queue is reported as the Space put it', async () => {
    const { provider } = zeroGpu({ join: json({ detail: 'Queue is full. Max size is 20 and size is 20.' }, 503) })
    const error = await expectCode(provider.generate(BOS_TOXIC), 'http-error')
    expect(error.message).toContain('Queue is full')
  })

  it('inputs the Space rejects point at a contract that has moved', async () => {
    const { provider } = zeroGpu({ join: json({ detail: [{ msg: 'Value is not a valid choice' }] }, 422) })
    const error = await expectCode(provider.generate(BOS_TOXIC), 'http-error')
    expect(error.message).toMatch(/no longer match/)
  })

  it('a submission the network dropped is unavailable, not retried', async () => {
    const { server, provider } = zeroGpu({ join: () => { throw new TypeError('network error') } })
    expect(await failure(provider.generate(BOS_TOXIC))).toBeInstanceOf(EngineUnavailableError)
    expect(server.joins()).toBe(1)
  })
})

describe('results that are not a song', () => {
  it('outputs missing altogether', async () => {
    const { provider } = zeroGpu({ stream: sse([{ ...completed(), output: { is_generating: false } }]) })
    await expectCode(provider.generate(BOS_TOXIC), 'bad-result')
  })

  it('fewer outputs than the endpoint declares', async () => {
    const { provider } = zeroGpu({ stream: sse([completed([FILE_DATA])]) })
    await expectCode(provider.generate(BOS_TOXIC), 'bad-result')
  })

  it('metadata that is not JSON, or not an object', async () => {
    for (const metadata of ['{not json', '[1, 2, 3]', null]) {
      const { provider } = zeroGpu({ stream: sse([completed([FILE_DATA, metadata])]) })
      await expectCode(provider.generate(BOS_TOXIC), 'bad-result')
    }
  })

  it('an audio output that is not a file', async () => {
    const { provider } = zeroGpu({ stream: sse([completed(['/tmp/song.wav', JSON.stringify(METADATA)])]) })
    await expectCode(provider.generate(BOS_TOXIC), 'bad-result')
  })

  it('a message on the stream that is not JSON', async () => {
    const { provider } = zeroGpu({ stream: ['data: {"msg": "process_completed", \n\n'] })
    await expectCode(provider.generate(BOS_TOXIC), 'bad-result')
  })

  it('no audio at all', async () => {
    const { provider } = zeroGpu({ stream: sse([completed([null, JSON.stringify(METADATA)])]) })
    const error = await expectCode(provider.generate(BOS_TOXIC), 'missing-audio')
    expect(error.message).toMatch(/no audio file/)
  })

  it('a file record with no file in it', async () => {
    const { provider } = zeroGpu({ stream: sse([completed([{ orig_name: 'x.wav', meta: {} }, JSON.stringify(METADATA)])]) })
    await expectCode(provider.generate(BOS_TOXIC), 'missing-audio')
  })

  it('a download that is gone', async () => {
    const { provider } = zeroGpu({ file: new Response('not found', { status: 404 }) })
    const error = await expectCode(provider.generate(BOS_TOXIC), 'http-error')
    expect(error.message).toMatch(/Could not download the song \(HTTP 404/)
  })

  it('a file on another site is never fetched', async () => {
    const elsewhere = { ...FILE_DATA, url: 'https://example.com/steal.wav' }
    const { server, provider } = zeroGpu({ stream: sse([completed([elsewhere, JSON.stringify(METADATA)])]) })
    await expectCode(provider.generate(BOS_TOXIC), 'bad-result')
    expect(server.calls.some((call) => call.url.includes('example.com'))).toBe(false)
  })

  it('an error page served as the file', async () => {
    const { provider } = zeroGpu({ file: new Response('<html>oops</html>', { headers: { 'Content-Type': 'text/html' } }) })
    const error = await expectCode(provider.generate(BOS_TOXIC), 'bad-result')
    expect(error.message).toMatch(/not usable audio/)
  })

  it('a silent file', async () => {
    const { provider } = zeroGpu({ file: () => new Response(wav(271, { amplitude: 0 }), { headers: { 'Content-Type': 'audio/wav' } }) })
    const error = await expectCode(provider.generate(BOS_TOXIC), 'bad-result')
    expect(error.message).toMatch(/silent/)
  })

  it('bytes that are not a WAV, whatever the metadata claims', async () => {
    // Served as audio/wav, large enough to pass the size check, with the
    // Space's metadata still saying 271 seconds: none of that makes it a song.
    const junk = new Uint8Array(8192).map((_, i) => (i * 37) % 251)
    const { provider } = zeroGpu({ file: () => new Response(junk, { headers: { 'Content-Type': 'audio/wav' } }) })
    const error = await expectCode(provider.generate(BOS_TOXIC), 'bad-result')
    expect(error.message).toMatch(/not a readable WAV/)
  })

  it('a clip where a song was asked for', async () => {
    const { provider } = zeroGpu({ file: () => new Response(wav(58), { headers: { 'Content-Type': 'audio/wav' } }) })
    const error = await expectCode(provider.generate(BOS_TOXIC), 'bad-result')
    expect(error.message).toMatch(/Asked for a 4:31 song and received 0:58/)
  })
})

describe('what the Space says it did must be what was asked', () => {
  it('refuses a song made by a substituted language model', async () => {
    const { provider } = zeroGpu({ stream: withMetadata({ loaded_lm_model: 'acestep-5Hz-lm-1.7B' }) })
    const error = await expectCode(provider.generate(BOS_TOXIC), 'bad-result')
    expect(error.message).toMatch(/asked for acestep-5Hz-lm-0\.6B, it ran acestep-5Hz-lm-1\.7B/)
  })

  it('refuses a song made by a substituted generation model', async () => {
    const { provider } = zeroGpu({ stream: withMetadata({ loaded_model: 'acestep-v15-sft' }) })
    await expectCode(provider.generate(BOS_TOXIC), 'bad-result')
  })

  it('refuses a song whose models the Space did not report', async () => {
    const { provider } = zeroGpu({ stream: withMetadata({ loaded_model: undefined }) })
    await expectCode(provider.generate(BOS_TOXIC), 'bad-result')
  })

  it('refuses when fewer lyric lines arrived than were sent', async () => {
    const { provider } = zeroGpu({ stream: withMetadata({ lyric_lines_sent: 60 }) })
    const error = await expectCode(provider.generate(BOS_TOXIC), 'bad-result')
    expect(error.message).toMatch(/received 60 lyric lines; 68 were sent/)
  })

  it('refuses a different language, instrumental choice or length than was sent', async () => {
    for (const changes of [{ vocal_language: 'en' }, { instrumental: true }, { requested_audio_duration_s: 120 }]) {
      const { provider } = zeroGpu({ stream: withMetadata(changes) })
      await expectCode(provider.generate(BOS_TOXIC), 'bad-result')
    }
  })
})

describe('time, cancellation and a dead connection', () => {
  it('a job over the overall budget is a timeout, and is not resubmitted', async () => {
    const { server, provider } = zeroGpu({ stream: [], hang: true }, { jobTimeoutMs: 30 }, { heartbeatTimeoutMs: 10_000 })
    const error = await expectCode(provider.generate(BOS_TOXIC), 'timeout')
    expect(error.message).toMatch(/did not finish within/)
    expect(server.joins()).toBe(1)
  })

  it('a stream that stops sending heartbeats is treated as a lost, unavailable connection', async () => {
    const { server, provider } = zeroGpu({ stream: sse([{ msg: 'estimation', event_id: EVENT_ID, rank: 0, queue_size: 1 }]), hang: true },
      {}, { heartbeatTimeoutMs: 25 })
    const error = await failure(provider.generate(BOS_TOXIC))
    expect(error).toBeInstanceOf(EngineUnavailableError)
    expect(error.message).toMatch(/no heartbeat/)
    expect(server.joins()).toBe(1)
  })

  it('a stream that closes before the job finishes is a lost connection', async () => {
    for (const stream of [sse([{ msg: 'process_starts', event_id: EVENT_ID }]), sse([{ msg: 'close_stream', event_id: null }])]) {
      const { provider } = zeroGpu({ stream })
      expect(await failure(provider.generate(BOS_TOXIC))).toBeInstanceOf(EngineUnavailableError)
    }
  })

  it('cancelling while waiting settles as cancelled, and nothing is resubmitted', async () => {
    const controller = new AbortController()
    const { server, provider } = zeroGpu({ stream: sse([{ msg: 'estimation', event_id: EVENT_ID, rank: 3, queue_size: 4 }]), hang: true })
    const promise = provider.generate(BOS_TOXIC, {
      signal: controller.signal,
      onStatus: (status) => { if (status.queuePosition) controller.abort() },
    })
    expect(await failure(promise)).toBeInstanceOf(GenerationCancelledError)
    expect(server.joins()).toBe(1)
  })

  it('an already-cancelled request never contacts the Space', async () => {
    const controller = new AbortController()
    controller.abort()
    const { server, provider } = zeroGpu()
    expect(await failure(provider.generate(BOS_TOXIC, { signal: controller.signal }))).toBeInstanceOf(GenerationCancelledError)
    expect(server.calls).toHaveLength(0)
  })

  it('offers no server-side cancel, because the protocol does not promise one', () => {
    const asProvider: MusicGenerationProvider = new ZeroGpuProvider({ config: TEST_CONFIG })
    expect(asProvider.cancel).toBeUndefined()
  })
})

describe('checking the connection costs no GPU', () => {
  it('reports connected from the configuration alone', async () => {
    const { server, provider } = zeroGpu()
    expect(await provider.status()).toEqual({ connected: true })
    expect(await provider.isAvailable()).toBe(true)
    expect(server.joins()).toBe(0)
  })

  it('reports why it is not connected, without throwing', async () => {
    const { provider } = zeroGpu({ config: new Response('sleeping', { status: 503 }) })
    const status = await provider.status()
    expect(status.connected).toBe(false)
    expect(status.detail).toMatch(/HTTP 503/)
  })

  it('a provider with no address is blocked, says why, and never calls anything', async () => {
    const { server, provider } = zeroGpu({}, { spaceUrl: '' })
    expect(await provider.status()).toEqual({ connected: false, blockedReason: expect.stringMatching(/not set/) })
    expect(await failure(provider.generate(BOS_TOXIC))).toBeInstanceOf(EngineUnavailableError)
    expect(server.calls).toHaveLength(0)
  })
})

describe('the provider factory', () => {
  it('builds the local provider by default, as every build before this one did', () => {
    expect(parseNeuralBackend(undefined)).toEqual({ backend: 'local' })
    const provider = createNeuralProvider({ backend: 'local' })
    expect(provider).toBeInstanceOf(AceStepProvider)
    expect(provider.backend).toBe('local')
    // Unit tests carry no baked configuration, so the default really is local.
    expect(createNeuralProvider()).toBeInstanceOf(AceStepProvider)
  })

  it('builds the ZeroGPU provider when asked, whatever the capitalisation', () => {
    expect(parseNeuralBackend('ZeroGPU')).toEqual({ backend: 'zerogpu' })
    const provider = createNeuralProvider({ backend: 'zerogpu' })
    expect(provider).toBeInstanceOf(ZeroGpuProvider)
    expect(provider.backend).toBe('zerogpu')
    expect(provider.autoDuration).toBe(271)
  })

  it('reports a backend it does not know, and never treats it as local', async () => {
    const choice = parseNeuralBackend('remote')
    expect(choice.problem).toMatch(/ACE_STEP_BACKEND is "remote"/)
    const provider = createNeuralProvider(choice)
    expect(provider).toBeInstanceOf(MisconfiguredNeuralProvider)
    expect(await provider.isAvailable()).toBe(false)
    expect((await provider.status()).blockedReason).toMatch(/must be "local" or "zerogpu"/)
    expect(await failure(provider.generate(BOS_TOXIC))).toBeInstanceOf(EngineUnavailableError)
  })

  it('hands back neural for neural and procedural for procedural', () => {
    expect(createProvider('neural').type).toBe('neural')
    expect(createProvider('procedural')).toBeInstanceOf(ProceduralMusicProvider)
  })

  it('refuses an unavailable backend in its own words, and never swaps engines', async () => {
    const zero = new ZeroGpuProvider({ config: { ...TEST_CONFIG, spaceUrl: '' } })
    await expect(resolveProvider('neural', {}, zero)).rejects.toThrow(ZEROGPU_UNAVAILABLE_MESSAGE)
    const local = new AceStepProvider({ baseUrl: 'http://127.0.0.1:1', fetchImpl: (async () => { throw new TypeError('down') }) as typeof fetch })
    await expect(resolveProvider('neural', {}, local)).rejects.toThrow(ENGINE_UNAVAILABLE_MESSAGE)
  })

  it('is the only place the interface builds a neural provider', () => {
    // Read the source, so a screen that starts constructing its own provider —
    // and so can end up on a different backend from its indicator — fails here.
    const ui = new URL('../../src/ui/', import.meta.url)
    const files = readdirSync(ui, { recursive: true, encoding: 'utf8' }).filter((file) => /\.tsx?$/.test(file))
    const constructing = files.filter((file) =>
      /new (AceStepProvider|ZeroGpuProvider)\(/.test(readFileSync(new URL(file, ui), 'utf8')))
    expect(constructing).toEqual([])
    const users = files.filter((file) => readFileSync(new URL(file, ui), 'utf8').includes('createNeuralProvider()'))
    expect(users.sort()).toEqual(['pages/StudioPage.tsx', 'useNeuralEngine.ts'])
  })
})

describe('the Gradio client, as transport', () => {
  it('parses Server-Sent Events however the bytes are split', () => {
    const parser = new SseParser()
    const events = [
      ...parser.push('data: {"a":'),
      ...parser.push('1}\r'),
      ...parser.push('\n\r\n: a comment\n'),
      ...parser.push('data: line one\ndata: line two\n\n'),
      ...parser.push('data: {"tail":true}'),
      ...parser.end(),
    ]
    expect(events).toEqual(['{"a":1}', 'line one\nline two', '{"tail":true}'])
  })

  it('does not mistake a CRLF split across chunks for two line endings', () => {
    // Read naively, the CR ends "data: a" and the LF that follows in the next
    // chunk is a blank line, which would dispatch "a" on its own and "b" after.
    const parser = new SseParser()
    const events = [...parser.push('data: a\r'), ...parser.push('\ndata: b\r\n\r\n')]
    expect(events).toEqual(['a\nb'])
  })

  it('builds a file address the way Gradio does when only a path is given', () => {
    const client = new GradioClient({ baseUrl: SPACE })
    const endpoint = { apiName: 'generate_music', fnIndex: 0, apiPrefix: '/gradio_api', version: '6.2.0' }
    expect(client.fileUrl({ path: '/tmp/a.wav' }, endpoint)).toBe(`${SPACE}/gradio_api/file=/tmp/a.wav`)
    expect(client.fileUrl({ url: FILE_DATA.url }, endpoint)).toBe(FILE_DATA.url)
    expect(() => client.fileUrl({}, endpoint)).toThrow(GradioProtocolError)
  })

  it('ignores messages that belong to another job in the session', async () => {
    const { provider } = zeroGpu({ stream: sse([failed('ZeroGPU quota exceeded', 'not ours'), completed()].map((message, index) =>
      index === 0 ? { ...message, event_id: 'someone-else' } : message)) })
    await expect(provider.generate(BOS_TOXIC)).resolves.toMatchObject({ engine: 'ace-step' })
  })
})
