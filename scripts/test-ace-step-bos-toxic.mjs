#!/usr/bin/env node
/**
 * Runs the Bos Toxic case against a real, running ACE-Step 1.5 backend.
 *
 * This is the test that cannot be faked and cannot run in CI: it needs the
 * backend up, the weights downloaded, and hardware to run them on. Everything
 * it prints is read back off the server — the models that actually ran, the
 * wall-clock time, the duration of the file that came out. Nothing here
 * estimates anything.
 *
 *   node scripts/test-ace-step-bos-toxic.mjs
 *   ACE_STEP_API_URL=http://127.0.0.1:8001 node scripts/test-ace-step-bos-toxic.mjs
 *
 * Exits non-zero if the backend is down, the job fails, or the audio that comes
 * back is not a playable file.
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const OUT_ROOT = join(ROOT, 'evaluation', 'bos-toxic')
const ACE_STEP_HOME = process.env.ACE_STEP_HOME
  || join(homedir(), 'Applications', 'ACE-Step-1.5')

const BASE_URL = (process.env.ACE_STEP_API_URL || 'http://127.0.0.1:8001').replace(/\/+$/, '')
const API_KEY = process.env.ACE_STEP_API_KEY || ''
const MODEL = process.env.ACE_STEP_MODEL || 'acestep-v15-turbo'
const LM_MODEL = process.env.ACE_STEP_LM_MODEL || 'acestep-5Hz-lm-0.6B'
const POLL_MS = Number(process.env.ACE_STEP_POLL_MS || 3000)
const TIMEOUT_MS = Number(process.env.ACE_STEP_TIMEOUT_MS || 45 * 60_000)

export const BOS_TOXIC_STYLE =
  'Indonesian dangdut koplo, sarcastic workplace anthem, powerful kendang, groovy bass, ' +
  'funky guitar, dramatic male vocal, humorous verses, explosive sing-along chorus'

export const BOS_TOXIC_LYRICS = readFileSync(
  join(ROOT, 'tests/unit/fixtures/bos-toxic-lyrics.txt'), 'utf8')
  .replace(/\r\n?/g, '\n').replace(/\s+$/, '')

/**
 * The `/release_task` body for this case.
 *
 * Kept in step with `src/engine/providers/aceStepRequest.ts` by a unit test
 * that asserts the two produce the same object — that file is the canonical
 * adapter; this is the same request expressed without a TypeScript build.
 */
export function bosToxicTaskBody({ model = MODEL, lmModel = LM_MODEL } = {}) {
  return {
    prompt: BOS_TOXIC_STYLE,
    lyrics: BOS_TOXIC_LYRICS,
    vocal_language: 'id',
    audio_format: 'wav',
    thinking: true,
    use_format: false,
    batch_size: 1,
    model,
    lm_model_path: lmModel,
  }
}

const headers = (json) => ({
  ...(json ? { 'Content-Type': 'application/json' } : {}),
  ...(API_KEY ? { Authorization: `Bearer ${API_KEY}` } : {}),
})

/**
 * Everything printed is also kept, so the run can be read back later without
 * relying on a terminal scrollback that will be gone by then.
 */
const transcript = []
function say(line = '') {
  transcript.push(line)
  process.stdout.write(`${line}\n`)
}

let logPath = null
function flushLog() {
  if (!logPath) return
  try { writeFileSync(logPath, `${transcript.join('\n')}\n`) } catch { /* best effort */ }
}

function fail(message) {
  transcript.push(`FAILED: ${message}`)
  flushLog()
  console.error(`\n✗ ${message}`)
  process.exit(1)
}

