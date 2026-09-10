import { describe, expect, it } from 'vitest'
import { lineSyllables, splitSyllables, syllablesInLine, syllablesInWord } from '../../src/engine/lyrics/syllables'
import { findRhymes, groupByRhyme, rhymeKey, rhymes } from '../../src/engine/lyrics/rhyme'
import { article, gerund, isCountable, pluralize, thirdPerson } from '../../src/engine/lyrics/inflect'
import { generateLyrics, schemeLabels, themeKeywords } from '../../src/engine/lyrics/generator'
import { RHYME_WORDS, VERSE_TEMPLATES, CHORUS_TEMPLATES, BRIDGE_TEMPLATES, RAP_TEMPLATES, OPENER_TEMPLATES } from '../../src/engine/lyrics/vocab'
import type { Mood } from '../../src/engine/compose/prompt'

describe('syllables', () => {
  const cases: [string, number][] = [
    ['cat', 1], ['water', 2], ['beautiful', 3], ['the', 1], ['make', 1],
    ['table', 2], ['little', 2], ['running', 2], ['wanted', 2], ['jumped', 1],
    ['watches', 2], ['rhythm', 2], ['fire', 2], ['every', 3], ['ocean', 2],
    ['midnight', 2], ['shadow', 2], ['forever', 3], ['remember', 3], ['go', 1],
  ]
  it.each(cases)('counts %s as %i syllables', (word, expected) => {
    expect(syllablesInWord(word)).toBe(expected)
  })

  it('never returns zero for a real word', () => {
    for (const word of ['a', 'I', 'strengths', 'rhythm', 'x']) {
      expect(syllablesInWord(word)).toBeGreaterThanOrEqual(1)
    }
  })

  it('counts a line', () => {
    expect(syllablesInLine('I was standing in the rain')).toBe(7)
    expect(syllablesInLine('')).toBe(0)
  })

  it('splits a word into one chunk per syllable', () => {
    for (const word of ['water', 'beautiful', 'midnight', 'remember', 'shadow', 'ocean', 'table']) {
      expect(splitSyllables(word)).toHaveLength(syllablesInWord(word))
    }
  })

  it('keeps every letter when splitting', () => {
    for (const word of ['everything', 'nightingale', 'carousel', 'wanderer']) {
      expect(splitSyllables(word).join('')).toBe(word)
    }
  })

  it('splits a full line', () => {
    const chunks = lineSyllables('I keep the golden fire')
    expect(chunks.length).toBe(syllablesInLine('I keep the golden fire'))
    expect(chunks.every((c) => c.length > 0)).toBe(true)
  })
})

describe('rhyme', () => {
  it('matches obvious rhymes', () => {
    expect(rhymes('night', 'light')).toBe(true)
    expect(rhymes('day', 'away')).toBe(true)
    expect(rhymes('gold', 'cold')).toBe(true)
    expect(rhymes('heart', 'start')).toBe(true)
  })

  it('rejects non-rhymes and self-rhymes', () => {
    expect(rhymes('night', 'orange')).toBe(false)
    expect(rhymes('night', 'night')).toBe(false)
    expect(rhymes('', 'night')).toBe(false)
  })

  it('produces a stable key', () => {
    expect(rhymeKey('light')).toBe(rhymeKey('night'))
    expect(rhymeKey('runner')).toBe(rhymeKey('stunner'))
  })

  it('groups only real groups', () => {
    const groups = groupByRhyme(['night', 'light', 'orange'])
    expect(groups.size).toBe(1)
    expect([...groups.values()][0]).toEqual(['night', 'light'])
  })

  it('finds rhymes in a pool', () => {
    const found = findRhymes('night', ['light', 'bright', 'night', 'dog'])
    expect(found).toEqual(['light', 'bright'])
  })

  it('every rhyme lexicon group has at least two members', () => {
    const groups = groupByRhyme(RHYME_WORDS.map((w) => w.word))
    expect(groups.size).toBeGreaterThan(12)
    for (const group of groups.values()) expect(group.length).toBeGreaterThanOrEqual(2)
  })
})

