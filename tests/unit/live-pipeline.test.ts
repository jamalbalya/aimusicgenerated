/**
 * The live ACE-Step pipeline: plan, compile, one request, one measurement.
 *
 * The property this file exists to hold is not "the code works" but "the code
 * cannot do the thing it promised not to do". One press of Generate authorises
 * exactly one ZeroGPU request, and a failed result — of the request, or of the
 * verification afterwards — buys nothing. Several tests below therefore assert
 * that a second call *throws*, which is the only kind of guarantee worth making
 * about someone else's GPU allowance.
 */

import { describe, expect, it, beforeEach } from 'vitest'
import {
  planLiveGeneration, planSeed, compilePrompt, directionsFor,
  mintRequestTicket, resetRequestTickets, RequestTicketSpentError, MissingRequestTicketError,
  verifyLiveResult, planLyrics, CONSTRAINTS, constraintsOf,
  MAX_SUSTAINED_SYLLABLES_PER_SECOND,
  type LiveGenerationInput,
} from '../../src/engine/live'
import { ACE_STEP_TEXT_LIMITS } from '../../src/engine/providers/aceStepRequest'
import { detectLanguage } from '../../src/engine/lang'
import { detectTempo } from '../../src/engine/audio/analyze'
import type { AudioData } from '../../src/engine/audio/wav'

const SHEET = `[Verse 1]
Aku masih di sini menunggu
Cahaya pagi yang tak kunjung datang

[Chorus]
Rindu yang tak selesai
Menggantung di udara

[Verse 2]
Langkahku pelan menyusuri jalan
Bayangmu tinggal di setiap sudut

[Chorus]
Rindu yang tak selesai
Menggantung di udara`

const input = (over: Partial<LiveGenerationInput> = {}): LiveGenerationInput => ({
  style: 'melancholic Indonesian ballad, soft piano and warm upright bass',
  lyrics: SHEET,
  durationSeconds: 210,
  instrumental: false,
  vocalGender: 'auto',
  language: 'auto',
  ...over,
})

/* ------------------------------------------------------ pre-generation --- */

