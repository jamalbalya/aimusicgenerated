/**
 * The boundary between "make me a song" and whatever actually makes it.
 *
 * Two engines sit behind this interface and they are not the same kind of
 * thing: one is a neural model running on a machine with a GPU, the other is a
 * composition engine running in this tab. The point of the boundary is that the
 * request describes what the listener asked for and nothing about how it gets
 * made, so neither engine's vocabulary leaks into the other's.
 *
 * Nothing in this file may mention ACE-Step, HTTP, workers or Float32Array.
 */

/** Where a result came from. Always shown to the user; never inferred. */
export type EngineKind = 'neural' | 'procedural'

export interface MusicGenerationRequest {
  /**
   * The style description exactly as the user wrote it.
   *
   * This is passed through whole. Reducing it to a genre and a mood throws away
   * most of what a neural model reads, which is the difference between
   * "Indonesian dangdut koplo, sarcastic workplace anthem, powerful kendang"
   * and "dangdut".
   */
  style: string
  /** The user's lyrics, verbatim, section tags included. */
  lyrics: string
  /** BCP-47-ish code the vocal should be sung in, e.g. `id`. */
  language?: string
  vocalGender?: 'male' | 'female' | 'mixed'
  /** Requested length in seconds. */
  duration?: number
  /** Engine-specific generation model, e.g. a DiT checkpoint name. */
  model?: string
  /** Engine-specific language model, where the engine has a separate one. */
  lmModel?: string
  seed?: number
  /** True for a backing track with no singer. */
  instrumental?: boolean
}

export interface MusicGenerationResult {
  id: string
  engine: 'ace-step' | 'procedural'
  /** Playable and downloadable; an object URL for a locally produced result. */
  audioUrl: string
  duration: number
  sampleRate?: number
  metadata?: {
    model?: string
    lmModel?: string
    seed?: number
    language?: string
    style?: string
    /** Tempo the engine reported, where it reports one. */
    bpm?: number
    keyScale?: string
  }
}

/**
 * How far along a job is.
 *
 * `queued` and `generating` are distinct because a queued job is waiting for a
 * machine and a generating one is using it, and a person waiting deserves to
 * know which. There is deliberately no percentage here: see `GenerationStatus`.
 */
export type GenerationState =
  | 'idle'
  | 'initializing'
  | 'queued'
  | 'generating'
  | 'completed'
  | 'failed'
  | 'cancelled'

export interface GenerationStatus {
  state: GenerationState
  /** What is happening, in words the engine actually reported. */
  detail?: string
  /**
   * Completion 0..1, and only when the engine genuinely reports one.
   *
   * Left undefined rather than estimated. A bar that moves on a timer tells the
   * user something false about how long they are waiting.
   */
  progress?: number
  /** Position in the engine's queue, when it reports one. */
  queuePosition?: number
}

export interface GenerateOptions {
  onStatus?: (status: GenerationStatus) => void
  signal?: AbortSignal
}

export interface MusicGenerationProvider {
  readonly id: string
  readonly name: string
  readonly type: EngineKind
  /** One line for the interface, describing what this engine is. */
  readonly description: string

  /**
   * Whether this engine can run right now.
   *
   * For a networked engine this is a real check against the service, not a
   * guess from configuration: the difference between "an address is set" and
   * "something is listening" is the whole point.
   */
  isAvailable(): Promise<boolean>

  generate(
    request: MusicGenerationRequest, options?: GenerateOptions,
  ): Promise<MusicGenerationResult>

  /** Present only on engines that can actually stop work already started. */
  cancel?(jobId: string): Promise<void>
}

/** Thrown when an engine was asked for and is not there. Never swallowed. */
export class EngineUnavailableError extends Error {
  constructor(readonly engineId: string, message: string) {
    super(message)
    this.name = 'EngineUnavailableError'
  }
}

/** Thrown when the caller aborted. Distinguished from a real failure. */
export class GenerationCancelledError extends Error {
  constructor(message = 'Generation cancelled.') {
    super(message)
    this.name = 'GenerationCancelledError'
  }
}
