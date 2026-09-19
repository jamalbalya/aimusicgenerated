/**
 * Fitting any Style into ACE-Step's caption without editing what was typed.
 *
 * The rule this module exists to enforce: **a model limit is not a user
 * limit**. ACE-Step's caption field holds 512 characters. A person writing a
 * 900-character description of their song has not made a mistake, and telling
 * them to shorten it is the product asking the user to work around the
 * implementation. So the original is kept, untouched and unshown to the model,
 * and a compact caption is compiled from it.
 *
 * Two objects, never one:
 *
 *   originalStyle   what they typed. Never edited, never truncated, never sent.
 *   caption         compiled, <= 512, sent.
 *
 * The compiler is extractive, not generative. It never invents a word that was
 * not in the input or in the plan, because a caption that paraphrases somebody's
 * song description is a caption that can get it wrong. What it does is choose
 * which of their own clauses survive, by musical salience, keeping their
 * original order and their original wording.
 *
 * Salience, in the order it matters to a text-conditioned music model:
 *
 *   instruments and voice   what the listener actually hears
 *   genre and style words   the strongest single lever
 *   mood and emotion        the second strongest
 *   production and space    how it should sound
 *   narrative and backstory nearly worthless to the model — dropped first
 *
 * Tempo, key and time signature are deliberately *not* scored here. Since
 * ACE-Step 1.5 takes them as real `GenerationParams` fields, they no longer
 * need to compete for caption space at all, and a clause that only states a
 * tempo is redundant rather than salient.
 */

import { ACE_STEP_TEXT_LIMITS } from '../providers/aceStepRequest'

/** Words that name something a listener hears. Highest value per character. */
const INSTRUMENT_WORDS = /\b(piano|guitar|bass|drum|drums|kendang|suling|flute|violin|cello|strings?|brass|horn|sax|saxophone|trumpet|synth|pad|organ|choir|vocal|vocals|voice|singer|percussion|keys|rhodes|accordion|harp|banjo|mandolin|ukulele|clarinet|oboe|bassoon|tuba|timpani|marimba|vibraphone|gamelan|sitar|erhu|koto|shamisen|808|909|arp|arpeggio|riff|lead|snare|kick|hat|hi-hat|cymbal|tom|conga|bongo|tabla|djembe|upright)\b/i

/** Genre and style words. */
const GENRE_WORDS = /\b(pop|rock|metal|jazz|blues|folk|country|soul|funk|disco|house|techno|trance|dubstep|drum ?and ?bass|dnb|hip ?hop|rap|trap|r&b|rnb|reggae|ska|dub|latin|salsa|bossa|samba|tango|flamenco|classical|orchestral|cinematic|ambient|lofi|lo-fi|chillout|edm|dance|electro|indie|punk|grunge|emo|ballad|anthem|dangdut|koplo|keroncong|gamelan|k-?pop|j-?pop|city ?pop|synthwave|vaporwave|shoegaze|post-?rock|math ?rock|prog|progressive|garage|grime|afrobeat|highlife|soca|calypso|bhangra|qawwali|score|soundtrack|trailer)\b/i

/** Mood and emotional words. */
const MOOD_WORDS = /\b(happy|sad|melancholic|melancholy|romantic|bittersweet|dark|bright|epic|intimate|tender|angry|aggressive|calm|peaceful|dreamy|nostalgic|hopeful|triumphant|haunting|eerie|playful|serious|sarcastic|joyful|sombre|somber|wistful|yearning|longing|uplifting|driving|restrained|emotional|passionate|gentle|soft|powerful|fierce|warm|cold|lush|sparse|moody|brooding|euphoric|anthemic|climax|climactic)\b/i

/** Production and space words. */
const PRODUCTION_WORDS = /\b(reverb|delay|echo|stereo|wide|dry|wet|compressed|saturated|distorted|clean|crisp|muddy|warm|bright|analog|analogue|digital|tape|vinyl|lo-?fi|hi-?fi|mix|master|mastered|loud|quiet|dynamic|punchy|tight|loose|live|studio|acoustic|electric|layered|doubled|harmony|harmonies|falsetto|belt|whisper|breathy|raspy|smooth)\b/i

