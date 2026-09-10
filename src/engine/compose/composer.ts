/**
 * The composer: turns a song specification into a complete score — form,
 * harmony, drums, every instrumental part, and a vocal line with the lyrics
 * placed syllable-by-syllable onto its notes.
 */

import { Rng } from '../core/rng'
import { chordName, keyUsesFlats, voiceChord, CHORD_INTERVALS } from '../theory/chords'
import { snapToScale } from '../theory/pitch'
import { buildForm, formFromBlocks, labelSlots, type FormSlot } from './arrangement'
import { hasStructureTags, parseLyricStructure, type LyricBlock } from '../lyrics/structure'
import { generateDrums } from './drums'
import { generateArp, generateBass, generateMelody, compRhythm, type MelodyContext } from './melody'
import { planHarmony } from './harmony'
import { generateLyrics, type LyricSectionRequest } from '../lyrics/generator'
import { pronounceLine, resolveLanguage } from '../lang'
import type { Syllable } from '../voice/phonemes'
import { MOODS, type SongSpec } from './prompt'
import { GENRES } from './genres'
import type {
  InstrumentId, LyricLine, Score, ScoreNote, ScoreTrack, Section, SectionKind,
  SongLyrics, TrackFx, TrackRole,
} from './types'

/** Section kinds that carry a sung or rapped line. */
const VOCAL_SECTIONS: SectionKind[] = ['verse', 'prechorus', 'chorus', 'bridge', 'drop', 'outro']

export interface ComposeOptions {
  /** Overrides the vocal register centre in MIDI (default 62 ≈ D4). */
  vocalCenterMidi?: number
}

