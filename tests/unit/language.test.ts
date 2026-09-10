import { describe, expect, it } from 'vitest'
import {
  LANGUAGES, countLineSyllables, detectLanguage, languageProfile,
  pronounceLine, pronounceWord, resolveLanguage, tokenize,
  type LanguageId,
} from '../../src/engine/lang'
import { isVowel, type Syllable, type Vowel } from '../../src/engine/voice/phonemes'
import { CONSONANTS, vowelFormants, VOICE_TYPES } from '../../src/engine/voice/formants'
import { planSegments, SING_PRESETS, renderSungNote } from '../../src/engine/voice/singer'
import { stft } from '../../src/engine/audio/stft'
import { readFileSync } from 'node:fs'
import { handleRequest } from '../../src/workers/handler'
import { describeResult } from '../../src/engine/synth/validate'
import { checkSingability, STRUCTURE_TAGS } from '../../src/engine/lyrics/structure'
import type { GenerateResult } from '../../src/workers/protocol'
import { planSpeech, SPEECH_VOICES, synthesizeSpeech } from '../../src/engine/voice/speech'
import { scoreToMidi } from '../../src/engine/export/midi'
import { scoreToLrc, scoreToSrt, timedLyricLines } from '../../src/engine/export/subtitles'
import { buildSpec } from '../../src/engine/compose/prompt'
import { chordChart, composeSong } from '../../src/engine/compose/composer'
import { hasStructureTags, parseLyricStructure, tagToKind } from '../../src/engine/lyrics/structure'
import { renderScore } from '../../src/engine/synth/render'
import { sumStems, isVocalStem } from '../../src/lib/mixdown'

/** Compact reading of a word, for readable expectations. */
function read(word: string, language: LanguageId): string {
  return pronounceWord(word, language)
    .map((s) => [...s.onset, s.vowel, ...(s.glide ? [s.glide] : []), ...s.coda].join(' '))
    .join(' | ')
}