describe('inflection', () => {
  it('forms gerunds', () => {
    expect(gerund('run')).toBe('running')
    expect(gerund('make')).toBe('making')
    expect(gerund('carry')).toBe('carrying')
    expect(gerund('see')).toBe('seeing')
    expect(gerund('drift')).toBe('drifting')
    expect(gerund('let go')).toBe('letting go')
    expect(gerund('begin')).toBe('beginning')
    expect(gerund('remember')).toBe('remembering')
    expect(gerund('travel')).toBe('travelling')
  })

  it('forms third person singular', () => {
    expect(thirdPerson('run')).toBe('runs')
    expect(thirdPerson('watch')).toBe('watches')
    expect(thirdPerson('carry')).toBe('carries')
    expect(thirdPerson('go')).toBe('goes')
    expect(thirdPerson('play')).toBe('plays')
    expect(thirdPerson('move on')).toBe('moves on')
  })

  it('pluralises', () => {
    expect(pluralize('star')).toBe('stars')
    expect(pluralize('box')).toBe('boxes')
    expect(pluralize('memory')).toBe('memories')
    expect(pluralize('life')).toBe('lives')
    expect(pluralize('day')).toBe('days')
  })

  it('knows which nouns cannot be pluralised', () => {
    expect(isCountable('star')).toBe(true)
    expect(isCountable('lightning')).toBe(false)
    expect(isCountable('Thunder')).toBe(false)
  })

  it('chooses articles', () => {
    expect(article('ocean')).toBe('an')
    expect(article('star')).toBe('a')
  })
})

