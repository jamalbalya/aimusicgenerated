/**
 * Compiling a plan into the caption ACE-Step actually receives.
 *
 * The hard fact this module is built around: **the caption is 512 characters**.
 * That is ACE-Step's own `GenerationParams` limit, re-checked by the Space's
 * guard, which answers HTTP 400 and spends no GPU. Every musical direction —
 * genre, tempo, key, groove, harmony, melody, voice, arrangement, mix, master —
 * competes for those 512 characters with the words the person actually typed.
 *
 * So this is not a template that concatenates everything it knows. It is a
 * budget. Directions are emitted in priority order and the budget is checked
 * before each one; when the next direction will not fit, it is dropped and
 * recorded in `dropped` so the interface can say what did not make it rather
 * than pretending the model was told.
 *
 * Priority order, highest first, and the reasoning for it:
 *
 *  1. **The user's own words, whole.** They are the request. Nothing else here
 *     outranks them and nothing truncates them — if they alone exceed the
 *     limit the compiler refuses rather than editing someone's sentence.
 *  2. **Genre and mood.** The single strongest lever on a text-conditioned
 *     music model, and the one it was most densely trained on.
 *  3. **Tempo and groove.** Cheap in characters, and the thing most often
 *     wrong.
 *  4. **Voice.** Whether there is one, who sings, how it should sound.
 *  5. **Key and harmonic character.**
 *  6. **Instrumentation.**
 *  7. **Arrangement and form.**
 *  8. **Mix and master direction.** Last because ACE-Step returns one finished
 *     mixed file and these words move it least.
 *
 * Deterministic: the same plan compiles to the same caption, byte for byte.
 * There is no randomness here and no clock.
 *
 * What this module does *not* do is claim any of it is binding. The compiled
 * caption is a description. `constraints.ts` records which of these directions
 * ACE-Step has no parameter for, which is nearly all of them.
 */

import { ACE_STEP_TEXT_LIMITS } from '../providers/aceStepRequest'
import type { LivePlan, MusicalPlan } from './plan'

/** One direction competing for caption space. */
interface Direction {
  id: string
  text: string
}

export interface CompiledPrompt {
  /** The caption to send. Never longer than ACE_STEP_TEXT_LIMITS.style. */
  caption: string
  /** Direction ids that fitted, in the order they appear. */
  included: string[]
  /** Direction ids the budget could not take. */
  dropped: string[]
  characters: number
  limit: number
  /** Set when even the user's own words do not fit; nothing may be sent. */
  refusal?: string
}

/** Joins with ", " while collapsing the separators an empty part would leave. */
const joinParts = (parts: string[]): string => parts.filter((part) => part.trim()).join(', ')

/**
 * The form, named as a shape rather than a list.
 *
 * A caption has no room for ten section names and a model does not need them:
 * what it can act on is "verse-chorus song with a bridge", which is four words
 * for the same information. Section *order* travels in the lyric sheet's own
 * tags, which are sent whole and cost nothing here.
 */
function formPhrase(music: MusicalPlan): string {
  const kinds = new Set(music.form.map((section) => section.kind))
  if (kinds.has('drop')) return 'build-and-drop structure'
  const parts: string[] = []
  if (kinds.has('verse') && kinds.has('chorus')) parts.push('verse-chorus structure')
  else if (kinds.has('verse')) parts.push('sectional structure')
  if (kinds.has('prechorus')) parts.push('pre-chorus lift')
  if (kinds.has('bridge')) parts.push('contrasting bridge')
  if (kinds.has('intro')) parts.push('short intro')
  if (kinds.has('outro')) parts.push('resolved outro')
  return parts.join(', ')
}

/** How busy the arrangement should be, in words. */
function densityPhrase(music: MusicalPlan): string {
  if (music.arrangementDensity >= 0.75) return 'full dense arrangement that still leaves room for the voice'
  if (music.arrangementDensity <= 0.4) return 'sparse uncluttered arrangement'
  return 'balanced arrangement, dynamic verses and a fuller chorus'
}

/**
 * Every direction this plan could state, in priority order.
 *
 * Exported so a test can assert the order rather than infer it from a caption,
 * and so the interface can show what was asked for even when the budget drops
 * it.
 */
export function directionsFor(plan: LivePlan): Direction[] {
  const { music } = plan
  const directions: Direction[] = [
    { id: 'genre', text: joinParts([music.genre, music.genreFamily !== music.genre ? music.genreFamily.toLowerCase() : '']) },
    { id: 'mood', text: music.emotion },
    { id: 'tempo', text: `${music.targetBpm} BPM` },
    { id: 'groove', text: music.groove },
  ]

  if (music.instrumental) {
    directions.push({ id: 'vocal', text: 'instrumental, no vocals' })
  } else {
    directions.push({ id: 'vocal', text: music.vocalType })
    directions.push({ id: 'vocal-range', text: music.vocalRange })
    directions.push({
      id: 'vocal-delivery',
      text: 'clear natural pronunciation, stable pitch, emotional phrasing, no robotic delivery',
    })
  }

  directions.push({ id: 'key', text: `key of ${music.keyName}` })
  directions.push({ id: 'harmony', text: music.chordDirection })

  if (!music.instrumental) {
    directions.push({ id: 'melody', text: 'memorable singable melody with a clear contour' })
  }

  if (music.instruments.length > 0) {
    directions.push({ id: 'instruments', text: music.instruments.join(', ') })
  }

  const form = formPhrase(music)
  if (form) directions.push({ id: 'form', text: form })
  directions.push({ id: 'density', text: densityPhrase(music) })

  if (!music.instrumental) {
    directions.push({ id: 'integration', text: 'vocal clearly above the mix, instruments out of its way' })
  }
  directions.push({ id: 'mix', text: music.mixDirection })
  directions.push({ id: 'master', text: music.masterDirection })

  return directions.filter((direction) => direction.text.trim().length > 0)
}

/**
 * Compiles the plan into one caption, within the limit.
 *
 * `userStyle` is passed separately rather than read off the plan because it
 * must arrive here exactly as typed: the plan's `spec.prompt` has been through
 * a lowercasing normaliser on its way to genre detection, and the caption has
 * to carry the person's own capitalisation and punctuation.
 */
export function compilePrompt(plan: LivePlan, userStyle: string): CompiledPrompt {
  const limit = ACE_STEP_TEXT_LIMITS.style
  const base = userStyle.trim().replace(/[,;\s]+$/, '')

  if (base.length > limit) {
    return {
      caption: base,
      included: [],
      dropped: directionsFor(plan).map((direction) => direction.id),
      characters: base.length,
      limit,
      refusal: `The Style text alone is ${base.length} characters and ACE-Step takes ${limit}. `
        + `Shorten it by ${base.length - limit}. Nothing was sent.`,
    }
  }

  const included: string[] = []
  const dropped: string[] = []
  let caption = base

  for (const direction of directionsFor(plan)) {
    const text = direction.text.trim().replace(/[,;\s]+$/, '')
    // A direction the person already wrote is not repeated. Matching on the
    // whole phrase, case-insensitively: "112 BPM" in the style means the tempo
    // direction adds nothing, and a caption that says it twice reads as noise.
    if (caption.toLowerCase().includes(text.toLowerCase())) {
      included.push(direction.id)
      continue
    }
    const candidate = caption ? `${caption}, ${text}` : text
    if (candidate.length > limit) {
      dropped.push(direction.id)
      continue
    }
    caption = candidate
    included.push(direction.id)
  }

  return { caption, included, dropped, characters: caption.length, limit }
}