describe('nothing reaches the GPU until the request is worth sending', () => {
  it('refuses an empty style', () => {
    const plan = planLiveGeneration(input({ style: '   ' }))
    expect(plan.valid).toBe(false)
    expect(plan.problems.some((problem) => problem.severity === 'error')).toBe(true)
  })

  it('refuses empty lyrics for a sung song, and accepts them for an instrumental', () => {
    const sung = planLiveGeneration(input({ lyrics: '' }))
    expect(sung.valid).toBe(false)
    expect(sung.problems.map((problem) => problem.code)).toContain('EMPTY')

    // An instrumental was asked for with no words on purpose. Refusing it for
    // having none would be refusing the mode itself.
    const instrumental = planLiveGeneration(input({ lyrics: '', instrumental: true }))
    expect(instrumental.valid).toBe(true)
  })

  it('refuses a sheet with tags but no words under them', () => {
    const plan = planLiveGeneration(input({ lyrics: '[Verse 1]\n\n[Chorus]\n' }))
    expect(plan.valid).toBe(false)
    expect(plan.problems.map((problem) => problem.code)).toContain('NO_SUNG_LINES')
  })

  it('refuses a duration ACE-Step does not generate at', () => {
    for (const seconds of [5, 900, Number.NaN]) {
      const plan = planLiveGeneration(input({ durationSeconds: seconds }))
      expect(`${seconds}: ${plan.valid}`).toBe(`${seconds}: false`)
    }
  })

  it('refuses lyrics that cannot be sung in the time asked for', () => {
    // Deliberately far past any human delivery rate: 60 dense lines in 30
    // seconds. ACE-Step would not sing this faster, it would stop mid-phrase.
    const dense = Array.from({ length: 60 }, (_, index) =>
      `Baris nomor ${index} penuh dengan kata kata yang sangat panjang sekali`).join('\n')
    const plan = planLiveGeneration(input({ lyrics: `[Verse 1]\n${dense}`, durationSeconds: 30 }))
    expect(plan.valid).toBe(false)
    const problem = plan.problems.find((entry) => entry.code === 'TOO_LONG_FOR_DURATION')
    expect(problem?.severity).toBe('error')
    // And it says what length would work, rather than only refusing.
    expect(problem?.message).toMatch(/at least \d+ seconds/)
  })

  it('refuses a sheet longer than ACE-Step takes, whatever the duration', () => {
    // Not the same question as whether it fits the time. A sheet can be
    // perfectly singable at the length requested and still be more characters
    // than the endpoint accepts — found by an end-to-end test whose sheet
    // passed every musical check and was then refused by the provider, after
    // the planner had said the request was fine.
    const huge = Array.from({ length: 200 }, (_, index) =>
      `Baris ${index} dengan kata kata panjang sekali untuk mengisi ruang`).join('\n')
    expect(huge.length).toBeGreaterThan(4096)
    const plan = planLiveGeneration(input({ lyrics: `[Verse 1]\n${huge}` }))
    expect(plan.valid).toBe(false)
    expect(plan.problems.some((problem) => /at most 4096/.test(problem.message))).toBe(true)

    // And an instrumental, whose sheet is replaced by [inst], is not refused
    // for the contents of a box it does not send.
    expect(planLiveGeneration(input({ lyrics: `[Verse 1]\n${huge}`, instrumental: true })).valid)
      .toBe(true)
  })

  it('warns rather than refuses when the sheet is sparse for its length', () => {
    const plan = planLiveGeneration(input({
      lyrics: '[Verse 1]\nSatu baris saja', durationSeconds: 300,
    }))
    expect(plan.valid).toBe(true)
    expect(plan.problems.map((problem) => problem.code)).toContain('SPARSE')
  })

  it('warns about a bracketed line that is a direction rather than a section', () => {
    const plan = planLiveGeneration(input({
      lyrics: '[Verse 1]\nSatu dua tiga empat\n[slow down here]\nLima enam tujuh delapan',
    }))
    const problem = plan.problems.find((entry) => entry.code === 'CONTROL_INSTRUCTION')
    expect(problem).toBeDefined()
    expect(problem?.severity).toBe('warning')
    // ACE-Step has no control instructions, so this is words it may sing.
    expect(problem?.message).toMatch(/may sing/)
  })

  it('warns about a block pasted twice in a row, but not about a chorus that returns', () => {
    const pasted = planLiveGeneration(input({
      lyrics: '[Verse 1]\nSatu dua tiga\n\n[Verse 2]\nSatu dua tiga',
    }))
    expect(pasted.problems.map((problem) => problem.code)).toContain('DUPLICATE_BLOCK')
    // The standard sheet repeats its chorus with a verse in between: normal form.
    expect(planLiveGeneration(input()).problems.map((problem) => problem.code))
      .not.toContain('DUPLICATE_BLOCK')
  })

  it('notices lyrics in a different language from the one requested', () => {
    const plan = planLiveGeneration(input({ language: 'en' }))
    expect(plan.problems.map((problem) => problem.code)).toContain('LANGUAGE_MISMATCH')
    // A warning, not a refusal: someone may genuinely want an accent.
    expect(plan.valid).toBe(true)
  })

  it('counts syllables with the language the words are actually in', () => {
    const indonesian = planLyrics(SHEET, 'id', 210, detectLanguage)
    expect(indonesian.syllables).toBeGreaterThan(40)
    expect(indonesian.density).toBeGreaterThan(0)
    expect(indonesian.density).toBeLessThan(MAX_SUSTAINED_SYLLABLES_PER_SECOND)
  })

  it('reports the minimum length a sheet could be sung in', () => {
    const plan = planLyrics(SHEET, 'id', undefined, detectLanguage)
    expect(plan.minimumDurationSeconds).toBeGreaterThan(0)
    expect(plan.minimumDurationSeconds).toBeLessThan(120)
  })
})

