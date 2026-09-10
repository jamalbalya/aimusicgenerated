import { describe, expect, it } from 'vitest'
import { buildSpec } from '../../src/engine/compose/prompt'
import { composeSong } from '../../src/engine/compose/composer'
import { renderScore, swingBeat } from '../../src/engine/synth/render'
import { renderVoice, getPatch, voiceLength } from '../../src/engine/synth/instruments'
import { drumLength, renderDrum } from '../../src/engine/synth/drumkit'
import { renderSungNote, planSegments, SING_PRESETS, sungNoteLength } from '../../src/engine/voice/singer'
import { isVowel } from '../../src/engine/voice/phonemes'
import { englishSyllable, pronounceWord } from '../../src/engine/lang'
import { vowelFormants, VOICE_TYPES } from '../../src/engine/voice/formants'
import { estimateSpeechDuration, planSpeech, SPEECH_VOICES, splitSentences, synthesizeSpeech } from '../../src/engine/voice/speech'
import { measureLoudness } from '../../src/engine/audio/analyze'
import { stft } from '../../src/engine/audio/stft'
import type { InstrumentId } from '../../src/engine/compose/types'

const RATE = 16000

function isClean(buffer: Float32Array, label: string): void {
  for (let i = 0; i < buffer.length; i++) {
    if (!Number.isFinite(buffer[i]!)) throw new Error(`${label}: non-finite sample at ${i}`)
    if (Math.abs(buffer[i]!) > 8) throw new Error(`${label}: runaway sample ${buffer[i]} at ${i}`)
  }
}

function energy(buffer: Float32Array): number {
  let sum = 0
  for (let i = 0; i < buffer.length; i++) sum += buffer[i]! * buffer[i]!
  return Math.sqrt(sum / Math.max(1, buffer.length))
}

const ALL_INSTRUMENTS: InstrumentId[] = [
  'grandPiano', 'electricPiano', 'organ', 'nylonGuitar', 'cleanGuitar', 'crunchGuitar',
  'distortedGuitar', 'acousticBass', 'electricBass', 'subBass', 'synthBass', 'reeseBass',
  'sawLead', 'squareLead', 'pluck', 'bell', 'marimba', 'warmPad', 'glassPad', 'choirPad',
  'strings', 'brass', 'flute', 'violin', 'cello', 'harp', 'sitar', 'accordion', 'chiptune',
  'noiseSweep', 'vocal',
]

describe('instrument voices', () => {
  it.each(ALL_INSTRUMENTS)('%s renders clean audible audio', (instrument) => {
    const buffer = renderVoice({
      instrument, midi: 60, duration: 0.4, velocity: 0.8, sampleRate: RATE, brightness: 0.6, seed: 42,
    })
    isClean(buffer, instrument)
    expect(buffer.length).toBeGreaterThan(RATE * 0.3)
    expect(energy(buffer)).toBeGreaterThan(0.0005)
  })

  it('covers the full playable range without aliasing into silence', () => {
    for (const midi of [24, 36, 48, 60, 72, 84, 96]) {
      const buffer = renderVoice({
        instrument: 'sawLead', midi, duration: 0.2, velocity: 0.9, sampleRate: RATE, brightness: 0.8, seed: midi,
      })
      isClean(buffer, `sawLead@${midi}`)
      expect(energy(buffer)).toBeGreaterThan(0.0005)
    }
  })

  it('starts and ends at silence, so notes do not click', () => {
    for (const instrument of ['grandPiano', 'warmPad', 'sawLead', 'cleanGuitar'] as InstrumentId[]) {
      const buffer = renderVoice({
        instrument, midi: 60, duration: 0.3, velocity: 0.9, sampleRate: RATE, brightness: 0.6, seed: 1,
      })
      expect(Math.abs(buffer[0]!)).toBeLessThan(0.05)
      expect(Math.abs(buffer[buffer.length - 1]!)).toBeLessThan(0.05)
    }
  })

  it('scales with velocity', () => {
    const quiet = renderVoice({ instrument: 'sawLead', midi: 60, duration: 0.3, velocity: 0.2, sampleRate: RATE, brightness: 0.6, seed: 3 })
    const loud = renderVoice({ instrument: 'sawLead', midi: 60, duration: 0.3, velocity: 1, sampleRate: RATE, brightness: 0.6, seed: 3 })
    expect(energy(loud)).toBeGreaterThan(energy(quiet) * 2)
  })

  it('is deterministic', () => {
    const make = () => renderVoice({ instrument: 'bell', midi: 67, duration: 0.3, velocity: 0.7, sampleRate: RATE, brightness: 0.5, seed: 9 })
    expect(Array.from(make())).toEqual(Array.from(make()))
  })

  it('reports its own buffer length', () => {
    const request = { instrument: 'grandPiano' as InstrumentId, midi: 60, duration: 0.5, velocity: 0.8, sampleRate: RATE, brightness: 0.6, seed: 1 }
    expect(voiceLength(request)).toBeGreaterThanOrEqual(renderVoice(request).length)
    expect(getPatch('grandPiano').env.attack).toBeGreaterThan(0)
  })

  it('survives degenerate requests', () => {
    for (const duration of [0.001, 0.01]) {
      const buffer = renderVoice({ instrument: 'pluck', midi: 60, duration, velocity: 0.5, sampleRate: RATE, brightness: 0.5, seed: 1 })
      isClean(buffer, `pluck@${duration}`)
    }
  })
})

