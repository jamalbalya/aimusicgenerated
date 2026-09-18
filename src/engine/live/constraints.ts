/**
 * What can be decided before the GPU, what can only be measured after it, and
 * what ACE-Step does not let anyone decide at all.
 *
 * This file exists because the difference matters more than any individual
 * check. A requirement in the wrong category is how a system ends up claiming
 * a guarantee it cannot keep: "the song is at 120 BPM" is a promise if the API
 * takes a tempo and a hope if it does not, and ACE-Step's does not. Writing the
 * classification down as data, next to the evidence for each entry, means the
 * report and the interface read from the same list rather than each describing
 * the system from memory.
 *
 * The evidence for every `NOT_CONTROLLED_BY_ACE_STEP` row is the endpoint
 * itself. `poc/zerogpu-space/app.py` declares six inputs:
 *
 *   style, lyrics, language, vocal_gender, instrumental, duration
 *
 * There is no seventh. Nothing below claims control through a parameter that
 * does not exist.
 */

export type ConstraintClass =
  /** Must hold before the request is sent. Violation means no GPU is spent. */
  | 'PRE_RENDER_HARD_CONSTRAINT'
  /** Estimable before the request from the text alone. Informs, warns, or refuses. */
  | 'PRE_RENDER_MEASURABLE_CONSTRAINT'
  /** Knowable only from the audio that comes back. Measured once, never re-rolled. */
  | 'POST_RENDER_MEASUREMENT_ONLY'
  /** ACE-Step's API exposes no control over it. Steered by words at best. */
  | 'NOT_CONTROLLED_BY_ACE_STEP'

export interface ConstraintEntry {
  id: string
  label: string
  classification: ConstraintClass
  /** Why it sits in that category, in terms of the actual API. */
  evidence: string
}

/**
 * The classification, in one place.
 *
 * Ordered by category so it reads as an argument rather than a lookup table.
 */
