/**
 * The live ACE-Step pipeline: plan, compile, send once, measure once.
 *
 * The order is the design. Everything that can be decided or refused locally
 * happens before the request, because after the request nothing can be undone
 * — there is no second attempt, by construction rather than by policy.
 *
 *   Style + Lyrics
 *     → planLiveGeneration   decide the music, validate the words   (free)
 *     → compilePrompt        write the caption within 512 chars     (free)
 *     → mintRequestTicket    authorise exactly one request          (free)
 *     → provider.generate    one ZeroGPU call, ticket spent first   (costs GPU)
 *     → verifyLiveResult     measure what came back, once           (free)
 *
 * `constraints.ts` says which requirements each stage can actually hold, and
 * which ones ACE-Step's six-input endpoint leaves to chance.
 */

export {
  CONSTRAINTS, constraintsOf, constraint,
  type ConstraintClass, type ConstraintEntry,
} from './constraints'

export {
  planLyrics, normalizeSheet,
  MAX_SUSTAINED_SYLLABLES_PER_SECOND, SPARSE_SYLLABLES_PER_SECOND, NON_SUNG_SHARE,
  type LyricPlan, type LyricProblem, type LyricProblemCode, type PlannedSection,
} from './lyricPlan'

export {
  planLiveGeneration, planSeed, PLANNABLE_SCALES,
  type LiveGenerationInput, type LivePlan, type MusicalPlan, type PlannedForm,
} from './plan'

export {
  compilePrompt, directionsFor,
  type CompiledPrompt,
} from './promptCompiler'

export {
  mintRequestTicket, resetRequestTickets,
  MissingRequestTicketError, RequestTicketSpentError,
  type RequestTicket,
} from './requestGuard'

export {
  verifyLiveResult, UNMEASURABLE_IN_BROWSER,
  MAX_INTERNAL_SILENCE_SECONDS, MAX_SILENT_SHARE, MAX_CLIPPED_SHARE,
  type LiveVerdict, type LiveVerification, type LiveMeasurements, type VerifyOptions,
} from './verify'
