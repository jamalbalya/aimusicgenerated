/**
 * A very small router.
 *
 * The app has eight pages and no nested routes, so a routing library would be
 * more code than this.
 *
 * Two modes. Normally it uses the History API and real paths, with GitHub
 * Pages serving `404.html` — a copy of `index.html` — for unknown paths, which
 * is what makes deep links survive a reload. In a single-file build there is
 * no server to do that, and the document may even be opened straight from
 * disk, so routes live in the fragment instead.
 */

import { useCallback, useEffect, useState } from 'react'

export const BASE = import.meta.env.BASE_URL.replace(/\/$/, '')

/** True when there is no server able to map paths back to the document. */
const HASH_MODE =
  typeof window !== 'undefined' &&
  (window.location.protocol === 'file:' || import.meta.env.VITE_INLINE_WORKER === true)

function normalize(path: string): string {
  if (!path.startsWith('/')) return `/${path}`
  return path
}

function currentPath(): string {
  if (typeof window === 'undefined') return '/'
  if (HASH_MODE) {
    const hash = window.location.hash.replace(/^#/, '')
    return hash === '' ? '/' : normalize(hash)
  }
  const path = window.location.pathname
  const stripped = BASE && path.startsWith(BASE) ? path.slice(BASE.length) : path
  return stripped === '' ? '/' : stripped
}

const listeners = new Set<(path: string) => void>()

function notify(): void {
  const path = currentPath()
  for (const listener of listeners) listener(path)
}

export function href(path: string): string {
  if (HASH_MODE) return `#${path === '/' ? '/' : path}`
  return `${BASE}${path === '/' ? '/' : path}`
}

export function navigate(path: string, options: { replace?: boolean } = {}): void {
  const target = href(path)
  if (HASH_MODE) {
    if (window.location.hash === target) return
    if (options.replace) {
      window.history.replaceState({}, '', target)
      notify()
    } else {
      // Assigning the hash fires `hashchange`, which drives the update.
      window.location.hash = target
    }
    window.scrollTo({ top: 0 })
    return
  }

  if (window.location.pathname === target) return
  if (options.replace) window.history.replaceState({}, '', target)
  else window.history.pushState({}, '', target)
  notify()
  window.scrollTo({ top: 0 })
}

export function useRoute(): [string, (path: string) => void] {
  const [path, setPath] = useState(currentPath)

  useEffect(() => {
    const onChange = (): void => setPath(currentPath())
    listeners.add(setPath)
    window.addEventListener('popstate', onChange)
    window.addEventListener('hashchange', onChange)
    return () => {
      listeners.delete(setPath)
      window.removeEventListener('popstate', onChange)
      window.removeEventListener('hashchange', onChange)
    }
  }, [])

  const go = useCallback((next: string) => navigate(next), [])
  return [path, go]
}

/** Intercepts a link click so it routes without a full page load. */
export function linkProps(path: string, onNavigate?: () => void) {
  return {
    href: href(path),
    onClick: (event: React.MouseEvent<HTMLAnchorElement>) => {
      // Let the browser handle modified clicks — open in a new tab still works.
      if (
        event.defaultPrevented || event.button !== 0 ||
        event.metaKey || event.ctrlKey || event.shiftKey || event.altKey
      ) {
        return
      }
      event.preventDefault()
      navigate(path)
      onNavigate?.()
    },
  }
}