describe('drum kit', () => {
  const drums = [
    'kick', 'snare', 'clap', 'rim', 'hatClosed', 'hatOpen', 'hatPedal', 'tomLow', 'tomMid',
    'tomHigh', 'crash', 'ride', 'shaker', 'tambourine', 'cowbell', 'conga', 'perc',
    'reverseCymbal', 'sweepUp', 'impact',
  ] as const

  it.each(drums)('%s renders clean audible audio', (drum) => {
    const request = { drum, velocity: 0.9, sampleRate: RATE, duration: 0.25, seed: 5, brightness: 0.6, tune: 0 }
    const buffer = renderDrum(request)
    isClean(buffer, drum)
    expect(buffer.length).toBe(drumLength(request))
    expect(energy(buffer)).toBeGreaterThan(0.0005)
  })

  it('responds to tuning and velocity', () => {
    const base = { drum: 'kick' as const, sampleRate: RATE, duration: 0.25, seed: 5, brightness: 0.6 }
    const quiet = renderDrum({ ...base, velocity: 0.2, tune: 0 })
    const loud = renderDrum({ ...base, velocity: 1, tune: 0 })
    expect(energy(loud)).toBeGreaterThan(energy(quiet))
    isClean(renderDrum({ ...base, velocity: 0.9, tune: -5 }), 'kick tuned')
  })
})

describe('phonemes', () => {
  it('splits a syllable into onset, vowel and coda', () => {
    expect(englishSyllable('cat')).toEqual({ text: 'cat', onset: ['K'], vowel: 'AE', coda: ['T'] })
    expect(englishSyllable('shine').vowel).toBe('AY')
    expect(englishSyllable('shine').onset).toEqual(['SH'])
    expect(englishSyllable('go').vowel).toBe('OW')
    expect(englishSyllable('night').vowel).toBe('AY')
    expect(englishSyllable('rain').vowel).toBe('EY')
  })

  it('always returns a vowel, even for consonant clusters', () => {
    for (const text of ['', 'brr', 'xyz', '123', 'strength']) {
      const parts = englishSyllable(text)
      expect(isVowel(parts.vowel)).toBe(true)
    }
  })

  it('produces a full phoneme list', () => {
    const [syllable] = pronounceWord('start', 'en')
    expect(syllable).toBeDefined()
    expect(syllable!.onset.length + 1 + syllable!.coda.length).toBeGreaterThan(2)
  })

  it('has formants for every vowel and voice type', () => {
    for (const voice of VOICE_TYPES) {
      const formants = vowelFormants('AA', voice)
      expect(formants).toHaveLength(4)
      for (const formant of formants) {
        expect(formant.freq).toBeGreaterThan(100)
        expect(formant.freq).toBeLessThan(6000)
        expect(formant.bandwidth).toBeGreaterThan(0)
      }
    }
    // Longer tracts sit lower: a bass's first formant is below a soprano's.
    expect(vowelFormants('AA', 'bass')[0]!.freq).toBeLessThan(vowelFormants('AA', 'soprano')[0]!.freq)
  })
})

