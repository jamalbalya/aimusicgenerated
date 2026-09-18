/**
 * The deterministic planning layer that runs before the single ZeroGPU request.
 *
 * It answers one question and answers it locally: given this Style and these
 * Lyrics, what song is being asked for? Genre, tempo, key, form, instruments,
 * voice — all decided here, on this machine, at no cost, before anything is
 * sent.
 *
 * Why plan at all, when ACE-Step takes no tempo, key or chord parameter?
 * Because the caption is the only channel there is, and an unplanned caption
 * uses it badly. "Sad Indonesian song" tells the model almost nothing; the same
 * request planned out says dangdut koplo, 112 BPM, A minor, kendang and suling,
 * verse–chorus form, male lead. That is not enforcement and this module never
 * claims it is — `constraints.ts` files every one of those under
 * NOT_CONTROLLED_BY_ACE_STEP. It is the difference between asking clearly and
 * asking vaguely, which is the only lever a caption-driven model gives you.
 *
 * The genre tables, mood tables and progression library this reads are the same
 * ones the offline engine composes from. That is reuse of a planner, not a
 * substitution of engines: nothing here renders a sample, and the plan's only
 * destination is the caption compiler. The offline engine remains reachable
 * only by explicitly choosing it.
 *
 * Determinism matters and is tested: the same Style, Lyrics, mode and duration
 * must produce the same plan, so a person who presses Generate twice with the
 * same words gets the same *request*. The seed is derived from the input rather
 * than from the clock for exactly that reason.
 */

import {
  buildSpec, detectGenreDetailed, genreIsConfident, type SongSpec,
} from '../compose/prompt'
import { getProgression } from '../theory/progressions'
import { resolveProgressionPool } from '../compose/harmony'
import { NOTE_NAMES, SCALES } from '../theory/pitch'
import { detectLanguage } from '../lang'
import type { LanguageId } from '../lang/types'
import type { SectionKind } from '../compose/types'
import { planLyrics, type LyricPlan, type LyricProblem } from './lyricPlan'
import { ACE_STEP_DURATION_RANGE, aceStepTextTooLong } from '../providers/aceStepRequest'

export interface LiveGenerationInput {
  style: string
  lyrics: string
  /** Seconds, or undefined for Auto — ACE-Step choosing the length from the words. */
  durationSeconds?: number
  instrumental: boolean
  vocalGender: 'male' | 'female' | 'auto'
  language: LanguageId | 'auto'
}

export interface PlannedForm {
  kind: SectionKind
  label: string
  /** True when the section came from the user's own sheet rather than a template. */
  fromLyrics: boolean
}

export interface MusicalPlan {
  genre: string
  genreFamily: string
  genreId: string
  mood: string
  /** The emotional direction, as a short phrase for the caption. */
  emotion: string
  targetBpm: number
  /** How the beat sits: straight, shuffled, syncopated. */
  groove: string
  keyName: string
  tonic: number
  scale: string
  /** The chord movement the genre implies, named rather than sent. */
  chordDirection: string
  form: PlannedForm[]
  /** Seconds, or undefined when ACE-Step is choosing. */
  targetDurationSeconds: number | undefined
  vocalType: string
  vocalRange: string
  instruments: string[]
  /** 0..1 — how busy the arrangement should be. */
  arrangementDensity: number
  mixDirection: string
  masterDirection: string
  instrumental: boolean
  language: LanguageId
  /**
   * Whether the genre was detected confidently enough to state it to the model.
   *
   * When false the genre still drives the plan's own defaults, because
   * something has to, but the caption says nothing about it and names no
   * instruments — asserting a guessed genre in the one channel the model reads
   * is how a piano ballad gets told it is dangdut koplo.
   */
  genreConfident: boolean
}

export interface LivePlan {
  music: MusicalPlan
  lyrics: LyricPlan
  /** Everything wrong with the request, lyric problems included. */
  problems: LyricProblem[]
  /** False when any problem is an error. The request must not be sent. */
  valid: boolean
  /** The spec the plan was derived from, for tests and for the report. */
  spec: SongSpec
}

/** Separates the fields of the seed source so two of them cannot run together. */
const SEED_SEPARATOR = String.fromCharCode(0)