describe('grapheme to phoneme', () => {
  it('reads the five-vowel languages with pure vowels, not English ones', () => {
    // "cinta" must not come out as the English "sinter".
    expect(read('cinta', 'id')).toBe('CH IY N | T A')
    expect(read('selamat', 'id')).toBe('S AX | L A | M A T')
    expect(read('mata', 'es')).toBe('M A | T A')
    expect(read('moyo', 'sw')).toBe('M O | Y O')
    expect(read('puso', 'tl')).toBe('P U | S O')
  })

  it('gives Indonesian its glottal stop and its schwa', () => {
    // A final k is a catch in the throat, not a released k.
    expect(pronounceWord('tidak', 'id').at(-1)!.coda).toEqual(['Q'])
    // The e of a non-final syllable is a schwa; the final one is not.
    expect(read('beri', 'id')).toBe('B AX | DX IY')
    expect(read('sore', 'id')).toBe('S O | DX E')
  })

  it('distinguishes the Spanish tap from the trill', () => {
    expect(read('pero', 'es')).toBe('P E | DX O')
    expect(read('perro', 'es')).toBe('P E | RR O')
    // A word-initial r is trilled even though it is written single.
    expect(pronounceWord('rosa', 'es')[0]!.onset).toEqual(['RR'])
  })

  it('reads Spanish c, g, ll and ñ by context', () => {
    expect(read('cielo', 'es')).toBe('S IY E | L O')
    expect(read('casa', 'es')).toBe('K A | S A')
    expect(read('gente', 'es')).toBe('X E N | T E')
    expect(read('niño', 'es')).toBe('N IY | NY O')
    expect(pronounceWord('llama', 'es')[0]!.onset).toEqual(['Y'])
  })

  it('nasalises Portuguese vowels and raises its final ones', () => {
    expect(pronounceWord('coração', 'pt').at(-1)!.vowel).toBe('AN')
    expect(read('bem', 'pt')).toBe('B EN')
    // Brazilian: a final o is /u/ and a final e is /i/.
    expect(pronounceWord('amigo', 'pt').at(-1)!.vowel).toBe('U')
    expect(pronounceWord('noite', 'pt').at(-1)!.vowel).toBe('IY')
  })

  it('silences French endings and finds its nasal vowels', () => {
    expect(read('bon', 'fr')).toBe('B ON')
    // "bonne" is not nasal: the vowel that follows undoes it.
    expect(read('bonne', 'fr')).toBe('B O N')
    expect(read('toujours', 'fr')).toBe('T U | ZH U RU')
    // A whole-word exception beats the rules.
    expect(read('les', 'fr')).toBe('L E')
    expect(read('vous', 'fr')).toBe('V U')
  })

  it('reads German ch by the vowel before it, and devoices its endings', () => {
    expect(pronounceWord('nacht', 'de')[0]!.coda).toContain('X')
    expect(pronounceWord('ich', 'de')[0]!.coda).toContain('CX')
    // Final g is said as k.
    expect(pronounceWord('tag', 'de')[0]!.coda).toEqual(['K'])
    expect(pronounceWord('schön', 'de')[0]!.vowel).toBe('OE')
  })

  it('reads Turkish exactly as written', () => {
    expect(read('güzel', 'tr')).toBe('G UE | Z EH L')
    expect(read('ışık', 'tr')).toBe('IX | SH IX K')
    expect(read('çok', 'tr')).toBe('CH O K')
  })

  it('handles the Slavic consonant clusters', () => {
    expect(read('miłość', 'pl')).toBe('M IY | W O SH CH')
    expect(pronounceWord('czas', 'pl')[0]!.onset).toEqual(['CH'])
    expect(pronounceWord('srdce', 'cs').length).toBeGreaterThan(0)
  })

  it('reads the Cyrillic and Greek alphabets', () => {
    expect(read('да', 'ru')).toBe('D A')
    // An iotated vowel carries its glide at the start of a word.
    expect(pronounceWord('ель', 'ru')[0]!.onset).toEqual(['Y'])
    expect(pronounceWord('мясо', 'ru')[0]!.onset).toEqual(['M'])
    expect(read('φως', 'el')).toBe('F O S')
    // ι before a vowel is a glide, so καρδιά is two beats, not three.
    expect(pronounceWord('καρδιά', 'el')).toHaveLength(2)
  })

  it('reads Devanagari as an abugida', () => {
    // The inherent vowel is dropped at the end of the word.
    expect(read('राम', 'hi')).toBe('DX A M')
    expect(read('हिन्दी', 'hi')).toBe('HH IH N | D IY')
  })

  it('reads kana one mora at a time', () => {
    expect(read('さくら', 'ja')).toBe('S A | K U | DX A')
    // The moraic n closes the syllable before it rather than taking a note.
    expect(pronounceWord('にほん', 'ja').at(-1)!.coda).toEqual(['N'])
    // Katakana share the table with hiragana.
    expect(read('サクラ', 'ja')).toBe('S A | K U | DX A')
    // A small ya glides onto the mora before it.
    expect(pronounceWord('きゃ', 'ja')[0]!.onset).toEqual(['K', 'Y'])
  })

  it('decomposes hangul into its jamo', () => {
    expect(read('사랑', 'ko')).toBe('S A | DX A NG')
    expect(read('한국', 'ko')).toBe('HH A N | G U K')
    // Only seven sounds can close a Korean syllable, whatever the spelling.
    expect(pronounceWord('앞', 'ko')[0]!.coda).toEqual(['P'])
  })

  it('reads Arabic as consonant-vowel-consonant', () => {
    expect(read('قلب', 'ar')).toBe('Q A L B')
    // With the vowel marks written, the reading is exact.
    expect(read('كَتَبَ', 'ar')).toBe('K A | T A | B A')
  })

  it('reads an unknown Latin language at face value rather than as English', () => {
    // Not a language with a table; the generic reader still gives pure vowels.
    expect(read('kalima', 'latn')).toBe('K A | L IY | M A')
  })

  it('keeps English spelling exceptions', () => {
    // The magic-e rule would rhyme "love" with "stove".
    expect(read('love', 'en')).toBe('L AH V')
    expect(read('heart', 'en')).toBe('HH AA R T')
    expect(read('one', 'en')).toBe('W AH N')
  })

  it('always produces a real vowel, in every language, for any input', () => {
    const samples = ['', '123', '!!!', 'x', 'strength', 'zzz', 'ъ', 'ー']
    for (const profile of LANGUAGES) {
      for (const sample of samples) {
        for (const syllable of pronounceWord(sample, profile.id)) {
          expect(isVowel(syllable.vowel), `${profile.id} "${sample}"`).toBe(true)
          if (syllable.glide) expect(isVowel(syllable.glide)).toBe(true)
        }
      }
    }
  })

  it('produces only phonemes the synthesiser can render', () => {
    const words: [LanguageId, string][] = [
      ['id', 'aku cinta kamu selamanya'], ['es', 'mi corazón es tuyo'],
      ['it', 'ti amo tanto amore'], ['pt', 'eu te amo coração'],
      ['fr', 'je t’aime toujours mon cœur'], ['de', 'ich liebe dich für immer'],
      ['nl', 'ik hou van jou'], ['tr', 'seni çok seviyorum'],
      ['pl', 'kocham cię miłość'], ['ro', 'te iubesc inima mea'],
      ['cs', 'miluji tě lásko'], ['sv', 'jag älskar dig'],
      ['fi', 'rakastan sinua aina'], ['vi', 'anh yêu em mãi mãi'],
      ['tl', 'mahal kita habang buhay'], ['sw', 'nakupenda moyo wangu'],
      ['ru', 'я тебя люблю навсегда'], ['uk', 'я тебе кохаю'],
      ['el', 'σ’ αγαπώ καρδιά μου'], ['hi', 'मैं तुमसे प्यार करता हूँ'],
      ['ja', 'あなたをあいしてる'], ['ko', '사랑해요 언제나'],
      ['ar', 'أحبك يا قلبي'], ['en', 'i will love you always'],
    ]
    for (const [language, line] of words) {
      const syllables = pronounceLine(line, language)
      expect(syllables.length, `${language} produced nothing`).toBeGreaterThan(0)
      for (const syllable of syllables) {
        for (const consonant of [...syllable.onset, ...syllable.coda]) {
          expect(CONSONANTS[consonant], `${language}: ${consonant}`).toBeDefined()
        }
        for (const voice of ['alto', 'bass'] as const) {
          expect(vowelFormants(syllable.vowel, voice)).toHaveLength(4)
        }
      }
    }
  })

  it('counts syllables the way each language does', () => {
    expect(countLineSyllables('aku cinta kamu', 'id')).toBe(6)
    expect(countLineSyllables('mi corazón', 'es')).toBe(4)
    expect(countLineSyllables('さくら', 'ja')).toBe(3)
    expect(countLineSyllables('사랑해요', 'ko')).toBe(4)
    // Vietnamese writes one syllable per space-separated word.
    expect(countLineSyllables('anh yêu em', 'vi')).toBe(3)
  })
})