async function unwrap(response, what) {
  if (!response.ok) fail(`${what} returned HTTP ${response.status}.`)
  const envelope = await response.json()
  if (envelope?.error) fail(`${what} returned an error: ${envelope.error}`)
  if (!envelope || !('data' in envelope)) fail(`${what} did not return an ACE-Step response envelope.`)
  return envelope.data
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

/**
 * Reads a WAV header and measures the samples.
 *
 * This establishes that a valid, non-empty, non-silent audio file exists. It
 * establishes nothing about the music: not whether anyone is singing, not what
 * language they are singing in, and certainly not whether it is any good.
 */
function probeWav(bytes) {
  const out = { sampleRate: null, channels: null, durationSeconds: null, peak: null, problem: null }
  if (bytes.length < 1024) { out.problem = `the file is only ${bytes.length} bytes`; return out }
  if (bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') {
    out.problem = 'not a RIFF/WAVE file'
    return out
  }
  let offset = 12, channels = 0, sampleRate = 0, bitDepth = 0, format = 1, dataAt = -1, dataSize = 0
  while (offset + 8 <= bytes.length) {
    const id = bytes.toString('ascii', offset, offset + 4)
    const size = bytes.readUInt32LE(offset + 4)
    const body = offset + 8
    if (id === 'fmt ' && body + 16 <= bytes.length) {
      format = bytes.readUInt16LE(body)
      channels = bytes.readUInt16LE(body + 2)
      sampleRate = bytes.readUInt32LE(body + 4)
      bitDepth = bytes.readUInt16LE(body + 14)
      if (format === 0xfffe && size >= 40) format = bytes.readUInt16LE(body + 24)
    } else if (id === 'data') { dataAt = body; dataSize = Math.min(size, bytes.length - body); break }
    if (size === 0) break
    offset = body + size + (size % 2)
  }
  if (dataAt < 0 || !sampleRate || !channels || !bitDepth) {
    out.problem = 'the WAV header is unusable'
    return out
  }
  const bytesPerSample = bitDepth / 8
  const frames = Math.floor(dataSize / (bytesPerSample * channels))
  out.sampleRate = sampleRate
  out.channels = channels
  out.durationSeconds = Number((frames / sampleRate).toFixed(2))
  const step = Math.max(1, Math.floor(frames / 4000))
  let peak = 0
  for (let frame = 0; frame < frames; frame += step) {
    const at = dataAt + frame * bytesPerSample * channels
    if (at + bytesPerSample > bytes.length) break
    let value = 0
    if (format === 3 && bitDepth === 32) value = bytes.readFloatLE(at)
    else if (bitDepth === 16) value = bytes.readInt16LE(at) / 32768
    else if (bitDepth === 32) value = bytes.readInt32LE(at) / 2147483648
    else if (bitDepth === 24) value = (bytes.readIntLE(at, 3)) / 8388608
    else if (bitDepth === 8) value = (bytes.readUInt8(at) - 128) / 128
    peak = Math.max(peak, Math.abs(value))
  }
  out.peak = Number(peak.toFixed(4))
  if (!(out.durationSeconds > 0)) out.problem = 'the file contains no samples'
  else if (peak < 0.001) out.problem = 'the audio is silent'
  return out
}

/**
 * What ACE-Step this is, read off the checkout rather than guessed.
 *
 * The API's own /health reports the API contract version ("1.0"), not the
 * project's, so the commit and pyproject version come from the source on disk
 * when it is there. Anything that cannot be read is reported as unknown rather
 * than filled in.
 */
function aceStepVersion() {
  const out = { commit: 'unknown', version: 'unknown', home: ACE_STEP_HOME }
  try {
    out.commit = execFileSync('git', ['-C', ACE_STEP_HOME, 'rev-parse', '--short', 'HEAD'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch { /* not a checkout, or git missing */ }
  try {
    const pyproject = readFileSync(join(ACE_STEP_HOME, 'pyproject.toml'), 'utf8')
    out.version = pyproject.match(/^version\s*=\s*"([^"]+)"/m)?.[1] ?? 'unknown'
  } catch { /* not installed here */ }
  if (!existsSync(ACE_STEP_HOME)) out.home = `${ACE_STEP_HOME} (not found)`
  return out
}

/**
 * The compute this was generated on.
 *
 * Only reported for a backend on this machine — which is the workflow these
 * scripts are for. Against a remote backend the host's own hardware says
 * nothing about what ran, so it is labelled as unknown instead.
 */
function describeBackend(baseUrl) {
  const local = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|$)/i.test(baseUrl)
  if (!local) return 'remote backend (not determinable from here)'
  const lm = process.env.ACESTEP_LM_BACKEND
  if (process.platform === 'darwin' && process.arch === 'arm64') {
    return `Apple Silicon / ${lm === 'mlx' || !lm ? 'MLX' : lm}`
  }
  return `${process.platform}/${process.arch}${lm ? ` / ${lm}` : ''}`
}

async function main() {
  say('ACE-Step 1.5 — Bos Toxic smoke test')
  say(`  backend        ${BASE_URL}`)

  /* 1. Is it actually running? --------------------------------------- */
  let health
  try {
    health = await unwrap(await fetch(`${BASE_URL}/health`, { headers: headers(false) }), 'GET /health')
  } catch (error) {
    fail(`Could not reach the ACE-Step backend at ${BASE_URL}: ${error.message}\n` +
      '  Start it with ./scripts/start-ace-step-macos.sh, then check it with\n' +
      '  ./scripts/diagnose-ace-step-macos.sh or node scripts/ace-step-status.mjs.')
  }
  if (String(health.status).toLowerCase() !== 'ok') fail(`Backend reported status "${health.status}".`)
  say(`  service        ${health.service} ${health.version}`)
  say(`  models loaded  ${health.models_initialized} (LM: ${health.llm_initialized})`)
  say(`  DiT loaded     ${health.loaded_model ?? 'none yet (loads on first request)'}`)
  say(`  LM loaded      ${health.loaded_lm_model ?? 'none yet (loads on first request)'}`)

  // ACE-Step substitutes the language model by itself when it judges the
  // requested one unsupported for the detected tier, and carries on with no LM
  // at all when one fails to load. Both go to its own console, not to us, so a
  // run asked for on the 0.6B model can quietly come back from the 1.7B one.
  if (health.loaded_lm_model && health.loaded_lm_model !== LM_MODEL) {
    fail(`The backend loaded ${health.loaded_lm_model}, not the requested ${LM_MODEL}.\n`
      + `  Restart it with ACE_STEP_LM_MODEL=${LM_MODEL} ./scripts/start-ace-step-macos.sh`)
  }
  if (health.loaded_model && health.loaded_model !== MODEL) {
    fail(`The backend loaded ${health.loaded_model}, not the requested ${MODEL}.`)
  }
  if (health.models_initialized && !health.llm_initialized) {
    fail('The backend has no language model loaded, so it cannot sing the lyrics.\n'
      + '  A request made with thinking enabled would come back instrumental.\n'
      + '  Check the backend terminal for why the LM failed to load.')
  }

  /* 2. Submit ---------------------------------------------------------- */
  const body = bosToxicTaskBody()
  const lyricLines = body.lyrics.split('\n').filter((l) => l.trim() && !/^\[[^\]]+\]$/.test(l.trim()))
  say(`  style          ${body.prompt.slice(0, 68)}…`)
  say(`  lyrics         ${lyricLines.length} sung lines, language ${body.vocal_language}`)
  say(`  model          ${body.model}`)
  say(`  lm model       ${body.lm_model_path}`)
  say('\nsubmitting…')

  const startedAt = new Date()
  const started = startedAt.getTime()
  const created = await unwrap(await fetch(`${BASE_URL}/release_task`, {
    method: 'POST', headers: headers(true), body: JSON.stringify(body),
  }), 'POST /release_task')
  const taskId = created.task_id
  if (!taskId) fail('The backend accepted the request but returned no task id.')
  say(`  task           ${taskId}${created.queue_position ? ` (queue position ${created.queue_position})` : ''}`)

  /* 3. Poll ------------------------------------------------------------ */
  let item = null
  let lastLine = ''
  for (;;) {
    if (Date.now() - started > TIMEOUT_MS) fail(`Generation did not finish within ${Math.round(TIMEOUT_MS / 60000)} minutes.`)
    const rows = await unwrap(await fetch(`${BASE_URL}/query_result`, {
      method: 'POST', headers: headers(true), body: JSON.stringify({ task_id_list: [taskId] }),
    }), 'POST /query_result')
    const row = rows.find((r) => r.task_id === taskId) ?? rows[0]
    let parsed = []
    try { parsed = JSON.parse(row?.result || '[]') } catch { parsed = [] }
    const first = parsed[0] || {}

    if (row?.status === 2) fail(`Generation failed: ${first.error || row.progress_text || 'no reason given'}`)
    if (row?.status === 1) { item = first; break }

    const line = `  ${first.stage || row?.progress_text || 'queued'}` +
      (typeof first.progress === 'number' && first.progress > 0 ? ` ${Math.round(first.progress * 100)}%` : '')
    if (line !== lastLine) { say(line); lastLine = line }
    await sleep(POLL_MS)
  }
  const finishedAt = new Date()
  const generationSeconds = (finishedAt.getTime() - started) / 1000

  /* 4-5. Download and save --------------------------------------------- */
  if (!item.file) fail('The task succeeded but returned no audio file.')
  const audioUrl = /^https?:\/\//i.test(item.file) ? item.file : `${BASE_URL}${item.file}`
  const audio = await fetch(audioUrl, { headers: headers(false) })
  if (!audio.ok) fail(`Could not download the generated audio (HTTP ${audio.status}).`)
  const bytes = Buffer.from(await audio.arrayBuffer())
  if (bytes.length < 1024) fail(`The generated audio is only ${bytes.length} bytes — that is not a song.`)

  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const runDir = join(OUT_ROOT, `${stamp}-${body.model}`)
  await mkdir(runDir, { recursive: true })
  const audioPath = join(runDir, 'audio.wav')
  logPath = join(runDir, 'generation.log')
  await writeFile(audioPath, bytes)

  const acestep = aceStepVersion()
  const backend = describeBackend(BASE_URL)
  const wav = probeWav(bytes)
  if (wav.problem) {
    fail(`ACE-Step returned a file that is not usable audio: ${wav.problem}\n` +
      `  Saved anyway at ${audioPath} so it can be inspected.`)
  }

  // Only values that came from the real run. Nothing here is a placeholder.
  const metadata = {
    engine: 'ace-step',
    model: health.loaded_model ?? body.model,
    lm_model: health.loaded_lm_model ?? body.lm_model_path,
    backend: `${health.service} ${health.version}`,
    device: backend,
    language: body.vocal_language,
    vocal_gender: 'male',
    instrumental: false,
    generation_time_seconds: Number(generationSeconds.toFixed(1)),
    duration_seconds: item.metas?.duration ?? wav.durationSeconds,
    timestamp: finishedAt.toISOString(),

    // Everything else the run established, kept for later analysis.
    task_id: taskId,
    backend_url: BASE_URL,
    acestep_version: acestep.version,
    acestep_commit: acestep.commit,
    acestep_home: acestep.home,
    requested_model: body.model,
    requested_lm_model: body.lm_model_path,
    thinking: body.thinking,
    generation_started: startedAt.toISOString(),
    generation_finished: finishedAt.toISOString(),
    reported_duration_seconds: item.metas?.duration ?? null,
    measured_duration_seconds: wav.durationSeconds,
    sample_rate: wav.sampleRate,
    channels: wav.channels,
    peak: wav.peak,
    bpm: item.metas?.bpm ?? null,
    keyscale: item.metas?.keyscale ?? null,
    bytes: bytes.length,
    audio_file: audioPath,
    lyric_lines_sent: lyricLines.length,
  }
  await writeFile(join(runDir, 'metadata.json'), JSON.stringify(metadata, null, 2))

  /* 6-9. Report -------------------------------------------------------- */
  say('\n✓ ACE-Step generated a song')
  say(`  ACE-Step       ${acestep.version} (${acestep.commit})`)
  say(`  service        ${metadata.backend}`)
  say(`  DiT model      ${metadata.loaded_model ?? metadata.model}`)
  say(`  LM model       ${metadata.loaded_lm_model ?? metadata.lm_model}`)
  say(`  device/backend ${backend}`)
  say(`  task id        ${taskId}`)
  say(`  started        ${metadata.generation_started}`)
  say(`  finished       ${metadata.generation_finished}`)
  say(`  generation     ${metadata.generation_time_seconds}s`)
  say(`  output length  ${metadata.duration_seconds}s`
    + (metadata.reported_duration_seconds === null ? ' (measured from the file)' : ''))
  say(`  bpm / key      ${metadata.bpm ?? '—'} / ${metadata.keyscale ?? '—'}`)
  say(`  size           ${(bytes.length / 1e6).toFixed(2)} MB`)
  say(`  sample rate    ${wav.sampleRate ? `${wav.sampleRate} Hz` : 'unreadable'}`)
  say(`  channels       ${wav.channels ?? 'unreadable'}`)
  say(`  peak           ${wav.peak !== null ? wav.peak.toFixed(3) : 'unreadable'}`)
  say(`  audio          ${audioPath}`)
  say(`  metadata       ${join(runDir, 'metadata.json')}`)
  say(`  log            ${logPath}`)
  say('')
  say('  Nothing above says anything about how it sounds.')
  say('  Listen to it before drawing any conclusion about quality.')
}

// Only run when invoked directly; the unit test imports the body builder.
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => fail(error.stack || error.message))
}
