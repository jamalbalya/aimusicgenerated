/**
 * Which build this is.
 *
 * A bug report is only actionable if it says which build it came from, and a
 * GitHub Pages deployment behind a stale cache looks exactly like a current one
 * until something on the page disagrees. So the version, the commit and the
 * time are baked in at build time and shown on the About page.
 *
 * Every value here is public by nature: a semantic version, a short commit hash
 * of a public repository, and a timestamp. `vite.config.ts` decides what may be
 * baked, from a fixed list of three names; nothing else from the environment
 * can arrive through this module.
 */

/** Vite replaces these at build time; absent in Node, hence the guards. */
function baked(key: string): string {
  const env = (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env
  const value = env?.[key]
  return typeof value === 'string' ? value.trim() : ''
}

export interface BuildInfo {
  /** Semantic version of the application, from `package.json`. */
  version: string
  /** Short commit the build was made from, or `dev` when it was not CI's. */
  commit: string
  /** ISO timestamp of the build, or an empty string when it was not recorded. */
  builtAt: string
  /** Whether this build knows which commit it came from. */
  fromCommit: boolean
}

/** `v1.0.0 · build 18c7692` — the one line a screenshot needs to carry. */
export function buildLabel(info: BuildInfo = BUILD_INFO): string {
  return `v${info.version} · build ${info.commit}`
}

/**
 * How to write a moment down. Both are the reader's own by default; tests pass
 * them explicitly so an expected string does not depend on the machine.
 */
export interface TimeFormat {
  /** BCP 47 tag. Absent means whatever the browser is set to. */
  locale?: string | string[]
  /** IANA zone. Absent means whatever the device's clock is set to. */
  timeZone?: string
}

/** The stored instant, written out exactly, for when a local one is no use. */
function utcLabel(at: Date): string {
  return `${at.toISOString().slice(0, 16).replace('T', ' ')} UTC`
}

/** The exact instant the build was made, unambiguous; empty when unknown. */
export function buildTimeIso(info: BuildInfo = BUILD_INFO): string {
  if (!info.builtAt) return ''
  const at = new Date(info.builtAt)
  return Number.isNaN(at.getTime()) ? '' : at.toISOString()
}

/**
 * The build time on the reader's own clock.
 *
 * `BUILD_TIME` is baked in as UTC because that is the only way to write an
 * instant down without ambiguity. Nobody reads their own day in UTC, though, so
 * a visitor in Jakarta comparing this line against the deploy they just watched
 * finish should not have to add seven hours in their head.
 *
 * The zone and the language both come from the device rather than from here.
 * That is what lets the short zone name be a real one: `WIB` for a Jakarta
 * reader whose browser is set to Indonesian, `EDT` for one in New York. Where a
 * locale has no name for the zone, Intl writes the offset — `GMT+7` — which is
 * unambiguous and, unlike a guessed abbreviation, true.
 *
 * This formats the recorded instant and nothing else. It never reads the clock,
 * so a stale deployment still says when it was built and not when it was opened.
 */
export function buildTimeLabel(info: BuildInfo = BUILD_INFO, format: TimeFormat = {}): string {
  if (!info.builtAt) return ''
  const at = new Date(info.builtAt)
  if (Number.isNaN(at.getTime())) return ''
  try {
    return new Intl.DateTimeFormat(format.locale, {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      // 00-23, so midnight is `00:` in every locale rather than `24:`.
      hourCycle: 'h23',
      timeZoneName: 'short',
      timeZone: format.timeZone,
    }).format(at)
  } catch {
    // An engine without usable Intl data, or a zone name it does not know. The
    // recorded instant is still exact, so say it in UTC rather than invent a
    // local one.
    return utcLabel(at)
  }
}

export const BUILD_INFO: BuildInfo = (() => {
  const version = baked('VITE_APP_VERSION') || '0.0.0'
  const commit = baked('VITE_BUILD_SHA') || 'dev'
  return {
    version,
    commit,
    builtAt: baked('VITE_BUILD_TIME'),
    fromCommit: commit !== 'dev',
  }
})()
