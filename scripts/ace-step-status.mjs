#!/usr/bin/env node
/**
 * A one-screen answer to "is the neural engine actually usable right now".
 *
 *   node scripts/ace-step-status.mjs
 *   node scripts/ace-step-status.mjs --json
 *
 * READY is reported only when the backend responds. A configured address, an
 * installed checkout and a directory full of weights are all necessary and none
 * of them are sufficient — the only evidence that counts is an answer from
 * /health. Exits 0 when READY, 1 when not, so it can gate a script.
 */

import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const API_URL = (process.env.ACE_STEP_API_URL || 'http://127.0.0.1:8001').replace(/\/+$/, '')
const MODEL = process.env.ACE_STEP_MODEL || 'acestep-v15-turbo'
const LM_MODEL = process.env.ACE_STEP_LM_MODEL || 'acestep-5Hz-lm-0.6B'
const MODELS_DIR = process.env.ACE_STEP_MODELS
  || process.env.ACESTEP_CHECKPOINTS_DIR
  || join(homedir(), 'Models', 'ACE-Step-1.5')
const JSON_OUT = process.argv.includes('--json')

/** Files that mean a directory holds real weights (ACE-Step's own list). */
const WEIGHT_FILES = [
  'model.safetensors', 'model.safetensors.index.json',
  'pytorch_model.bin', 'pytorch_model.bin.index.json',
  'diffusion_pytorch_model.safetensors', 'diffusion_pytorch_model.safetensors.index.json',
  'diffusion_pytorch_model.bin', 'diffusion_pytorch_model.bin.index.json',
]

const hasWeights = (dir) =>
  existsSync(dir) && WEIGHT_FILES.some((file) => existsSync(join(dir, file)))

function dirBytes(dir) {
  if (!existsSync(dir)) return 0
  let total = 0
  const walk = (path) => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const full = join(path, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.isFile()) { try { total += statSync(full).size } catch { /* raced */ } }
    }
  }
  try { walk(dir) } catch { /* unreadable */ }
  return total
}

const gb = (bytes) => `${(bytes / 1e9).toFixed(1)} GB`

/** Describes the compute this machine can offer ACE-Step. */
function describeDevice() {
  if (process.platform !== 'darwin') return `${process.platform}/${process.arch}`
  return process.arch === 'arm64' ? 'Apple Silicon / MLX' : 'Intel Mac (no MLX)'
}

async function probe() {
  try {
    const response = await fetch(`${API_URL}/health`, { signal: AbortSignal.timeout(5000) })
    if (!response.ok) return { reachable: false, reason: `API returned HTTP ${response.status}` }
    const envelope = await response.json()
    const health = envelope?.data ?? envelope
    if (String(health?.status).toLowerCase() !== 'ok') {
      return { reachable: false, reason: `API reported status "${health?.status}"` }
    }
    return { reachable: true, health }
  } catch (error) {
    const reason = error?.name === 'TimeoutError'
      ? 'API did not answer within 5s'
      : 'API unreachable'
    return { reachable: false, reason }
  }
}

const status = await probe()
const modelsOnDisk = hasWeights(join(MODELS_DIR, MODEL))
const lmOnDisk = hasWeights(join(MODELS_DIR, LM_MODEL))
const ready = status.reachable

if (JSON_OUT) {
  console.log(JSON.stringify({
    ready,
    reason: status.reason ?? null,
    api: API_URL,
    model: MODEL,
    lmModel: LM_MODEL,
    device: describeDevice(),
    modelsDir: MODELS_DIR,
    ditOnDisk: modelsOnDisk,
    lmOnDisk,
    diskBytes: dirBytes(MODELS_DIR),
    health: status.health ?? null,
  }, null, 2))
  process.exit(ready ? 0 : 1)
}

console.log('ACE-Step Status')
console.log('')
if (ready) {
  const health = status.health
  console.log('Backend: READY')
  console.log(`API: ${API_URL}`)
  console.log(`Model: ${health.loaded_model || MODEL}${health.loaded_model ? '' : ' (configured; loads on first request)'}`)
  console.log(`LM: ${health.loaded_lm_model || LM_MODEL}${health.loaded_lm_model ? '' : ' (configured; loads on first request)'}`)
  console.log(`Device: ${describeDevice()}`)
  console.log(`Service: ${health.service} ${health.version}`)
  console.log(`Models loaded: ${health.models_initialized} (LM: ${health.llm_initialized})`)
} else {
  console.log('Backend: NOT READY')
  console.log(`Reason: ${status.reason}`)
  console.log(`API: ${API_URL}`)
  console.log(`Device: ${describeDevice()}`)
}
console.log('')
console.log(`Models directory: ${MODELS_DIR}`)
console.log(`  ${MODEL}: ${modelsOnDisk ? 'on disk' : 'missing'}`)
console.log(`  ${LM_MODEL}: ${lmOnDisk ? 'on disk' : 'missing'}`)
console.log(`  total: ${gb(dirBytes(MODELS_DIR))}`)

if (!ready) {
  console.log('')
  console.log(modelsOnDisk
    ? 'The weights are there but nothing is serving them. Start the backend:\n  ./scripts/start-ace-step-macos.sh'
    : 'Install ACE-Step and download the models:\n  ./scripts/setup-ace-step-macos.sh')
}
process.exit(ready ? 0 : 1)
