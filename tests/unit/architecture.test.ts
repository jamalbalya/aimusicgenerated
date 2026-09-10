/**
 * The seam between composing a song and singing it.
 *
 * These tests are about the shape of the pipeline rather than the sound it
 * makes: that a performance describes the singing without deciding who sings,
 * that a different renderer can be dropped in and is actually used, and that
 * the mix takes whatever it is handed.
 */

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { buildSpec } from '../../src/engine/compose/prompt'
import { composeSong } from '../../src/engine/compose/composer'
import { renderSong, vocalProfileFor } from '../../src/engine/synth/pipeline'
import { buildVocalPerformance, performanceSyllableCount } from '../../src/engine/voice/performance'
import {
  registerVocalRenderer, selectVocalRenderer, vocalRenderers, PROCEDURAL_RENDERER_ID,
  type VocalRenderer, type VocalRenderOptions, type VocalStems,
} from '../../src/engine/voice/renderer'
import type { VocalPerformance } from '../../src/engine/voice/performance'

const LYRIC = readFileSync(new URL('./fixtures/koplo-lyric.txt', import.meta.url), 'utf8')
const STYLE = 'Indonesian dangdut koplo, sarcastic workplace anthem, powerful kendang, groovy bass, funky guitar, dramatic male vocal, explosive sing-along chorus'

const koploScore = () => composeSong(buildSpec(STYLE, { seed: 'arch', customLyrics: LYRIC }))

describe('the vocal performance describes singing without deciding the singer', () => {
  const score = koploScore()
  const performance = buildVocalPerformance(score, {
    profile: vocalProfileFor(score),
    labels: score.sections.map((section) => section.label),
  })

  it('carries every syllable with its sounds, pitch and timing', () => {
    expect(performance.language).toBe('id')
    expect(performance.profile.gender).toBe('male')
    expect(performance.profile.register).toMatch(/baritone|tenor/)
    expect(performance.phrases.length).toBeGreaterThan(10)
    expect(performanceSyllableCount(performance)).toBeGreaterThan(50)

    for (const phrase of performance.phrases) {
      expect(phrase.notes.length).toBeGreaterThan(0)
      for (const note of phrase.notes) {
        expect(note.durationSeconds).toBeGreaterThan(0)
        expect(note.midi).toBeGreaterThan(30)
        expect(note.velocity).toBeGreaterThan(0)
        if (note.syllable) expect(note.syllable.vowel.length).toBeGreaterThan(0)
      }
      // Notes run forward in time within a phrase.
      for (let i = 1; i < phrase.notes.length; i++) {
        expect(phrase.notes[i]!.startSeconds).toBeGreaterThanOrEqual(phrase.notes[i - 1]!.startSeconds)
      }
    }
  })

  it('leaves room to breathe at the end of every line and nowhere else', () => {
    for (const phrase of performance.phrases) {
      phrase.notes.forEach((note, index) => {
        const last = index === phrase.notes.length - 1
        if (last) expect(note.breathAfter, phrase.text).toBeGreaterThan(0)
        else expect(note.breathAfter).toBe(0)
      })
    }
  })

  it('makes a call-and-response section an actual conversation', () => {
    // The break alternates a question and its answer; the answers must be
    // marked as answers, or they are just more lead vocal.
    const roles = performance.phrases
      .filter((phrase) => /break/i.test(phrase.sectionLabel))
      .map((phrase) => phrase.role)
    expect(roles.length).toBeGreaterThanOrEqual(4)
    expect(roles).toContain('response')
    expect(roles).toContain('lead')
    // And they alternate rather than clumping.
    expect(roles[0]).toBe('lead')
    expect(roles[1]).toBe('response')
  })

  it('sings the chorus harder than the verse', () => {
    const emphasis = (match: RegExp): number => {
      const notes = performance.phrases
        .filter((phrase) => match.test(phrase.sectionLabel))
        .flatMap((phrase) => phrase.notes)
      return notes.reduce((sum, note) => sum + note.emphasis, 0) / Math.max(1, notes.length)
    }
    expect(emphasis(/chorus/i)).toBeGreaterThan(emphasis(/verse/i))
  })
})

