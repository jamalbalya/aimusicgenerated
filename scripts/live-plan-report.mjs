/**
 * Prints what the live pipeline decides, and what survives the caption budget.
 *
 * Runs entirely offline. It plans a request exactly as the studio would,
 * compiles the caption exactly as the studio would, and prints the plan, the
 * caption, its character count, and — the part worth having — which directions
 * the 512-character limit removed.
 *
 * That last column is the honest answer to "are all the musical constraints
 * transmitted?". Usually they are not, and this says which ones were not,
 * rather than leaving the reader to assume the model was told everything the
 * planner worked out.
 *
 *   node scripts/live-plan-report.mjs                    # the built-in cases
 *   node scripts/live-plan-report.mjs --style "..." --lyrics-file words.txt
 *
 * No network, no GPU, no credentials.
 */

import { readFileSync } from 'node:fs'
import { createServer } from 'vite'

// The engine is TypeScript and this repository has no library build, so the
// modules are loaded through Vite's own SSR loader. Vite is already a
// dependency — nothing new is installed to run this.
const vite = await createServer({
  server: { middlewareMode: true },
  appType: 'custom',
  logLevel: 'silent',
})
const { planLiveGeneration } = await vite.ssrLoadModule('/src/engine/live/plan.ts')
const { compilePrompt, directionsFor } = await vite.ssrLoadModule('/src/engine/live/promptCompiler.ts')

const args = process.argv.slice(2)
const flag = (name) => {
  const at = args.indexOf(`--${name}`)
  return at >= 0 && args[at + 1] ? args[at + 1] : undefined
}

const SHEET = `[Verse 1]
Aku masih di sini menunggu
Cahaya pagi yang tak kunjung datang
Langkah yang dulu kita rencanakan
Kini tinggal bayangan di jalan

[Pre-Chorus]
Setiap detik terasa berat
Menahan rindu yang tak sempat

[Chorus]
Rindu yang tak selesai
Menggantung di udara
Tak pernah sampai padamu
Tak pernah jadi nyata

[Verse 2]
Langkahku pelan menyusuri jalan
Bayangmu tinggal di setiap sudut
Kota ini menyimpan ceritanya
Tentang kita yang tak pernah usai

[Chorus]
Rindu yang tak selesai
Menggantung di udara
Tak pernah sampai padamu
Tak pernah jadi nyata

[Bridge]
Mungkin waktu akan menghapus
Atau justru menyimpannya

[Final Chorus]
Rindu yang tak selesai
Menggantung di udara`

const CASES = flag('style')
  ? [{
    label: 'from the command line',
    style: flag('style'),
    lyrics: flag('lyrics-file') ? readFileSync(flag('lyrics-file'), 'utf8') : SHEET,
    durationSeconds: Number(flag('duration') ?? 240),
    instrumental: args.includes('--instrumental'),
  }]
  : [
    {
      label: 'short style, vocals, 4 minutes',
      style: 'melancholic Indonesian ballad, soft piano and warm upright bass',
      lyrics: SHEET, durationSeconds: 240, instrumental: false,
    },
    {
      label: 'short style, instrumental, 4 minutes',
      style: 'melancholic Indonesian ballad, soft piano and warm upright bass',
      lyrics: '', durationSeconds: 240, instrumental: true,
    },
    {
      label: 'detailed style, vocals, 5 minutes',
      style: 'Indonesian dangdut koplo, sarcastic workplace anthem, powerful kendang and '
        + 'suling answering the singer between lines, dramatic male vocal, festive but serious',
      lyrics: SHEET, durationSeconds: 300, instrumental: false,
    },
    {
      label: 'long style that crowds the budget, vocals, 3 minutes',
      style: 'A sweeping cinematic orchestral piece that opens with solo piano and gradually '
        + 'brings in strings, then brass, then a full choir, telling the story of a long journey '
        + 'home across mountains and rivers, with a sense of loss in the middle section and a '
        + 'triumphant but bittersweet arrival at the end, recorded as though in a large hall '
        + 'with natural reverb and a wide stereo image, in the manner of a film score written '
        + 'for the closing credits of a historical drama about a family separated by war and '
        + 'reunited decades later in a country neither of them recognises any more',
      lyrics: SHEET, durationSeconds: 180, instrumental: false,
    },
  ]

const line = (label, value) => console.log(`  ${label.padEnd(22)} ${value}`)

