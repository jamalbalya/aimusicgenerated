/**
 * A refusal in the Style is a refusal, not a request.
 *
 * Reported from production: a style line ending "dignified sorrow, no jazz,
 * no EDM." produced a swung jazz track. `detectGenre` asks whether the text
 * contains a genre's label, `"no jazz".includes('jazz')` is true, and a named
 * genre outranks every tag score — so the refusal was the single strongest
 * signal in the sentence. The caption that went to the model read:
 *
 *     "...dignified sorrow, no jazz, no EDM., Jazz, roots, ... swung hard"
 *
 * The person said no jazz; the engine replied Jazz, twice, and picked jazz
 * progressions and a swing feel to match.
 *
 * The same report exposed a second one. Tags are matched as plain substrings,
 * so the tag 'melancholy' does not match "deeply melancholic" and 'lonely'
 * does not match "quiet loneliness". Both scored zero, Romantic won on the one
 * word "intimate", and a song about a father too tired to speak came out in a
 * major key.
 */

import { describe, expect, it } from 'vitest'
import {
  detectGenre, detectMood, detectGenreDetailed, genreIsConfident,
  parseExclusions, isExcluded, withoutExclusions, buildSpec,
} from '../../src/engine/compose/prompt'
import { planLiveGeneration } from '../../src/engine/live/plan'
import { compilePrompt } from '../../src/engine/live/promptCompiler'

/** buildSpec's own normalisation, so these read the text the detector reads. */
const norm = (raw: string) =>
  ` ${raw.toLowerCase().replace(/[^\p{L}\p{N}#&'\s.,;-]/gu, ' ').replace(/\s+/g, ' ')} `

const REPORTED_STYLE = 'Cinematic Indonesian pop ballad, 84 BPM, deeply melancholic and '
  + 'intimate, warm mature male vocal, emotional grand piano, soft acoustic guitar, subtle '
  + 'warm strings, deep gentle bass, minimal organic percussion, spacious restrained '
  + 'production, simple poetic lyrics, short memorable phrases, quiet loneliness, emptiness '
  + 'and inner strength, gradual emotional build, heartfelt final chorus, dignified sorrow, '
  + 'no jazz, no EDM.'

const LYRICS = '[Intro, Sparse Piano]\nMalam turun perlahan\nRumah mulai kehilangan suara\n\n'
  + '[Chorus, Emotional Pop Vocal]\nDi balik diamnya ayah\nAda hati yang sedang lelah\n\n[End]\n'

describe('a style that refuses a genre does not get that genre', () => {
  it('reads "no jazz, no EDM" as two refusals', () => {
    expect(parseExclusions(norm(REPORTED_STYLE))).toEqual(
      expect.arrayContaining(['jazz', 'edm']))
    expect(isExcluded(REPORTED_STYLE, 'Jazz')).toBe(true)
    expect(isExcluded(REPORTED_STYLE, 'EDM')).toBe(true)
  })

  it('the reported style detects Pop, not Jazz', () => {
    expect(detectGenre(norm(REPORTED_STYLE))?.label).toBe('Pop')
  })

  it('and the caption never contains the refused genre as a direction', () => {
    const plan = planLiveGeneration({
      style: REPORTED_STYLE, lyrics: LYRICS, instrumental: false,
      vocalGender: 'male', language: 'auto', durationSeconds: 210,
    })
    const compiled = compilePrompt(plan, REPORTED_STYLE)
    // The person's own "no jazz" is still there — their words are never edited.
    expect(compiled.caption).toContain('no jazz')
    // What must not be there is the engine appending Jazz after it.
    const appended = compiled.caption.slice(REPORTED_STYLE.length)
    expect(appended.toLowerCase()).not.toContain('jazz')
    expect(appended.toLowerCase()).not.toContain('swung')
    expect(appended.toLowerCase()).not.toContain('shuffled')
  })

  it('refuses the genre however the refusal is worded', () => {
    for (const phrase of ['no jazz', 'not jazz', 'without jazz', 'avoid jazz',
      'never jazz', 'exclude jazz', 'non jazz']) {
      const text = norm(`Warm piano ballad, ${phrase}.`)
      expect(isExcluded(text, 'Jazz')).toBe(true)
      expect(detectGenre(text)?.label ?? 'none').not.toBe('Jazz')
    }
  })

  it('understands the refusal in Indonesian too', () => {
    // The people writing these sheets write in Indonesian. "tanpa" is without,
    // "bukan" is not, "jangan" is don't.
    for (const phrase of ['tanpa jazz', 'bukan jazz', 'jangan jazz', 'hindari jazz']) {
      const text = norm(`Balada piano hangat, ${phrase}.`)
      expect(isExcluded(text, 'Jazz')).toBe(true)
      expect(detectGenre(text)?.label ?? 'none').not.toBe('Jazz')
    }
  })

  it('still gives jazz to somebody who actually asks for it', () => {
    // The fix must not make the word unusable. This is the regression that
    // matters: a refusal is narrow, and everything else is unchanged.
    expect(detectGenre(norm('Smoky jazz ballad at 72 BPM, brushed drums'))?.label)
      .toBe('Jazz')
    expect(detectGenre(norm('Bossa nova with soft nylon guitar'))?.label)
      .toBe('Bossa Nova')
  })

  it('a refusal of one genre leaves the others alone', () => {
    const text = norm('Upbeat disco groove, no jazz')
    expect(detectGenre(text)?.label).toBe('Disco / Funk')
    expect(isExcluded(text, 'Disco')).toBe(false)
  })

  it('blanking a refusal does not join the words either side', () => {
    const text = norm('warm piano, no jazz, soft strings')
    const masked = withoutExclusions(text)
    expect(masked).not.toContain('jazz')
    expect(masked.length).toBe(text.length)
    expect(masked).toContain('warm piano')
    expect(masked).toContain('soft strings')
  })

  it('a refused genre is not counted as confidently detected', () => {
    const detection = detectGenreDetailed(norm('Soft ballad, no jazz, no swing'))
    if (detection) {
      expect(detection.genre.label).not.toBe('Jazz')
      // And if nothing else was named, it must not be confident enough to
      // write a guess into the caption.
      if (!genreIsConfident(detection)) expect(detection.matches).toBeLessThan(2)
    }
  })
})

describe('the words people actually write for sadness are read as sadness', () => {
  it('"deeply melancholic" is sad, not merely intimate', () => {
    expect(detectMood(norm('deeply melancholic and intimate ballad'))?.id).toBe('sad')
  })

  it('"quiet loneliness" is sad', () => {
    expect(detectMood(norm('a song of quiet loneliness'))?.id).toBe('sad')
  })

  it('the inflections of the existing tags all read', () => {
    for (const word of ['melancholic', 'melancholia', 'loneliness', 'sadness',
      'heartbroken', 'sorrowful', 'grief', 'mournful']) {
      expect(detectMood(norm(`a ${word} piano piece`))?.id).toBe('sad')
    }
  })

  it('the reported style lands in a minor key', () => {
    const spec = buildSpec(REPORTED_STYLE, { seed: 'fixed' })
    expect(spec.mood.id).toBe('sad')
    expect(['minor', 'harmonicMinor', 'melodicMinor', 'dorian', 'phrygian'])
      .toContain(spec.key.scale)
  })

  it('and still respects the stated tempo', () => {
    expect(buildSpec(REPORTED_STYLE, { seed: 'fixed' }).bpm).toBe(84)
  })

  it('a genuinely romantic style is still romantic', () => {
    expect(detectMood(norm('tender romantic wedding song, sweet and warm'))?.id)
      .toBe('romantic')
  })
})