describe('singing', () => {
  it('renders a sung syllable cleanly', () => {
    for (const preset of Object.values(SING_PRESETS)) {
      const buffer = renderSungNote({
        midi: 60, duration: 0.5, velocity: 0.9, sounds: englishSyllable('love'),
        sampleRate: RATE, style: preset, seed: 7, legato: false,
      })
      isClean(buffer, `sing ${preset.voice}`)
      expect(energy(buffer)).toBeGreaterThan(0.0008)
    }
  })

  it('plans segments that fill the note', () => {
    const request = {
      midi: 60, duration: 0.6, velocity: 0.8, sounds: englishSyllable('shine'),
      sampleRate: RATE, style: SING_PRESETS.pop!, seed: 1, legato: false,
    }
    const segments = planSegments(request)
    const total = segments.reduce((sum, s) => sum + s.seconds, 0)
    expect(total).toBeGreaterThan(0.3)
    expect(total).toBeLessThanOrEqual(0.62)
    expect(sungNoteLength(request)).toBeGreaterThan(RATE * 0.6)
  })

  it('handles empty and legato syllables', () => {
    const cases: [string, boolean][] = [['', false], ['ah', true], ['', true]]
    for (const [syllable, legato] of cases) {
      const buffer = renderSungNote({
        midi: 62, duration: 0.3, velocity: 0.8,
        sounds: syllable ? englishSyllable(syllable) : null,
        sampleRate: RATE, style: SING_PRESETS.pop!, seed: 2, legato,
      })
      isClean(buffer, `sing "${syllable}" legato=${legato}`)
    }
  })

  it('sings the requested pitch', () => {
    // Goertzel: energy at a single frequency over the steady part of the note.
    const energyAt = (buffer: Float32Array, freq: number): number => {
      const start = Math.floor(buffer.length * 0.3)
      const end = Math.floor(buffer.length * 0.8)
      const w = (2 * Math.PI * freq) / RATE
      const coefficient = 2 * Math.cos(w)
      let s1 = 0
      let s2 = 0
      for (let i = start; i < end; i++) {
        const s0 = buffer[i]! + coefficient * s1 - s2
        s2 = s1
        s1 = s0
      }
      return Math.sqrt(s1 * s1 + s2 * s2 - coefficient * s1 * s2) / (end - start)
    }

    for (const midi of [48, 60, 72]) {
      const buffer = renderSungNote({
        midi, duration: 0.6, velocity: 0.9, sounds: englishSyllable('ah'),
        sampleRate: RATE, style: SING_PRESETS.robot!, seed: 1, legato: false,
      })
      const expected = 440 * Math.pow(2, (midi - 69) / 12)
      const atPitch = energyAt(buffer, expected)
      // A semitone either side must carry noticeably less energy.
      expect(atPitch).toBeGreaterThan(energyAt(buffer, expected * Math.pow(2, 1 / 12)) * 1.5)
      expect(atPitch).toBeGreaterThan(energyAt(buffer, expected * Math.pow(2, -1 / 12)) * 1.5)
    }
  })
})