export function composeSong(spec: SongSpec, options: ComposeOptions = {}): Score {
  const rng = new Rng(`${spec.seed}|compose`)
  const genre = spec.genre
  const beatsPerBar = genre.beatsPerBar

  // A lyric that carries its own structure tags has already decided the shape
  // of the song, so the arranger follows it rather than inventing a form and
  // then trying to fit the words into it.
  const blocks = spec.customLyrics && hasStructureTags(spec.customLyrics)
    ? parseLyricStructure(spec.customLyrics)
    : null
  const slots = blocks
    ? formFromBlocks(blocks.map((block) => ({
      kind: block.kind,
      lines: block.lines.length,
      ...(block.intensity !== undefined ? { intensity: block.intensity } : {}),
    })))
    : buildForm(genre, spec.bpm, beatsPerBar, spec.durationSeconds, rng.fork('form'))
  // The lyricist's own tag text is the better label: "Final Chorus" and
  // "Break, Kendang Call And Response" say more than "Chorus 3" does.
  const labels = blocks ? blocks.map((block) => block.label) : labelSlots(slots)

  const slotStarts: number[] = []
  let cursor = 0
  for (const slot of slots) {
    slotStarts.push(cursor)
    cursor += slot.bars * beatsPerBar
  }
  const lengthBeats = cursor

  const harmony = planHarmony(slots, spec.key.tonic, spec.key.scale, genre, rng.fork('harmony'), spec.progressionId)

  const sections: Section[] = slots.map((slot, i) => ({
    kind: slot.kind,
    label: labels[i]!,
    startBeat: slotStarts[i]!,
    lengthBeats: slot.bars * beatsPerBar,
    chords: harmony.perSection[i]!,
    intensity: slot.intensity,
  }))

  const tracks: ScoreTrack[] = []
  const context = (slot: FormSlot, index: number, centerMidi: number, range: number): MelodyContext => ({
    chords: harmony.perSection[index]!,
    startBeat: slotStarts[index]!,
    bars: slot.bars,
    beatsPerBar,
    tonic: spec.key.tonic,
    scale: spec.key.scale,
    genre,
    intensity: slot.intensity,
    kind: slot.kind,
    rng: rng.fork(`sec${index}`),
    centerMidi,
    range,
  })

  // ---- Chords -------------------------------------------------------------
  const chordInstrument = rng.fork('inst').pick(genre.instruments.chords)
  const chordNotes: ScoreNote[] = []
  let previousVoicing: number[] | null = null
  for (let i = 0; i < slots.length; i++) {
    const slot = slots[i]!
    const chords = harmony.perSection[i]!
    const sectionRng = rng.fork(`comp${i}`)
    for (let bar = 0; bar < slot.bars; bar++) {
      const chord = chords[Math.min(chords.length - 1, bar)]!
      const voicing = voiceChord(chord, previousVoicing, 60, slot.intensity > 0.7 ? 4 : 3)
      previousVoicing = voicing
      const barStart = slotStarts[i]! + bar * beatsPerBar
      for (const step of compRhythm(genre, beatsPerBar, slot.intensity, sectionRng)) {
        for (const midi of voicing) {
          chordNotes.push({
            start: barStart + step.beat,
            duration: step.length,
            midi,
            velocity: Math.min(1, step.velocity * (0.8 + slot.intensity * 0.35)),
          })
        }
      }
    }
  }
  // A record with a singer on it is mixed around the singer: everything that
  // is not the voice sits a few dB lower than it would in an instrumental, so
  // the words stay in front instead of competing with the bed.
  const hasVocals = spec.vocals !== 'none'
  const bed = (instrumentalDb: number, underVocalDb: number): number =>
    (hasVocals ? underVocalDb : instrumentalDb)

  tracks.push(makeTrack('chords', 'Chords', 'chords', chordInstrument, chordNotes, {
    gainDb: bed(-5, -11), pan: rng.fork('pan1').float(-0.22, 0.22),
    fx: { reverbSend: 0.2 + genre.space * 0.2, delaySend: 0.05, sidechain: 0.25, drive: 0.1, highPassHz: 160 },
  }))

  // ---- Bass ---------------------------------------------------------------
  const bassInstrument = rng.fork('inst2').pick(genre.instruments.bass)
  const bassNotes: ScoreNote[] = []
  for (let i = 0; i < slots.length; i++) {
    const slot = slots[i]!
    if (slot.intensity < 0.3 && slot.kind === 'intro') continue
    bassNotes.push(...generateBass(context(slot, i, 40, 12)))
  }
  // Genres built around the 808 keep more weight; everything else sits back so
  // the parts carrying the tune are not competing with the low end.
  const bassGainDb = ['trap', 'drill', 'phonk', 'dubstep', 'dnb', 'reggaeton'].includes(genre.id) ? -6.5 : -10
  tracks.push(makeTrack('bass', 'Bass', 'bass', bassInstrument, bassNotes, {
    gainDb: bassGainDb, pan: 0,
    // Below about 35 Hz there is nothing to hear, only headroom to lose.
    fx: { reverbSend: 0.02, delaySend: 0, sidechain: 0.55, drive: 0.18, highPassHz: 34 },
  }))

  // ---- Pad ----------------------------------------------------------------
  const padInstrument = rng.fork('inst3').pick(genre.instruments.pad)
  const padNotes: ScoreNote[] = []
  for (let i = 0; i < slots.length; i++) {
    const slot = slots[i]!
    const chords = harmony.perSection[i]!
    let padVoicing: number[] | null = null
    for (let bar = 0; bar < slot.bars; bar++) {
      const chord = chords[Math.min(chords.length - 1, bar)]!
      padVoicing = voiceChord(chord, padVoicing, 64, 4)
      const barStart = slotStarts[i]! + bar * beatsPerBar
      for (const midi of padVoicing) {
        padNotes.push({
          start: barStart,
          duration: beatsPerBar * 0.98,
          midi,
          velocity: 0.3 + slot.intensity * 0.18,
        })
      }
    }
  }
  tracks.push(makeTrack('pad', 'Pad', 'pad', padInstrument, padNotes, {
    gainDb: bed(-12, -16), pan: 0,
    fx: { reverbSend: 0.4 + genre.space * 0.25, delaySend: 0.08, sidechain: 0.4, drive: 0, highPassHz: 220 },
  }))

  // ---- Arpeggio -----------------------------------------------------------
  const arpInstrument = rng.fork('inst4').pick(genre.instruments.arp)
  const arpNotes: ScoreNote[] = []
  const arpRate = genre.density > 0.65 ? 0.25 : 0.5
  for (let i = 0; i < slots.length; i++) {
    const slot = slots[i]!
    if (slot.intensity < 0.45) continue
    arpNotes.push(...generateArp(context(slot, i, 72, 12), arpRate))
  }
  if (arpNotes.length > 0) {
    tracks.push(makeTrack('arp', 'Arp', 'arp', arpInstrument, arpNotes, {
      gainDb: bed(-13, -17), pan: rng.fork('pan2').float(-0.5, 0.5),
      fx: { reverbSend: 0.28, delaySend: 0.22, sidechain: 0.35, drive: 0, highPassHz: 320 },
    }))
  }

  // ---- Vocals or lead melody ---------------------------------------------
  const vocalCenter = options.vocalCenterMidi ?? (spec.vocals === 'rap' ? 55 : 62)
  const vocalRange = spec.vocals === 'rap' ? 7 : 14

  const leadSections: number[] = []
  const vocalSections: number[] = []
  for (let i = 0; i < slots.length; i++) {
    const slot = slots[i]!
    // With written lyrics, a section is sung exactly when its block has lines
    // in it — including a break or a solo, if that is where the words are.
    const written = blocks?.[i]
    const sung = written
      ? hasVocals && written.lines.length > 0
      : hasVocals && VOCAL_SECTIONS.includes(slot.kind) && slot.kind !== 'outro'
    if (sung) {
      vocalSections.push(i)
    } else if (slot.intensity >= 0.45 || !hasVocals) {
      leadSections.push(i)
    }
  }

  const leadInstrument = rng.fork('inst5').pick(genre.instruments.lead)
  const leadNotes: ScoreNote[] = []
  for (const i of leadSections) {
    const slot = slots[i]!
    if (hasVocals && slot.kind !== 'solo' && slot.kind !== 'intro' && slot.kind !== 'outro' && slot.kind !== 'breakdown') continue
    leadNotes.push(...generateMelody(context(slot, i, 72, 16)).notes)
  }
  if (leadNotes.length > 0) {
    tracks.push(makeTrack('lead', 'Lead', 'lead', leadInstrument, leadNotes, {
      gainDb: hasVocals ? -12 : -6, pan: rng.fork('pan3').float(-0.2, 0.2),
      fx: { reverbSend: 0.25 + genre.space * 0.2, delaySend: 0.18, sidechain: 0.25, drive: 0.12, highPassHz: 200 },
    }))
  }

  // ---- Riff (guitar-driven genres) ---------------------------------------
  if (['rock', 'metal', 'punk', 'jpop', 'blues', 'disco', 'koplo'].includes(genre.id)) {
    const riffInstrument = rng.fork('inst6').pick(genre.instruments.riff)
    const riffNotes: ScoreNote[] = []
    for (let i = 0; i < slots.length; i++) {
      const slot = slots[i]!
      // The chop is part of the groove in these genres, so it plays under the
      // verses too rather than appearing only when everything else does.
      if (slot.intensity < 0.4) continue
      const ctx = context(slot, i, 52, 10)
      // A riff doubles the bass rhythm an octave up with chord thirds.
      for (const note of generateBass(ctx)) {
        riffNotes.push({ ...note, midi: note.midi + 12, velocity: note.velocity * 0.8 })
      }
    }
    if (riffNotes.length > 0) {
      tracks.push(makeTrack('riff', 'Riff', 'riff', riffInstrument, riffNotes, {
        // In the guitar genres the riff is a lead part, not wallpaper: it has
        // to be audible under the voice or the request for it went unanswered.
        gainDb: bed(-11, -8), pan: rng.fork('pan4').float(-0.6, 0.6),
        fx: { reverbSend: 0.14, delaySend: 0.05, sidechain: 0.2, drive: 0.4, highPassHz: 140 },
      }))
    }
  }

  const score: Score = {
    title: 'Untitled',
    bpm: spec.bpm,
    beatsPerBar,
    key: spec.key,
    lengthBeats,
    sections,
    tracks,
    drums: generateDrums({
      genre, beatsPerBar, slots, slotStarts, rng: rng.fork('drums'), energy: spec.energy,
    }),
    language: spec.language === 'auto' ? 'en' : spec.language,
    vocalGender: spec.vocalGender,
    seed: spec.seed,
    genreId: genre.id,
  }

  if (hasVocals && vocalSections.length > 0) {
    attachVocals(score, spec, slots, vocalSections, context, vocalCenter, vocalRange, rng, blocks)
  } else {
    score.title = defaultTitle(spec, rng)
  }

  return score
}

