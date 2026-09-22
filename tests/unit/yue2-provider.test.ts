/**
 * Provider B: the YuE2 adapter, against a fake Space.
 *
 * No test here reaches Hugging Face and none spends ZeroGPU quota. What they
 * hold is the part of the contract Auralyn owns: that the request arrives
 * unaltered, that one press produces exactly one generation POST, that a
 * refusal before execution is not reported as a generation that failed, and
 * that an outcome nobody can read is never answered by generating again.
 *
 * What they cannot hold is the Space's own signature. It has never been read
 * from the running Space — the egress proxy here refuses Hugging Face — so the
 * endpoint name, argument order and output positions are expectations. The
 * tests pin them to the constants rather than to literals, so a live check
 * that corrects the constants corrects the tests with them.
 */

import { describe, expect, it } from 'vitest'
import {
  EngineUnavailableError, QuotaExceededError, Yue2Error, Yue2Provider,
  YUE2_API_NAME, YUE2_API_ROUTE, YUE2_CONTRACT_VERIFIED, YUE2_INPUT_ORDER,
  YUE2_OUTPUT_FLAC, YUE2_OUTPUT_MP3, YUE2_PROVIDER_ID, YUE2_SPACE,
  YUE2_LIVE_GENERATION_DISABLED,
  describeFailure, planYue2Request, yue2SpaceUrl,
  type MusicGenerationRequest,
} from '../../src/engine/providers'
import {
  CLOSE, FLAC_FILE, MP3_FILE, STARTS, YUE2_EVENT_ID, YUE2_SPACE_URL,
  completed, failed, json, sse, yue2,
} from './helpers/fakeYue2Space'
import { press } from './helpers/press'

const STYLE = 'Emotional pop ballad, male vocal, warm piano, gentle strings, '
  + 'intimate and melancholic, modern clean production.'

/** As Auralyn's lyric plan hands them over: [End] already consumed upstream. */
const PROVIDER_LYRICS = `[Verse]
Aku berjalan sendiri
Mencari arti hari ini

[Chorus]
Masih kuingat namamu
Masih kurasakan rindu`

const REQUEST: MusicGenerationRequest = {
  style: STYLE, lyrics: PROVIDER_LYRICS, language: 'id', vocalGender: 'male',
}

async function failure(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise
  } catch (error) {
    return error as Error
  }
  throw new Error('the generation resolved, and it was expected to fail')
}

/* ------------------------------------------------------- 1-3 construction -- */

describe('the provider is built from one configuration', () => {
  it('has the agreed id, name and kind', () => {
    const provider = new Yue2Provider()
    expect(provider.id).toBe('yue2')
    expect(YUE2_PROVIDER_ID).toBe('yue2')
    expect(provider.name).toBe('YuE2')
    expect(provider.type).toBe('neural')
    expect(provider.backend).toBe('zerogpu')
  })

  it('derives the Space host from the Space id, in one place', () => {
    expect(YUE2_SPACE).toBe('Jamalbalya/auralyn-yue2')
    expect(yue2SpaceUrl()).toBe('https://jamalbalya-auralyn-yue2.hf.space')
    expect(new Yue2Provider().baseUrl).toBe('https://jamalbalya-auralyn-yue2.hf.space')
  })

  it('names the endpoint without a leading slash, and the route with one', () => {
    // Gradio stores the bare name in /config and publishes the slashed route.
    // Verified on gradio 6.2.0: a leading slash here publishes //generate_song.
    expect(YUE2_API_NAME).toBe('generate_song')
    expect(YUE2_API_NAME.startsWith('/')).toBe(false)
    expect(YUE2_API_ROUTE).toBe('/generate_song')
  })

  it('says out loud that the contract is not verified against the live Space', () => {
    // This must stay false until someone reads /gradio_api/info from a network
    // that can reach Hugging Face. It is the difference between "we expect"
    // and "we checked", and nothing should be able to blur it silently.
    expect(YUE2_CONTRACT_VERIFIED).toBe(false)
  })

  it('refuses to generate unless the build was told it may', () => {
    const provider = new Yue2Provider({ config: { liveGeneration: false } })
    return failure(provider.generate(REQUEST, { ticket: press() })).then((error) => {
      expect(error).toBeInstanceOf(EngineUnavailableError)
      expect(error.message).toContain(YUE2_LIVE_GENERATION_DISABLED)
    })
  })
})