describe('speech', () => {
  it('splits sentences and keeps terminators', () => {
    expect(splitSentences('Hello there. How are you? Great!')).toEqual([
      { text: 'Hello there', terminator: '.' },
      { text: 'How are you', terminator: '?' },
      { text: 'Great', terminator: '!' },
    ])
    expect(splitSentences('no terminator')).toEqual([{ text: 'no terminator', terminator: '' }])
    expect(splitSentences('')).toEqual([])
  })

  it.each(SPEECH_VOICES)('renders with the $id voice', (voice) => {
    const audio = synthesizeSpeech('Hello there, this is a test.', { voice, sampleRate: RATE })
    isClean(audio.channels[0]!, voice.id)
    expect(audio.channels).toHaveLength(2)
    expect(audio.channels[0]!.length).toBeGreaterThan(RATE * 0.5)
    expect(energy(audio.channels[0]!)).toBeGreaterThan(0.01)
  })

  it('gets longer with more text and shorter at higher speed', () => {
    const voice = SPEECH_VOICES[2]!
    const short = estimateSpeechDuration('Hello.', { voice })
    const long = estimateSpeechDuration('Hello there, this is a much longer sentence to read aloud.', { voice })
    expect(long).toBeGreaterThan(short * 2)
    expect(estimateSpeechDuration('Hello there friend.', { voice, speed: 2 }))
      .toBeLessThan(estimateSpeechDuration('Hello there friend.', { voice, speed: 1 }))
  })

  it('handles empty and punctuation-only text', () => {
    for (const text of ['', '   ', '...', '!!!']) {
      const audio = synthesizeSpeech(text, { voice: SPEECH_VOICES[0]!, sampleRate: RATE })
      isClean(audio.channels[0]!, `speech "${text}"`)
      expect(audio.channels[0]!.length).toBeGreaterThan(0)
    }
    expect(planSpeech('', { voice: SPEECH_VOICES[0]! }).length).toBeGreaterThan(0)
  })

  it('applies pitch and expressiveness settings', () => {
    const voice = SPEECH_VOICES[3]!
    const monotone = synthesizeSpeech('Is this a question?', { voice, sampleRate: RATE, expressiveness: 0 })
    const lively = synthesizeSpeech('Is this a question?', { voice, sampleRate: RATE, expressiveness: 2 })
    isClean(monotone.channels[0]!, 'monotone')
    isClean(lively.channels[0]!, 'lively')
    const shifted = synthesizeSpeech('Hello.', { voice, sampleRate: RATE, pitchSemitones: 7 })
    isClean(shifted.channels[0]!, 'shifted')
  })
})

describe('swing', () => {
  it('delays only off-grid subdivisions', () => {
    expect(swingBeat(0, 0.3, 8)).toBe(0)
    expect(swingBeat(0.5, 0.3, 8)).toBeCloseTo(0.5 + 0.3 * 0.5 * 0.5, 6)
    expect(swingBeat(1, 0.3, 8)).toBe(1)
    expect(swingBeat(0.25, 0.3, 16)).toBeCloseTo(0.25 + 0.3 * 0.25 * 0.5, 6)
    expect(swingBeat(0.37, 0.3, 16)).toBe(0.37)
    expect(swingBeat(0.5, 0, 8)).toBe(0.5)
  })
})

