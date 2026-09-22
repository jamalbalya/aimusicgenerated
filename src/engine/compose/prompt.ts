/**
 * Turns a free-text description ("a dark trap beat at 140 with sad piano")
 * into a concrete song specification. Everything is matched locally — no
 * network call, no API key, no quota.
 */

import { parsePitchClass, SCALE_NAMES, type PitchClass, type ScaleName } from '../theory/pitch'
import { GENRES, getGenre, type GenreDef, type VocalStyle } from './genres'
import { Rng } from '../core/rng'
import type { LanguageId } from '../lang/types'

export type Mood =
  | 'happy' | 'sad' | 'dark' | 'epic' | 'chill' | 'energetic'
  | 'romantic' | 'angry' | 'dreamy' | 'nostalgic' | 'tense' | 'hopeful'

export interface MoodDef {
  id: Mood
  label: string
  tags: string[]
  /** Preference for minor tonality, 0..1. */
  minorBias: number
  /** Multiplier applied to the genre's tempo midpoint. */
  tempoScale: number
  /** 0..1 — pushes arrangement density. */
  energy: number
  brightness: number
}

export const MOODS: MoodDef[] = [
  { id: 'happy', label: 'Happy', tags: ['happy', 'joyful', 'cheerful', 'fun', 'sunny', 'playful', 'feel good'], minorBias: 0.05, tempoScale: 1.05, energy: 0.7, brightness: 0.85 },
  // The inflections matter as much as the roots. Tags are matched as plain
  // substrings, so 'melancholy' does not match "deeply melancholic" and
  // 'lonely' does not match "quiet loneliness" — a style line that said both
  // scored zero here and lost to Romantic on the single word "intimate",
  // which put a song about a tired father into a major key.
  { id: 'sad', label: 'Sad', tags: ['sad', 'sadness', 'melancholy', 'melancholic', 'melancholia', 'heartbreak', 'heartbroken', 'lonely', 'loneliness', 'crying', 'sorrow', 'sorrowful', 'grief', 'mournful', 'blue'], minorBias: 0.95, tempoScale: 0.86, energy: 0.3, brightness: 0.35 },
  { id: 'dark', label: 'Dark', tags: ['dark', 'sinister', 'evil', 'haunting', 'creepy', 'ominous', 'menacing'], minorBias: 0.98, tempoScale: 0.95, energy: 0.55, brightness: 0.22 },
  { id: 'epic', label: 'Epic', tags: ['epic', 'heroic', 'powerful', 'triumphant', 'grand', 'massive', 'battle'], minorBias: 0.7, tempoScale: 0.98, energy: 0.9, brightness: 0.6 },
  { id: 'chill', label: 'Chill', tags: ['chill', 'relaxed', 'laid back', 'mellow', 'calm', 'lazy', 'smooth'], minorBias: 0.45, tempoScale: 0.85, energy: 0.28, brightness: 0.45 },
  { id: 'energetic', label: 'Energetic', tags: ['energetic', 'hype', 'pumped', 'intense', 'workout', 'fast', 'party'], minorBias: 0.4, tempoScale: 1.12, energy: 0.95, brightness: 0.78 },
  { id: 'romantic', label: 'Romantic', tags: ['romantic', 'love', 'tender', 'sweet', 'intimate', 'wedding'], minorBias: 0.3, tempoScale: 0.9, energy: 0.4, brightness: 0.62 },
  { id: 'angry', label: 'Angry', tags: ['angry', 'furious', 'rage', 'aggressive', 'violent', 'savage'], minorBias: 0.92, tempoScale: 1.1, energy: 0.95, brightness: 0.45 },
  { id: 'dreamy', label: 'Dreamy', tags: ['dreamy', 'ethereal', 'floaty', 'hazy', 'surreal', 'underwater'], minorBias: 0.35, tempoScale: 0.82, energy: 0.25, brightness: 0.55 },
  { id: 'nostalgic', label: 'Nostalgic', tags: ['nostalgic', 'memories', 'wistful', 'bittersweet', 'childhood', 'retro'], minorBias: 0.6, tempoScale: 0.9, energy: 0.4, brightness: 0.5 },
  { id: 'tense', label: 'Tense', tags: ['tense', 'suspense', 'anxious', 'thriller', 'urgent', 'chase'], minorBias: 0.9, tempoScale: 1.05, energy: 0.7, brightness: 0.4 },
  { id: 'hopeful', label: 'Hopeful', tags: ['hopeful', 'uplifting', 'inspiring', 'motivational', 'rising', 'bright future'], minorBias: 0.2, tempoScale: 1.0, energy: 0.65, brightness: 0.8 },
]