/* -------------------------------------------------------------- plan --- */

describe('the plan is deterministic and musical', () => {
  it('produces the same plan for the same request, every time', () => {
    const first = planLiveGeneration(input())
    const second = planLiveGeneration(input())
    expect(JSON.stringify(second.music)).toBe(JSON.stringify(first.music))
    expect(planSeed(input())).toBe(planSeed(input()))
  })

  it('produces a different plan when the request differs', () => {
    expect(planSeed(input())).not.toBe(planSeed(input({ style: 'thrash metal' })))
  })

  it('decides every field the caption needs', () => {
    const { music } = planLiveGeneration(input())
    expect(music.genre).toBeTruthy()
    expect(music.mood).toBeTruthy()
    expect(music.emotion).toBeTruthy()
    expect(music.targetBpm).toBeGreaterThan(39)
    expect(music.targetBpm).toBeLessThan(241)
    expect(music.groove).toBeTruthy()
    expect(music.keyName).toMatch(/^[A-G]/)
    expect(music.chordDirection).toBeTruthy()
    expect(music.vocalType).toBeTruthy()
    expect(music.vocalRange).toBeTruthy()
    expect(music.instruments.length).toBeGreaterThan(0)
    expect(music.mixDirection).toBeTruthy()
    expect(music.masterDirection).toBeTruthy()
    expect(music.form.length).toBeGreaterThan(2)
  })

  it('takes the form from the user sheet when the sheet has one', () => {
    const { music } = planLiveGeneration(input())
    expect(music.form.every((section) => section.fromLyrics)).toBe(true)
    expect(music.form.map((section) => section.kind)).toEqual(
      ['verse', 'chorus', 'verse', 'chorus'])
  })

  it('falls back to a genre-appropriate template when the sheet has no sections', () => {
    const { music } = planLiveGeneration(input({
      lyrics: 'satu dua tiga empat\nlima enam tujuh delapan', durationSeconds: 240,
    }))
    expect(music.form.every((section) => !section.fromLyrics)).toBe(true)
    const kinds = music.form.map((section) => section.kind)
    expect(kinds).toContain('intro')
    expect(kinds).toContain('chorus')
    expect(kinds).toContain('outro')
  })

  it('does not force ten sections into a short song', () => {
    const short = planLiveGeneration(input({ lyrics: 'satu dua tiga', durationSeconds: 60 }))
    const long = planLiveGeneration(input({ lyrics: 'satu dua tiga', durationSeconds: 300 }))
    expect(short.music.form.length).toBeLessThan(long.music.form.length)
    expect(short.music.form.map((section) => section.kind)).not.toContain('bridge')
  })

  it('honours an explicit tempo in the style rather than inventing one', () => {
    const { music } = planLiveGeneration(input({ style: 'lo-fi hip hop at 84 bpm' }))
    expect(music.targetBpm).toBe(84)
  })

  it('honours an explicit key in the style', () => {
    const { music } = planLiveGeneration(input({ style: 'soft ballad in F# minor' }))
    expect(music.keyName).toMatch(/^F#/)
    expect(music.keyName).toMatch(/minor/)
  })
})

/* ---------------------------------------------------- prompt compiler --- */

describe('the caption compiler works inside ACE-Step 512 characters', () => {
  it('never exceeds the limit, on any plan it is given', () => {
    for (const style of [
      'melancholic Indonesian ballad',
      'heavy metal, double kick, aggressive male vocal',
      'lo-fi chill study beat',
      'epic cinematic orchestral trailer music',
      'x'.repeat(480),
    ]) {
      const plan = planLiveGeneration(input({ style }))
      const compiled = compilePrompt(plan, style)
      expect(`${style.slice(0, 20)}: ${compiled.caption.length <= ACE_STEP_TEXT_LIMITS.style}`)
        .toBe(`${style.slice(0, 20)}: true`)
    }
  })

  it('keeps the user words whole and first', () => {
    const style = 'dangdut koplo sarkastik, kendang menghentak'
    const compiled = compilePrompt(planLiveGeneration(input({ style })), style)
    expect(compiled.caption.startsWith(style)).toBe(true)
  })

  it('refuses rather than truncating a style that is already too long', () => {
    const style = 'y'.repeat(ACE_STEP_TEXT_LIMITS.style + 1)
    const compiled = compilePrompt(planLiveGeneration(input({ style })), style)
    expect(compiled.refusal).toBeTruthy()
    // Nothing is sent, and no word of theirs was edited to make it fit.
    expect(compiled.caption).toBe(style)
  })

  it('records what the budget dropped instead of pretending the model was told', () => {
    // A long style leaves little room, so late directions cannot fit.
    const style = 'z'.repeat(430)
    const compiled = compilePrompt(planLiveGeneration(input({ style })), style)
    expect(compiled.dropped.length).toBeGreaterThan(0)
    expect([...compiled.included, ...compiled.dropped].sort())
      .toEqual(directionsFor(planLiveGeneration(input({ style }))).map((d) => d.id).sort())
  })

  it('compiles the same caption twice for the same plan', () => {
    const style = input().style
    const first = compilePrompt(planLiveGeneration(input()), style)
    const second = compilePrompt(planLiveGeneration(input()), style)
    expect(second.caption).toBe(first.caption)
  })

  it('never states a genre it only guessed, nor that guess\'s instruments', () => {
    // Found by running the report script on real inputs. "melancholic
    // Indonesian ballad, soft piano and warm upright bass" matches Dangdut
    // Koplo on the single word "indonesian", and the compiled caption was
    // telling the model "Dangdut Koplo, organ, electric bass, flute" over the
    // top of somebody's piano ballad. The planner may guess — something has to
    // choose a tempo — but the caption is the one channel the model reads, and
    // a guess in it argues with the request.
    const weak = 'melancholic Indonesian ballad, soft piano and warm upright bass'
    const weakPlan = planLiveGeneration(input({ style: weak }))
    expect(weakPlan.music.genreConfident).toBe(false)
    const weakCaption = compilePrompt(weakPlan, weak)
    expect(weakCaption.included).not.toContain('genre')
    expect(weakCaption.included).not.toContain('instruments')
    expect(weakCaption.caption.toLowerCase()).not.toContain('koplo')

    // Named outright, it is stated — the rule is about confidence, not about
    // refusing to describe the genre at all.
    const strong = 'Indonesian dangdut koplo, powerful kendang and suling, dramatic male vocal'
    const strongPlan = planLiveGeneration(input({ style: strong }))
    expect(strongPlan.music.genreConfident).toBe(true)
    expect(compilePrompt(strongPlan, strong).included).toContain('genre')
  })

  it('does not ask for a vocal to be mixed forward in an instrumental', () => {
    const style = 'cinematic piano'
    const plan = planLiveGeneration(input({ style, instrumental: true, lyrics: '' }))
    expect(plan.music.mixDirection).not.toMatch(/vocal/i)
  })

  it('names a chord direction in the same mode as the key it planned', () => {
    // The caption was saying "A major" and "i-bVI-bIII-bVII" in adjacent
    // clauses, because the chord direction took the genre's first listed
    // progression without asking which mode the key had ended up in.
    for (const style of [
      'epic cinematic orchestral trailer', 'upbeat pop love song',
      'heavy metal guitar', 'bossa nova', 'lofi chill study music',
    ]) {
      const { music } = planLiveGeneration(input({ style }))
      const minorKey = /minor|dorian|phrygian|locrian|blues/.test(music.scale.toLowerCase())
      const saysMinor = music.chordDirection.includes('minor-key')
      expect(`${style}: key minor=${minorKey}, direction minor=${saysMinor}`)
        .toBe(`${style}: key minor=${minorKey}, direction minor=${minorKey}`)
    }
  })

  it('does not repeat a direction the user already wrote', () => {
    const style = 'lo-fi hip hop at 84 BPM'
    const compiled = compilePrompt(planLiveGeneration(input({ style })), style)
    expect(compiled.caption.match(/84 BPM/gi)).toHaveLength(1)
  })

  it('says "instrumental, no vocals" and nothing about a singer, in instrumental mode', () => {
    const style = 'cinematic piano'
    const plan = planLiveGeneration(input({ style, instrumental: true, lyrics: '' }))
    const compiled = compilePrompt(plan, style)
    expect(compiled.caption).toContain('instrumental, no vocals')
    expect(compiled.included).not.toContain('vocal-range')
    expect(compiled.included).not.toContain('melody')
  })
})

/* ------------------------------------------------ one-request guarantee --- */

describe('one press of Generate authorises exactly one request', () => {
  beforeEach(() => resetRequestTickets())

  it('spends once and refuses every later attempt', () => {
    const ticket = mintRequestTicket()
    expect(ticket.spent).toBe(false)
    expect(ticket.spend()).toBe('gen-1')
    expect(ticket.spent).toBe(true)
    expect(() => ticket.spend()).toThrow(RequestTicketSpentError)
    // Twice more, because a guard that only holds for the second attempt is
    // not a guard.
    expect(() => ticket.spend()).toThrow(RequestTicketSpentError)
    expect(() => ticket.spend()).toThrow(RequestTicketSpentError)
  })

  it('makes a loop over one ticket impossible rather than discouraged', () => {
    const ticket = mintRequestTicket()
    const sent: string[] = []
    expect(() => {
      for (let attempt = 0; attempt < 4; attempt++) sent.push(ticket.spend())
    }).toThrow(RequestTicketSpentError)
    expect(sent).toEqual(['gen-1'])
  })

  it('gives each press its own ticket', () => {
    expect(mintRequestTicket().spend()).toBe('gen-1')
    expect(mintRequestTicket().spend()).toBe('gen-2')
  })

  it('names the failure when a generation is attempted with no ticket at all', () => {
    expect(new MissingRequestTicketError().message).toMatch(/without a request ticket/)
  })

  it('explains, in the error itself, that a retry is not what to do', () => {
    const message = new RequestTicketSpentError('gen-1').message
    expect(message).toMatch(/not a retry/)
    expect(message).toMatch(/not a second candidate/)
    expect(message).toMatch(/Press Generate again/)
  })
})

/* ------------------------------------------------- post-render verify --- */

const audio = (fill: (t: number, index: number) => number, options: {
  seconds?: number; rate?: number; channels?: number
} = {}): AudioData => {
  const rate = options.rate ?? 44100
  const length = Math.round((options.seconds ?? 12) * rate)
  const channels = Array.from({ length: options.channels ?? 2 }, () => new Float32Array(length))
  for (const channel of channels) {
    for (let index = 0; index < length; index++) channel[index] = fill(index / rate, index)
  }
  return { channels, sampleRate: rate }
}

/** A tone with energy in the voice band, so a sung song is not read as silent. */
const song = (t: number) =>
  0.3 * Math.sin(2 * Math.PI * 220 * t)
  + 0.25 * Math.sin(2 * Math.PI * 2200 * t)
  + 0.15 * Math.sin(2 * Math.PI * 3100 * t)

describe('the song that came back is measured once, and never regenerated', () => {
  it('measures a valid song and says what it could not measure', () => {
    const report = verifyLiveResult(audio(song))
    expect(report.usable).toBe(true)
    expect(report.failures).toEqual([])
    expect(report.measurements).not.toBeNull()
    expect(report.measurements!.durationSeconds).toBeCloseTo(12, 1)
    expect(report.measurements!.channels).toBe(2)
    // The honesty rule: unmeasurable properties are listed, never counted as passing.
    expect(report.notMeasured.length).toBeGreaterThan(0)
    expect(report.verdict).toBe('PASS_WITH_LIMITATIONS')
  })

  it('never reports a plain PASS while anything is unmeasurable', () => {
    // In a browser `notMeasured` is never empty, so PASS is unreachable — and
    // that is the point. A song labelled fully verified on a partial
    // measurement is the lie this pipeline exists to avoid.
    for (const seconds of [12, 30, 60]) {
      expect(verifyLiveResult(audio(song, { seconds })).verdict).not.toBe('PASS')
    }
  })

  it('detects silent audio', () => {
    const report = verifyLiveResult(audio(() => 0))
    expect(report.verdict).toBe('FAILED_VERIFICATION')
    expect(report.usable).toBe(false)
    expect(report.failures.join(' ')).toMatch(/silen/i)
  })

  it('detects audio that decoded to nothing at all', () => {
    const report = verifyLiveResult({ channels: [], sampleRate: 44100 })
    expect(report.verdict).toBe('ANALYSIS_UNAVAILABLE')
    expect(report.measurements).toBeNull()
    expect(report.usable).toBe(false)
  })

  it('detects clipping', () => {
    // A square wave pinned at full scale: long runs of clipped samples.
    const report = verifyLiveResult(audio((t) => (Math.sin(2 * Math.PI * 220 * t) > 0 ? 1 : -1)))
    expect(report.verdict).toBe('FAILED_VERIFICATION')
    expect(report.failures.join(' ')).toMatch(/full scale/)
    expect(report.measurements!.clippedShare).toBeGreaterThan(0.001)
  })

  it('detects a dead channel', () => {
    const stereo = audio(song)
    stereo.channels[1] = new Float32Array(stereo.channels[0]!.length)
    const report = verifyLiveResult(stereo)
    expect(report.verdict).toBe('FAILED_VERIFICATION')
    expect(report.failures.join(' ')).toMatch(/one side only/)
  })

  it('reports a song shorter than the length that was asked for', () => {
    const report = verifyLiveResult(audio(song, { seconds: 30 }), { requestedDurationSeconds: 240 })
    expect(report.verdict).toBe('FAILED_VERIFICATION')
    expect(report.failures.join(' ')).toMatch(/Asked for 240 seconds and received 30/)
  })

  it('reports a long internal dropout', () => {
    const rate = 44100
    // A gap inside an otherwise-fine song: 12 seconds of a 60-second file, so
    // this trips the dropout rule and not the "mostly silent" one above it.
    const dropout = audio(song, { seconds: 60, rate })
    for (const channel of dropout.channels) channel.fill(0, 20 * rate, 32 * rate)
    const report = verifyLiveResult(dropout)
    expect(report.failures.join(' ')).toMatch(/unbroken silence/)
  })

  it('does not fail an instrumental for having no vocal analysis', () => {
    // Below 1.5 kHz only: no voice-band energy at all. A vocal request would
    // fail on this; an instrumental request must not.
    const backing = audio((t) => 0.4 * Math.sin(2 * Math.PI * 180 * t))
    const asInstrumental = verifyLiveResult(backing, { instrumental: true })
    expect(asInstrumental.verdict).not.toBe('FAILED_VERIFICATION')
    expect(asInstrumental.usable).toBe(true)

    const asVocal = verifyLiveResult(backing, { instrumental: false })
    expect(asVocal.verdict).toBe('FAILED_VERIFICATION')
    expect(asVocal.failures.join(' ')).toMatch(/appears to be an instrumental/)
  })

  it('states the requested tempo as a note, not as a defect', () => {
    // ACE-Step has no tempo parameter, so a tempo that came back wrong is the
    // model not following prose. Worth saying; not grounds for calling the
    // audio defective.
    const report = verifyLiveResult(audio(song, { seconds: 30 }), { targetBpm: 72 })
    expect(report.verdict).not.toBe('FAILED_VERIFICATION')
    if (report.tempo && !report.tempo.passed) {
      expect(report.notes.join(' ')).toMatch(/no tempo parameter/)
    }
  })

  it('never returns a verdict outside the four the requirement names', () => {
    const verdicts = new Set([
      verifyLiveResult(audio(song)).verdict,
      verifyLiveResult(audio(() => 0)).verdict,
      verifyLiveResult({ channels: [], sampleRate: 44100 }).verdict,
    ])
    for (const verdict of verdicts) {
      expect(['PASS', 'PASS_WITH_LIMITATIONS', 'FAILED_VERIFICATION', 'ANALYSIS_UNAVAILABLE'])
        .toContain(verdict)
    }
  })
})

/* ------------------------------------------------- the cost of measuring --- */

describe('measuring the song is cheap enough to do on arrival', () => {
  /** A click track: a short decaying burst on every beat. */
  const clicks = (bpm: number, seconds: number, rate = 44100): Float32Array => {
    const out = new Float32Array(Math.round(seconds * rate))
    const period = Math.round((60 / bpm) * rate)
    for (let beat = 0; beat * period < out.length; beat++) {
      const at = beat * period
      for (let index = 0; index < 2000 && at + index < out.length; index++) {
        out[at + index] = Math.sin(2 * Math.PI * 1000 * (index / rate)) * Math.exp(-index / 500)
      }
    }
    return out
  }

  it('takes the tempo from a window, and gets the same answer as from the whole song', () => {
    // Verification cost is dominated by tempo detection, which runs its own
    // STFT at a 256-sample hop: 3.2 of the original 5.3 seconds on a
    // 271-second song. Taking ninety seconds from the middle is what makes it
    // affordable, and this is the evidence that it costs nothing in accuracy —
    // measured on a real click track rather than argued for, because a
    // sustained tone has no onsets and its "tempo" is noise either way.
    for (const bpm of [72, 90, 120]) {
      const rate = 22050
      const mono = clicks(bpm, 200, rate)
      const full = detectTempo({ channels: [mono], sampleRate: rate })
      const window = Math.round(90 * rate)
      const from = Math.round((mono.length - window) / 2)
      const windowed = detectTempo(
        { channels: [mono.subarray(from, from + window)], sampleRate: rate })
      expect(`${bpm}: ${windowed.bpm.toFixed(2)}`).toBe(`${bpm}: ${full.bpm.toFixed(2)}`)
      // And the answer is right, not merely stable.
      expect(Math.abs(windowed.bpm - bpm)).toBeLessThan(1)
    }
  })
})

/* -------------------------------------------------------- constraints --- */

describe('every requirement is filed under what can actually hold it', () => {
  it('classifies each entry exactly once, with evidence', () => {
    const ids = CONSTRAINTS.map((entry) => entry.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const entry of CONSTRAINTS) {
      expect(`${entry.id}: ${entry.evidence.length > 20}`).toBe(`${entry.id}: true`)
    }
  })

  it('files tempo, key, chords, melody and seed as things ACE-Step does not control', () => {
    const uncontrolled = constraintsOf('NOT_CONTROLLED_BY_ACE_STEP').map((entry) => entry.id)
    for (const id of ['exact-bpm', 'exact-key', 'chord-progression', 'melody-contour', 'seed']) {
      expect(uncontrolled).toContain(id)
    }
  })

  it('files the single-request rule as a hard pre-render constraint', () => {
    expect(constraintsOf('PRE_RENDER_HARD_CONSTRAINT').map((entry) => entry.id))
      .toContain('single-request')
  })

  it('files actual BPM as measurable only after the render', () => {
    expect(constraintsOf('POST_RENDER_MEASUREMENT_ONLY').map((entry) => entry.id))
      .toContain('actual-bpm')
  })
})
