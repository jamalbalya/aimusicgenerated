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

/** The build time as a person reads it, in UTC; empty when it is unknown. */
export function buildTimeLabel(info: BuildInfo = BUILD_INFO): string {
  if (!info.builtAt) return ''
  const at = new Date(info.builtAt)
  if (Number.isNaN(at.getTime())) return ''
  return `${at.toISOString().slice(0, 16).replace('T', ' ')} UTC`
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