/** Tempo, key and time signature — carried by parameters now, not by words. */
const METADATA_ONLY = /^\s*(\d{2,3}\s*(bpm|beats per minute)|in\s+[a-g][#b]?\s*(major|minor)?|key of\s+[a-g][#b]?\s*(major|minor)?|\d\/\d)\s*$/i

export interface StyleClause {
  /** The clause exactly as written, trimmed of surrounding whitespace only. */
  text: string
  /** Position in the original, from 0. Order is preserved when rebuilding. */
  index: number
  /** How much this clause is worth to a music model, higher is better. */
  salience: number
  /** Why it scored that way, for the report. */
  reasons: string[]
}

export interface CompiledStyle {
  /** What the person typed. Byte for byte. Never sent to the model. */
  original: string
  /** The caption that is sent. Never longer than the limit. */
  caption: string
  characters: number
  limit: number
  /** True when the original had to be compressed to fit. */
  compressed: boolean
  /** Clauses that made it into the caption, in original order. */
  kept: StyleClause[]
  /** Clauses the budget could not take. Reported, never silently lost. */
  dropped: StyleClause[]
}

/**
 * Splits a style into clauses on the punctuation people actually write.
 *
 * Newlines count: a style written as a list of lines is a list of clauses, and
 * treating the whole thing as one sentence would make it all-or-nothing.
 */
export function splitClauses(style: string): string[] {
  return style
    .split(/[,;\n]+|(?<=[.!?])\s+/)
    .map((clause) => clause.trim())
    .filter((clause) => clause.length > 0)
}

/** Scores one clause by what a text-conditioned music model can use. */
export function scoreClause(text: string): { salience: number; reasons: string[] } {
  const reasons: string[] = []
  let salience = 0

  if (METADATA_ONLY.test(text)) {
    // A clause that says only "72 BPM" or "in D minor". ACE-Step 1.5 takes
    // both as real parameters, so spending caption characters on them buys
    // nothing — the model is already being told, through a field built for it.
    return { salience: -1, reasons: ['metadata, sent as a parameter instead'] }
  }

  if (INSTRUMENT_WORDS.test(text)) { salience += 4; reasons.push('instruments') }
  if (GENRE_WORDS.test(text)) { salience += 4; reasons.push('genre') }
  if (MOOD_WORDS.test(text)) { salience += 3; reasons.push('mood') }
  if (PRODUCTION_WORDS.test(text)) { salience += 2; reasons.push('production') }

  // Short clauses are cheap: the same salience in fewer characters is worth
  // more when the budget is what binds. Long narrative prose scores nothing on
  // any of the above and is dropped first, which is the intent — "telling the
  // story of a long journey home across mountains and rivers" is a lovely
  // sentence and tells a music model nothing it can render.
  if (salience > 0) salience += Math.max(0, 3 - text.length / 40)
  else reasons.push('no musical content the model can act on')

  return { salience, reasons }
}

/**
 * Compiles a caption that fits, from a style of any length.
 *
 * `extra` is the plan's own directions, already compiled; they are appended
 * after the user's clauses and compete for the same budget, which is why the
 * user's own words are laid down first.
 *
 * Never throws and never refuses. A style of any length produces a caption,
 * because the caption is ours to build and the style is theirs to write.
 */
export function compileStyle(original: string, extra: string[] = []): CompiledStyle {
  const limit = ACE_STEP_TEXT_LIMITS.style
  const trimmed = original.trim()
  const clauses = splitClauses(trimmed).map((text, index) => {
    const { salience, reasons } = scoreClause(text)
    return { text, index, salience, reasons }
  })

  // The whole thing fits: send it as written. No scoring, no reordering, no
  // cleverness — the best caption for a style that fits is that style.
  const joined = [trimmed, ...extra].join(', ')
  if (trimmed.length <= limit && joined.length <= limit) {
    return {
      original, caption: joined, characters: joined.length, limit,
      compressed: false, kept: clauses, dropped: [],
    }
  }
  if (trimmed.length <= limit) {
    // The style fits but the plan's additions do not. Lay down the style whole
    // and add what room is left allows.
    let caption = trimmed
    for (const addition of extra) {
      const candidate = `${caption}, ${addition}`
      if (candidate.length <= limit) caption = candidate
    }
    return {
      original, caption, characters: caption.length, limit,
      compressed: false, kept: clauses, dropped: [],
    }
  }

  // The style alone is over the limit. Choose which of their clauses survive,
  // by salience, then rebuild in their original order so the caption still
  // reads the way they wrote it.
  const byValue = [...clauses].sort((a, b) =>
    (b.salience - a.salience) || (a.index - b.index))
  const chosen: StyleClause[] = []
  let length = 0
  for (const clause of byValue) {
    if (clause.salience <= 0) continue
    const cost = clause.text.length + (chosen.length > 0 ? 2 : 0)
    if (length + cost > limit) continue
    chosen.push(clause)
    length += cost
  }

  // Nothing scored: a long style with no recognised musical word at all. Take
  // its opening clauses rather than send an empty caption — they are still the
  // person's own words, and the first thing someone writes is usually the
  // thing they most meant.
  if (chosen.length === 0) {
    for (const clause of clauses) {
      const cost = clause.text.length + (chosen.length > 0 ? 2 : 0)
      if (length + cost > limit) break
      chosen.push(clause)
      length += cost
    }
  }

  const keptIndexes = new Set(chosen.map((clause) => clause.index))
  const kept = clauses.filter((clause) => keptIndexes.has(clause.index))
  const dropped = clauses.filter((clause) => !keptIndexes.has(clause.index))

  let caption = kept.map((clause) => clause.text).join(', ')
  for (const addition of extra) {
    const candidate = `${caption}, ${addition}`
    if (candidate.length <= limit) caption = candidate
  }

  return {
    original, caption, characters: caption.length, limit,
    compressed: true, kept, dropped,
  }
}