describe('acoustics of the wider inventory', () => {
  it('has plausible formants for every vowel', () => {
    for (const profile of LANGUAGES) {
      const line = 'aeiou aeiou'
      for (const syllable of pronounceLine(line, profile.id)) {
        for (const voice of VOICE_TYPES) {
          for (const formant of vowelFormants(syllable.vowel, voice)) {
            expect(formant.freq).toBeGreaterThan(100)
            expect(formant.freq).toBeLessThan(6000)
            expect(formant.bandwidth).toBeGreaterThan(0)
          }
        }
      }
    }
  })

  it('puts the front rounded vowels between the front and back ones', () => {
    // ü has the tongue of "ee" and the lips of "oo", so its F2 sits between.
    const [, front] = vowelFormants('IY', 'alto')
    const [, rounded] = vowelFormants('UE', 'alto')
    const [, back] = vowelFormants('UW', 'alto')
    expect(rounded!.freq).toBeLessThan(front!.freq)
    expect(rounded!.freq).toBeGreaterThan(back!.freq)
  })

  it('damps the nasal vowels', () => {
    // Coupling the nasal cavity widens every resonance.
    expect(vowelFormants('AN', 'alto')[0]!.bandwidth)
      .toBeGreaterThan(vowelFormants('A', 'alto')[0]!.bandwidth)
  })

  it('renders a trill as a run of taps rather than one steady sound', () => {
    const trilled = planSegments({
      midi: 60, duration: 0.6, velocity: 0.9,
      sounds: { text: 'rro', onset: ['RR'], vowel: 'O', coda: [] },
      sampleRate: 16000, style: SING_PRESETS.pop!, seed: 1, legato: false,
    })
    const tapped = planSegments({
      midi: 60, duration: 0.6, velocity: 0.9,
      sounds: { text: 'ro', onset: ['DX'], vowel: 'O', coda: [] },
      sampleRate: 16000, style: SING_PRESETS.pop!, seed: 1, legato: false,
    })
    expect(trilled.length).toBeGreaterThan(tapped.length + 2)
  })

  it('sings every language cleanly', () => {
    const lines: [LanguageId, string][] = [
      ['id', 'aku cinta'], ['es', 'corazón'], ['fr', 'toujours'], ['de', 'schön'],
      ['tr', 'güzel'], ['pl', 'miłość'], ['ru', 'люблю'], ['el', 'καρδιά'],
      ['hi', 'प्यार'], ['ja', 'さくら'], ['ko', '사랑'], ['ar', 'قلب'],
    ]
    for (const [language, line] of lines) {
      for (const syllable of pronounceLine(line, language)) {
        const buffer = renderSungNote({
          midi: 60, duration: 0.35, velocity: 0.9, sounds: syllable,
          sampleRate: 16000, style: SING_PRESETS.pop!, seed: 3, legato: false,
        })
        let peak = 0
        for (let i = 0; i < buffer.length; i++) {
          const value = buffer[i]!
          expect(Number.isFinite(value), `${language} ${syllable.text}`).toBe(true)
          peak = Math.max(peak, Math.abs(value))
        }
        expect(peak, `${language} ${syllable.text} was silent`).toBeGreaterThan(0.01)
      }
    }
  })

  it('speaks a non-English line without falling back to English sounds', () => {
    const spanish = planSpeech('mi corazón', { voice: SPEECH_VOICES[2]!, language: 'es' })
    const english = planSpeech('mi corazón', { voice: SPEECH_VOICES[2]!, language: 'en' })
    expect(spanish.length).toBeGreaterThan(0)
    expect(english.length).toBeGreaterThan(0)
    expect(spanish.length).not.toBe(english.length)

    const audio = synthesizeSpeech('halo apa kabar', {
      voice: SPEECH_VOICES[2]!, language: 'id', sampleRate: 16000,
    })
    expect(audio.channels[0]!.length).toBeGreaterThan(1000)
    for (const sample of audio.channels[0]!) expect(Number.isFinite(sample)).toBe(true)
  })
})

