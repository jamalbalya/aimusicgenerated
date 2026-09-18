/**
 * The switch that stops a build spending someone else's GPU allowance.
 *
 * A real generation costs ZeroGPU seconds out of an allowance belonging to
 * whoever deployed the Space, which resets on Hugging Face's schedule and
 * cannot be refunded. So the question these tests answer is not "does the flag
 * parse" but "can a build that was not told it may generate reach the network
 * anyway" — and the answer has to be no by construction, not by convention.
 */

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  ZeroGpuProvider, LIVE_GENERATION_DISABLED, parseLiveGeneration, parseZeroGpuConfig,
} from '../../src/engine/providers'
import { TEST_CONFIG } from './helpers/fakeSpace'
import { NEURAL_SETTINGS } from '../../vite.config'
import { press } from './helpers/press'

const BOS_TOXIC = { style: 'Dangdut koplo sarkastik', lyrics: '[Verse]\nHei kawan' }

describe('a build is not allowed to generate unless it was told it may', () => {
  it('sends nothing at all when the switch is off', async () => {
    const reached: string[] = []
    const provider = new ZeroGpuProvider({
      config: { ...TEST_CONFIG, liveGeneration: false },
      fetchImpl: ((input: RequestInfo | URL) => {
        reached.push(String(input))
        return Promise.reject(new Error('this should be unreachable'))
      }) as typeof fetch,
    })

    await expect(provider.generate(BOS_TOXIC, { ticket: press() })).rejects.toThrow(/switched off/i)
    // Not "a request that failed" — no request. That is the difference between
    // a switch and a hope.
    expect(reached).toEqual([])
  })

  it('refuses before the request is even planned, so a bad request cannot mask it', async () => {
    // A style over the 512-character limit would normally be refused by the
    // planner. The switch has to come first, or a build with it off would
    // report a length problem and leave someone believing generation was tried.
    const provider = new ZeroGpuProvider({ config: { ...TEST_CONFIG, liveGeneration: false } })
    await expect(provider.generate({ style: 'x'.repeat(900), lyrics: 'hello' }, { ticket: press() }))
      .rejects.toThrow(/switched off/i)
  })

  it('says nothing was spent, and how to turn it on', () => {
    expect(LIVE_GENERATION_DISABLED).toMatch(/no GPU time was spent/i)
    expect(LIVE_GENERATION_DISABLED).toMatch(/ACE_STEP_LIVE_GENERATION_ENABLED=true/)
    // It must not read like a backend that is down: the remedies are nothing
    // alike, and a person who reads "unavailable" goes and restarts a Space.
    expect(LIVE_GENERATION_DISABLED).toMatch(/switched off in this build/i)
  })

  it('defaults to off, which is what an unset variable has to mean', () => {
    const read = (env: Record<string, string>) => (key: string) => env[key]
    expect(parseZeroGpuConfig(read({
      VITE_ACE_STEP_SPACE_URL: 'https://owner-space.hf.space',
    }), 'https:').liveGeneration).toBe(false)
    expect(parseLiveGeneration(undefined)).toBe(false)
  })

  it('generates normally once a build turns it on', async () => {
    // The switch gates the request and nothing else: with it on, the provider
    // behaves exactly as the rest of the suite already proves it does. Shown
    // here by getting past the switch and failing on the fixture instead.
    const provider = new ZeroGpuProvider({
      config: { ...TEST_CONFIG, liveGeneration: true },
      fetchImpl: (() => Promise.reject(new TypeError('Failed to fetch'))) as typeof fetch,
    })
    await expect(provider.generate(BOS_TOXIC, { ticket: press() })).rejects.not.toThrow(/switched off/i)
  })
})

describe('the switch is wired into the builds that matter', () => {
  it('is carried into the browser bundle', () => {
    expect([...NEURAL_SETTINGS]).toContain('LIVE_GENERATION_ENABLED')
  })

  it('is on for the deployed site', () => {
    const deploy = readFileSync(new URL('../../.github/workflows/deploy.yml', import.meta.url), 'utf8')
    expect(deploy).toMatch(/ACE_STEP_LIVE_GENERATION_ENABLED:.*'true'/)
  })

  it('is on for the end-to-end build, which answers every request itself', () => {
    // CI points at a fake Space the suite serves. Nothing there reaches Hugging
    // Face, so the switch is on to exercise the provider rather than the refusal.
    const ci = readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8')
    expect(ci).toMatch(/ACE_STEP_LIVE_GENERATION_ENABLED: 'true'/)
    expect(ci).toMatch(/fake-space\.hf\.space/)
  })

  it('is documented where someone configuring a build will look', () => {
    const example = readFileSync(new URL('../../.env.example', import.meta.url), 'utf8')
    expect(example).toMatch(/ACE_STEP_LIVE_GENERATION_ENABLED=false/)
  })
})
