/**
 * One press, one request, enforced by something that cannot be pressed twice.
 *
 * The studio already refuses a second Generate while one is running, with a
 * synchronous latch. That guard is real and it stays, but it is a *check*: it
 * works by asking whether a flag is set. Every check of that shape has the same
 * weakness — someone adds a call site that does not ask.
 *
 * A ticket is a different kind of guarantee. It holds the single permission to
 * send, `spend()` hands it over exactly once, and every later call throws. The
 * provider cannot generate without one, so a second request is not refused by
 * policy — there is nothing left to send it with. That makes the loop that used
 * to sit around `provider.generate` unwritable rather than merely discouraged:
 * a second iteration has no ticket.
 *
 * What this deliberately does not do is time out, expire or renew. A ticket
 * that could be reissued after a failure would be an automatic retry wearing a
 * different name, and the requirement is that a failed generation costs one
 * press and then stops. Generating again is a person pressing Generate again,
 * which mints a new ticket, which is the correct and only path.
 */

/** Thrown when something tries to send a second request under one ticket. */
export class RequestTicketSpentError extends Error {
  constructor(readonly ticketId: string) {
    super('This generation ticket has already been spent. One press of Generate authorises exactly '
      + 'one ACE-Step request, and no part of this system may send a second one — not a retry, not '
      + 'a second candidate, not a regeneration after a failed check. Press Generate again to '
      + 'authorise another.')
    this.name = 'RequestTicketSpentError'
  }
}

/** Thrown when a generation is attempted with no ticket at all. */
export class MissingRequestTicketError extends Error {
  constructor() {
    super('A live generation was attempted without a request ticket. Every ACE-Step request must '
      + 'carry one, so that the number of requests can never exceed the number of times a person '
      + 'pressed Generate.')
    this.name = 'MissingRequestTicketError'
  }
}

export interface RequestTicket {
  /** Identifies this generation in logs and in the status line. */
  readonly id: string
  /** True until `spend` is called. */
  readonly spent: boolean
  /**
   * Consumes the ticket. The first call returns the id; every later call
   * throws, whatever called it and for whatever reason.
   */
  spend(): string
}

let counter = 0

/**
 * Mints one ticket. Called once per press of Generate, and nowhere else.
 *
 * The id is monotonic within the page rather than random, so two requests in
 * one session are distinguishable in a log by eye, and a test can assert that
 * the second press produced ticket 2 rather than reusing ticket 1.
 */
export function mintRequestTicket(): RequestTicket {
  counter += 1
  const id = `gen-${counter}`
  let spent = false
  return {
    id,
    get spent() { return spent },
    spend() {
      if (spent) throw new RequestTicketSpentError(id)
      spent = true
      return id
    },
  }
}

/** Resets the counter. For tests only, so ids are predictable per test. */
export function resetRequestTickets(): void {
  counter = 0
}
