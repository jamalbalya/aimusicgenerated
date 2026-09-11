/**
 * The build time, on the reader's clock.
 *
 * `BUILD_TIME` is baked in as UTC, which is the only way to write an instant
 * down without ambiguity — but nobody reads their own day in UTC. A visitor in
 * Jakarta checking this line against a deploy they just watched finish should
 * not have to add seven hours in their head.
 *
 * So the zone and the language both come from the device. Every expectation
 * below therefore names both explicitly: an assertion that passed only on a
 * machine set to one particular zone would be worth nothing, and the whole
 * point of the change is that the machine decides.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

import { buildTimeIso, buildTimeLabel, type BuildInfo } from '../../src/lib/buildInfo'

/** A build CI made, at a known instant. */
function built(at: string): BuildInfo {
  return { version: '1.0.0', commit: 'ea45ae6', builtAt: at, fromCommit: true }
}

/** A build made on somebody's own machine, which records no commit. */
const LOCAL: BuildInfo = { version: '1.0.0', commit: 'dev', builtAt: '', fromCommit: false }

const AFTERNOON = built('2026-09-11T13:41:00Z')
/** Late enough in UTC that the eastern half of the world is already tomorrow. */
const LATE = built('2026-09-11T23:30:00Z')

afterEach(() => {
  vi.useRealTimers()
})

describe('the instant it was built', () => {
  it('reads a UTC timestamp as UTC', () => {
    expect(buildTimeLabel(AFTERNOON, { locale: 'en-GB', timeZone: 'UTC' }))
      .toBe('11 Sept 2026, 13:41 UTC')
  })

  it('keeps the exact stored instant alongside the local one', () => {
    // What the page puts in `dateTime`, so the UTC value stays recoverable
    // however the local rendering reads.
    expect(buildTimeIso(AFTERNOON)).toBe('2026-09-11T13:41:00.000Z')
    expect(buildTimeIso(LOCAL)).toBe('')
    expect(buildTimeIso(built('not a date'))).toBe('')
  })
})

describe('the device decides the zone', () => {
  it('shows a Jakarta reader their own afternoon', () => {
    // 13:41Z is 20:41 on a WIB clock. Indonesian is where the abbreviation
    // `WIB` actually lives, and `.` is that locale's own time separator.
    expect(buildTimeLabel(AFTERNOON, { locale: 'id-ID', timeZone: 'Asia/Jakarta' }))
      .toBe('11 Sep 2026, 20.41 WIB')
  })

  it('shows a Tokyo reader theirs, and a New York reader theirs', () => {
    expect(buildTimeLabel(AFTERNOON, { locale: 'en-GB', timeZone: 'Asia/Tokyo' }))
      .toBe('11 Sept 2026, 22:41 GMT+9')
    expect(buildTimeLabel(AFTERNOON, { locale: 'en-US', timeZone: 'America/New_York' }))
      .toBe('Sep 11, 2026, 09:41 EDT')
  })

  it('follows the zone into the next day, and back out of it', () => {
    // One instant, two dates. 23:30Z is already the 12th in Jakarta and still
    // the 11th in New York — which is the whole reason a build line that only
    // ever said UTC was hard to check against.
    expect(buildTimeLabel(LATE, { locale: 'id-ID', timeZone: 'Asia/Jakarta' }))
      .toBe('12 Sep 2026, 06.30 WIB')
    expect(buildTimeLabel(LATE, { locale: 'en-US', timeZone: 'America/New_York' }))
      .toBe('Sep 11, 2026, 19:30 EDT')

    // And the other way: past midnight UTC is still the previous evening in
    // New York.
    expect(buildTimeLabel(built('2026-09-12T00:15:00Z'), { locale: 'en-US', timeZone: 'America/New_York' }))
      .toBe('Sep 11, 2026, 20:15 EDT')
  })

  it('tracks the zone’s own summer time rather than a fixed offset', () => {
    // A hardcoded UTC-4 would put this an hour out. EST and EDT are the zone's
    // answer, not ours.
    expect(buildTimeLabel(built('2026-01-15T13:41:00Z'), { locale: 'en-US', timeZone: 'America/New_York' }))
      .toBe('Jan 15, 2026, 08:41 EST')
  })

  it('handles a zone past the date line', () => {
    expect(buildTimeLabel(built('2026-09-11T17:00:00Z'), { locale: 'en-GB', timeZone: 'Pacific/Kiritimati' }))
      .toBe('12 Sept 2026, 07:00 GMT+14')
  })

  it('writes an offset where the locale has no name for the zone', () => {
    // `WIB` is Indonesian; English has no short name for Jakarta, so Intl
    // writes the offset. That is unambiguous, and unlike a guessed
    // abbreviation it is true — so it is left exactly as Intl gives it.
    expect(buildTimeLabel(AFTERNOON, { locale: 'en-GB', timeZone: 'Asia/Jakarta' }))
      .toBe('11 Sept 2026, 20:41 GMT+7')
  })
})

describe('it is the build time, not the visit', () => {
  it('ignores the clock entirely', () => {
    // The distinction the whole feature rests on: this line says when the
    // deployment was made, so a stale cache is visible. If it read the clock
    // it would say "now" on every page load and a stale build would look
    // freshly deployed.
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2031-12-25T08:00:00Z'))
    expect(buildTimeLabel(AFTERNOON, { locale: 'en-GB', timeZone: 'UTC' }))
      .toBe('11 Sept 2026, 13:41 UTC')
  })

  it('gives two different builds two different lines', () => {
    const format = { locale: 'en-GB', timeZone: 'UTC' }
    expect(buildTimeLabel(AFTERNOON, format)).not.toBe(buildTimeLabel(LATE, format))
  })
})

describe('when there is nothing usable to show', () => {
  it('says nothing at all for a local build', () => {
    // A build made outside CI records no time. The page then shows the version
    // line alone with `(local build, not from CI)` — it must not invent a
    // deployment timestamp, and the empty string is what suppresses the
    // whole clause.
    expect(buildTimeLabel(LOCAL)).toBe('')
    expect(buildTimeLabel(LOCAL, { locale: 'id-ID', timeZone: 'Asia/Jakarta' })).toBe('')
  })

  it('says nothing for a timestamp it cannot read', () => {
    expect(buildTimeLabel(built('not a date'), { locale: 'en-GB', timeZone: 'UTC' })).toBe('')
    expect(buildTimeLabel(built('2026-13-45T99:99:99Z'), { locale: 'en-GB', timeZone: 'UTC' })).toBe('')
  })

  it('falls back to the exact UTC instant when the zone is unusable', () => {
    // An engine that cannot resolve the zone still knows when the build was
    // made. Saying so in UTC is honest; guessing a local time would not be.
    expect(buildTimeLabel(AFTERNOON, { timeZone: 'Mars/Olympus_Mons' }))
      .toBe('2026-09-11 13:41 UTC')
  })
})
