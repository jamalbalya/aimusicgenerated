/**
 * A very small History-API router.
 *
 * The app has eight pages and no nested routes, so a routing library would be
 * more code than this. GitHub Pages serves `404.html` for unknown paths, and
 * the build copies `index.html` there, which is what makes deep links work.
 */

import { useCallback, useEffect, useState } from 'react'

export const BASE = import.meta.env.BASE_URL.replace(/\/$/, '')

function currentPath(): string {
  const path = window.location.pathname
  const stripped = BASE && path.startsWith(BASE) ? path.slice(BASE.length) : path
  return stripped === '' ? '/' : stripped
}

const listeners = new Set<(path: string) => void>()

function notify(): void {
  const path = currentPath()
  for (const listener of listeners) listener(path)
}

export function navigate(path: string, options: { replace?: boolean } = {}): void {
  const target = `${BASE}${path === '/' ? '/' : path}`
  if (window.location.pathname === target) return
  if (options.replace) window.history.replaceState({}, '', target)
  else window.history.pushState({}, '', target)
  notify()
  window.scrollTo({ top: 0 })
}

export function href(path: string): string {
  return `${BASE}${path === '/' ? '/' : path}`
}

export function useRoute(): [string, (path: string) => void] {
  const [path, setPath] = useState(currentPath)

  useEffect(() => {
    const onPop = (): void => setPath(currentPath())
    listeners.add(setPath)
    window.addEventListener('popstate', onPop)
    return () => {
      listeners.delete(setPath)
      window.removeEventListener('popstate', onPop)
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
      // Let the browser handle modified clicks — open in new tab still works.
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
        return
      }
      event.preventDefault()
      navigate(path)
      onNavigate?.()
    },
  }
}
