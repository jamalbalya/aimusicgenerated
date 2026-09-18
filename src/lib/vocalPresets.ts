/**
 * Optional wording a person can add to a caption to ask for a steadier vocal.
 *
 * These are hints and nothing more. ACE-Step's endpoint takes a caption, a lyric
 * sheet, a language, a voice, an instrumental flag and a length — there is no
 * key, no scale, no pitch and no melody parameter anywhere in it, and the model
 * writes the tune itself from a seed it draws. So a preset shifts the odds of
 * getting the performance described. It cannot make the model sing a particular
 * note, and this module must never be described as if it could.
 *
 * The composition rule matters as much as the wording. A preset is never written
 * into what the person typed: their text is theirs, and it is kept separately
 * from the selection. `composeStyle` joins the two at the moment a request is
 * built, which is what makes deselecting a preset remove exactly its own
 * contribution and nothing else — no diffing, no trying to find the hint again
 * in text that may have been edited since.
 */

export interface VocalPreset {
  id: string
  /** What the chip says. Short, because it sits in a scrolling row. */
  label: string
  /** Appended to the caption verbatim when chosen. */
  hint: string
  /** One line saying what it asks for, shown on hover. */
  description: string
}

/**
 * The presets, in the order they are always composed in.
 *
 * Fixed order, so the caption for a given set of choices is the same whichever
 * order they were clicked in. Two songs generated from the same selection should
 * differ because the model reseeded, not because the words moved.
 *
 * The wording describes a performance. It deliberately avoids "accurate pitch",
 * "perfect intonation" and their relatives: those read as instructions the model
 * will follow, and it has no mechanism to follow them.
 */
export const VOCAL_PRESETS: readonly VocalPreset[] = [
  {
    id: 'baritone',
    label: 'Baritone',
    hint: 'warm male baritone lead vocal, comfortable low-to-mid range, natural chest voice',
    description: 'Asks for a lower, chestier voice that sits away from the top of the range.',
  },
  {
    id: 'tenor',
    label: 'Tenor',
    hint: 'male tenor lead vocal, steady mid register, smooth legato phrasing',
    description: 'Asks for a mid-range male voice with connected phrasing.',
  },
  {
    id: 'high-tenor',
    label: 'High tenor',
    hint: 'male tenor lead vocal with supported high notes, no forced belting',
    description: 'Asks for height without shouting for it.',
  },
  {
    id: 'soft-vibrato',
    label: 'Soft vibrato',
    hint: 'gentle controlled vibrato on held notes',
    description: 'Asks for a narrow, even wobble rather than a wide one.',
  },
  {
    id: 'minimal-vibrato',
    label: 'Minimal vibrato',
    hint: 'straight sustained tone, very little vibrato',
    description: 'Asks for held notes to stay still.',
  },
  {
    id: 'sustained',
    label: 'Steady held notes',
    hint: 'sustained notes held evenly without sliding',
    description: 'Asks for long notes not to drift off their pitch.',
  },
] as const

/** Trailing punctuation a caption should not be joined onto. */
const TRAILING = /[,;\s]+$/

/**
 * The caption to send: what they wrote, then the hints they chose.
 *
 * The person's text comes back untouched when nothing is selected — not trimmed,
 * not normalised, not rewritten. A hint already present in their own words is
 * skipped rather than repeated, because someone who has written "natural chest
 * voice" themselves should not see it twice for having also clicked the chip.
 */
export function composeStyle(style: string, selected: readonly string[]): string {
  if (selected.length === 0) return style
  const chosen = new Set(selected)
  const lower = style.toLowerCase()
  const parts: string[] = []
  for (const preset of VOCAL_PRESETS) {
    if (!chosen.has(preset.id)) continue
    if (lower.includes(preset.hint.toLowerCase())) continue
    if (parts.some((part) => part.toLowerCase() === preset.hint.toLowerCase())) continue
    parts.push(preset.hint)
  }
  if (parts.length === 0) return style
  const base = style.replace(TRAILING, '')
  return base.length === 0 ? parts.join(', ') : `${base}, ${parts.join(', ')}`
}

/** Adds or removes one preset, leaving the rest as they were. */
export function togglePreset(selected: readonly string[], id: string): string[] {
  return selected.includes(id)
    ? selected.filter((each) => each !== id)
    : [...selected, id]
}