describe('language detection', () => {
  const cases: [string, LanguageId][] = [
    ['aku cinta kamu selamanya', 'id'],
    ['mi corazón es tuyo para siempre', 'es'],
    ['ti amo tanto amore mio', 'it'],
    ['eu te amo muito meu coração', 'pt'],
    ['je t’aime toujours mon amour', 'fr'],
    ['ich liebe dich für immer', 'de'],
    ['ik hou van jou mijn liefde', 'nl'],
    ['seni çok seviyorum aşkım', 'tr'],
    ['kocham cię i tylko ciebie', 'pl'],
    ['te iubesc și mereu voi', 'ro'],
    ['jag älskar dig min kärlek', 'sv'],
    ['rakastan sinua aina ja ikuisesti', 'fi'],
    ['anh yêu em và không bao giờ', 'vi'],
    ['mahal kita ang puso ko', 'tl'],
    ['nakupenda moyo wangu sana', 'sw'],
    ['я тебя люблю навсегда', 'ru'],
    ['я тебе кохаю назавжди', 'uk'],
    ['σ’ αγαπώ καρδιά μου', 'el'],
    ['मैं तुमसे प्यार करता हूँ', 'hi'],
    ['あなたを愛してる', 'ja'],
    ['사랑해요 언제나', 'ko'],
    ['أحبك يا قلبي', 'ar'],
    ['i will love you always and forever', 'en'],
  ]

  it('names the language of a line', () => {
    for (const [text, expected] of cases) {
      expect(detectLanguage(text), text).toBe(expected)
    }
  })

  it('falls back rather than guessing wildly', () => {
    expect(detectLanguage('')).toBe('en')
    expect(detectLanguage('zzz qqq')).toBe('en')
    // Latin letters with diacritics but no recognised words: read them, don't
    // pretend they are English.
    expect(detectLanguage('ǧǩǯ ǒǔ')).toBe('latn')
  })

  it('resolves the automatic option only when asked to', () => {
    expect(resolveLanguage('auto', 'aku cinta kamu')).toBe('id')
    expect(resolveLanguage('fr', 'aku cinta kamu')).toBe('fr')
  })

  it('every profile is reachable and describes itself', () => {
    for (const profile of LANGUAGES) {
      expect(languageProfile(profile.id).id).toBe(profile.id)
      expect(profile.label.length).toBeGreaterThan(0)
      expect(profile.native.length).toBeGreaterThan(0)
      // Either a rule table or a reader of its own, never neither.
      expect(Boolean(profile.rules) || Boolean(profile.pronounceWord)).toBe(true)
    }
  })

  it('splits words out of any script', () => {
    expect(tokenize('aku cinta kamu')).toEqual(['aku', 'cinta', 'kamu'])
    expect(tokenize('사랑해요, 언제나!')).toEqual(['사랑해요', '언제나'])
    expect(tokenize('  ')).toEqual([])
  })
})

describe('singing in another language end to end', () => {
  const spec = buildSpec('gentle indonesian pop ballad', {
    seed: 'lang-test', durationSeconds: 40, vocals: 'sung',
    customLyrics: 'Aku masih di sini menunggu\nSampai malam berganti pagi',
  })
  const score = composeSong(spec)

  it('detects the language from the words the user wrote', () => {
    expect(score.language).toBe('id')
  })

  it('carries the sounds on the notes, not just the spelling', () => {
    const vocal = score.tracks.find((track) => track.id === 'vocal')
    expect(vocal).toBeDefined()
    const sung = vocal!.notes.filter((note): note is typeof note & { sounds: Syllable } =>
      note.sounds !== undefined)
    expect(sung.length).toBeGreaterThan(4)
    // Read as Indonesian, so pure vowels rather than the English lax set.
    const vowels = new Set(sung.map((note) => note.sounds.vowel))
    expect([...vowels].some((vowel) => ['A', 'E', 'O', 'AX'].includes(vowel))).toBe(true)
  })

  it('uses the words the user wrote as the lyric', () => {
    expect(score.lyrics?.formatted).toContain('Aku masih di sini menunggu')
  })
})

describe('exports', () => {
  const score = composeSong(buildSpec('bright pop song', {
    seed: 'export-test', durationSeconds: 40, vocals: 'sung',
  }))

  it('writes a standard MIDI file', () => {
    const bytes = scoreToMidi(score)
    expect(String.fromCharCode(...bytes.slice(0, 4))).toBe('MThd')
    // Header: format 1, then the track count, then the division.
    expect(bytes[8]! << 8 | bytes[9]!).toBe(1)
    const trackCount = bytes[10]! << 8 | bytes[11]!
    expect(trackCount).toBeGreaterThan(1)

    // Every chunk after the header must be a well-formed track.
    let offset = 14
    let found = 0
    while (offset < bytes.length) {
      expect(String.fromCharCode(...bytes.slice(offset, offset + 4))).toBe('MTrk')
      const length = (bytes[offset + 4]! << 24) | (bytes[offset + 5]! << 16)
        | (bytes[offset + 6]! << 8) | bytes[offset + 7]!
      offset += 8 + length
      found++
    }
    expect(found).toBe(trackCount)
    expect(offset).toBe(bytes.length)
  })

  it('times the lyrics against the mix', () => {
    const lines = timedLyricLines(score)
    expect(lines.length).toBeGreaterThan(0)
    for (const line of lines) {
      expect(line.end).toBeGreaterThan(line.start)
      expect(line.text.trim().length).toBeGreaterThan(0)
    }
    // Lines run in order and do not overlap themselves.
    for (let i = 1; i < lines.length; i++) {
      expect(lines[i]!.start).toBeGreaterThanOrEqual(lines[i - 1]!.start)
    }

    const srt = scoreToSrt(score)
    expect(srt).toMatch(/^1\n\d\d:\d\d:\d\d,\d\d\d --> \d\d:\d\d:\d\d,\d\d\d\n/)
    expect(scoreToLrc(score)).toMatch(/\[\d\d:\d\d\.\d\d\]/)
  })

  it('splits a mix into its instrumental and its vocal', () => {
    const stems = [
      { id: 'vocal', name: 'Lead Vocal', audio: { channels: [new Float32Array([1, 1])], sampleRate: 8000 } },
      { id: 'bass', name: 'Bass', audio: { channels: [new Float32Array([0.5, 0.5])], sampleRate: 8000 } },
      { id: 'drums', name: 'Drums', audio: { channels: [new Float32Array([0.25, 0.25])], sampleRate: 8000 } },
    ]
    const vocals = sumStems(stems, (stem) => isVocalStem(stem.id))
    const instrumental = sumStems(stems, (stem) => !isVocalStem(stem.id))
    expect(vocals!.channels[0]![0]).toBeCloseTo(1)
    expect(instrumental!.channels[0]![0]).toBeCloseTo(0.75)
    expect(sumStems(stems, () => false)).toBeNull()
  })
})

