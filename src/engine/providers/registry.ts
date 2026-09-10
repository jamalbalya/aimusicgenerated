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
 */

import { AceStepProvider, ACE_STEP_PROVIDER_ID } from './aceStepProvider'
import { ProceduralMusicProvider, PROCEDURAL_PROVIDER_ID, type ProceduralProviderOptions } from './proceduralProvider'
import { EngineUnavailableError, type EngineKind, type MusicGenerationProvider } from './types'

export type EngineMode = 'neural' | 'procedural'

export const ENGINE_UNAVAILABLE_MESSAGE =
  'Neural music engine is unavailable. You can start the ACE-Step backend or switch to Offline Procedural Mode.'

export interface EngineDescriptor {
  id: string
  name: string
  type: EngineKind
  description: string
}

/**
 * Builds the provider for a mode.
 *
 * The neural provider is constructed rather than shared because its options —
 * the backend address, the models — are per-request in tests and per-build in
 * the app, and a module-level singleton would freeze whichever came first.
 */
export function createProvider(
  mode: EngineMode, options: ProceduralProviderOptions = {},
): MusicGenerationProvider {
  return mode === 'neural' ? new AceStepProvider() : new ProceduralMusicProvider(options)
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
  throw new EngineUnavailableError(ACE_STEP_PROVIDER_ID, ENGINE_UNAVAILABLE_MESSAGE)
}

/**
 * Which mode to start in.
 *
 * Neural when the backend answers, offline when it does not — but this is only
 * consulted to pick the *initial* setting of a control the user can see and
 * change. It is not a fallback applied to a request they already made.
 */
export async function preferredMode(
  probe: MusicGenerationProvider = new AceStepProvider(),
): Promise<EngineMode> {
  return (await probe.isAvailable()) ? 'neural' : 'procedural'
}

export const ENGINES: Record<EngineMode, EngineDescriptor> = {
  neural: {
    id: ACE_STEP_PROVIDER_ID,
    name: 'ACE-Step 1.5',
    type: 'neural',
    description: 'Neural full-song generation. Needs the ACE-Step backend running.',
  },
  procedural: {
    id: PROCEDURAL_PROVIDER_ID,
    name: 'Resonant Procedural',
    type: 'procedural',
    description: 'Composes and sings in this tab. No server, no account, works offline.',
  },
}

/** The label shown against a finished song, so the engine is never in doubt. */
export function engineLabel(engine: 'ace-step' | 'procedural'): string {
  return engine === 'ace-step'
    ? 'Engine: ACE-Step 1.5 — Neural'
    : 'Engine: Resonant Procedural — Offline'
}