for (const testCase of CASES) {
  console.log(`\n${'='.repeat(78)}\n${testCase.label}\n${'='.repeat(78)}`)

  const plan = planLiveGeneration({
    style: testCase.style,
    lyrics: testCase.lyrics,
    durationSeconds: testCase.durationSeconds,
    instrumental: testCase.instrumental,
    vocalGender: 'auto',
    language: 'auto',
  })

  console.log('\n-- planned specification (decided locally, before any request) --')
  line('genre', `${plan.music.genre} (${plan.music.genreFamily})`)
  line('mood', plan.music.mood)
  line('emotional direction', plan.music.emotion)
  line('target BPM', plan.music.targetBpm)
  line('groove', plan.music.groove)
  line('key', plan.music.keyName)
  line('chord direction', plan.music.chordDirection)
  line('form', plan.music.form.map((s) => s.label).join(' - '))
  line('form source', plan.music.form[0]?.fromLyrics ? 'the lyric sheet' : 'genre template')
  line('target duration', `${testCase.durationSeconds}s`)
  line('vocal type', plan.music.vocalType)
  line('vocal range', plan.music.vocalRange)
  line('instruments', plan.music.instruments.join(', '))
  line('arrangement density', plan.music.arrangementDensity.toFixed(2))
  line('mix direction', plan.music.mixDirection)
  line('master direction', plan.music.masterDirection)
  line('language', plan.music.language)

  if (!testCase.instrumental) {
    console.log('\n-- lyric sheet --')
    line('sung lines', plan.lyrics.sungLines)
    line('syllables', plan.lyrics.syllables)
    line('syllables/sec', plan.lyrics.density.toFixed(2))
    line('minimum length', `${Math.ceil(plan.lyrics.minimumDurationSeconds)}s`)
    line('sections', plan.lyrics.sections.map((s) => s.sectionName).join(' | '))

    console.log('\n-- parsed headers (name / direction) --')
    for (const section of plan.lyrics.sections) {
      console.log(`  ${section.sectionName.padEnd(16)} ${section.sectionDirection || '(no direction)'}`)
    }

    const script = plan.lyrics.script
    console.log('\n-- original vs sent --')
    line('original characters', script.original.length)
    line('sent characters', plan.lyrics.text.length)
    line('end marker', script.terminated ? `${script.terminator} (terminator, not sent)` : 'none')
    if (script.afterEnd.length > 0) {
      line('after the marker', `${script.afterEnd.length} line(s), kept but not sent`)
    }
    const originalLines = script.original.split('\n').map((l) => l.trim()).filter(Boolean)
    const sentLines = new Set(plan.lyrics.text.split('\n').map((l) => l.trim()).filter(Boolean))
    const missing = originalLines.filter((l) => !sentLines.has(l))
    line('lines not sent', missing.length === 0 ? 'none' : missing.join(' | '))
    line('section directions', `${script.directions.length}, all inside the sheet and all sent`)
  }

  console.log('\n-- validation --')
  line('valid', plan.valid)
  for (const problem of plan.problems) {
    console.log(`  [${problem.severity}] ${problem.code}: ${problem.message}`)
  }
  if (plan.problems.length === 0) console.log('  (no problems)')

  if (!plan.valid) {
    console.log('\n  REFUSED before the request. No caption is compiled and no GPU is spent.')
    continue
  }

  const compiled = compilePrompt(plan, testCase.style)
  const all = directionsFor(plan).map((direction) => direction.id)

  if (compiled.refusal) {
    console.log('\n-- compiled ACE-Step caption --')
    console.log(`  REFUSED: ${compiled.refusal}`)
    console.log('  Nothing is sent and no GPU is spent.')
    continue
  }

  console.log('\n-- compiled ACE-Step caption --')
  console.log(`  "${compiled.caption}"`)
  console.log('')
  line('characters', `${compiled.characters} / ${compiled.limit}`)
  line('headroom', `${compiled.limit - compiled.characters} characters`)
  line('user words intact', compiled.caption.startsWith(testCase.style.trim()))

  console.log('\n-- what reached the model, and what did not --')
  line('directions planned', all.length)
  line('transmitted', `${compiled.included.length}: ${compiled.included.join(', ')}`)
  line('DROPPED by the budget',
    compiled.dropped.length === 0 ? 'none' : `${compiled.dropped.length}: ${compiled.dropped.join(', ')}`)
  if (compiled.dropped.length > 0) {
    console.log('\n  The model was NOT told about the dropped directions. They were planned,')
    console.log('  they did not fit in 512 characters, and nothing else carries them.')
  }
}

console.log(`\n${'='.repeat(78)}`)
console.log('Every direction above is a description in a caption. ACE-Step\'s endpoint takes')
console.log('style, lyrics, language, vocal_gender, instrumental and duration — and nothing')
console.log('else. None of tempo, key, chords, melody or seed is a parameter, so none of them')
console.log('is enforced by any of this.')

await vite.close()