describe('the mix puts the voice in front', () => {
  const rms = (buffer: Float32Array): number => {
    let sum = 0
    for (let i = 0; i < buffer.length; i++) sum += buffer[i]! * buffer[i]!
    return Math.sqrt(sum / buffer.length)
  }
  const db = (value: number): number => 20 * Math.log10(Math.max(1e-9, value))

  it('sings by default, whatever genre was asked for', () => {
    // Several of these genres are instrumental traditions. Asking for the sound
    // is not the same as asking for the vocal to be dropped.
    for (const prompt of ['lo-fi beats', 'ambient', 'techno', 'cinematic', 'indonesian dangdut koplo']) {
      const spec = buildSpec(prompt, { seed: 'vox', durationSeconds: 30 })
      expect(spec.vocals, prompt).not.toBe('none')
      expect(spec.instrumental, prompt).toBe(false)
    }
  })

  it('drops the vocal only when asked', () => {
    for (const prompt of ['an instrumental lo-fi beat', 'lo-fi, no vocals', 'a backing track']) {
      expect(buildSpec(prompt, { seed: 'vox' }).vocals, prompt).toBe('none')
    }
    expect(buildSpec('a pop song', { seed: 'vox', vocals: 'none' }).vocals).toBe('none')
  })

  it('leaves the lead vocal louder than the bed it sits on', () => {
    const score = composeSong(buildSpec('an upbeat pop song', {
      seed: 'balance', durationSeconds: 30, vocals: 'sung',
    }))
    const rendered = renderScore(score, { sampleRate: 22050, keepStems: true })
    const levels = new Map((rendered.stems ?? []).map((stem) => [stem.id, db(rms(stem.left))]))

    const vocal = levels.get('vocal')
    expect(vocal).toBeDefined()
    for (const bed of ['chords', 'pad', 'arp']) {
      const level = levels.get(bed)
      if (level === undefined) continue
      expect(vocal!, `${bed} is louder than the vocal`).toBeGreaterThan(level)
    }
    // And it is not so far forward that it is the only thing left.
    expect(vocal! - (levels.get('drums') ?? -60)).toBeLessThan(12)
  })
})