describe('full render', () => {
  const prompts = [
    'an upbeat pop song about summer',
    'dark trap beat, instrumental',
    'ambient meditation, instrumental',
    'heavy metal',
    'jazz lounge, instrumental',
  ]

  it.each(prompts)('renders "%s" to clean audio', (prompt) => {
    const score = composeSong(buildSpec(prompt, { seed: `r-${prompt}`, durationSeconds: 16 }))
    const result = renderScore(score, { sampleRate: RATE })

    isClean(result.left, `${prompt} L`)
    isClean(result.right, `${prompt} R`)
    expect(result.left.length).toBe(result.right.length)
    expect(result.durationSeconds).toBeGreaterThan(10)
    expect(result.peak).toBeGreaterThan(0.4)
    expect(result.peak).toBeLessThanOrEqual(1)
    expect(result.loudnessDb).toBeGreaterThan(-30)
    expect(result.loudnessDb).toBeLessThan(0)
    expect(measureLoudness({ channels: [result.left, result.right], sampleRate: RATE }).clipping).toBe(false)
  })

  it('lands every genre at the same loudness', () => {
    const measured: number[] = []
    for (const prompt of ['an upbeat pop song', 'ambient meditation instrumental', 'heavy metal', 'lofi chill instrumental']) {
      const score = composeSong(buildSpec(prompt, { seed: `loud-${prompt}`, durationSeconds: 14 }))
      const result = renderScore(score, { sampleRate: RATE })
      const loudness = measureLoudness({ channels: [result.left, result.right], sampleRate: RATE })
      expect(loudness.clipping).toBe(false)
      measured.push(loudness.lufs)
    }
    // Auditioning one track after another should not mean reaching for the
    // volume control, so the spread has to be small.
    expect(Math.max(...measured) - Math.min(...measured)).toBeLessThan(2.5)
    for (const lufs of measured) expect(lufs).toBeGreaterThan(-17)
  })

  it('does not pile the whole mix into the low end', () => {
    // Synthesised material is naturally low-heavy; a mix where almost nothing
    // sits where melody and words live is the classic failure.
    for (const prompt of ['an upbeat pop song about summer', 'heavy metal', 'dark trap beat instrumental']) {
      const score = composeSong(buildSpec(prompt, { seed: `band-${prompt}`, durationSeconds: 14 }))
      const result = renderScore(score, { sampleRate: RATE })
      const spectrum = stft(result.left, 1024, 1024, RATE)

      const bands = [0, 0, 0, 0]
      let total = 0
      for (const frame of spectrum.magnitude) {
        for (let bin = 1; bin < frame.length; bin++) {
          const freq = (bin * RATE) / 1024
          const power = frame[bin]! * frame[bin]!
          total += power
          if (freq < 250) bands[0]! += power
          else if (freq < 800) bands[1]! += power
          else if (freq < 2500) bands[2]! += power
          else bands[3]! += power
        }
      }
      const share = bands.map((value) => value / Math.max(1e-12, total))
      expect(share[0], `${prompt} lows`).toBeLessThan(0.62)
      expect(share[1], `${prompt} low-mids`).toBeGreaterThan(0.16)
      expect(share[2], `${prompt} mids`).toBeGreaterThan(0.05)
    }
  })

  it('reports monotonically increasing progress ending at one', () => {
    const score = composeSong(buildSpec('a pop song', { seed: 'prog', durationSeconds: 12 }))
    const seen: number[] = []
    renderScore(score, { sampleRate: RATE, onProgress: (p) => seen.push(p) })
    expect(seen.length).toBeGreaterThan(2)
    expect(seen[seen.length - 1]).toBe(1)
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1]!)
  })

  it('produces stems that sum to roughly the mix', () => {
    const score = composeSong(buildSpec('a pop song', { seed: 'stems', durationSeconds: 12 }))
    const result = renderScore(score, { sampleRate: RATE, keepStems: true })
    expect(result.stems).toBeDefined()
    expect(result.stems!.length).toBe(score.tracks.length + 1)
    for (const stem of result.stems!) {
      expect(stem.left.length).toBe(result.left.length)
      isClean(stem.left, `stem ${stem.id}`)
    }
    expect(result.stems!.some((s) => s.id === 'drums')).toBe(true)
  })

  it('can exclude tracks for instrumental and karaoke exports', () => {
    const score = composeSong(buildSpec('a pop song about the sea', { seed: 'karaoke', durationSeconds: 12, vocals: 'sung' }))
    expect(score.tracks.some((t) => t.id === 'vocal')).toBe(true)
    const full = renderScore(score, { sampleRate: RATE })
    const karaoke = renderScore(score, { sampleRate: RATE, excludeTrackIds: ['vocal', 'vocalHarmony'] })
    isClean(karaoke.left, 'karaoke')
    expect(karaoke.left.length).toBe(full.left.length)

    const drumless = renderScore(score, { sampleRate: RATE, includeDrums: false })
    isClean(drumless.left, 'drumless')
  })

  it('is deterministic', () => {
    const score = composeSong(buildSpec('a pop song', { seed: 'det', durationSeconds: 8 }))
    const a = renderScore(score, { sampleRate: RATE })
    const b = renderScore(score, { sampleRate: RATE })
    expect(a.peak).toBe(b.peak)
    for (let i = 0; i < a.left.length; i += 501) expect(a.left[i]).toBe(b.left[i])
  })

  it('renders at every supported sample rate', () => {
    const score = composeSong(buildSpec('a pop song', { seed: 'rates', durationSeconds: 8 }))
    for (const sampleRate of [22050, 32000, 44100]) {
      const result = renderScore(score, { sampleRate })
      expect(result.sampleRate).toBe(sampleRate)
      isClean(result.left, `rate ${sampleRate}`)
    }
  })
})