describe('lyrics generator', () => {
  const structure = [
    { kind: 'verse' as const, lines: 4, syllableTargets: [8, 8, 8, 8] },
    { kind: 'chorus' as const, lines: 4, syllableTargets: [7, 7, 7, 7] },
    { kind: 'verse' as const, lines: 4, syllableTargets: [8, 8, 8, 8] },
    { kind: 'chorus' as const, lines: 4, syllableTargets: [7, 7, 7, 7] },
    { kind: 'bridge' as const, lines: 2, syllableTargets: [9, 9] },
  ]

  it('produces the requested number of lines', () => {
    const result = generateLyrics({ theme: 'the ocean at night', mood: 'sad', style: 'sung', seed: 'a', structure })
    expect(result.lines).toHaveLength(18)
  })

  it('is deterministic for a seed', () => {
    const a = generateLyrics({ theme: 'the ocean', mood: 'sad', style: 'sung', seed: 'x', structure })
    const b = generateLyrics({ theme: 'the ocean', mood: 'sad', style: 'sung', seed: 'x', structure })
    expect(a.formatted).toBe(b.formatted)
  })

  it('varies with the seed', () => {
    const a = generateLyrics({ theme: 'the ocean', mood: 'sad', style: 'sung', seed: 'x', structure })
    const b = generateLyrics({ theme: 'the ocean', mood: 'sad', style: 'sung', seed: 'y', structure })
    expect(a.formatted).not.toBe(b.formatted)
  })

  it('repeats the chorus verbatim', () => {
    const result = generateLyrics({ theme: 'fire', mood: 'epic', style: 'sung', seed: 'chorus', structure })
    const choruses = [0, 1].map((n) =>
      result.lines.filter((l) => l.section === 'chorus' && l.sectionIndex === (n === 0 ? 1 : 3)).map((l) => l.text))
    expect(choruses[0]).toEqual(choruses[1])
    expect(choruses[0]!.length).toBe(4)
  })

  it('lands the rhyme scheme', () => {
    // Over many seeds, most lines that share a rhyme label should rhyme.
    let hits = 0
    let total = 0
    for (let seed = 0; seed < 25; seed++) {
      const result = generateLyrics({
        theme: 'the long road home', mood: 'nostalgic', style: 'sung', seed: `seed-${seed}`,
        rhymeScheme: 'AABB',
        structure: [{ kind: 'verse', lines: 4 }],
      })
      const endings = result.lines.map((l) => l.text.split(/\s+/).pop() ?? '')
      total += 2
      if (rhymes(endings[0]!, endings[1]!)) hits++
      if (rhymes(endings[2]!, endings[3]!)) hits++
    }
    expect(hits / total).toBeGreaterThan(0.9)
  })

  it('gets close to the syllable targets', () => {
    let within = 0
    let total = 0
    for (let seed = 0; seed < 12; seed++) {
      const result = generateLyrics({
        theme: 'city lights', mood: 'dreamy', style: 'sung', seed: `s${seed}`, structure,
      })
      result.lines.forEach((line, i) => {
        const target = structure.flatMap((s) => s.syllableTargets ?? [])[i]
        if (!target) return
        total++
        if (Math.abs(syllablesInLine(line.text) - target) <= 3) within++
      })
    }
    expect(within / total).toBeGreaterThan(0.75)
  })

  it('produces a usable title', () => {
    for (const theme of ['summer love', 'a broken engine', 'running out of time']) {
      const result = generateLyrics({ theme, mood: 'hopeful', style: 'sung', seed: theme, structure })
      expect(result.title.length).toBeGreaterThan(2)
      expect(result.title.length).toBeLessThan(60)
      expect(result.title).not.toMatch(/^(But|And|So|Oh|Yeah),/)
      expect(result.title.trim()).toBe(result.title)
    }
  })

  it('leaves no unfilled template slots or markers', () => {
    for (let seed = 0; seed < 30; seed++) {
      for (const style of ['sung', 'rap'] as const) {
        const result = generateLyrics({
          theme: 'the storm outside my window', mood: 'tense', style, seed: `t${seed}`, structure,
        })
        expect(result.formatted).not.toMatch(/[{}]/)
        expect(result.formatted).not.toContain('%END')
        expect(result.formatted).not.toContain('undefined')
        for (const line of result.lines) {
          expect(line.text.length).toBeGreaterThan(3)
          expect(line.text).toMatch(/^[A-Z]/)
        }
      }
    }
  })

  it('handles an empty theme and an empty structure', () => {
    expect(generateLyrics({ theme: '', mood: 'chill', style: 'sung', seed: 'e', structure: [] }).lines).toHaveLength(0)
    const noTheme = generateLyrics({ theme: '', mood: 'chill', style: 'sung', seed: 'e', structure })
    expect(noTheme.lines).toHaveLength(18)
    expect(noTheme.title.length).toBeGreaterThan(2)
  })

  it('works for every mood', () => {
    const moods: Mood[] = ['happy', 'sad', 'dark', 'epic', 'chill', 'energetic', 'romantic', 'angry', 'dreamy', 'nostalgic', 'tense', 'hopeful']
    for (const mood of moods) {
      const result = generateLyrics({ theme: 'a long night', mood, style: 'sung', seed: mood, structure })
      expect(result.lines).toHaveLength(18)
    }
  })

  it('extracts theme keywords without verb forms', () => {
    expect(themeKeywords('driving home and never sleeping about the ocean')).toEqual(['home', 'ocean'])
  })

  it('expands rhyme schemes', () => {
    expect(schemeLabels('AABB', 4)).toEqual(['A0', 'A0', 'B0', 'B0'])
    expect(schemeLabels('ABAB', 4)).toEqual(['A0', 'B0', 'A0', 'B0'])
    expect(schemeLabels('AABB', 8)).toEqual(['A0', 'A0', 'B0', 'B0', 'A1', 'A1', 'B1', 'B1'])
    expect(new Set(schemeLabels('ABCB', 4)).size).toBe(3)
  })
})

describe('templates', () => {
  const all = [...VERSE_TEMPLATES, ...CHORUS_TEMPLATES, ...BRIDGE_TEMPLATES, ...RAP_TEMPLATES, ...OPENER_TEMPLATES]

  it('all end with the rhyme marker', () => {
    for (const template of all) {
      expect(template.text.endsWith('%END')).toBe(true)
    }
  })

  it('use only known slots', () => {
    for (const template of all) {
      const slots = template.text.match(/\{[a-zA-Z]+\}/g) ?? []
      for (const slot of slots) {
        expect(['{noun}', '{nouns}', '{adj}', '{vMove}', '{vMoveIng}', '{vMoves}', '{vFeel}', '{place}']).toContain(slot)
      }
    }
  })

  it('every ending part of speech is reachable from the lexicon', () => {
    const available = new Set(RHYME_WORDS.flatMap((w) => w.pos))
    for (const template of all) expect(available.has(template.end)).toBe(true)
  })
})
