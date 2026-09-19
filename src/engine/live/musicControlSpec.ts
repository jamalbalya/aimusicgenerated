/**
 * The one internal description of the song being asked for.
 *
 * Everything downstream reads this and nothing downstream re-derives it: the
 * caption compiler, the ACE-Step payload, the verification report and the
 * interface all take their numbers from here. A second place that decides the
 * tempo is a second place that can disagree about it, and this project has
 * already been bitten twice by exactly that — two analysers reporting different
 * harmonic scores on the same file, and a caption naming a key the chord
 * direction contradicted.
 *
 * The important structural fact, and the one that corrects a mistake this
 * project made for a long time: **ACE-Step 1.5 has real parameters for tempo,
 * key and time signature.** From its own `GenerationParams`:
 *
 *   bpm: Optional[int]      "BPM (beats per minute), e.g., 120.
 *                            Set to None for automatic estimation. 30 ~ 300"
 *   keyscale: str           "Musical key (e.g., "C Major", "Am").
 *                            Leave empty for auto-detection."
 *   timesignature: str      "2 for '2/4', 3 for '3/4', 4 for '4/4', 6 for '6/8'"
 *   seed: int               "-1 means use random seed each time"
 *
 * These are fed to the model as structured metadata, and `inference.py` only
 * lets its own language model fill in the ones the caller left empty — a
 * user-supplied value is never overwritten by the model's guess. That is a
 * genuine control channel and it is categorically different from writing
 * "72 BPM" into a caption and hoping.
 *
 * It is still a generative model: conditioning is not a contract, and the
 * measured tempo can still land off the requested one. What changed is that the
 * request is now made through the field built to carry it, instead of as prose
 * the model is free to read as flavour text.
 */

import type { LanguageId } from '../lang/types'
import type { SectionKind } from '../compose/types'

/** ACE-Step's own stated range for the `bpm` parameter. */
export const ACE_STEP_BPM_RANGE = { min: 30, max: 300 } as const

/** The time signatures ACE-Step names, and the number each is sent as. */
export const ACE_STEP_TIME_SIGNATURES: Record<string, string> = {
  '2/4': '2',
  '3/4': '3',
  '4/4': '4',
  '6/8': '6',
}

/** One planned section, with whatever direction its header carried. */
export interface ControlSection {
  kind: SectionKind
  /** "Verse 1", "Chorus" — the name, without the direction. */
  name: string
  /** "Full Band, Powerful and Wide", when the header had one. */
  direction: string
  /** True when it came from the person's own sheet rather than a template. */
  fromLyrics: boolean
  /** 0..1 — where this section sits in the song's emotional arc. */
  intensity: number
}

/**
 * How a value came to be what it is.
 *
 * `user` beats `planner` everywhere, and the distinction is reported rather
 * than buried: a deviation from a tempo the person asked for is a missed
 * requirement, and a deviation from one the planner guessed is not.
 */
export type ControlSource = 'user' | 'planner'

export interface ControlValue<T> {
  value: T
  source: ControlSource
}

/**
 * How a control reaches ACE-Step, which decides what may be claimed about it.
 *
 * `parameter` is a dedicated `GenerationParams` field — conditioning the model
 * was built to receive. `caption` is prose in the style text. `sheet` is inside
 * the lyric sheet. `none` means it shapes the plan and never leaves the
 * machine.
 */
export type ControlChannel = 'parameter' | 'caption' | 'sheet' | 'none'

export interface MusicControlSpec {
  /* ------------------------------------------------- the user's own text --- */
  /** What they typed in Style. Byte for byte. Never edited. */
  originalStyle: string
  /** What they typed in Lyrics. Byte for byte. Never edited. */
  originalLyrics: string

  /* ----------------------------------------------------------- metadata --- */
  /** Sent through `GenerationParams.bpm`. */
  bpm: ControlValue<number>
  /** Sent through `GenerationParams.keyscale`, in ACE-Step's own spelling. */
  keyscale: ControlValue<string>
  /** Sent through `GenerationParams.timesignature`, as its number. */
  timeSignature: ControlValue<string>
  /** Sent through `GenerationParams.duration`. Undefined means Auto. */
  durationSeconds: ControlValue<number> | undefined
  /** Sent through `GenerationParams.vocal_language`. */
  language: ControlValue<LanguageId>
  /** Sent through `GenerationParams.seed`. Undefined means the model draws one. */
  seed: ControlValue<number> | undefined

  /* -------------------------------------------------- musical direction --- */
  genre: string
  genreConfident: boolean
  mood: string
  emotion: string
  groove: string
  chordDirection: string
  instruments: string[]
  arrangementDensity: number
  mixDirection: string
  masterDirection: string

  /* ----------------------------------------------------------- the song --- */
  sections: ControlSection[]
  instrumental: boolean
  vocalType: string
  vocalRange: string
  /** Midi note numbers the vocal is expected to sit between. */
  vocalRangeMidi: { low: number; high: number }
}

/** What each control is, how it travels, and therefore what may be said of it. */
export interface ChannelEntry {
  id: string
  label: string
  channel: ControlChannel
  /** The exact mechanism, for the report and for anyone checking the claim. */
  evidence: string
}