const MOOD_BY_ID = new Map(MOODS.map((m) => [m.id, m]))
export function getMood(id: Mood): MoodDef {
  return MOOD_BY_ID.get(id) ?? MOODS[0]!
}

export interface SongSpec {
  prompt: string
  genre: GenreDef
  mood: MoodDef
  bpm: number
  key: { tonic: PitchClass; scale: ScaleName }
  /** Target duration in seconds. */
  durationSeconds: number
  vocals: VocalStyle
  /** Subject matter handed to the lyric writer. */
  theme: string
  seed: string
  /** True when the user asked for an instrumental explicitly. */
  instrumental: boolean
  /** 0..1 overrides derived from the prompt. */
  energy: number
  /** Set when the user named an explicit chord progression template. */
  progressionId?: string
  /**
   * The language the vocals are pronounced in. `auto` reads it off whatever
   * lyrics end up being sung, which is the right answer whenever the singer is
   * given words rather than asked to invent them.
   */
  language: LanguageId | 'auto'
  /** Which voice sings it; `auto` lets the genre decide. */
  vocalGender: 'male' | 'female' | 'auto'
  /** Lyrics the user wrote, sung instead of generated ones. */
  customLyrics?: string
}

// Said in the languages this is most often asked in. A request for "dramatic
// male vocal" is not a decoration on the prompt — it names who sings.
//
// Matched on word boundaries, because "female" ends in "male": a plain
// substring test hears every request for a female vocal as a male one.
const MALE_PATTERN = /\b(male (vocal|voice|singer)s?|man singing|baritone|tenor|bass vocals?|vokal pria|penyanyi pria|suara pria|cowok|laki-laki|pria)\b/
const FEMALE_PATTERN = /\b(female (vocal|voice|singer)s?|woman singing|soprano|alto|vokal wanita|penyanyi wanita|suara wanita|cewek|perempuan|wanita)\b/

const INSTRUMENTAL_WORDS = ['instrumental', 'no vocals', 'no vocal', 'without vocals', 'karaoke', 'beat only', 'backing track', 'bgm', 'background music']
const RAP_WORDS = ['rap', 'rapping', 'bars', 'verse spitting', 'mc', 'freestyle']

/** Extracts a tempo in BPM if the prompt states one. */
function parseBpm(text: string): number | null {
  const match = /(\d{2,3})\s*(?:bpm|beats per minute)/.exec(text)
  if (match) {
    const value = Number(match[1])
    if (value >= 40 && value <= 240) return value
  }
  const at = /\bat\s+(\d{2,3})\b/.exec(text)
  if (at) {
    const value = Number(at[1])
    if (value >= 40 && value <= 240) return value
  }
  return null
}

/** Extracts a duration in seconds if the prompt states one. */
function parseDuration(text: string): number | null {
  // Longest alternatives first: "min" would otherwise win against "minutes"
  // and swallow the trailing seconds.
  const minSec = /(\d+)\s*(?:minutes|minute|mins|min)\s*(?:and\s*)?(\d{1,2})?\s*(?:seconds|second|secs|sec)?/.exec(text)
  if (minSec) {
    const minutes = Number(minSec[1])
    const seconds = minSec[2] ? Number(minSec[2]) : 0
    const total = minutes * 60 + seconds
    if (total >= 10 && total <= 900) return total
  }
  const secOnly = /(\d{2,3})\s*(?:seconds|second|secs|sec)\b/.exec(text)
  if (secOnly) {
    const total = Number(secOnly[1])
    if (total >= 10 && total <= 900) return total
  }
  return null
}

