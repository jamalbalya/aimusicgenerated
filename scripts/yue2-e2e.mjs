/**
 * One real Provider B generation, against the live YuE2 Space.
 *
 * Run this from a machine that can reach https://jamalbalya-auralyn-yue2.hf.space.
 * It is NOT part of the test suite and CI never runs it: a real generation costs
 * GPU seconds out of somebody's ZeroGPU allowance, and that must be a decision
 * a person makes on purpose.
 *
 *   node scripts/yue2-e2e.mjs                 # preflight only, no generation
 *   node scripts/yue2-e2e.mjs --generate      # preflight, then ONE generation
 *
 * What it exercises is the shipped code: `Yue2Provider`, `GradioClient`, the
 * request ticket and the lyric plan, all loaded from `src/` through Vite. There
 * is no second HTTP client and no second provider here — a harness that
 * reimplemented the transport would prove the harness works, not the adapter.
 *
 * It never retries. One generation POST, or none.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createServer } from 'vite'

const GENERATE = process.argv.includes('--generate')
const OUT = resolve(process.cwd(), 'yue2-e2e-out')

/* The test request, verbatim. The lyrics carry [End]; Auralyn's own lyric plan
 * is what removes it, and this harness checks that it did rather than doing it. */
const STYLE = 'Emotional pop ballad, male vocal, warm piano, gentle strings, '
  + 'intimate and melancholic, modern clean production.'

const LYRICS = `[Verse]
Aku berjalan sendiri
Mencari arti hari ini

[Chorus]
Masih kuingat namamu
Masih kurasakan rindu

[End]
`

const line = (k, v) => console.log(`  ${String(k).padEnd(26)}${v}`)
const head = (t) => console.log(`\n=== ${t} ===`)
const fail = (why) => { console.error(`\nSTOPPED: ${why}`); process.exitCode = 1 }

/* ---------------------------------------------------------------- audio --- */

/** FLAC STREAMINFO: exact sample rate, channels and sample count. */
function readFlac(bytes) {
  if (String.fromCharCode(...bytes.slice(0, 4)) !== 'fLaC') return null
  // STREAMINFO is always the first metadata block; its body starts at byte 8.
  const b = bytes.subarray(8)
  if (b.length < 18) return null
  const sampleRate = (b[10] << 12) | (b[11] << 4) | (b[12] >> 4)
  const channels = ((b[12] >> 1) & 0x07) + 1
  const bitsPerSample = (((b[12] & 0x01) << 4) | (b[13] >> 4)) + 1
  // 36-bit total sample count. The high 4 bits live in b[13].
  const totalSamples = ((b[13] & 0x0f) * 2 ** 32)
    + ((b[14] << 24) >>> 0) + (b[15] << 16) + (b[16] << 8) + b[17]
  return {
    codec: 'flac', sampleRate, channels, bitsPerSample,
    totalSamples, durationSeconds: sampleRate ? totalSamples / sampleRate : null,
    durationExact: true,
  }
}

const MPEG_RATES = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] }
const V1L3_BITRATES = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0]

/** The first MPEG audio frame header: sample rate, channels, bitrate. */
function readMp3(bytes) {
  let at = 0
  if (String.fromCharCode(...bytes.slice(0, 3)) === 'ID3') {
    // Syncsafe size, then skip the tag to reach the first frame.
    at = 10 + ((bytes[6] << 21) | (bytes[7] << 14) | (bytes[8] << 7) | bytes[9])
  }
  for (let i = at; i < Math.min(bytes.length - 4, at + 200_000); i++) {
    if (bytes[i] !== 0xff || (bytes[i + 1] & 0xe0) !== 0xe0) continue
    const versionBits = (bytes[i + 1] >> 3) & 0x03
    const rates = MPEG_RATES[versionBits]
    if (!rates) continue
    const sampleRate = rates[(bytes[i + 2] >> 2) & 0x03]
    if (!sampleRate) continue
    const bitrate = V1L3_BITRATES[(bytes[i + 2] >> 4) & 0x0f]
    const channels = ((bytes[i + 3] >> 6) & 0x03) === 3 ? 1 : 2
    return {
      codec: 'mp3', sampleRate, channels, bitrateKbps: bitrate || null,
      // From size and bitrate, so it is right for constant-bitrate audio and
      // approximate otherwise. Marked, never presented as measured.
      durationSeconds: bitrate ? (bytes.length * 8) / (bitrate * 1000) : null,
      durationExact: false,
    }
  }
  return null
}