type ContextFactory = (slot: FormSlot, index: number, centerMidi: number, range: number) => MelodyContext

/** Writes the vocal melody, generates lyrics to fit it, and places syllables. */
function attachVocals(
  score: Score,
  spec: SongSpec,
  slots: FormSlot[],
  vocalSections: number[],
  context: ContextFactory,
  centerMidi: number,
  range: number,
  rng: Rng,
  blocks: LyricBlock[] | null,
): void {
  // 1. Write the melody first, so the lyrics can be measured against it.
  //
  // A topline is not one register repeated section after section: a verse is
  // conversational and sits low, a pre-chorus climbs, and the chorus is the
  // highest thing in the song. Lifting the centre by the section's own energy
  // is what gives the song a shape to follow rather than a flat recitation.
  const perSection = new Map<number, { notes: ScoreNote[]; phrases: { start: number; end: number }[] }>()
  for (const i of vocalSections) {
    const slot = slots[i]!
    const lift = Math.round((slot.intensity - 0.5) * 10)
    perSection.set(i, generateMelody(context(slot, i, centerMidi + lift, range)))
  }

  // 2. Ask for one lyric line per melodic phrase, sized to its note count.
  const structure: LyricSectionRequest[] = []
  const sectionOrder: number[] = []
  for (const i of vocalSections) {
    const result = perSection.get(i)!
    if (result.phrases.length === 0) continue
    structure.push({
      kind: slots[i]!.kind,
      lines: result.phrases.length,
      syllableTargets: result.phrases.map((p) => p.end - p.start),
    })
    sectionOrder.push(i)
  }
  if (structure.length === 0) {
    score.title = defaultTitle(spec, rng)
    return
  }

  // Words the user wrote always win over invented ones, and they decide the
  // language: someone who typed a chorus in Indonesian wants it sung in
  // Indonesian whether or not they also picked that from the menu.
  const lyrics = spec.customLyrics
    ? layOutCustomLyrics(spec.customLyrics, structure, sectionOrder, slots, spec, rng, blocks)
    : generateLyrics({
      theme: spec.theme,
      mood: spec.mood.id,
      style: spec.vocals === 'rap' ? 'rap' : 'sung',
      seed: spec.seed,
      structure,
    })

  score.language = resolveLanguage(
    spec.language,
    lyrics.lines.map((line: LyricLine) => line.text).join('\n'),
  )

  // 3. Place syllables on notes, phrase by phrase.
  const linesBySection = new Map<number, string[]>()
  lyrics.lines.forEach((line) => {
    const sectionIndex = sectionOrder[line.sectionIndex]
    if (sectionIndex === undefined) return
    const list = linesBySection.get(sectionIndex)
    if (list) list.push(line.text)
    else linesBySection.set(sectionIndex, [line.text])
  })

  const vocalNotes: ScoreNote[] = []
  const harmonyNotes: ScoreNote[] = []

  for (const i of sectionOrder) {
    const result = perSection.get(i)!
    const lines = linesBySection.get(i) ?? []
    const slot = slots[i]!
    const placed: ScoreNote[] = []

    result.phrases.forEach((phrase, phraseIndex) => {
      const phraseNotes = result.notes.slice(phrase.start, phrase.end)
      const syllables = pronounceLine(lines[phraseIndex] ?? '', score.language)
      const placedPhrase = fitSyllablesToNotes(phraseNotes, syllables)
      if (placedPhrase[0]) placedPhrase[0].phraseStart = true
      placed.push(...placedPhrase)
    })

    vocalNotes.push(...placed)

    // Choruses get a harmony a third or fifth above, inside the key.
    if (slot.intensity >= 0.8) {
      const interval = rng.fork(`harm${i}`).pick([3, 4, 7])
      for (const note of placed) {
        harmonyNotes.push({
          ...note,
          midi: snapToScale(note.midi + interval, score.key.tonic, score.key.scale),
          velocity: note.velocity * 0.55,
        })
      }
    }
  }

  const vocalInstrument: InstrumentId = 'vocal'
  score.tracks.push(makeTrack('vocal', 'Lead Vocal', 'vocal', vocalInstrument, vocalNotes, {
    // The lead vocal is the loudest thing in the mix, because it is the thing
    // the song is about. A little presence lift keeps the words readable.
    gainDb: -3, pan: 0,
    fx: { reverbSend: score.genreId === 'ambient' ? 0.38 : 0.18, delaySend: 0.12, sidechain: 0.12, drive: 0.1, highPassHz: 110, presenceDb: 3 },
  }))
  if (harmonyNotes.length > 0) {
    score.tracks.push(makeTrack('vocalHarmony', 'Vocal Harmony', 'vocalHarmony', vocalInstrument, harmonyNotes, {
      gainDb: -10, pan: 0.25,
      fx: { reverbSend: 0.34, delaySend: 0.16, sidechain: 0.15, drive: 0.05, highPassHz: 160 },
    }))
  }

  score.lyrics = lyrics
  score.title = lyrics.title
}