/** Extracts an explicit key such as "in F# minor" or "key of Eb". */
function parseKey(text: string): { tonic: PitchClass; scale: ScaleName } | null {
  const match = /(?:\bin\b|\bkey of\b)\s+([a-gA-G][#b]?)\s*(major|minor|maj|min|dorian|lydian|mixolydian|phrygian|locrian|harmonic minor|melodic minor|blues|pentatonic)?/.exec(text)
  if (!match) return null
  const tonic = parsePitchClass(match[1]!)
  if (tonic === null) return null
  const raw = (match[2] ?? '').replace(/\s+/g, '')
  const map: Record<string, ScaleName> = {
    major: 'major', maj: 'major', minor: 'minor', min: 'minor',
    dorian: 'dorian', lydian: 'lydian', mixolydian: 'mixolydian',
    phrygian: 'phrygian', locrian: 'locrian', harmonicminor: 'harmonicMinor',
    melodicminor: 'melodicMinor', blues: 'blues', pentatonic: 'majorPentatonic',
  }
  return { tonic, scale: map[raw] ?? 'major' }
}

/**
 * The words that turn the phrase after them into a refusal.
 *
 * English and Indonesian, because the people using this write in both and a
 * sheet in Indonesian with an English style line is the normal case here.
 * `tanpa` is "without", `bukan` is "not/isn't", `jangan` is "don't".
 */
const EXCLUSION_WORDS = [
  'no', 'not', 'non', 'without', 'avoid', 'avoiding', 'never', 'exclude',
  'excluding', 'except', 'minus', 'anti', 'hindari', 'tanpa', 'bukan', 'jangan',
]

/**
 * What the person asked NOT to have.
 *
 * "no jazz, no EDM" used to name jazz. `detectGenre` asks whether the text
 * contains a genre's label, `text.includes('jazz')` is true of "no jazz", and
 * the request came back a swung jazz track whose caption read
 *
 *     "...dignified sorrow, no jazz, no EDM., Jazz, roots, ... swung hard"
 *
 * — the refusal and its exact opposite in one sentence, with the plan choosing
 * jazz progressions to match. A refusal is the strongest thing a person can say
 * about a genre and it was being read as a request for it.
 *
 * Each exclusion runs from the refusing word to the next comma, semicolon,
 * full stop, or "and"/"or", because that is where a listed refusal ends:
 * "no jazz, no EDM" is two, and "without heavy drums or distorted guitar" is
 * two as well. The spans are returned so a caller can both ignore them when
 * detecting and refuse to append a direction that contradicts them.
 */
export function parseExclusions(text: string): string[] {
  const found: string[] = []
  const pattern = new RegExp(
    String.raw`\b(?:${EXCLUSION_WORDS.join('|')})[\s-]+([^,;.]+?)(?=\s*(?:,|;|\.|\band\b|\bor\b|$))`,
    'gu',
  )
  for (const match of text.matchAll(pattern)) {
    const phrase = match[1]!.trim()
    // "no" also appears in ordinary prose ("no more than", "not too bright").
    // A refusal of nothing is not a refusal.
    if (phrase.length >= 2) found.push(phrase)
  }
  return found
}

/**
 * The text with every refusal blanked out, for detection to read.
 *
 * Blanked rather than deleted: removing the span would let the words either
 * side become adjacent and form a phrase nobody wrote.
 */
export function withoutExclusions(text: string): string {
  let out = text
  for (const phrase of parseExclusions(text)) {
    out = out.split(phrase).join(' '.repeat(phrase.length))
  }
  return out
}

/** True when `term` is something the text refused. */
export function isExcluded(text: string, term: string): boolean {
  const wanted = term.toLowerCase().trim()
  if (!wanted) return false
  return parseExclusions(text.toLowerCase()).some(
    (phrase) => phrase === wanted || phrase.split(/\s+/).includes(wanted),
  )
}

function scoreTags(text: string, tags: readonly string[]): number {
  let score = 0
  for (const tag of tags) {
    if (!text.includes(tag)) continue
    // Longer, more specific phrases outweigh single common words.
    score += 1 + tag.length / 12
  }
  return score
}

/**
 * How strongly a genre was detected, alongside which one.
 *
 * `matches` counts distinct tags of that genre found in the text, and
 * `namedDirectly` is true when the genre's own label appears. One incidental
 * tag is not a genre detection: "melancholic Indonesian ballad, soft piano"
 * matches Dangdut Koplo on the single word "indonesian", and a caption that
 * then tells the model "Dangdut Koplo, organ, electric bass, flute" is
 * contradicting the person who asked for a piano ballad.
 *
 * The composer has always been free to guess here — a guess only chose a
 * chord table. The live pipeline writes its guess into the caption, where a
 * wrong one actively fights the request, so it needs to know how sure it is.
 */
export interface GenreDetection {
  genre: GenreDef
  matches: number
  namedDirectly: boolean
}

/** True when the detection is worth putting in words the model will read. */
export function genreIsConfident(detection: GenreDetection | null): boolean {
  if (!detection) return false
  return detection.namedDirectly || detection.matches >= 2
}

export function detectGenreDetailed(text: string): GenreDetection | null {
  const genre = detectGenre(text)
  if (!genre) return null
  // Counted on the text with refusals blanked, so "no jazz" never contributes
  // confidence to Jazz. Confidence is what decides whether the guess is written
  // into the caption at all.
  const visible = withoutExclusions(text)
  const matches = genre.tags.filter((tag) => visible.includes(tag)).length
  return { genre, matches, namedDirectly: visible.includes(genre.label.toLowerCase()) }
}

/**
 * The genre the text is asking for.
 *
 * A genre the person *named* beats one merely inferred from tags, and that is
 * not a tuning preference — it is the difference between reading somebody's
 * description and overruling it. Scoring alone got this wrong on an ordinary
 * request:
 *
 *     "Romantic melancholic jazz ballad at 72 BPM, ... delicate piano, ..."
 *
 * Classical scored 3.08 on the tags `piano` and `romantic`; Jazz scored 2.67 on
 * the word `jazz`. The caption then went out reading "jazz ballad ... Classical,
 * score" — two genres in one sentence, one of them nobody asked for — and the
 * plan chose classical progressions and instruments to match. "Piano" appears in
 * almost every ballad ever described, and "romantic" here is a mood and not a
 * period.
 *
 * So: any genre whose own name appears in the text is considered first, and the
 * tag scores only break ties among those. Tag scoring is the fallback for a
 * description that names no genre at all, which is most of them.
 */
export function detectGenre(text: string): GenreDef | null {
  // Everything below reads the text with refusals blanked. "no jazz" is not a
  // request for jazz, and before this it was the strongest one the detector
  // could see: a named genre beats every tag score.
  const visible = withoutExclusions(text)
  const score = (genre: GenreDef): number =>
    scoreTags(visible, genre.tags) + scoreTags(visible, [genre.label.toLowerCase()])

  const named = GENRES.filter((genre) => visible.includes(genre.label.toLowerCase()))
  const pool = (named.length > 0 ? named : GENRES)
    // A refused genre is never the answer, even if some tag of it survives
    // elsewhere in the sentence.
    .filter((genre) => !isExcluded(text, genre.label))

  let best: GenreDef | null = null
  let bestScore = 0
  for (const genre of pool) {
    const value = score(genre)
    if (value > bestScore) {
      bestScore = value
      best = genre
    }
  }
  return bestScore > 0 ? best : null
}

export function detectMood(text: string): MoodDef | null {
  const visible = withoutExclusions(text)
  let best: MoodDef | null = null
  let bestScore = 0
  for (const mood of MOODS) {
    const score = scoreTags(visible, mood.tags)
    if (score > bestScore) {
      bestScore = score
      best = mood
    }
  }
  return bestScore > 0 ? best : null
}

/** Pulls the "about X" subject out of a prompt for the lyric writer. */
export function detectTheme(text: string): string {
  const about = /\babout\s+(.{3,90}?)(?:[.,;]|$)/.exec(text)
  if (about) return about[1]!.trim()
  const forWhom = /\bfor\s+(?:my\s+)?(.{3,60}?)(?:[.,;]|$)/.exec(text)
  if (forWhom) return forWhom[1]!.trim()
  return ''
}

export interface PromptOverrides {
  genreId?: string
  mood?: Mood
  bpm?: number
  tonic?: PitchClass
  scale?: ScaleName
  durationSeconds?: number
  vocals?: VocalStyle
  seed?: string
  theme?: string
  progressionId?: string
  language?: LanguageId | 'auto'
  customLyrics?: string
  vocalGender?: 'male' | 'female' | 'auto'
}

/**
 * Resolves a prompt plus any explicit UI overrides into a full specification.
 * Overrides always win; anything not stated is inferred from the text and then
 * filled in deterministically from the seed.
 */
export function buildSpec(prompt: string, overrides: PromptOverrides = {}): SongSpec {
  const text = ` ${prompt.toLowerCase().replace(/[^\p{L}\p{N}#&'\s.,;-]/gu, ' ').replace(/\s+/g, ' ')} `
  const seed = overrides.seed ?? `${prompt}|${Date.now()}`
  const rng = new Rng(seed)

  const genre = overrides.genreId ? getGenre(overrides.genreId) : (detectGenre(text) ?? getGenre('pop'))
  const mood = overrides.mood ? getMood(overrides.mood) : (detectMood(text) ?? inferMoodFromGenre(genre, rng))

  const [bpmLow, bpmHigh] = genre.bpm
  const genreMid = (bpmLow + bpmHigh) / 2
  const inferredBpm = Math.round(
    Math.max(bpmLow - 6, Math.min(bpmHigh + 6, genreMid * mood.tempoScale + rng.float(-4, 4))),
  )
  const bpm = clampBpm(overrides.bpm ?? parseBpm(text) ?? inferredBpm)

  const explicitKey = parseKey(text)
  let tonic: PitchClass
  let scale: ScaleName
  if (overrides.tonic !== undefined && overrides.scale) {
    tonic = overrides.tonic
    scale = overrides.scale
  } else if (explicitKey) {
    tonic = explicitKey.tonic
    scale = explicitKey.scale
  } else {
    scale = pickScale(genre, mood, rng)
    // Keys in the lower half of the circle sit better for the vocal range.
    tonic = rng.pick([0, 2, 3, 5, 7, 8, 9, 10]) as PitchClass
  }
  if (overrides.scale && SCALE_NAMES.includes(overrides.scale)) scale = overrides.scale
  if (overrides.tonic !== undefined) tonic = overrides.tonic

  const instrumental =
    overrides.vocals === 'none' ||
    (overrides.vocals === undefined && INSTRUMENTAL_WORDS.some((w) => text.includes(w)))

  // A song has a singer on it unless the listener asked for one that does not.
  // The genre decides *how* it is delivered — sung, rapped, chanted — but never
  // whether there is a voice at all: a request for "lo-fi" is a request for a
  // sound, not an instruction to drop the vocal, and silently returning a
  // backing track is the single most confusing thing this could do.
  let vocals: VocalStyle
  if (overrides.vocals) {
    vocals = overrides.vocals
  } else if (instrumental) {
    vocals = 'none'
  } else if (RAP_WORDS.some((w) => text.includes(w))) {
    vocals = 'rap'
  } else if (genre.vocalStyle === 'none') {
    vocals = 'sung'
  } else {
    vocals = genre.vocalStyle
  }

  const durationSeconds = Math.round(
    Math.max(15, Math.min(600, overrides.durationSeconds ?? parseDuration(text) ?? defaultDuration(genre))),
  )

  const theme = overrides.theme?.trim() || detectTheme(text) || prompt.trim()

  return {
    prompt,
    genre,
    mood,
    bpm,
    key: { tonic, scale },
    durationSeconds,
    vocals,
    theme,
    seed,
    instrumental: vocals === 'none',
    energy: clamp01(mood.energy * 0.6 + genre.density * 0.4),
    progressionId: overrides.progressionId,
    language: overrides.language ?? 'auto',
    vocalGender: overrides.vocalGender
      ?? (FEMALE_PATTERN.test(text) ? 'female' : MALE_PATTERN.test(text) ? 'male' : 'auto'),
    ...(overrides.customLyrics?.trim() ? { customLyrics: overrides.customLyrics.trim() } : {}),
  }
}

function clampBpm(bpm: number): number {
  return Math.max(40, Math.min(240, Math.round(bpm)))
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v
}

function defaultDuration(genre: GenreDef): number {
  switch (genre.formStyle) {
    case 'ambient': return 150
    case 'loop': return 120
    case 'edm': return 165
    case 'through': return 135
    default: return 150
  }
}

function inferMoodFromGenre(genre: GenreDef, rng: Rng): MoodDef {
  const preference: Record<string, Mood[]> = {
    trap: ['dark', 'energetic'], drill: ['dark', 'tense'], phonk: ['dark', 'energetic'],
    lofi: ['chill', 'nostalgic'], ambient: ['dreamy', 'chill'], cinematic: ['epic', 'tense'],
    metal: ['angry', 'dark'], punk: ['energetic', 'angry'], edm: ['energetic', 'epic'],
    gospel: ['hopeful', 'happy'], lullaby: ['dreamy', 'romantic'], corporate: ['hopeful', 'happy'],
    rnb: ['romantic', 'chill'], indie: ['dreamy', 'nostalgic'], synthwave: ['nostalgic', 'dark'],
    blues: ['sad', 'nostalgic'], jazz: ['chill', 'romantic'], disco: ['happy', 'energetic'],
    kpop: ['happy', 'energetic'], jpop: ['hopeful', 'energetic'], afrobeats: ['happy', 'chill'],
  }
  const options = preference[genre.id] ?? ['happy', 'chill', 'hopeful']
  return getMood(rng.pick(options))
}

function pickScale(genre: GenreDef, mood: MoodDef, rng: Rng): ScaleName {
  const minorish: ScaleName[] = ['minor', 'dorian', 'phrygian', 'harmonicMinor', 'minorPentatonic', 'blues', 'locrian', 'phrygianDominant', 'melodicMinor', 'japanese']
  const candidates = genre.scales
  const weights = candidates.map((s) => {
    const isMinor = minorish.includes(s)
    return isMinor ? mood.minorBias + 0.1 : 1.1 - mood.minorBias
  })
  return rng.weighted(candidates, weights)
}