/* ------------------------------------------------- 4-6 the request itself -- */

describe('the request reaches the Space exactly as Auralyn built it', () => {
  it('sends the style byte for byte', async () => {
    const { server, provider } = yue2()
    await provider.generate(REQUEST, { ticket: press() })
    const sent = server.joinBody()!.data as unknown[]
    expect(sent[0]).toBe(STYLE)
  })

  it('sends the lyrics byte for byte', async () => {
    const { server, provider } = yue2()
    await provider.generate(REQUEST, { ticket: press() })
    const sent = server.joinBody()!.data as unknown[]
    expect(sent[1]).toBe(PROVIDER_LYRICS)
  })

  it('sends two arguments, style then lyrics, and nothing else', async () => {
    const { server, provider } = yue2()
    await provider.generate(REQUEST, { ticket: press() })
    expect(server.joinBody()!.data).toHaveLength(YUE2_INPUT_ORDER.length)
    expect(YUE2_INPUT_ORDER).toEqual(['style', 'lyrics'])
  })

  it('adds no genre, no compiled caption and no hidden instruction', async () => {
    const { server, provider } = yue2()
    await provider.generate(REQUEST, { ticket: press() })
    const sentStyle = (server.joinBody()!.data as string[])[0]!
    expect(sentStyle).toBe(STYLE)
    expect(sentStyle.length).toBe(STYLE.length)
  })

  it('plans the request without touching either string', () => {
    const plan = planYue2Request(REQUEST)
    expect(plan.style).toBe(STYLE)
    expect(plan.lyrics).toBe(PROVIDER_LYRICS)
    expect(plan.data).toEqual([STYLE, PROVIDER_LYRICS])
  })
})

/* ---------------------------------------------------------- 5 [End] rule -- */

describe('[End] never reaches YuE2', () => {
  it('is absent from what Auralyn hands over, and from what is sent', async () => {
    const { server, provider } = yue2()
    await provider.generate(REQUEST, { ticket: press() })
    const sent = (server.joinBody()!.data as string[])[1]!
    expect(sent).not.toContain('[End]')
    expect(sent.toLowerCase()).not.toContain('[end]')
  })

  it('refuses a request whose lyrics still carry the marker, rather than editing it out', () => {
    // Auralyn's lyric plan already removed it, so one surviving here means
    // something upstream is broken. Stripping it quietly would hide that and
    // make this the second place in the codebase that edits someone's words.
    const withMarker = { ...REQUEST, lyrics: `${PROVIDER_LYRICS}\n\n[End]` }
    expect(() => planYue2Request(withMarker)).toThrow(Yue2Error)
    try {
      planYue2Request(withMarker)
    } catch (error) {
      expect((error as Yue2Error).code).toBe('contract-mismatch')
      expect((error as Yue2Error).message).toContain('end marker')
    }
  })

  it('does not send anything when it refuses', async () => {
    const { server, provider } = yue2()
    await failure(provider.generate({ ...REQUEST, lyrics: `${PROVIDER_LYRICS}\n[End]` },
      { ticket: press() }))
    expect(server.joins()).toBe(0)
  })
})

/* ------------------------------------------------- 7,15 the one-shot rule -- */

describe('one Auralyn request is one Space generation', () => {
  it('POSTs the generation exactly once on success', async () => {
    const { server, provider } = yue2()
    await provider.generate(REQUEST, { ticket: press() })
    expect(server.joins()).toBe(1)
  })

  it('POSTs it exactly once when the Space reports a failure', async () => {
    const { server, provider } = yue2({
      stream: sse([STARTS, failed('RuntimeError', 'the model fell over'), CLOSE]),
    })
    await failure(provider.generate(REQUEST, { ticket: press() }))
    expect(server.joins()).toBe(1)
  })

  it('POSTs it exactly once when the connection dies mid-job', async () => {
    const { server, provider } = yue2({ stream: sse([STARTS]), hang: true },
      { heartbeatTimeoutMs: 40 })
    await failure(provider.generate(REQUEST, { ticket: press() }))
    expect(server.joins()).toBe(1)
  })

  it('a spent ticket cannot buy a second generation', async () => {
    const { server, provider } = yue2()
    const ticket = press()
    await provider.generate(REQUEST, { ticket })
    await failure(provider.generate(REQUEST, { ticket }))
    expect(server.joins()).toBe(1)
  })

  it('a generation without a ticket is refused before anything is sent', async () => {
    const { server, provider } = yue2()
    const error = await failure(provider.generate(REQUEST))
    expect(error).toBeInstanceOf(Yue2Error)
    expect(server.joins()).toBe(0)
  })
})