/**
 * Spreads the user's own lyrics over the song's sections.
 *
 * The melody is already written by this point, so the lines are laid onto the
 * phrases in the order they were typed and wrapped round if the song is longer
 * than the lyric. Blank lines separate sections, the way people write lyrics.
 */
function layOutCustomLyrics(
  text: string,
  structure: LyricSectionRequest[],
  sectionOrder: number[],
  slots: FormSlot[],
  spec: SongSpec,
  rng: Rng,
  blocks: LyricBlock[] | null,
): SongLyrics {
  // Structure tags are instructions to the arranger, not words to sing, so
  // they never reach the lyric lines.
  const written = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !/^\[.+\]$/.test(line))
  if (written.length === 0) {
    return generateLyrics({
      theme: spec.theme, mood: spec.mood.id,
      style: spec.vocals === 'rap' ? 'rap' : 'sung', seed: spec.seed, structure,
    })
  }

  const lines: LyricLine[] = []
  if (blocks) {
    // Tagged lyrics: each section sings the lines written under its own tag,
    // in order, and nothing is borrowed from a neighbouring section.
    structure.forEach((section, sectionIndex) => {
      const block = blocks[sectionOrder[sectionIndex]!]
      const own = block?.lines ?? []
      for (let i = 0; i < section.lines; i++) {
        const line = own[i]
        if (line === undefined) break
        lines.push({ text: line, section: slots[sectionOrder[sectionIndex]!]!.kind, sectionIndex })
      }
    })
  } else {
    let cursor = 0
    structure.forEach((section, sectionIndex) => {
      for (let i = 0; i < section.lines; i++) {
        lines.push({
          text: written[cursor % written.length]!,
          section: slots[sectionOrder[sectionIndex]!]!.kind,
          sectionIndex,
        })
        cursor++
      }
    })
  }

  // The title comes from the hook — the line the song says most often — and
  // falls back to the opening line when nothing repeats. A song called "Bos
  // Toxic" is named after what people will actually sing back at it, which the
  // first line of the first verse almost never is.
  const title = hookLine(written)
  void rng

  // The sheet shows what the user typed, not the wrapped-round version, which
  // would repeat lines they only wrote once. It opens with the title, the same
  // as a generated sheet does, so a download says what it is and the panel can
  // drop that first line knowing it is there.
  return { title, lines, formatted: `${title}\n\n${text.trim()}` }
}