describe('lyrics that carry their own structure', () => {
  const LYRIC = `[Intro, Dark Koplo]
Pagi datang hati berdebar

[Verse 1]
Salah sedikit langsung dimarahin
Benar sedikit tetap dicurigain

[Chorus, Full Koplo]
Bos toxic, bos toxic
Bikin kepala hampir meledak

[Break, Kendang Call And Response]
Kalau salah?
Bicarakan!

[Final Chorus, Explosive Koplo]
Bos toxic, kami sudah lelah

[Outro, Koplo Fade]
Bos boleh tegas, jangan kejam`

  it('reads the tags a lyricist writes', () => {
    expect(hasStructureTags(LYRIC)).toBe(true)
    expect(hasStructureTags('just some words\nwith no tags')).toBe(false)

    const blocks = parseLyricStructure(LYRIC)
    expect(blocks.map((block) => block.kind)).toEqual([
      'intro', 'verse', 'chorus', 'breakdown', 'chorus', 'outro',
    ])
    // "Final Chorus" is a chorus; the modifier in front does not change that.
    expect(tagToKind('Final Chorus')).toBe('chorus')
    expect(tagToKind('Pre-Chorus')).toBe('prechorus')
    expect(tagToKind('Kendang Break')).toBe('breakdown')
    expect(tagToKind('Guitar Solo')).toBe('solo')
    expect(tagToKind('not a section')).toBeNull()
  })

  it('reads emphasis from the qualifier, and a genre name as neither', () => {
    const byLabel = new Map(parseLyricStructure(LYRIC).map((b) => [b.label, b.intensity]))
    // "Dark" and "Fade" are quiet; "Full" and "Explosive" are not. "Koplo"
    // appears in all four and must not decide any of them.
    expect(byLabel.get('Intro, Dark Koplo')!).toBeLessThan(0.5)
    expect(byLabel.get('Outro, Koplo Fade')!).toBeLessThan(0.5)
    expect(byLabel.get('Chorus, Full Koplo')!).toBe(1)
    expect(byLabel.get('Final Chorus, Explosive Koplo')!).toBe(1)
    // A kendang break is a peak, not a lull.
    expect(byLabel.get('Break, Kendang Call And Response')!).toBeGreaterThan(0.8)
  })

  it('builds the song to the shape the lyric describes', () => {
    const score = composeSong(buildSpec('Indonesian dangdut koplo', {
      seed: 'koplo', customLyrics: LYRIC,
    }))

    expect(score.genreId).toBe('koplo')
    expect(score.language).toBe('id')
    // One section per tag, in the order they were written, labelled as written.
    expect(score.sections.map((section) => section.label)).toEqual([
      'Intro, Dark Koplo', 'Verse 1', 'Chorus, Full Koplo',
      'Break, Kendang Call And Response', 'Final Chorus, Explosive Koplo', 'Outro, Koplo Fade',
    ])
    // The energy rises into the choruses and falls away at the end.
    const level = (label: string): number =>
      score.sections.find((section) => section.label === label)!.intensity
    expect(level('Chorus, Full Koplo')).toBeGreaterThan(level('Verse 1'))
    expect(level('Outro, Koplo Fade')).toBeLessThan(level('Verse 1'))

    // The tags themselves are never sung.
    const vocal = score.tracks.find((track) => track.id === 'vocal')!
    const sung = vocal.notes.map((note) => note.syllable).filter(Boolean).join(' ').toLowerCase()
    for (const word of ['intro', 'chorus', 'verse', 'outro', 'koplo']) {
      expect(sung, `sang the tag word "${word}"`).not.toContain(word)
    }
    expect(sung).toContain('bos')

    // And the title is the hook, not the first line of the first verse.
    expect(score.title).toBe('Bos Toxic')
  })

  it('spells a chord chart the way its key is written', () => {
    const score = composeSong(buildSpec('Indonesian dangdut koplo', {
      seed: 'koplo', customLyrics: LYRIC,
    }))
    const chords = chordChart(score).flatMap((section) => section.chords).join(' ')
    // A chart is spelled one way or the other, never both at once: mixing a Bb
    // and a G# in the same key is what makes a player stop and translate.
    expect(/[A-G]#/.test(chords) && /[A-G]b/.test(chords)).toBe(false)

    // And a flat key is written with flats.
    const inCMinor = composeSong(buildSpec('Indonesian dangdut koplo', {
      seed: 'koplo', customLyrics: LYRIC, tonic: 0, scale: 'minor',
    }))
    const flatChart = chordChart(inCMinor).flatMap((section) => section.chords).join(' ')
    expect(flatChart).toContain('Cm')
    expect(flatChart).not.toMatch(/[A-G]#/)
  })
})

describe('the arrangement has a shape', () => {
  const rms = (buffer: Float32Array): number => {
    let sum = 0
    for (let i = 0; i < buffer.length; i++) sum += buffer[i]! * buffer[i]!
    return 20 * Math.log10(Math.max(1e-9, Math.sqrt(sum / buffer.length)))
  }

  it('sings with the voice that was asked for', () => {
    expect(buildSpec('dramatic male vocal pop song', { seed: 'v' }).vocalGender).toBe('male')
    expect(buildSpec('soaring female vocal', { seed: 'v' }).vocalGender).toBe('female')
    expect(buildSpec('vokal pria dangdut', { seed: 'v' }).vocalGender).toBe('male')
    expect(buildSpec('a pop song', { seed: 'v' }).vocalGender).toBe('auto')

    // And it reaches the renderer, which is where it actually decides anything.
    const male = composeSong(buildSpec('dangdut koplo, dramatic male vocal', { seed: 'v' }))
    expect(male.vocalGender).toBe('male')
  })

  it('lifts the chorus above the verse', () => {
    const score = composeSong(buildSpec('an anthemic pop song', {
      seed: 'lift', durationSeconds: 90, vocals: 'sung',
    }))
    const vocal = score.tracks.find((track) => track.id === 'vocal')!
    const average = (kind: string): number => {
      const notes = score.sections
        .filter((section) => section.kind === kind)
        .flatMap((section) => vocal.notes.filter((note) =>
          note.start >= section.startBeat && note.start < section.startBeat + section.lengthBeats))
      return notes.reduce((sum, note) => sum + note.midi, 0) / Math.max(1, notes.length)
    }
    expect(average('chorus')).toBeGreaterThan(average('verse'))
  })

  it('never writes a phrase that stays on one note', () => {
    // A melody that never moves is a recitation. Check every section of a few
    // songs rather than trusting one lucky seed.
    for (const seed of ['a', 'b', 'c', 'd']) {
      const score = composeSong(buildSpec('a pop song', {
        seed, durationSeconds: 60, vocals: 'sung',
      }))
      const vocal = score.tracks.find((track) => track.id === 'vocal')!
      for (const section of score.sections) {
        const pitches = vocal.notes
          .filter((note) => note.start >= section.startBeat
            && note.start < section.startBeat + section.lengthBeats)
          .map((note) => note.midi)
        if (pitches.length < 4) continue
        expect(Math.max(...pitches) - Math.min(...pitches), `${seed} ${section.label}`)
          .toBeGreaterThan(0)
      }
    }
  })

  it('plays the quiet sections quietly', () => {
    const score = composeSong(buildSpec('an anthemic pop song', {
      seed: 'dyn', durationSeconds: 90, vocals: 'sung',
    }))
    const rendered = renderScore(score, { sampleRate: 22050 })
    const level = (section: (typeof score.sections)[number]): number => {
      const from = Math.floor((section.startBeat * 60 / score.bpm) * 22050)
      const to = Math.min(rendered.left.length,
        Math.floor(((section.startBeat + section.lengthBeats) * 60 / score.bpm) * 22050))
      return to > from ? rms(rendered.left.slice(from, to)) : -99
    }
    const levels = score.sections.map(level).filter((value) => value > -90)
    // A song that plays everything flat out from beginning to end has no
    // arrangement, only content.
    expect(Math.max(...levels) - Math.min(...levels)).toBeGreaterThan(2)

    const loudest = score.sections[levels.indexOf(Math.max(...levels))]!
    const quietest = score.sections[levels.indexOf(Math.min(...levels))]!
    expect(loudest.intensity).toBeGreaterThan(quietest.intensity)
  })
})

describe('the voice carries words, not just pitch', () => {
  const SR = 22050

  /** Average magnitude spectrum of a rendered buffer. */
  const spectrumOf = (buffer: Float32Array): Float32Array => {
    const spec = stft(buffer, 1024, 256, SR)
    const average = new Float32Array(spec.magnitude[0]!.length)
    for (const frame of spec.magnitude) {
      for (let i = 0; i < frame.length; i++) average[i]! += frame[i]!
    }
    return average
  }

  /** Share of a spectrum's energy above a frequency, 0..1. */
  const shareAbove = (spectrum: Float32Array, hz: number): number => {
    let high = 0
    let all = 0
    for (let i = 1; i < spectrum.length; i++) {
      const power = spectrum[i]! * spectrum[i]!
      all += power
      if ((i * SR) / 1024 >= hz) high += power
    }
    return high / (all || 1)
  }

  const sing = (vowel: Vowel, midi: number, style = SING_PRESETS.baritone!): Float32Array =>
    renderSungNote({
      midi, duration: 0.5, velocity: 0.9,
      sounds: { text: 'x', onset: [], vowel, coda: [] },
      sampleRate: SR, style, seed: 5, legato: false,
    })

  it('puts real energy in the band where words are heard', () => {
    // A voiced source is a comb of harmonics; a formant narrower than the gap
    // between them passes almost nothing, which is what turns a sung vowel into
    // a hum. Every vowel must carry something above 800 Hz, at any pitch.
    for (const [style, midi] of [
      [SING_PRESETS.baritone!, 45], [SING_PRESETS.baritone!, 57],
      [SING_PRESETS.pop!, 62], [SING_PRESETS.soprano!, 72],
    ] as const) {
      for (const vowel of ['A', 'E', 'O', 'IY'] as Vowel[]) {
        const share = shareAbove(spectrumOf(sing(vowel, midi, style)), 800)
        expect(share, `${style.voice} ${vowel} at ${midi}`).toBeGreaterThan(0.04)
      }
    }
  })

  it('keeps the vowels telling themselves apart', () => {
    // Widening the formants to catch harmonics must not widen them so far that
    // every vowel sounds the same — the spread is the intelligibility.
    const shares = (['A', 'E', 'O', 'UW'] as Vowel[])
      .map((vowel) => shareAbove(spectrumOf(sing(vowel, 50)), 800))
    expect(Math.max(...shares) - Math.min(...shares)).toBeGreaterThan(0.15)
  })

  it('leaves the voice owning the band it is heard in', () => {
    const score = composeSong(buildSpec('Indonesian dangdut koplo, male vocal', {
      seed: 'band', durationSeconds: 40, vocals: 'sung',
    }))
    const rendered = renderScore(score, { sampleRate: SR, keepStems: true })
    const stems = rendered.stems ?? []

    const bandPower = (buffer: Float32Array): number => {
      const spec = stft(buffer, 1024, 256, SR)
      let total = 0
      for (const frame of spec.magnitude) {
        for (let i = 1; i < frame.length; i++) {
          const hz = (i * SR) / 1024
          if (hz >= 800 && hz < 5000) total += frame[i]! * frame[i]!
        }
      }
      return total
    }

    const vocal = bandPower(stems.find((stem) => stem.id === 'vocal')!.left)
    const backing = stems
      .filter((stem) => stem.id !== 'vocal' && stem.id !== 'vocalHarmony')
      .reduce((sum, stem) => sum + bandPower(stem.left), 0)

    // Most of what is audible between 800 Hz and 5 kHz should be the singer.
    expect(vocal / (vocal + backing)).toBeGreaterThan(0.5)
  })
})

describe('the pipeline reports what it actually produced', () => {
  const LYRIC = readFileSync(new URL('./fixtures/koplo-lyric.txt', import.meta.url), 'utf8')

  const run = async (overrides: Record<string, unknown>, takes?: number): Promise<GenerateResult> =>
    await handleRequest({
      kind: 'generate',
      prompt: 'Indonesian dangdut koplo, sarcastic workplace anthem, powerful kendang, groovy bass, funky guitar, dramatic male vocal, explosive sing-along chorus',
      quality: 'draft',
      keepStems: true,
      ...(takes ? { takes } : {}),
      overrides: { seed: 'pipeline', ...overrides },
    } as never, () => {}) as GenerateResult

  const generate = async (overrides: Record<string, unknown>) => (await run(overrides)).takes[0]!

    it('calls a sung song a sung song, and an instrumental an instrumental', async () => {
    const song = await generate({ customLyrics: LYRIC })
    expect(song.validation.kind).toBe('vocal-song')
    expect(song.validation.vocalRequested).toBe(true)
    expect(song.validation.problems).toEqual([])
    expect(describeResult(song.validation)).toMatch(/sung/)

    const instrumental = await generate({ vocals: 'none' })
    expect(instrumental.validation.kind).toBe('instrumental')
    expect(instrumental.validation.vocalRequested).toBe(false)
    expect(describeResult(instrumental.validation)).toBe('Instrumental generated.')
  }, 120_000)

  it('renders the words that were written, in Indonesian, sung by a man', async () => {
    const song = await generate({ customLyrics: LYRIC })
    expect(song.score.language).toBe('id')
    expect(song.score.vocalGender).toBe('male')

    const vocal = song.score.tracks.find((track) => track.id === 'vocal')!
    expect(vocal.notes.filter((note) => note.syllable).length).toBeGreaterThan(50)

    // The mix is not the instrumental: subtracting the backing from it must
    // leave a great deal behind, or the voice never reached the export.
    const mix = song.audio.channels[0]!
    const backing = new Float32Array(mix.length)
    for (const stem of song.stems) {
      if (stem.id === 'vocal' || stem.id === 'vocalHarmony') continue
      const channel = stem.audio.channels[0]!
      for (let i = 0; i < mix.length; i++) backing[i]! += channel[i] ?? 0
    }
    let difference = 0
    let total = 0
    for (let i = 0; i < mix.length; i++) {
      difference += (mix[i]! - backing[i]!) ** 2
      total += mix[i]! ** 2
    }
    expect(difference / (total || 1)).toBeGreaterThan(0.05)

    // And the voice is carrying the range it is heard in.
    expect(song.validation.voiceBandShare!).toBeGreaterThan(0.4)
  }, 120_000)

  it('writes a different song for every take, from one brief', async () => {
    const run2 = await run({ customLyrics: LYRIC }, 2)
    expect(run2.takes).toHaveLength(2)

    const [first, second] = run2.takes as [typeof run2.takes[0], typeof run2.takes[0]]
    // Same brief, so the same genre and the same words — a different song.
    expect(second.score.genreId).toBe(first.score.genreId)
    expect(second.score.lyrics?.formatted).toBe(first.score.lyrics?.formatted)
    expect(second.score.seed).not.toBe(first.score.seed)

    const tune = (take: typeof first): string =>
      take.score.tracks.find((track) => track.id === 'vocal')!
        .notes.slice(0, 24).map((note) => note.midi).join(',')
    expect(tune(second)).not.toBe(tune(first))

    // Both are finished songs, not one song and one draft.
    for (const take of run2.takes) {
      expect(take.validation.kind).toBe('vocal-song')
      expect(take.validation.problems).toEqual([])
      expect(take.audio.channels[0]!.length).toBeGreaterThan(0)
    }

    // Stems would cost a set of full-length buffers per take, so a run that
    // writes several hands them back without.
    expect(run2.takes.every((take) => take.stems.length === 0)).toBe(true)
  }, 120_000)

  it('notices a lyric a singer cannot perform', () => {
    const count = (line: string): number => countLineSyllables(line, 'id')

    expect(checkSingability('[Chorus]\nBos toxic bos toxic\nBos toxic bos toxic', count)).toEqual([])

    const tooLong = checkSingability(
      `[Verse 1]\n${'kata '.repeat(30)}`, count)
    expect(tooLong.some((w) => w.reason.includes('more than a phrase holds'))).toBe(true)

    // A production note left in the lyric box gets sung.
    const note = checkSingability('[Full Koplo Kendang Groove 128bpm]\nsatu dua tiga', count)
    expect(note.some((w) => w.reason.includes('will be sung as words'))).toBe(true)

    // Only markers, nothing to sing.
    expect(checkSingability('[Intro]\n[Chorus]', count).some((w) => w.reason.includes('no words'))).toBe(true)

    // A chorus that never comes round again.
    const noRepeat = checkSingability('[Chorus]\nsatu dua tiga empat\nlima enam tujuh lapan', count)
    expect(noRepeat.some((w) => w.reason.includes('Nothing repeats'))).toBe(true)
  })

  it('offers plain section names, with no production notes among them', () => {
    const tags = STRUCTURE_TAGS.flatMap((group) => group.tags)
    expect(tags).toContain('Chorus')
    expect(tags).toContain('Pre-Chorus')
    expect(tags).toContain('Instrumental Break')
    for (const tag of tags) {
      expect(tag, `${tag} carries a production note`).not.toContain(',')
      expect(tagToKind(tag), `${tag} is not a section`).not.toBeNull()
    }
  })
})