/* ------------------------------------------- 8-11 the result, normalised -- */

describe('the result is normalised into Auralyn s own shape', () => {
  it('maps the MP3 to the playable url', async () => {
    const { provider } = yue2()
    const result = await provider.generate(REQUEST, { ticket: press() })
    expect(result.audioUrl).toMatch(/^blob:yue2\//)
    expect(result.engine).toBe('yue2')
  })

  it('keeps the FLAC alongside it rather than discarding it', async () => {
    const { provider } = yue2()
    const result = await provider.generate(REQUEST, { ticket: press() })
    expect(result.alternateFormats).toEqual([
      { format: 'flac', url: expect.stringMatching(/^blob:yue2\//) },
    ])
  })

  it('downloads both files and only those two', async () => {
    const { server, provider } = yue2()
    await provider.generate(REQUEST, { ticket: press() })
    expect(server.downloads()).toBe(2)
  })

  it('carries the event id through as the provider request id', async () => {
    const { provider } = yue2()
    const result = await provider.generate(REQUEST, { ticket: press() })
    expect(result.providerRequestId).toBe(YUE2_EVENT_ID)
    expect(result.ticketId).toBeTruthy()
  })

  it('reads the two outputs at the documented positions', async () => {
    // Pinned to the constants, so a live check that finds them swapped is a
    // one-line change in the provider rather than a rewrite here.
    expect(YUE2_OUTPUT_MP3).toBe(0)
    expect(YUE2_OUTPUT_FLAC).toBe(1)
    const { provider } = yue2({ stream: sse([STARTS, completed([MP3_FILE, FLAC_FILE]), CLOSE]) })
    const result = await provider.generate(REQUEST, { ticket: press() })
    expect(result.audioUrl).toBeTruthy()
    expect(result.alternateFormats).toHaveLength(1)
  })

  it('refuses a result with the wrong number of outputs rather than guessing', async () => {
    const { provider } = yue2({ stream: sse([STARTS, completed([MP3_FILE]), CLOSE]) })
    const error = await failure(provider.generate(REQUEST, { ticket: press() }))
    expect((error as Yue2Error).code).toBe('bad-result')
    expect((error as Yue2Error).generationStarted).toBe(true)
  })
})

/* ------------------------------------------------ 12-14 failure reporting -- */

describe('a failure says what actually happened', () => {
  it('an HTTP refusal keeps the status and the Space body', async () => {
    const { provider } = yue2({ join: json({ detail: 'the queue is closed' }, 503) })
    const error = await failure(provider.generate(REQUEST, { ticket: press() }))
    const described = describeFailure(error)
    expect(described.details.httpStatus).toBe(503)
    expect(String(described.details.spaceResponse)).toContain('queue is closed')
  })

  it('a quota refusal is not called a generation failure', async () => {
    // ZeroGPU raises this before the decorated function runs. Reporting it as
    // "YuE2 generation failed" would describe something that never started.
    const { provider } = yue2({
      stream: sse([failed('ZeroGPU quota exceeded', '194s requested vs. 109s left'), CLOSE]),
    })
    const error = await failure(provider.generate(REQUEST, { ticket: press() }))
    expect(error).toBeInstanceOf(QuotaExceededError)
    expect(error).not.toBeInstanceOf(Yue2Error)
    expect(describeFailure(error).code).toBe('QUOTA_EXCEEDED')
  })

  it('and carries the allowance the refusal stated, without inventing any', async () => {
    const { provider } = yue2({
      stream: sse([failed('ZeroGPU quota exceeded', '194s requested vs. 109s left'), CLOSE]),
    })
    const error = await failure(provider.generate(REQUEST, { ticket: press() })) as QuotaExceededError
    // Read from the refusal's own words. Nothing in the adapter knows these.
    expect(error.quota?.remainingSeconds).toBe(109)
    expect(error.quota?.requestedSeconds).toBe(194)
  })

  it('a quota refusal records that nothing was generated', async () => {
    const { server, provider } = yue2({
      stream: sse([failed('ZeroGPU quota exceeded', '60s requested vs. 5s left'), CLOSE]),
    })
    await failure(provider.generate(REQUEST, { ticket: press() }))
    // One POST was made and refused. Nothing was generated and nothing retried.
    expect(server.joins()).toBe(1)
    expect(server.downloads()).toBe(0)
  })

  it('a handler failure after the job started is a generation failure', async () => {
    const { provider } = yue2({
      stream: sse([STARTS, failed('RuntimeError', 'CUDA out of memory'), CLOSE]),
    })
    const error = await failure(provider.generate(REQUEST, { ticket: press() })) as Yue2Error
    expect(error.code).toBe('generation-failed')
    expect(error.generationStarted).toBe(true)
    expect(error.message).toContain('CUDA out of memory')
  })

  it('a lost connection is ambiguous, never a silent second attempt', async () => {
    const { server, provider } = yue2({ stream: sse([STARTS]), hang: true },
      { heartbeatTimeoutMs: 40 })
    const error = await failure(provider.generate(REQUEST, { ticket: press() })) as Yue2Error
    expect(error.code).toBe('ambiguous-outcome')
    expect(error.generationStarted).toBe(true)
    expect(error.message).toContain('Nothing is sent again')
    expect(server.joins()).toBe(1)
  })

  it('every failure keeps whether generation had started', async () => {
    const before = await failure(
      yue2({ join: json({ detail: 'nope' }, 500) }).provider
        .generate(REQUEST, { ticket: press() })) as Yue2Error
    expect(before.generationStarted).toBe(false)
    expect(describeFailure(before).details.generationStarted).toBe(false)
  })
})

/* ------------------------------------------------------- capacity, status -- */

describe('capacity is never claimed, only reported', () => {
  it('is unknown before a request, because ZeroGPU publishes no way to read it', async () => {
    const capacity = await new Yue2Provider().capacity()
    expect(capacity.state).toBe('unknown')
    expect(capacity.reason).toBeTruthy()
    expect(capacity.remainingSeconds).toBeUndefined()
  })

  it('reports the Space as reachable only when it answers with the endpoint', async () => {
    const { provider } = yue2()
    expect(await provider.isAvailable()).toBe(true)
  })

  it('and says why when it does not', async () => {
    const { provider } = yue2({ config: json({ detail: 'sleeping' }, 503) })
    const status = await provider.status()
    expect(status.connected).toBe(false)
    expect(status.detail).toContain('503')
  })

  it('a Space missing the endpoint is unavailable, and names the endpoint', async () => {
    const { provider } = yue2({
      config: json({ version: '6.2.0', protocol: 'sse_v3', api_prefix: '/gradio_api',
        root: YUE2_SPACE_URL, dependencies: [{ id: 0, api_name: 'something_else' }] }),
    })
    const status = await provider.status()
    expect(status.connected).toBe(false)
    expect(status.detail).toContain(YUE2_API_NAME)
  })
})

/* --------------------------------------------------- 16 dependency weight -- */

describe('Auralyn stays a client', () => {
  it('the adapter imports no model, no runtime and no heavy dependency', async () => {
    const source = await import('node:fs').then((fs) =>
      fs.readFileSync('src/engine/providers/yue2Provider.ts', 'utf8'))
    const imports = [...source.matchAll(/from '([^']+)'/g)].map((match) => match[1]!)
    // Everything it needs is either relative or already in the project.
    expect(imports.every((name) => name.startsWith('./') || name.startsWith('../'))).toBe(true)
    for (const heavy of ['torch', 'transformers', 'onnxruntime', '@gradio/client',
      'gradio', 'huggingface', '@huggingface/hub', 'torchaudio']) {
      expect(source).not.toContain(`'${heavy}`)
    }
  })

  it('no YuE2 or ML package was added to package.json', async () => {
    const pkg = await import('node:fs').then((fs) =>
      JSON.parse(fs.readFileSync('package.json', 'utf8')) as {
        dependencies?: Record<string, string>; devDependencies?: Record<string, string>
      })
    const names = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })
    for (const heavy of ['@gradio/client', 'onnxruntime-web', '@huggingface/hub',
      '@huggingface/inference', '@xenova/transformers']) {
      expect(names).not.toContain(heavy)
    }
  })
})