/** True when a line says the same short phrase twice in a row. */
function repeatsItself(line: string): boolean {
  return /^(.{2,30}?)([,;]\s*|\s+)\1(\b|$)/iu.test(line.trim())
}

/**
 * The most repeated line, preferring short ones.
 *
 * A hook is short and said often; a long line that happens to appear twice is
 * a repeated verse, not a title. Ties go to whichever came first, so a chorus
 * beats a later refrain.
 */
function hookLine(lines: string[]): string {
  const counts = new Map<string, { count: number; first: number; text: string }>()
  lines.forEach((line, index) => {
    const key = line.toLowerCase().replace(/[^\p{L}\p{N} ]/gu, '').trim()
    if (!key) return
    const seen = counts.get(key)
    if (seen) seen.count++
    // A line that repeats a phrase inside itself — "Bos toxic, bos toxic" — is
    // a hook by construction, even the first time it is written down.
    else counts.set(key, { count: repeatsItself(line) ? 2 : 1, first: index, text: line })
  })

  // Nothing repeated means there is no hook to find, and the opening line is a
  // better title than whichever line happens to be shortest.
  const repeated = [...counts.values()].filter((entry) => entry.count > 1)
  let best = { count: 1, first: 0, text: lines[0] ?? 'Untitled' }
  for (const entry of repeated) {
    // Weight repetition against length: eight words said twice is a verse.
    const words = entry.text.split(/\s+/).length
    const score = entry.count * 10 - words
    const bestScore = best.count * 10 - best.text.split(/\s+/).length
    if (score > bestScore || (score === bestScore && entry.first < best.first)) best = entry
  }

  // A hook line often says the phrase twice — "Bos toxic, bos toxic" — which
  // is right to sing and wrong to print on the sleeve.
  const collapsed = best.text.replace(
    /^(.{2,30}?)([,;]\s*|\s+)\1(\b|$).*$/iu,
    (_match, phrase: string) => phrase,
  )
  const clean = collapsed.replace(/[,.;:!?]+$/, '').trim()
  const title = clean.length > 42 ? `${clean.slice(0, 40).trimEnd()}…` : clean
  // Titles are title-cased when the source line is a short hook.
  return title.split(/\s+/).length <= 4
    ? title.replace(/\b\p{L}/gu, (c) => c.toUpperCase())
    : title
}

