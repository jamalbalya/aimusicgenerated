/**
 * Compiles one request exactly as the Studio would, and prints it as JSON.
 *
 * This exists so the real-run harness sends *the same thing the browser sends*.
 * A validation run against a payload assembled by a second implementation would
 * be validating the second implementation. Everything here — the plan, the
 * caption, the lyric payload, the target melody and its validator — is the
 * engine's own code, loaded through Vite's SSR loader.
 *
 *   node scripts/build-melody.mjs --style-file S --lyrics-file L [--duration 210]
 *                                 [--vocal-gender male] [--language auto]
 *
 * Prints one JSON object on stdout and nothing else, so it can be piped.
 * No network, no GPU, no credentials.
 */

import { readFileSync } from 'node:fs'
import { createServer } from 'vite'

const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const at = args.indexOf(`--${name}`)
  return at >= 0 && args[at + 1] !== undefined ? args[at + 1] : fallback
}

const vite = await createServer({
  server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent',
})

try {
  const { planLiveGeneration } = await vite.ssrLoadModule('/src/engine/live/plan.ts')
  const { compilePrompt } = await vite.ssrLoadModule('/src/engine/live/promptCompiler.ts')
  const { buildTargetMelody, melodyPayload, anchorNotes } =
    await vite.ssrLoadModule('/src/engine/live/targetMelody.ts')
  const { checkTargetMelody } = await vite.ssrLoadModule('/src/engine/live/melodyCheck.ts')
  const { aceStepKeyscale } = await vite.ssrLoadModule('/src/engine/live/musicControlSpec.ts')

  const style = readFileSync(flag('style-file'), 'utf8').trim()
  const lyrics = readFileSync(flag('lyrics-file'), 'utf8')
  const durationRaw = flag('duration', '')
  const durationSeconds = durationRaw ? Number(durationRaw) : undefined
  const vocalGender = flag('vocal-gender', 'male')
  const language = flag('language', 'auto')
  // 'bare' sends the person's Style and nothing else. See promptCompiler.
  const captionMode = flag('caption-mode', 'compiled')
  if (captionMode !== 'compiled' && captionMode !== 'bare') {
    throw new Error(`--caption-mode must be 'compiled' or 'bare', got '${captionMode}'`)
  }

  const input = {
    style, lyrics, instrumental: false, vocalGender, language,
    ...(durationSeconds !== undefined ? { durationSeconds } : {}),
  }
  const plan = planLiveGeneration(input)
  const melody = buildTargetMelody(plan, vocalGender)
  const check = checkTargetMelody(melody)
  const compiled = compilePrompt(plan, style, captionMode)
  const sung = melody.notes.filter((note) => note.role !== 'rest')

  // The melody is sent only when it passed its own checks. Correcting a vocal
  // towards a melody that failed is worse than not correcting it, so a failure
  // here means the song comes back exactly as ACE-Step made it.
  const usable = check.usable && melody.notes.length > 0

  process.stdout.write(JSON.stringify({
    valid: plan.valid,
    problems: plan.problems.map((p) => ({ code: p.code, severity: p.severity, message: p.message })),
    request: {
      style: compiled.caption,
      lyrics: plan.lyrics.text,
      language: plan.music.language,
      vocalGender,
      instrumental: false,
      ...(durationSeconds !== undefined ? { duration: durationSeconds } : {}),
      bpm: plan.music.targetBpm,
      keyscale: aceStepKeyscale(plan.music.tonic, plan.music.scale),
      melody: usable ? JSON.stringify(melodyPayload(melody)) : '',
    },
    plan: {
      genre: plan.music.genre,
      key: plan.music.keyName,
      bpm: plan.music.targetBpm,
      bpmStated: plan.music.bpmStated,
      sections: plan.music.form.map((section) => section.label),
      syllables: plan.lyrics.syllables,
      captionMode,
      captionChars: compiled.caption.length,
      // What the planner derived and, in bare mode, did not send. Recorded so
      // the report can say what the model was not told.
      captionIncluded: compiled.included,
      captionDropped: compiled.dropped,
      captionWithheld: compiled.withheld,
      lyricChars: plan.lyrics.text.length,
      terminator: plan.lyrics.script.terminator,
    },
    melody: {
      usable,
      notes: sung.length,
      rests: melody.notes.length - sung.length,
      structural: anchorNotes(melody).length,
      phrases: new Set(sung.map((note) => note.phrase)).size,
      bars: melody.harmony.bars.length,
      progressions: [...new Set(melody.harmony.progressionIds)],
      lowestMidi: sung.length ? Math.min(...sung.map((n) => n.midi)) : 0,
      highestMidi: sung.length ? Math.max(...sung.map((n) => n.midi)) : 0,
      checksPassed: check.passed,
      problems: check.problems,
    },
  }, null, 2))
} finally {
  await vite.close()
}
