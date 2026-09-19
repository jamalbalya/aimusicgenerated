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
    classification: 'POST_RENDER_MEASUREMENT_ONLY',
    evidence: 'CORRECTED. ACE-Step 1.5 does have a tempo parameter: GenerationParams.bpm, an int '
      + 'in the range 30-300, documented as "Set to None for automatic estimation". inference.py '
      + 'passes it to the model as metadata and only lets its own LM fill it in when the caller '
      + 'left it empty, so a stated tempo is never overwritten by the model\'s guess. This project '
      + 'previously filed BPM as uncontrollable; that was true of the Space\'s Gradio wrapper, '
      + 'which declares six inputs and passes no tempo, and false of ACE-Step. Conditioning is '
      + 'still not a contract — the model can land off it — so adherence is measured afterwards '
      + 'rather than assumed.',
  },
  {
    id: 'exact-key', label: 'Generating in an exact key',
    classification: 'POST_RENDER_MEASUREMENT_ONLY',
    evidence: 'CORRECTED, same as BPM. GenerationParams.keyscale takes a string such as "C Major" '
      + 'or "Am", documented "Leave empty for auto-detection", with the same precedence rule. '
      + 'Modal scales have no spelling in that field and are sent as their parent major or minor, '
      + 'with the mode\'s colour left to the caption.',
  },
  {
    id: 'time-signature', label: 'Generating in a stated time signature',
    classification: 'POST_RENDER_MEASUREMENT_ONLY',
    evidence: 'GenerationParams.timesignature — "2" for 2/4, "3" for 3/4, "4" for 4/4, "6" for '
      + '6/8. Same precedence rule as BPM and key.',
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
    classification: 'PRE_RENDER_HARD_CONSTRAINT',
    evidence: 'CORRECTED. GenerationParams.seed is an int field, -1 for random, documented '
      + '"Integer seed for reproducibility". The reason seeds were unavailable here is that this '
      + 'project\'s own Space hardcodes GenerationConfig(use_random_seed=True) and declares no '
      + 'seed input — a limitation we imposed, not one ACE-Step imposes. Exposing it makes a '
      + 'generation reproducible.',
  },
  {
    id: 'lyric-adherence', label: 'Every written word actually sung',
    classification: 'NOT_CONTROLLED_BY_ACE_STEP',
    evidence: 'The sheet is sent whole and verified byte for byte on the way out, but nothing in the API forces the model to sing all of it, and nothing in a browser can transcribe the result to check.',
  },
  {
    id: 'mix-mastering', label: 'Mixing and mastering decisions',
    classification: 'NOT_CONTROLLED_BY_ACE_STEP',
    evidence: 'Partly corrected. There are still no stems on text2music and no per-instrument or '
      + 'bus control, so the mix itself is not directable. ACE-Step does expose '
      + 'enable_normalization, normalization_db, fade_in_duration and fade_out_duration, which are '
      + 'real mastering parameters — a loudness target is available, a mix is not.',
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