const describeAudio = (bytes) => readFlac(bytes) ?? readMp3(bytes) ?? { codec: 'unrecognised' }

/* ----------------------------------------------------------------- main --- */

const vite = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' })
try {
  const { Yue2Provider, planYue2Request, YUE2_API_NAME, YUE2_API_ROUTE, YUE2_SPACE,
    YUE2_CONTRACT_VERIFIED, yue2SpaceUrl, describeFailure } =
    await vite.ssrLoadModule('/src/engine/providers/index.ts')
  const { planLiveGeneration } = await vite.ssrLoadModule('/src/engine/live/plan.ts')
  const { mintRequestTicket } = await vite.ssrLoadModule('/src/engine/live/requestGuard.ts')

  head('contract this harness is testing')
  line('space', YUE2_SPACE)
  line('host', yue2SpaceUrl())
  line('api name', YUE2_API_NAME)
  line('documented route', YUE2_API_ROUTE)
  line('YUE2_CONTRACT_VERIFIED', String(YUE2_CONTRACT_VERIFIED))

  /* -- the provider-ready lyrics come from Auralyn's own plan, not from here -- */
  head('request, built by Auralyn')
  const plan = planLiveGeneration({
    style: STYLE, lyrics: LYRICS, instrumental: false,
    vocalGender: 'male', language: 'auto',
  })
  const providerLyrics = plan.lyrics.text
  const request = { style: STYLE, lyrics: providerLyrics, language: 'id', vocalGender: 'male' }

  const checks = []
  const check = (name, ok, detail = '') => {
    checks.push({ name, ok })
    console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
  }

  const planned = planYue2Request(request)
  check('style is byte-for-byte what was supplied', planned.style === STYLE,
    `${planned.style.length} chars`)
  check('[End] is absent from the provider lyrics', !/\[end\]/i.test(planned.lyrics))
  check('nothing after [End] survives',
    !planned.lyrics.includes('[End]') && planned.lyrics.trim().endsWith('Masih kurasakan rindu'))
  check('exactly two arguments, style then lyrics', planned.data.length === 2
    && planned.data[0] === STYLE && planned.data[1] === providerLyrics)

  if (checks.some((c) => !c.ok)) {
    fail('the request does not match the contract; nothing was sent.')
    process.exit(1)
  }
  console.log('\n  --- provider lyrics as they will be sent ---')
  console.log(providerLyrics.split('\n').map((l) => `  | ${l}`).join('\n'))

  /* ------------------------------ preflight ------------------------------ */
  // Every request is recorded so the report can state the real URLs and prove
  // how many generation POSTs were made.
  const calls = []
  const fetchImpl = async (input, init) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    const started = Date.now()
    try {
      const response = await fetch(input, init)
      calls.push({ method, url, status: response.status, ms: Date.now() - started })
      return response
    } catch (error) {
      calls.push({ method, url, status: 'network-error', ms: Date.now() - started })
      throw error
    }
  }

  const blobs = new Map()
  const provider = new Yue2Provider({
    // The live-generation gate is off by default and is turned on HERE, in the
    // harness, and nowhere else. Nothing about the quota is touched.
    config: { liveGeneration: true },
    fetchImpl,
    toObjectUrl: (blob) => {
      const key = `mem:${blobs.size}`
      blobs.set(key, blob)
      return key
    },
  })

  head('preflight')
  const status = await provider.status()
  line('connected', String(status.connected))
  if (status.detail) line('detail', status.detail)
  if (status.blockedReason) line('blockedReason', status.blockedReason)
  const capacity = await provider.capacity()
  line('capacity.state', capacity.state)
  line('capacity.reason', capacity.reason)

  if (!status.connected) {
    fail(`the Space did not answer with the "${YUE2_API_NAME}" endpoint. `
      + 'No generation was attempted and no quota was used.')
    process.exit(1)
  }

  if (!GENERATE) {
    head('result')
    console.log('  Preflight only. Re-run with --generate to spend ONE generation.')
    console.log(`  Requests made so far: ${calls.length} (none of them a generation).`)
    for (const c of calls) console.log(`    ${c.method} ${c.status} ${c.url}`)
    process.exit(0)
  }

  /* ------------------------- exactly one generation ---------------------- */
  head('generating — ONE request, no retry')
  mkdirSync(OUT, { recursive: true })
  const ticket = mintRequestTicket()
  let result
  let failureReport
  const t0 = Date.now()
  try {
    result = await provider.generate(request, {
      ticket,
      onStatus: (s) => console.log(`  [${s.state}] ${s.detail ?? ''}`.trimEnd()),
    })
  } catch (error) {
    failureReport = describeFailure(error)
  }
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1)

  head('every HTTP call this run made')
  for (const c of calls) console.log(`  ${c.method.padEnd(5)} ${String(c.status).padEnd(14)} ${c.ms}ms  ${c.url}`)
  const generationPosts = calls.filter((c) =>
    c.method === 'POST' && (c.url.includes('/queue/join') || c.url.includes('/call/')))
  line('generation POSTs', String(generationPosts.length))

  if (failureReport) {
    head('FAILED — nothing retried')
    line('stage', failureReport.stage)
    line('code', failureReport.code)
    line('message', failureReport.message)
    for (const [k, v] of Object.entries(failureReport.details)) line(`detail.${k}`, String(v))
    line('retryable', String(failureReport.retryable))
    console.log('\n  This harness does not send a second request, whatever the reason.')
    fail(`generation did not complete (${failureReport.code}).`)
    process.exit(1)
  }

  /* --------------------------------- result ------------------------------ */
  head('result')
  line('elapsed', `${elapsed}s`)
  line('engine', result.engine)
  line('providerRequestId', result.providerRequestId ?? '(none)')
  line('ticketId', result.ticketId ?? '(none)')

  const saved = []
  const write = async (key, format) => {
    const blob = blobs.get(key)
    if (!blob) return null
    const bytes = new Uint8Array(await blob.arrayBuffer())
    const path = resolve(OUT, `yue2-e2e.${format}`)
    writeFileSync(path, bytes)
    const meta = describeAudio(bytes)
    saved.push({ format, path, bytes: bytes.length, ...meta })
    return meta
  }
  await write(result.audioUrl, 'mp3')
  for (const alt of result.alternateFormats ?? []) await write(alt.url, alt.format)

  head('files')
  for (const f of saved) {
    console.log(`  ${f.format.toUpperCase()}`)
    line('  path', f.path)
    line('  bytes', f.bytes.toLocaleString())
    line('  codec', f.codec)
    if (f.sampleRate) line('  sampleRate', `${f.sampleRate} Hz`)
    if (f.channels) line('  channels', String(f.channels))
    if (f.bitsPerSample) line('  bitsPerSample', String(f.bitsPerSample))
    if (f.bitrateKbps) line('  bitrate', `${f.bitrateKbps} kbps`)
    if (f.durationSeconds) {
      line('  duration', `${f.durationSeconds.toFixed(2)}s`
        + (f.durationExact ? ' (exact, from STREAMINFO)' : ' (estimated from bitrate)'))
    }
  }

  head('verdict')
  const v = []
  const verdict = (name, ok, detail = '') => {
    v.push(ok)
    console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
  }
  verdict('exactly one generation POST', generationPosts.length === 1,
    String(generationPosts.length))
  verdict('engine is yue2', result.engine === 'yue2', result.engine)
  verdict('providerRequestId carries the event id', Boolean(result.providerRequestId))
  verdict('MP3 received and non-empty', Boolean(saved.find((f) => f.format === 'mp3')?.bytes))
  verdict('FLAC received and non-empty', Boolean(saved.find((f) => f.format === 'flac')?.bytes))
  verdict('MP3 is recognised as audio', saved.find((f) => f.format === 'mp3')?.codec === 'mp3')
  verdict('FLAC is recognised as audio', saved.find((f) => f.format === 'flac')?.codec === 'flac')
  verdict('[End] was not sent', !/\[end\]/i.test(planned.lyrics))
  verdict('style was byte-exact', planned.style === STYLE)

  const pass = v.every(Boolean)
  console.log(`\n${pass ? 'LIVE E2E PASS — PROVIDER B TRANSPORT VERIFIED' : 'LIVE E2E FAIL'}`)
  console.log('This is transport only. It says the bytes arrived, not that the song is good.')
  if (!pass) process.exitCode = 1
} finally {
  await vite.close()
}