/**
 * The channel map. Read by the interface and by the tests, so a claim about
 * how something is sent cannot drift from how it is actually sent.
 */
export const CONTROL_CHANNELS: readonly ChannelEntry[] = [
  {
    id: 'bpm', label: 'Tempo', channel: 'parameter',
    evidence: 'GenerationParams.bpm — an int field, range 30-300. inference.py reads it into the '
      + 'metadata passed to the model and only lets its own LM fill it in when the caller left it '
      + 'empty, so a stated tempo is never overwritten by the model\'s estimate.',
  },
  {
    id: 'keyscale', label: 'Key and scale', channel: 'parameter',
    evidence: 'GenerationParams.keyscale — a string such as "C Major" or "Am". Same precedence '
      + 'rule as bpm.',
  },
  {
    id: 'timesignature', label: 'Time signature', channel: 'parameter',
    evidence: 'GenerationParams.timesignature — "2", "3", "4" or "6". Same precedence rule.',
  },
  {
    id: 'duration', label: 'Length', channel: 'parameter',
    evidence: 'GenerationParams.duration — seconds, 10-600, or -1 to let the model choose. It is '
      + 'a hard token budget: the decoder may not end before it and must end at it.',
  },
  {
    id: 'language', label: 'Vocal language', channel: 'parameter',
    evidence: 'GenerationParams.vocal_language.',
  },
  {
    id: 'seed', label: 'Seed', channel: 'parameter',
    evidence: 'GenerationParams.seed — an int, -1 for random. Available, and therefore a request '
      + 'made with a seed is reproducible.',
  },
  {
    id: 'instrumental', label: 'Instrumental', channel: 'parameter',
    evidence: 'GenerationParams.instrumental — a bool the model acts on directly.',
  },
  {
    id: 'lyrics', label: 'The words', channel: 'parameter',
    evidence: 'GenerationParams.lyrics — the sheet itself, up to 4096 characters.',
  },
  {
    id: 'genre', label: 'Genre and style', channel: 'caption',
    evidence: 'Prose in GenerationParams.caption. The strongest text lever there is, and still '
      + 'text the model may read loosely.',
  },
  {
    id: 'mood', label: 'Mood and emotion', channel: 'caption',
    evidence: 'Prose in the caption.',
  },
  {
    id: 'instruments', label: 'Instrumentation', channel: 'caption',
    evidence: 'Prose in the caption.',
  },
  {
    id: 'mix', label: 'Mix and master direction', channel: 'caption',
    evidence: 'Prose in the caption. ACE-Step does return one finished mixed file and exposes '
      + 'enable_normalization and normalization_db, but no per-instrument control.',
  },
  {
    id: 'section-direction', label: 'Per-section arrangement directions', channel: 'sheet',
    evidence: 'Carried inside the lyric sheet\'s own headers. There is no per-section parameter, '
      + 'so these steer the model without binding it.',
  },
  {
    id: 'chord-progression', label: 'Chord progression', channel: 'none',
    evidence: 'No chord input exists on any task type. The planner uses it to choose a key and to '
      + 'describe harmonic character; the progression itself never leaves this machine.',
  },
  {
    id: 'melody', label: 'The vocal melody', channel: 'none',
    evidence: 'No melody, MIDI or note-level input exists for text2music. This is the gap the '
      + 'post-generation vocal pipeline exists to close.',
  },
] as const

export function channelOf(id: string): ChannelEntry | undefined {
  return CONTROL_CHANNELS.find((entry) => entry.id === id)
}

/** Everything sent through a real parameter, for the report. */
export function parameterControls(): ChannelEntry[] {
  return CONTROL_CHANNELS.filter((entry) => entry.channel === 'parameter')
}

/** Everything that is description rather than control. */
export function descriptiveControls(): ChannelEntry[] {
  return CONTROL_CHANNELS.filter((entry) => entry.channel === 'caption' || entry.channel === 'sheet')
}

const NOTE_NAMES_SHARP = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const

/**
 * A key in ACE-Step's own spelling: "C Major", "A Minor".
 *
 * Modal scales are named by the major or minor they are closest to, because
 * `keyscale` documents "A-G, #/♭, major/minor" and nothing else. Sending
 * "D Dorian" into a field that parses major and minor would be sending a string
 * it cannot read; sending the parent quality is the honest reduction, and the
 * mode's actual colour still travels in the caption.
 */
export function aceStepKeyscale(tonic: number, scale: string): string {
  const name = NOTE_NAMES_SHARP[((tonic % 12) + 12) % 12]!
  const lower = scale.toLowerCase()
  const minor = lower.includes('minor')
    || lower === 'dorian' || lower === 'phrygian' || lower === 'locrian'
    || lower === 'blues' || lower === 'minorpentatonic'
  return `${name} ${minor ? 'Minor' : 'Major'}`
}

/** Clamps a tempo into the range ACE-Step's own parameter accepts. */
export function aceStepBpm(bpm: number): number {
  const { min, max } = ACE_STEP_BPM_RANGE
  return Math.max(min, Math.min(max, Math.round(bpm)))
}