export const CONSTRAINTS: readonly ConstraintEntry[] = [
  // ---------------------------------------------------- hard, pre-render ---
  {
    id: 'style-present', label: 'Style is present',
    classification: 'PRE_RENDER_HARD_CONSTRAINT',
    evidence: 'The caption is ACE-Step\'s only description of the music. Empty means nothing was asked for.',
  },
  {
    id: 'lyrics-present', label: 'Lyrics are present (unless instrumental)',
    classification: 'PRE_RENDER_HARD_CONSTRAINT',
    evidence: 'A sung request with no words has nothing to sing. Instrumental mode sends [inst] instead.',
  },
  {
    id: 'style-length', label: 'Style within 512 characters',
    classification: 'PRE_RENDER_HARD_CONSTRAINT',
    evidence: 'ACE-Step\'s GenerationParams limit, re-checked by the Space\'s guard, which answers HTTP 400 and spends no GPU.',
  },
  {
    id: 'lyrics-length', label: 'Lyrics within 4096 characters',
    classification: 'PRE_RENDER_HARD_CONSTRAINT',
    evidence: 'Same source and same guard as the caption limit.',
  },
  {
    id: 'duration-valid', label: 'Duration is 10–600 seconds or Auto',
    classification: 'PRE_RENDER_HARD_CONSTRAINT',
    evidence: 'ACE-Step docs/en/API.md: audio_duration range 10-600. Auto is -1, the model\'s own default.',
  },
  {
    id: 'payload-valid', label: 'The six-input payload is well formed',
    classification: 'PRE_RENDER_HARD_CONSTRAINT',
    evidence: 'planZeroGpuRequest builds and type-checks the exact tuple the endpoint declares.',
  },
  {
    id: 'single-request', label: 'Exactly one generation request per Generate',
    classification: 'PRE_RENDER_HARD_CONSTRAINT',
    evidence: 'A synchronous in-flight latch, a single-shot request ticket, and one /queue/join in GradioClient.submit.',
  },
  {
    id: 'lyrics-fit', label: 'Lyrics can plausibly fit the target duration',
    classification: 'PRE_RENDER_HARD_CONSTRAINT',
    evidence: 'Syllable count against a singable ceiling for the target length. Refused before the GPU, because the model would cut the sheet off rather than sing it short.',
  },

  // ----------------------------------------------- measurable, pre-render ---
  {
    id: 'lyric-density', label: 'Syllables per second against the planned tempo',
    classification: 'PRE_RENDER_MEASURABLE_CONSTRAINT',
    evidence: 'Counted from the sheet with the language\'s own syllabifier; compared with what a singer can articulate at the planned BPM.',
  },
  {
    id: 'section-balance', label: 'Section structure is identifiable and balanced',
    classification: 'PRE_RENDER_MEASURABLE_CONSTRAINT',
    evidence: 'parseLyricStructure reads the sheet\'s own tags; unmarked sheets are segmented by blank lines.',
  },
  {
    id: 'duplicate-blocks', label: 'No accidentally duplicated blocks',
    classification: 'PRE_RENDER_MEASURABLE_CONSTRAINT',
    evidence: 'Consecutive identical blocks are compared. A repeated chorus is normal; two identical verses back to back is a paste error.',
  },
  {
    id: 'language-match', label: 'Lyrics match the requested language',
    classification: 'PRE_RENDER_MEASURABLE_CONSTRAINT',
    evidence: 'detectLanguage over the sung lines, compared with the language the request carries.',
  },
  {
    id: 'target-bpm', label: 'Target BPM is chosen and stated',
    classification: 'PRE_RENDER_MEASURABLE_CONSTRAINT',
    evidence: 'Read from the style if stated, otherwise from the genre\'s own range. Written into the caption as words.',
  },
  {
    id: 'planned-key', label: 'Key and mode are chosen and stated',
    classification: 'PRE_RENDER_MEASURABLE_CONSTRAINT',
    evidence: 'Read from the style if stated, otherwise from the genre\'s scale list. Written into the caption as words.',
  },
  {
    id: 'planned-structure', label: 'Song structure is planned',
    classification: 'PRE_RENDER_MEASURABLE_CONSTRAINT',
    evidence: 'Derived from the lyric sheet\'s own sections, or from a genre-appropriate template when the sheet has none.',
  },
  {
    id: 'planned-instrumentation', label: 'Instrumentation is chosen',
    classification: 'PRE_RENDER_MEASURABLE_CONSTRAINT',
    evidence: 'From the genre table\'s instrument list. Named in the caption.',
  },

  // -------------------------------------------------- post-render only ---
  {
    id: 'file-valid', label: 'The file is readable audio',
    classification: 'POST_RENDER_MEASUREMENT_ONLY',
    evidence: 'RIFF/WAVE header parse plus a minimum size.',
  },
  {
    id: 'actual-duration', label: 'Actual duration',
    classification: 'POST_RENDER_MEASUREMENT_ONLY',
    evidence: 'Read from the file\'s own header, not from what the Space reported.',
  },
  {
    id: 'actual-bpm', label: 'Actual tempo',
    classification: 'POST_RENDER_MEASUREMENT_ONLY',
    evidence: 'Onset-envelope autocorrelation over the decoded samples. An estimate, reported with its confidence.',
  },
  {
    id: 'clipping', label: 'Clipping',
    classification: 'POST_RENDER_MEASUREMENT_ONLY',
    evidence: 'Share of samples at or above full scale, and the longest consecutive run of them.',
  },
  {
    id: 'loudness', label: 'Loudness and dynamic range',
    classification: 'POST_RENDER_MEASUREMENT_ONLY',
    evidence: 'RMS in dBFS, peak, crest factor, and the spread between loud and quiet thirds.',
  },
  {
    id: 'silence', label: 'Silence and dead air',
    classification: 'POST_RENDER_MEASUREMENT_ONLY',
    evidence: 'Share of the file below a floor, and the longest single silent run.',
  },
  {
    id: 'vocal-presence', label: 'Whether a voice is present at all',
    classification: 'POST_RENDER_MEASUREMENT_ONLY',
    evidence: 'Energy in the 1.5–4 kHz formant band relative to the whole, over time. Presence only — not intelligibility.',
  },
  {
    id: 'spectral-balance', label: 'Gross spectral balance',
    classification: 'POST_RENDER_MEASUREMENT_ONLY',
    evidence: 'Band energies from an FFT: mud, harshness, and a missing top or bottom.',
  },

  // ------------------------------------------- not controlled by ACE-Step ---
  {
    id: 'exact-bpm', label: 'Generating at an exact BPM',
    classification: 'NOT_CONTROLLED_BY_ACE_STEP',
    evidence: 'The endpoint has no tempo input. A BPM in the caption is prose the model may follow or ignore; a real song came back 17.8 BPM from the number it was given.',
  },
  {
    id: 'exact-key', label: 'Generating in an exact key',
    classification: 'NOT_CONTROLLED_BY_ACE_STEP',
    evidence: 'No key, scale or chord input exists. The caption is the only channel.',
  },
  {
    id: 'chord-progression', label: 'A specified chord progression',
    classification: 'NOT_CONTROLLED_BY_ACE_STEP',
    evidence: 'No chord, MIDI or conditioning input exists.',
  },
  {
    id: 'melody-contour', label: 'A specified melody',
    classification: 'NOT_CONTROLLED_BY_ACE_STEP',
    evidence: 'No melody or reference-audio input exists on this endpoint.',
  },
  {
    id: 'seed', label: 'A chosen seed',
    classification: 'NOT_CONTROLLED_BY_ACE_STEP',
    evidence: 'The Space hardcodes GenerationConfig(use_random_seed=True) and declares no seed input. The seed it drew comes back in the result metadata, after the fact.',
  },
  {
    id: 'lyric-adherence', label: 'Every written word actually sung',
    classification: 'NOT_CONTROLLED_BY_ACE_STEP',
    evidence: 'The sheet is sent whole and verified byte for byte on the way out, but nothing in the API forces the model to sing all of it, and nothing in a browser can transcribe the result to check.',
  },
  {
    id: 'mix-mastering', label: 'Mixing and mastering decisions',
    classification: 'NOT_CONTROLLED_BY_ACE_STEP',
    evidence: 'ACE-Step returns one mixed, mastered stereo file. There are no stems, no bus controls and no loudness target.',
  },
  {
    id: 'section-boundaries', label: 'Where each section starts in the audio',
    classification: 'NOT_CONTROLLED_BY_ACE_STEP',
    evidence: 'Section tags steer the model but are not returned as timings, and no forced aligner runs in the browser.',
  },
] as const

/** Every entry in one class, in declaration order. */
export function constraintsOf(classification: ConstraintClass): ConstraintEntry[] {
  return CONSTRAINTS.filter((entry) => entry.classification === classification)
}

/** One entry by id, or undefined. Ids are stable and used by the report. */
export function constraint(id: string): ConstraintEntry | undefined {
  return CONSTRAINTS.find((entry) => entry.id === id)
}
