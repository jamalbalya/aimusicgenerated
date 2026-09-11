/**
 * Choosing an engine, and never choosing one behind the user's back.
 *
 * The rule this module exists to enforce: asking for the neural engine and
 * getting the procedural one is not a graceful degradation, it is a wrong
 * answer delivered quietly. Someone who asked for a neural song and was handed
 * a synthesised one would reasonably conclude the neural engine sounds like
 * that. So a neural request that cannot be served fails, with a message naming
 * the two things the user can actually do about it.
 *
 * Switching to the offline engine is always available — as a choice, made here,
 * once, by them.
 *
 * It is also the one place a neural provider is built. Which neural backend a
 * build uses — a local ACE-Step server or the hosted ZeroGPU Space — is decided
 * by configuration, here, and nowhere else, so no screen can end up talking to
 * a different backend from the one its connection indicator describes.
 */

import { AceStepProvider } from './aceStepProvider'
import { ZeroGpuProvider, ZEROGPU_UNAVAILABLE_MESSAGE } from './zeroGpuProvider'
import { ProceduralMusicProvider, type ProceduralProviderOptions } from './proceduralProvider'
import { neuralBackendChoice, type NeuralBackendChoice } from './config'
import {
  EngineUnavailableError,
  type MusicGenerationProvider, type MusicGenerationResult,
  type NeuralBackend, type NeuralMusicProvider, type NeuralProviderStatus,
} from './types'

export type EngineMode = 'neural' | 'procedural'

export const ENGINE_UNAVAILABLE_MESSAGE =
  'Neural music engine is unavailable. You can start the ACE-Step backend or switch to Offline Procedural Mode.'

/**
 * Stands in for the neural engine when its configuration is unusable.
 *
 * It exists so that a mistyped `ACE_STEP_BACKEND` is reported rather than read
 * as "local": it is never available, and says exactly why.
 */
export class MisconfiguredNeuralProvider implements NeuralMusicProvider {
  readonly id = 'neural-misconfigured'
  readonly name = 'Neural engine (not configured)'
  readonly type = 'neural' as const
  readonly description = 'The neural engine is not configured correctly for this build.'
  readonly baseUrl = ''

  constructor(readonly blockedReason: string, readonly backend: NeuralBackend = 'local') {}

  async isAvailable(): Promise<boolean> {
    return false
  }

  async status(): Promise<NeuralProviderStatus> {
    return { connected: false, blockedReason: this.blockedReason }
  }

  async generate(): Promise<MusicGenerationResult> {
    throw new EngineUnavailableError(this.id, `Neural music engine is unavailable. ${this.blockedReason}`)
  }
}

/**
 * Builds the neural provider this build is configured for.
 *
 * Constructed rather than shared: its options — the backend, its address, the
 * models — are per-request in tests and per-build in the app, and a
 * module-level singleton would freeze whichever came first.
 */
export function createNeuralProvider(
  choice: NeuralBackendChoice = neuralBackendChoice(),
  options: { authorization?: () => string | undefined } = {},
): NeuralMusicProvider {
  if (choice.problem) return new MisconfiguredNeuralProvider(choice.problem, choice.backend)
  // Passed in rather than reached for, so the engine layer stays unaware of how
  // anyone signs in and the dependency points one way only.
  return choice.backend === 'zerogpu' ? new ZeroGpuProvider(options) : new AceStepProvider()
}

/** Builds the provider for a mode. */
export function createProvider(
  mode: EngineMode, options: ProceduralProviderOptions = {},
): MusicGenerationProvider {
  return mode === 'neural' ? createNeuralProvider() : new ProceduralMusicProvider(options)
}

const isNeuralProvider = (provider: MusicGenerationProvider): provider is NeuralMusicProvider =>
  provider.type === 'neural' && 'backend' in provider

/** What to say when a neural engine is not there, in terms of the backend it is. */
export function unavailableMessage(provider: MusicGenerationProvider): string {
  return isNeuralProvider(provider) && provider.backend === 'zerogpu'
    ? ZEROGPU_UNAVAILABLE_MESSAGE
    : ENGINE_UNAVAILABLE_MESSAGE
}

/**
 * Returns the provider for the requested mode, or refuses.
 *
 * Note what this does *not* do: there is no `?? procedural` at the end of it.
 */
export async function resolveProvider(
  mode: EngineMode,
  options: ProceduralProviderOptions = {},
  provider: MusicGenerationProvider = createProvider(mode, options),
): Promise<MusicGenerationProvider> {
  if (mode === 'procedural') return provider
  if (await provider.isAvailable()) return provider
  throw new EngineUnavailableError(provider.id, unavailableMessage(provider))
}

/**
 * Which engine the studio is on.
 *
 * The person's own choice always wins. Until they make one, the studio moves
 * onto the neural engine once that engine has answered — and it stays there.
 * It never moves back to the offline engine by itself: a hosted backend that
 * misses one health check would otherwise flip the control under someone who
 * saw "Neural" selected a moment earlier, and their next Generate, or ⌘/Ctrl +
 * Enter, would quietly produce a procedural song. With the control held, that
 * Generate goes to the neural engine and fails out loud if it is not there.
 */
export function resolveEngineMode(choice: EngineMode | null, neuralHasAnswered: boolean): EngineMode {
  return choice ?? (neuralHasAnswered ? 'neural' : 'procedural')
}

/** The label shown against a finished song, so the engine is never in doubt. */
export function engineLabel(engine: 'ace-step' | 'procedural'): string {
  return engine === 'ace-step'
    ? 'Engine: ACE-Step 1.5 — Neural'
    : 'Engine: Resonant Procedural — Offline'
}