/**
 * A seed that depends only on the request.
 *
 * `buildSpec` fills unstated choices — which scale, which tonic — from a seeded
 * RNG, and its default seed contains `Date.now()`. Planning the same request
 * twice would then produce two different keys, and the caption compiled from it
 * would differ between two presses of the same button. FNV-1a over the whole
 * input fixes that: same words, same plan, every time.
 */
export function planSeed(input: LiveGenerationInput): string {
  const source = [
    input.style, input.lyrics, String(input.durationSeconds ?? 'auto'),
    String(input.instrumental), input.vocalGender, input.language,
  ].join(SEED_SEPARATOR)
  let hash = 0x811c9dc5
  for (let index = 0; index < source.length; index++) {
    hash ^= source.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return `live-${hash.toString(36)}`
}

/** Straight, shuffled or pushed, from the genre's own swing figure. */
function grooveOf(spec: SongSpec): string {
  const { swing, swingSubdivision, density } = spec.genre
  if (swing >= 0.3) return `shuffled ${swingSubdivision}ths, swung hard`
  if (swing >= 0.12) return `lightly swung ${swingSubdivision}ths`
  if (density >= 0.75) return 'straight and syncopated'
  return 'straight, steady time'
}

/** The emotional direction, from mood energy and brightness rather than a label alone. */
function emotionOf(spec: SongSpec): string {
  const { energy, brightness, label } = spec.mood
  const lift = brightness >= 0.7 ? 'bright' : brightness <= 0.35 ? 'dark' : 'muted'
  const drive = energy >= 0.7 ? 'driving' : energy <= 0.35 ? 'restrained' : 'measured'
  return `${label.toLowerCase()}, ${lift} and ${drive}`
}

/**
 * The chord movement this genre and mode imply, named for the caption.
 *
 * Named, not sent: ACE-Step has no chord input. What goes in the caption is the
 * *character* of the harmony — where it should feel tension and where it should
 * resolve — because that is language a text-conditioned model can act on, while
 * a roman-numeral sequence is not.
 */
function chordDirectionOf(spec: SongSpec): string {
  // The same mode-filtered pool the composer draws from, rather than the
  // genre's raw list. Taking the raw first entry described a song planned in A
  // major as "i-bVI-bIII-bVII", a minor progression, because the genre happens
  // to list a minor idiom first. The caption then asked for two different keys
  // in one clause.
  const template = resolveProgressionPool(spec.genre, spec.key.scale)
    .map((id) => getProgression(id))
    .find((found) => found !== undefined)
  // Read from the progression's own declared mode where there is one, rather
  // than from the melodic scale's name. D dorian is not spelled "minor" and was
  // being described as a major-key lift while the progression underneath it was
  // i-bVII-bVI-V — the caption contradicting itself in two adjacent clauses.
  const minorScale = spec.key.scale.toLowerCase().includes('minor')
    || spec.key.scale === 'phrygian' || spec.key.scale === 'locrian'
    || spec.key.scale === 'dorian' || spec.key.scale === 'blues'
  const minor = template && template.mode !== 'either' ? template.mode === 'minor' : minorScale
  const colour = minor ? 'minor-key tension resolving home' : 'major-key lift with a clear resolution'
  return template ? `${template.label}, ${colour}` : colour
}

/** The template form for a genre, used when the sheet carries no section tags. */
function templateForm(spec: SongSpec, durationSeconds: number | undefined): PlannedForm[] {
  const seconds = durationSeconds ?? 180
  const short = seconds < 120
  const long = seconds >= 210
  const make = (kind: SectionKind, label: string): PlannedForm => ({ kind, label, fromLyrics: false })

  if (spec.genre.formStyle === 'edm') {
    return short
      ? [make('intro', 'Intro'), make('verse', 'Build'), make('drop', 'Drop'), make('outro', 'Outro')]
      : [make('intro', 'Intro'), make('verse', 'Verse'), make('prechorus', 'Build'), make('drop', 'Drop'),
        make('breakdown', 'Breakdown'), make('verse', 'Verse 2'), make('prechorus', 'Build 2'),
        make('drop', 'Drop 2'), make('outro', 'Outro')]
  }
  if (spec.genre.formStyle === 'ambient' || spec.genre.formStyle === 'loop') {
    return [make('intro', 'Intro'), make('verse', 'Section A'), make('bridge', 'Section B'),
      make('verse', 'Section A2'), make('outro', 'Outro')]
  }
  if (short) {
    return [make('intro', 'Intro'), make('verse', 'Verse 1'), make('chorus', 'Chorus'), make('outro', 'Outro')]
  }
  // The full song form. Pre-choruses and a bridge only when there is room for
  // them: forcing ten sections into two minutes gives each one eight bars and
  // the song never settles anywhere.
  return [
    make('intro', 'Intro'), make('verse', 'Verse 1'),
    ...(long ? [make('prechorus', 'Pre-Chorus')] : []),
    make('chorus', 'Chorus'), make('verse', 'Verse 2'),
    ...(long ? [make('prechorus', 'Pre-Chorus 2')] : []),
    make('chorus', 'Chorus 2'),
    ...(long ? [make('bridge', 'Bridge')] : []),
    make('chorus', 'Final Chorus'), make('outro', 'Outro'),
  ]
}

/**
 * The vocal range to ask for, in words a caption can carry.
 *
 * ACE-Step has no range parameter — this is a description, and it is the honest
 * kind: naming a register the model is likely to have heard described that way,
 * rather than a note range it has no way to act on.
 */
function vocalRangeOf(gender: 'male' | 'female' | 'auto', spec: SongSpec): string {
  if (spec.instrumental) return 'no vocal'
  const bright = spec.mood.brightness >= 0.65
  if (gender === 'male') return bright ? 'tenor, comfortable upper-chest range' : 'baritone, warm lower-mid range'
  if (gender === 'female') return bright ? 'soprano, open upper range' : 'alto, warm lower-mid range'
  return bright ? 'mid-to-upper range, comfortable and open' : 'comfortable mid range'
}

function vocalTypeOf(spec: SongSpec): string {
  switch (spec.vocals) {
    case 'none': return 'instrumental, no vocal'
    case 'rap': return 'rapped lead, clear diction'
    case 'chant': return 'chanted group vocal'
    default: return 'sung lead vocal'
  }
}

/** The instruments the genre is built from, named for the caption. */
function instrumentsOf(spec: SongSpec): string[] {
  const { chords, bass, lead, pad } = spec.genre.instruments
  const named = [chords[0], bass[0], lead[0], pad[0]]
    .filter((id) => id !== undefined)
    .map((id) => String(id).replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase())
  return [...new Set(named)]
}

/** Mix direction: what should sit where, given how busy the arrangement is. */
function mixDirectionOf(spec: SongSpec): string {
  // An instrumental has no vocal to put in front of anything. Saying "lead
  // vocal forward" in the caption of a request whose own `instrumental` flag is
  // true is the caption arguing with the payload.
  if (spec.instrumental) {
    return 'clear balanced instrumental mix, each part audible, nothing masking the lead line'
  }
  const dense = spec.genre.density >= 0.7
  return dense
    ? 'lead vocal forward and clear above a busy arrangement, instruments carved around the voice'
    : 'lead vocal forward and intimate, arrangement open around it'
}

/** Master direction: loudness and tone, in the terms a caption can carry. */
function masterDirectionOf(spec: SongSpec): string {
  const bright = spec.genre.brightness >= 0.65
  return `clean modern master, controlled dynamics, no clipping or distortion, ${
    bright ? 'bright but not harsh' : 'warm and full without mud'}, wide clean stereo image`
}

const keyNameOf = (tonic: number, scale: string): string =>
  `${NOTE_NAMES[((tonic % 12) + 12) % 12]} ${scale.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase()}`

/**
 * Plans one live generation.
 *
 * Never throws for bad input: a request that cannot be served comes back with
 * `valid: false` and the reasons, because the caller's job is to show them, not
 * to catch an exception.
 */
export function planLiveGeneration(input: LiveGenerationInput): LivePlan {
  const seed = planSeed(input)
  const spec = buildSpec(input.style, {
    seed,
    ...(input.durationSeconds !== undefined ? { durationSeconds: input.durationSeconds } : {}),
    ...(input.instrumental ? { vocals: 'none' as const } : {}),
    ...(input.vocalGender !== 'auto' ? { vocalGender: input.vocalGender } : {}),
    ...(input.language !== 'auto' ? { language: input.language } : {}),
    ...(input.lyrics.trim() ? { customLyrics: input.lyrics } : {}),
  })

  const language: LanguageId = input.language !== 'auto'
    ? input.language
    : (input.lyrics.trim() ? detectLanguage(input.lyrics) : 'en')

  const lyrics = planLyrics(input.lyrics, language, input.durationSeconds, detectLanguage)

  // Sections the user actually wrote win over any template: they are the form
  // the person asked for, and overriding them with a genre default would be
  // rewriting the song.
  const fromSheet: PlannedForm[] = lyrics.sections.map((section) => ({
    kind: section.kind, label: section.label, fromLyrics: true,
  }))
  const form = input.instrumental
    ? templateForm(spec, input.durationSeconds)
    : fromSheet.length > 1 ? fromSheet : templateForm(spec, input.durationSeconds)

  const problems: LyricProblem[] = input.instrumental
    // An instrumental has no sheet to judge. Nothing about the lyric box
    // applies, including its emptiness, which is the point of the mode.
    ? []
    : [...lyrics.problems]

  if (!input.style.trim()) {
    problems.unshift({
      code: 'EMPTY', severity: 'error',
      message: 'Describe the song you want. The Style text is ACE-Step\'s only description of the music.',
    })
  }

  // The sheet's own character limit, which is not the same question as whether
  // it can be sung in the time asked for: a sheet can be perfectly singable at
  // the length requested and still be more characters than ACE-Step accepts.
  // Found by an end-to-end test whose 80-line sheet passed every musical check
  // and was then refused by the provider — the planner had claimed the request
  // was fine and the GPU was never going to see it.
  //
  // Checked on the sheet as it will be sent, and phrased by the same function
  // the provider uses, so the two cannot disagree about the same number.
  if (!input.instrumental) {
    const tooLong = aceStepTextTooLong('lyrics', lyrics.text)
    if (tooLong) {
      problems.unshift({ code: 'TOO_LONG_FOR_DURATION', severity: 'error', message: tooLong })
    }
  }

  if (input.durationSeconds !== undefined) {
    const { min, max } = ACE_STEP_DURATION_RANGE
    if (!Number.isFinite(input.durationSeconds)
        || input.durationSeconds < min || input.durationSeconds > max) {
      problems.unshift({
        code: 'TOO_LONG_FOR_DURATION', severity: 'error',
        message: `ACE-Step makes songs from ${min} to ${max} seconds long; `
          + `${input.durationSeconds} seconds is outside that.`,
      })
    }
  }

  const genreConfident = genreIsConfident(detectGenreDetailed(
    ` ${input.style.toLowerCase().replace(/[^\p{L}\p{N}#&'\s.,;-]/gu, ' ').replace(/\s+/g, ' ')} `))

  const music: MusicalPlan = {
    genre: spec.genre.label,
    genreFamily: spec.genre.family,
    genreId: spec.genre.id,
    mood: spec.mood.label,
    emotion: emotionOf(spec),
    targetBpm: spec.bpm,
    groove: grooveOf(spec),
    keyName: keyNameOf(spec.key.tonic, spec.key.scale),
    tonic: spec.key.tonic,
    scale: spec.key.scale,
    chordDirection: chordDirectionOf(spec),
    form,
    targetDurationSeconds: input.durationSeconds,
    vocalType: vocalTypeOf(spec),
    vocalRange: vocalRangeOf(input.vocalGender, spec),
    instruments: instrumentsOf(spec),
    arrangementDensity: spec.genre.density,
    mixDirection: mixDirectionOf(spec),
    masterDirection: masterDirectionOf(spec),
    instrumental: input.instrumental,
    language,
    genreConfident,
  }

  return {
    music,
    lyrics,
    problems,
    valid: !problems.some((problem) => problem.severity === 'error'),
    spec,
  }
}

/** The scales the planner can name, for a test that no plan invents one. */
export const PLANNABLE_SCALES = Object.keys(SCALES)
