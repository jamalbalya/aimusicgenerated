/**
 * One press of Generate, for a test.
 *
 * The ZeroGPU provider requires a request ticket and spends it before it opens
 * a socket, so that the number of requests can never exceed the number of times
 * a person pressed Generate. A test calling `generate` is standing in for that
 * press, and this is the press.
 *
 * Deliberately a fresh ticket each time rather than a shared one: a test that
 * generates twice is two presses, and if it were one ticket the second call
 * would throw — which is exactly the behaviour `one-request.test.ts` exists to
 * prove, and not something every other test should have to work around.
 */

import { mintRequestTicket, type RequestTicket } from '../../../src/engine/live/requestGuard'

export function press(): RequestTicket {
  return mintRequestTicket()
}
