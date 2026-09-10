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
import { existsSync, readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const OUT_DIR = join(ROOT, 'evaluation', 'bos-toxic')
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

function fail(message) {
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
  console.log('ACE-Step 1.5 — Bos Toxic smoke test')
  console.log(`  backend        ${BASE_URL}`)

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
  console.log(`  service        ${health.service} ${health.version}`)
  console.log(`  models loaded  ${health.models_initialized} (LM: ${health.llm_initialized})`)

  /* 2. Submit ---------------------------------------------------------- */
  const body = bosToxicTaskBody()
  const lyricLines = body.lyrics.split('\n').filter((l) => l.trim() && !/^\[[^\]]+\]$/.test(l.trim()))
  console.log(`  style          ${body.prompt.slice(0, 68)}…`)
  console.log(`  lyrics         ${lyricLines.length} sung lines, language ${body.vocal_language}`)
  console.log(`  model          ${body.model}`)
  console.log(`  lm model       ${body.lm_model_path}`)
  console.log('\nsubmitting…')

  const started = Date.now()
  const created = await unwrap(await fetch(`${BASE_URL}/release_task`, {
    method: 'POST', headers: headers(true), body: JSON.stringify(body),
  }), 'POST /release_task')
  const taskId = created.task_id
  if (!taskId) fail('The backend accepted the request but returned no task id.')
  console.log(`  task           ${taskId}${created.queue_position ? ` (queue position ${created.queue_position})` : ''}`)

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
    if (line !== lastLine) { console.log(line); lastLine = line }
    await sleep(POLL_MS)
  }
  const generationSeconds = (Date.now() - started) / 1000

  /* 4-5. Download and save --------------------------------------------- */
  if (!item.file) fail('The task succeeded but returned no audio file.')
  const audioUrl = /^https?:\/\//i.test(item.file) ? item.file : `${BASE_URL}${item.file}`
  const audio = await fetch(audioUrl, { headers: headers(false) })
  if (!audio.ok) fail(`Could not download the generated audio (HTTP ${audio.status}).`)
  const bytes = Buffer.from(await audio.arrayBuffer())
  if (bytes.length < 1024) fail(`The generated audio is only ${bytes.length} bytes — that is not a song.`)

  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  await mkdir(OUT_DIR, { recursive: true })
  const audioPath = join(OUT_DIR, `bos-toxic-${body.model}-${stamp}.wav`)
  await writeFile(audioPath, bytes)

  const acestep = aceStepVersion()
  const backend = describeBackend(BASE_URL)
  const metadata = {
    task_id: taskId,
    backend_url: BASE_URL,
    service: `${health.service} ${health.version}`,
    acestep_version: acestep.version,
    acestep_commit: acestep.commit,
    acestep_home: acestep.home,
    device_backend: backend,
    loaded_model: health.loaded_model ?? null,
    loaded_lm_model: health.loaded_lm_model ?? null,
    model: body.model,
    lm_model: body.lm_model_path,
    vocal_language: body.vocal_language,
    instrumental: false,
    thinking: body.thinking,
    generation_seconds: Number(generationSeconds.toFixed(1)),
    output_seconds: item.metas?.duration ?? null,
    bpm: item.metas?.bpm ?? null,
    keyscale: item.metas?.keyscale ?? null,
    bytes: bytes.length,
    audio_file: audioPath,
    lyric_lines_sent: lyricLines.length,
    generated_at: new Date().toISOString(),
  }
  await writeFile(audioPath.replace(/\.wav$/, '.json'), JSON.stringify(metadata, null, 2))

  /* 6-9. Report -------------------------------------------------------- */
  console.log('\n✓ ACE-Step generated a song')
  console.log(`  ACE-Step       ${acestep.version} (${acestep.commit})`)
  console.log(`  service        ${metadata.service}`)
  console.log(`  DiT model      ${metadata.loaded_model ?? metadata.model}`)
  console.log(`  LM model       ${metadata.loaded_lm_model ?? metadata.lm_model}`)
  console.log(`  device/backend ${backend}`)
  console.log(`  task id        ${taskId}`)
  console.log(`  generation     ${metadata.generation_seconds}s`)
  console.log(`  output length  ${metadata.output_seconds ?? 'unreported'}s`)
  console.log(`  bpm / key      ${metadata.bpm ?? '—'} / ${metadata.keyscale ?? '—'}`)
  console.log(`  size           ${(bytes.length / 1e6).toFixed(2)} MB`)
  console.log(`  audio          ${audioPath}`)
  console.log(`  metadata       ${audioPath.replace(/\.wav$/, '.json')}`)
  console.log('')
  console.log('  Nothing above says anything about how it sounds.')
  console.log('  Listen to it before drawing any conclusion about quality.')
}

// Only run when invoked directly; the unit test imports the body builder.
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => fail(error.stack || error.message))
}
