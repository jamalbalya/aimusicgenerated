/**
 * Where the neural backend lives.
 *
 * Read once, from configuration rather than from anything that generates
 * music. A build for a public site points at a hosted backend; a developer
 * running ACE-Step on their own machine points at localhost; a build with
 * neither is simply a studio with one engine, which still works.
 *
 * A setting that is present but wrong is never quietly replaced by a default.
 * It becomes a stated reason the neural engine cannot be used, shown where the
 * connection status is shown, so the person who configured the build finds out
 * from the page rather than from a song made with something they did not ask for.
 */

import { ACE_STEP_DURATION_RANGE } from './aceStepRequest'
import type { NeuralBackend } from './types'

/** Reads one setting; `undefined` when it is unset or blank. */
export type EnvReader = (key: string) => string | undefined

/** Vite replaces these at build time; absent in Node, hence the guards. */
function fromEnv(key: string): string | undefined {
  const env = (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env
  const value = env?.[key]
  return value && value.trim() ? value.trim() : undefined
}

function pageProtocol(): string {
  return typeof window !== 'undefined' ? window.location.protocol : 'http:'
}

export interface NeuralEngineConfig {
  /** Base URL of the ACE-Step API, without a trailing slash. */
  baseUrl: string
  apiKey?: string
  /** DiT checkpoint to ask for, when the build pins one. */
  model?: string
  /** 5 Hz language model to ask for, when the build pins one. */
  lmModel?: string
  /**
   * Set when the browser will refuse to reach this backend whatever it does,
   * so the studio can say why instead of probing an address it cannot use.
   */
  blockedReason?: string
}

/**
 * A page served over HTTPS cannot call an http:// backend — browsers block it
 * as mixed content before the request leaves. Probing anyway achieves nothing
 * except a console error on every page load of the deployed site, so detect it
 * and report the real reason instead.
 */
export function mixedContentReason(pageProtocol: string, baseUrl: string): string | undefined {
  if (pageProtocol !== 'https:') return undefined
  if (!/^http:\/\//i.test(baseUrl)) return undefined
  return 'This page is served over HTTPS, so the browser will not connect to an http:// backend. '
    + 'Serve ACE-Step over HTTPS, or run the studio locally.'
}

/** The address ACE-Step's own `run_api_server.sh` binds by default. */
export const DEFAULT_ACE_STEP_URL = 'http://127.0.0.1:8001'

export function neuralEngineConfig(): NeuralEngineConfig {
  const configured = (fromEnv('VITE_ACE_STEP_API_URL') ?? DEFAULT_ACE_STEP_URL).replace(/\/+$/, '')
  const apiKey = fromEnv('VITE_ACE_STEP_API_KEY')
  const blockedReason = mixedContentReason(pageProtocol(), configured)
  const model = fromEnv('VITE_ACE_STEP_MODEL')
  const lmModel = fromEnv('VITE_ACE_STEP_LM_MODEL')
  return {
    baseUrl: configured,
    ...(apiKey ? { apiKey } : {}),
    ...(model ? { model } : {}),
    ...(lmModel ? { lmModel } : {}),
    ...(blockedReason ? { blockedReason } : {}),
  }
}

/* ------------------------------------------------------- which backend --- */

export interface NeuralBackendChoice {
  backend: NeuralBackend
  /** Set when `ACE_STEP_BACKEND` holds something that names neither backend. */
  problem?: string
}

/**
 * Reads `ACE_STEP_BACKEND`. Unset means `local`, which is what every build
 * before the hosted backend existed did, so nothing changes for anyone who has
 * not asked for the change.
 */
export function parseNeuralBackend(value: string | undefined): NeuralBackendChoice {
  const normalised = value?.trim().toLowerCase()
  if (!normalised || normalised === 'local') return { backend: 'local' }
  if (normalised === 'zerogpu') return { backend: 'zerogpu' }
  return {
    backend: 'local',
    problem: `ACE_STEP_BACKEND is "${value}". It must be "local" or "zerogpu".`,
  }
}

export function neuralBackendChoice(): NeuralBackendChoice {
  return parseNeuralBackend(fromEnv('VITE_ACE_STEP_BACKEND'))
}

/* ------------------------------------------------- the ZeroGPU Space --- */

/**
 * The song length verified end to end on the live ZeroGPU Space: one request,
 * one complete 271-second WAV, checked, on 2026-09-11.
 *
 * A fact about a test run, not a limit. Nothing enforces it — longer requests
 * are sent as asked, and `ACE_STEP_SPACE_MAX_DURATION` is the only ceiling —
 * but the studio does not present a longer song as verified, because it is not.
 */
export const VERIFIED_ZEROGPU_DURATION = 271

/*
 * There is deliberately no default Auto length here — see `ACE_STEP_AUTO_DURATION`.
 *
 * A fixed one was measured cutting a song off mid-phrase: the length was a
 * constant left over from one unrelated test run, and ACE-Step treats a stated
 * length as a hard budget rather than a target. Auto now sends no length and
 * the model picks one from the lyric sheet. A deployer who still wants a fixed
 * length can pin one with `ACE_STEP_SPACE_AUTO_DURATION`.
 */

/**
 * How long one generation may take from submission to a finished file.
 *
 * Generous on purpose. The validated song took about 45 seconds of GPU, but a
 * Space that has gone to sleep loads roughly 11 GB of checkpoints before it
 * answers, and a busy GPU queue adds its own wait. This is the outer bound; a
 * dead connection is caught much sooner by the heartbeat check.
 */
export const DEFAULT_ZEROGPU_TIMEOUT_SECONDS = 900

export interface ZeroGpuConfig {
  /** The Space's own host, e.g. `https://<owner>-<space>.hf.space`. Empty when unset. */
  spaceUrl: string
  /**
   * Seconds a request with no duration is given. Undefined — the default —
   * means ACE-Step chooses the length from the lyrics, which is what Auto is.
   */
  autoDuration?: number
  /**
   * Requests longer than this are refused before anything is sent. Undefined
   * when no ceiling has been configured — which is not a claim that any length
   * will fit the Space's GPU budget, only that nobody has set one.
   */
  maxDuration?: number
  /** The outer bound on one generation, queue and cold start included. */
  jobTimeoutMs: number
  /** Models the build expects the Space to run; checked against what it reports. */
  model?: string
  lmModel?: string
  /** Why this backend cannot be used as configured, when it cannot. */
  blockedReason?: string
}

/** A whole number of seconds, or the reason it is not one. */
function seconds(
  read: EnvReader, key: string, fallback: number, range: { min: number; max: number },
): { value: number; problem?: string } {
  const raw = read(key)
  if (raw === undefined) return { value: fallback }
  const value = Number(raw)
  if (!Number.isInteger(value) || value < range.min || value > range.max) {
    return {
      value: fallback,
      problem: `${key.replace(/^VITE_/, '')} is "${raw}". It must be a whole number of seconds `
        + `from ${range.min} to ${range.max}.`,
    }
  }
  return { value }
}

/**
 * Checks that a Space address is one a browser can call.
 *
 * The API lives on the Space's own host. The huggingface.co page for a Space is
 * a different site that embeds it, and calling that returns HTML, so it is
 * refused with the address that would work rather than probed and misread.
 */
export function spaceUrlProblem(raw: string | undefined, protocol: string): string | undefined {
  if (!raw) {
    return 'ACE_STEP_BACKEND is zerogpu, but ACE_STEP_SPACE_URL is not set. '
      + 'Set it to the Space\'s own host, e.g. https://<owner>-<space>.hf.space.'
  }
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return `ACE_STEP_SPACE_URL is "${raw}", which is not a URL.`
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return `ACE_STEP_SPACE_URL must be an http(s) address, not ${url.protocol}.`
  }
  if (url.hostname === 'huggingface.co' || url.hostname.endsWith('.huggingface.co')) {
    return 'ACE_STEP_SPACE_URL points at the Space\'s page on huggingface.co. The API lives on '
      + 'the Space\'s own host instead: https://<owner>-<space>.hf.space.'
  }
  if (url.pathname !== '/' || url.search || url.hash) {
    return `ACE_STEP_SPACE_URL must be just the Space's host, with no path: ${url.origin}.`
  }
  return mixedContentReason(protocol, url.origin)
}

/** Every ZeroGPU setting, validated. Pure, so it can be tested without a build. */
export function parseZeroGpuConfig(read: EnvReader, protocol: string): ZeroGpuConfig {
  const rawUrl = read('VITE_ACE_STEP_SPACE_URL')
  const problems: string[] = []

  const urlProblem = spaceUrlProblem(rawUrl, protocol)
  if (urlProblem) problems.push(urlProblem)
  const spaceUrl = !urlProblem && rawUrl ? new URL(rawUrl).origin : (rawUrl ?? '').replace(/\/+$/, '')

  // Only when a deployer pins one. Absent is Auto, and Auto is ACE-Step's job.
  const auto = read('VITE_ACE_STEP_SPACE_AUTO_DURATION') !== undefined
    ? seconds(read, 'VITE_ACE_STEP_SPACE_AUTO_DURATION', ACE_STEP_DURATION_RANGE.max, ACE_STEP_DURATION_RANGE)
    : undefined
  if (auto?.problem) problems.push(auto.problem)

  let maxDuration: number | undefined
  if (read('VITE_ACE_STEP_SPACE_MAX_DURATION') !== undefined) {
    const max = seconds(read, 'VITE_ACE_STEP_SPACE_MAX_DURATION', ACE_STEP_DURATION_RANGE.max, ACE_STEP_DURATION_RANGE)
    if (max.problem) problems.push(max.problem)
    else maxDuration = max.value
  }
  if (maxDuration !== undefined && auto && !auto.problem && auto.value > maxDuration) {
    problems.push(
      `ACE_STEP_SPACE_AUTO_DURATION (${auto.value}) is longer than ACE_STEP_SPACE_MAX_DURATION `
      + `(${maxDuration}), so every Auto-length request would be refused.`)
  }

  const timeout = seconds(read, 'VITE_ACE_STEP_SPACE_TIMEOUT_SECONDS', DEFAULT_ZEROGPU_TIMEOUT_SECONDS,
    { min: 60, max: 3600 })
  if (timeout.problem) problems.push(timeout.problem)

  const model = read('VITE_ACE_STEP_MODEL')
  const lmModel = read('VITE_ACE_STEP_LM_MODEL')
  return {
    spaceUrl,
    ...(auto && !auto.problem ? { autoDuration: auto.value } : {}),
    ...(maxDuration !== undefined ? { maxDuration } : {}),
    jobTimeoutMs: timeout.value * 1000,
    ...(model ? { model } : {}),
    ...(lmModel ? { lmModel } : {}),
    ...(problems.length > 0 ? { blockedReason: problems.join(' ') } : {}),
  }
}

export function zeroGpuConfig(): ZeroGpuConfig {
  return parseZeroGpuConfig(fromEnv, pageProtocol())
}