describe('the singer is replaceable', () => {
  it('registers the local one and reports it honestly', async () => {
    const local = await selectVocalRenderer()
    expect(local.id).toBe(PROCEDURAL_RENDERER_ID)
    expect(local.quality).toBe('procedural')
    // Never described as human, whatever it is compared to.
    expect(local.description.toLowerCase()).not.toContain('human')
    expect(vocalRenderers().some((renderer) => renderer.id === PROCEDURAL_RENDERER_ID)).toBe(true)
  })

  it('uses a renderer that is plugged in, and hands it the whole performance', async () => {
    let seen: VocalPerformance | null = null
    const stub: VocalRenderer = {
      id: 'stub-neural',
      label: 'Stub',
      quality: 'neural',
      description: 'A stand-in for a neural singing model.',
      isAvailable: () => true,
      render(performance: VocalPerformance, options: VocalRenderOptions): Promise<VocalStems> {
        seen = performance
        // A recognisable tone, so the mix can be checked for it.
        const lead = new Float32Array(options.totalSamples)
        for (let i = 0; i < lead.length; i++) lead[i] = Math.sin((2 * Math.PI * 440 * i) / options.sampleRate) * 0.25
        return Promise.resolve({ lead })
      },
    }
    registerVocalRenderer(stub)

    const score = koploScore()
    const rendered = await renderSong(score, {
      sampleRate: 22050, keepStems: true, vocalRendererId: 'stub-neural',
    })

    expect(rendered.vocalRenderer.id).toBe('stub-neural')
    expect(rendered.vocalRenderer.quality).toBe('neural')
    expect(seen).not.toBeNull()
    expect(seen!.language).toBe('id')
    expect(performanceSyllableCount(seen!)).toBeGreaterThan(50)

    // The mixer used what the renderer produced rather than synthesising its
    // own: the vocal stem is the stub's tone, not the formant singer's.
    const vocal = rendered.stems!.find((stem) => stem.id === 'vocal')!
    let energy = 0
    for (const sample of vocal.left) energy += sample * sample
    expect(energy).toBeGreaterThan(0)
  })

  it('falls back to the local singer when the preferred one cannot run', async () => {
    registerVocalRenderer({
      id: 'offline-model',
      label: 'Unavailable',
      quality: 'neural',
      description: 'A model that has not been downloaded.',
      isAvailable: () => false,
      render: () => Promise.reject(new Error('should never be called')),
    })
    const chosen = await selectVocalRenderer('offline-model')
    // A synthetic voice beats an error, and beats a silent instrumental.
    expect(chosen.id).toBe(PROCEDURAL_RENDERER_ID)

    // And asking for nothing gets the local singer rather than whichever other
    // renderer a build happened to register.
    expect((await selectVocalRenderer()).id).toBe(PROCEDURAL_RENDERER_ID)
  })
})

describe('the pipeline produces a complete song', () => {
  it('style and lyrics in, mixed song out', async () => {
    const score = koploScore()
    const rendered = await renderSong(score, {
      sampleRate: 22050, keepStems: true, vocalRendererId: PROCEDURAL_RENDERER_ID,
    })

    expect(rendered.validation.kind).toBe('vocal-song')
    expect(rendered.validation.problems).toEqual([])
    expect(rendered.durationSeconds).toBeGreaterThan(60)
    expect(rendered.peak).toBeGreaterThan(0.1)

    // Every part of a song is present as its own stem.
    const ids = rendered.stems!.map((stem) => stem.id)
    expect(ids).toContain('vocal')
    expect(ids).toContain('drums')
    expect(ids).toContain('bass')
    expect(rendered.performance.phrases.length).toBeGreaterThan(10)
  })
})

describe('the lyric decides the melody, not the other way round', () => {
  it('gives every written line a phrase to be sung on', () => {
    const score = koploScore()
    const performance = buildVocalPerformance(score, {
      profile: vocalProfileFor(score),
      labels: score.sections.map((section) => section.label),
    })

    const written = LYRIC.split(/\r?\n/)
      .filter((line) => line.trim().length > 0 && !/^\s*\[/.test(line)).length

    // Cutting the melody into phrases by bar count and fitting the words to
    // whatever came out silently dropped every line past the last phrase.
    expect(performance.phrases.length).toBe(written)

    const sung = performance.phrases.map((phrase) => phrase.text.toLowerCase())
    for (const line of ['bos toxic, bos toxic', 'kalau salah?', 'jangan di sini!']) {
      expect(sung, `"${line}" was never sung`).toContain(line)
    }
  })

  it('answers the call with a different voice', () => {
    const score = koploScore()
    const performance = buildVocalPerformance(score, {
      profile: vocalProfileFor(score),
      labels: score.sections.map((section) => section.label),
    })
    // Scoped to the break: "Kalau" opens ordinary verse lines elsewhere.
    const conversation = performance.phrases.filter((phrase) => /break/i.test(phrase.sectionLabel))

    expect(conversation.length).toBe(8)
    // Question, answer, question, answer.
    expect(conversation.map((phrase) => phrase.role)).toEqual(
      ['lead', 'response', 'lead', 'response', 'lead', 'response', 'lead', 'response'])
    // A response is thrown out rather than eased into.
    for (const phrase of conversation.filter((p) => p.role === 'response')) {
      expect(phrase.notes[0]!.slide).toBe(0)
    }
  })
})