/** The two fields a note needs to be sung: what it reads as, and what it sounds like. */
function sing(syllable: Syllable | undefined): Pick<ScoreNote, 'syllable' | 'sounds'> {
  if (!syllable) return { syllable: undefined, sounds: undefined }
  return { syllable: syllable.text, sounds: syllable }
}

/**
 * Places a line's syllables on a phrase's notes. Extra syllables split the
 * notes they land on; spare notes are absorbed into the previous syllable so
 * the melody still runs its full length.
 */
export function fitSyllablesToNotes(notes: ScoreNote[], syllables: Syllable[]): ScoreNote[] {
  if (notes.length === 0) return []
  if (syllables.length === 0) return notes.map((n) => ({ ...n }))

  const out: ScoreNote[] = []
  const noteCount = notes.length
  const syllableCount = syllables.length

  if (syllableCount === noteCount) {
    return notes.map((note, i) => ({ ...note, ...sing(syllables[i]) }))
  }

  if (syllableCount > noteCount) {
    // Split notes, giving the extra syllables to the longest notes first.
    const extras = syllableCount - noteCount
    const splitCounts = new Array(noteCount).fill(1)
    const order = notes
      .map((n, i) => ({ i, duration: n.duration }))
      .sort((a, b) => b.duration - a.duration)
    for (let e = 0; e < extras; e++) {
      const target = order[e % order.length]!.i
      splitCounts[target] += 1
    }
    let syllableIndex = 0
    for (let i = 0; i < noteCount; i++) {
      const note = notes[i]!
      const pieces = splitCounts[i]!
      const pieceDuration = note.duration / pieces
      for (let p = 0; p < pieces; p++) {
        out.push({
          ...note,
          start: note.start + p * pieceDuration,
          duration: pieceDuration * 0.96,
          ...sing(syllables[syllableIndex++]),
          legato: p > 0,
        })
      }
    }
    return out
  }

  // Fewer syllables than notes: melisma — hold each syllable over the extras.
  const perSyllable = new Array(syllableCount).fill(1)
  for (let extra = 0; extra < noteCount - syllableCount; extra++) {
    perSyllable[extra % syllableCount] += 1
  }
  let noteIndex = 0
  for (let s = 0; s < syllableCount; s++) {
    const count = perSyllable[s]!
    for (let c = 0; c < count; c++) {
      const note = notes[noteIndex++]!
      out.push({ ...note, ...sing(c === 0 ? syllables[s] : undefined), legato: c > 0 })
    }
  }
  return out
}

function makeTrack(
  id: string,
  name: string,
  role: TrackRole,
  instrument: InstrumentId,
  notes: ScoreNote[],
  options: { gainDb: number; pan: number; fx: TrackFx },
): ScoreTrack {
  return {
    id, name, role, instrument,
    notes: notes.sort((a, b) => a.start - b.start),
    gainDb: options.gainDb,
    pan: options.pan,
    fx: options.fx,
  }
}

/** Words that describe the request rather than the song. */
const TITLE_NOISE = /\b(\d+\s*(?:bpm|beats?\s*per\s*minute|seconds?|secs?|minutes?|mins?)|\d+|instrumental|no\s+vocals?|without\s+vocals?|backing\s+track|beat\s+only|karaoke|bgm|background\s+music|song|track|music|beat|make|generate|create|please|about|for|with|at|in|on|of|and|or|a|an|the)\b/gi

/**
 * Genre and mood words describe the style, not the subject. A title built
 * only from them is just the brief read back, so those cases fall through to
 * a generated name instead.
 */
const STYLE_WORDS = new Set<string>([
  ...GENRES.flatMap((genre) => [
    ...genre.tags.flatMap((tag) => tag.split(/\s+/)),
    ...genre.label.toLowerCase().split(/[\s/]+/),
    genre.id,
  ]),
  ...MOODS.flatMap((mood) => mood.tags.flatMap((tag) => tag.split(/\s+/))),
  'lofi', 'lo-fi', 'hi-fi', 'sound', 'sounds', 'style', 'vibe', 'vibes', 'type',
])

/**
 * Title for a song with no lyrics to take one from. The prompt is reused only
 * when something specific survives stripping the request's own vocabulary —
 * "lofi chill beat, 30 seconds" is a brief, not a title.
 */
function defaultTitle(spec: SongSpec, rng: Rng): string {
  const cleaned = spec.theme
    .replace(TITLE_NOISE, ' ')
    .replace(/[^\p{L}\p{N}\s'-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  const words = cleaned.split(' ').filter((w) => w.length > 1)
  const subjectWords = words.filter((w) => !STYLE_WORDS.has(w.toLowerCase()))
  // One substantial subject word is enough: "rain" is a title, "chill" is not.
  const hasSubject = subjectWords.length >= 2 || (subjectWords[0]?.length ?? 0) >= 4
  if (hasSubject && words.length <= 5 && cleaned.length <= 40) {
    return words.map((w, i) => (i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w)).join(' ')
  }
  const adjectives = ['Distant', 'Golden', 'Electric', 'Quiet', 'Endless', 'Neon', 'Hollow', 'Silver', 'Restless', 'Slow', 'Paper', 'Low']
  const nouns = ['Signal', 'Horizon', 'Machine', 'Current', 'Light', 'Motion', 'Static', 'Circuit', 'Tide', 'Hours', 'Window', 'Afternoon']
  return `${rng.pick(adjectives)} ${rng.pick(nouns)}`
}

/** Human-readable chord chart, one entry per section. */
export function chordChart(score: Score): { label: string; chords: string[] }[] {
  const flats = keyUsesFlats(score.key.tonic, score.key.scale)
  return score.sections.map((section) => ({
    label: section.label,
    chords: section.chords.map((chord) => chordName(chord, flats)),
  }))
}

/** Chord tones sounding at a given beat — used by the visualiser. */
export function chordAtBeat(score: Score, beat: number): string | null {
  for (const section of score.sections) {
    if (beat >= section.startBeat && beat < section.startBeat + section.lengthBeats) {
      const bar = Math.floor((beat - section.startBeat) / score.beatsPerBar)
      const chord = section.chords[Math.min(section.chords.length - 1, bar)]
      return chord ? chordName(chord, keyUsesFlats(score.key.tonic, score.key.scale)) : null
    }
  }
  return null
}

export { CHORD_INTERVALS }
