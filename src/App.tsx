/** Application shell: navigation, theme, transport and routing. */

import { lazy, Suspense, useEffect } from 'react'
import { Icon } from './ui/components/Icon'
import { Transport } from './ui/components/Transport'
import { Progress } from './ui/components/controls'
import { TOOLS, toolFor } from './ui/nav'
import { linkProps, useRoute } from './lib/router'
import { applyTheme, useStudio } from './state/store'
import { QUALITY_HINTS, QUALITY_LABELS, type RenderQuality } from './workers/protocol'

const StudioPage = lazy(() => import('./ui/pages/StudioPage'))
const LyricsPage = lazy(() => import('./ui/pages/LyricsPage'))
const SpeechPage = lazy(() => import('./ui/pages/SpeechPage'))
const StemsPage = lazy(() => import('./ui/pages/StemsPage'))
const ShifterPage = lazy(() => import('./ui/pages/ShifterPage'))
const ToolkitPage = lazy(() => import('./ui/pages/ToolkitPage'))
const LibraryPage = lazy(() => import('./ui/pages/LibraryPage'))
const AboutPage = lazy(() => import('./ui/pages/AboutPage'))

function routeElement(path: string) {
  switch (path) {
    case '/': return <StudioPage />
    case '/lyrics': return <LyricsPage />
    case '/voice': return <SpeechPage />
    case '/stems': return <StemsPage />
    case '/shifter': return <ShifterPage />
    case '/toolkit': return <ToolkitPage />
    case '/library': return <LibraryPage />
    case '/about': return <AboutPage />
    default: return <NotFound path={path} />
  }
}

function NotFound({ path }: { path: string }) {
  return (
    <div className="grid place-items-center gap-3 py-20 text-center">
      <p className="t-label">404</p>
      <h1 className="t-display">No tool lives here</h1>
      <p className="t-num text-[12px] text-[var(--text-dim)]">{path}</p>
      <a className="btn mt-2" {...linkProps('/')}>Back to the studio</a>
    </div>
  )
}

export default function App() {
  const [path] = useRoute()
  const theme = useStudio((s) => s.theme)
  const setTheme = useStudio((s) => s.setTheme)
  const quality = useStudio((s) => s.quality)
  const setQuality = useStudio((s) => s.setQuality)
  const job = useStudio((s) => s.job)
  const toast = useStudio((s) => s.toast)
  const dismissToast = useStudio((s) => s.dismissToast)

  useEffect(() => applyTheme(theme), [theme])

  useEffect(() => {
    const tool = toolFor(path)
    document.title = tool && tool.path !== '/'
      ? `${tool.label} · Resonant Studio`
      : 'Resonant Studio — free AI music, voice and audio tools'
  }, [path])

  useEffect(() => {
    if (!toast) return
    const timer = setTimeout(dismissToast, toast.tone === 'error' ? 7000 : 3600)
    return () => clearTimeout(timer)
  }, [toast, dismissToast])

  return (
    <div className="flex h-full flex-col">
      <div className="flex min-h-0 flex-1">
        <aside className="hidden w-[228px] shrink-0 flex-col border-r border-[var(--line)] bg-[var(--bg-panel)] lg:flex">
          <a className="flex items-center gap-2.5 px-4 py-4" {...linkProps('/')}>
            <Wordmark />
          </a>

          <nav className="flex-1 overflow-y-auto px-2.5 pb-3" aria-label="Tools">
            <p className="t-label px-2 pb-1.5 pt-2">Tools</p>
            <ul className="grid gap-0.5">
              {TOOLS.map((tool) => (
                <li key={tool.path}>
                  <a
                    className="nav-item"
                    aria-current={path === tool.path ? 'page' : undefined}
                    {...linkProps(tool.path)}
                  >
                    <Icon name={tool.icon} size={15} />
                    <span>{tool.label}</span>
                  </a>
                </li>
              ))}
            </ul>

            <p className="t-label px-2 pb-1.5 pt-5">Render quality</p>
            <div className="grid gap-0.5 px-1">
              {(['draft', 'balanced', 'studio'] as RenderQuality[]).map((option) => (
                <button
                  key={option}
                  type="button"
                  className="nav-item !py-1 whitespace-nowrap text-[12px]"
                  title={QUALITY_HINTS[option]}
                  aria-current={quality === option ? 'page' : undefined}
                  onClick={() => setQuality(option)}
                >
                  <span className="t-num">{QUALITY_LABELS[option]}</span>
                </button>
              ))}
            </div>
          </nav>

          <div className="border-t border-[var(--line)] p-2.5">
            <button
              type="button"
              className="nav-item w-full"
              onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
            >
              <Icon name={theme === 'dark' ? 'sun' : 'moon'} size={15} />
              <span>{theme === 'dark' ? 'Light theme' : 'Dark theme'}</span>
            </button>
            <a className="nav-item w-full" aria-current={path === '/about' ? 'page' : undefined} {...linkProps('/about')}>
              <Icon name="info" size={15} />
              <span>How this works</span>
            </a>
          </div>
        </aside>

        <div className="flex min-w-0 flex-1 flex-col">
          <header className="flex items-center justify-between gap-3 border-b border-[var(--line)] bg-[var(--bg-panel)] px-3 py-2.5 lg:hidden">
            <a className="flex items-center gap-2" {...linkProps('/')}>
              <Wordmark compact />
            </a>
            <div className="flex items-center gap-1">
              <a className="btn btn-ghost btn-sm !px-2" aria-label="How this works" {...linkProps('/about')}>
                <Icon name="info" size={16} />
              </a>
              <button
                type="button"
                className="btn btn-ghost btn-sm !px-2"
                aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
                onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
              >
                <Icon name={theme === 'dark' ? 'sun' : 'moon'} size={16} />
              </button>
            </div>
          </header>

          <main className="min-h-0 flex-1 overflow-y-auto">
            <div className="mx-auto w-full max-w-[1180px] px-3 py-4 sm:px-5 sm:py-6">
              <Suspense fallback={<div className="py-16"><Progress value={0} label="Loading tool" /></div>}>
                {routeElement(path)}
              </Suspense>
            </div>
          </main>
        </div>
      </div>

      {job && (
        <div className="border-t border-[var(--line)] bg-[var(--bg-raised)] px-3 py-2 sm:px-5">
          <div className="mx-auto w-full max-w-[1180px]">
            <Progress value={job.progress} stage={job.stage} label={job.label} />
          </div>
        </div>
      )}

      <Transport />

      <nav className="flex border-t border-[var(--line)] bg-[var(--bg-panel)] lg:hidden" aria-label="Tools">
        {TOOLS.filter((tool) => tool.primary).map((tool) => (
          <a
            key={tool.path}
            className="tabbar-item"
            aria-current={path === tool.path ? 'page' : undefined}
            {...linkProps(tool.path)}
          >
            <Icon name={tool.icon} size={17} />
            <span className="truncate">{tool.short}</span>
          </a>
        ))}
        <a
          className="tabbar-item"
          aria-current={['/toolkit', '/library', '/about'].includes(path) ? 'page' : undefined}
          {...linkProps('/toolkit')}
        >
          <Icon name="more" size={17} />
          <span>More</span>
        </a>
      </nav>

      {toast && (
        <div
          className="pointer-events-none fixed inset-x-0 bottom-24 z-50 flex justify-center px-4"
          role="status"
          aria-live="polite"
        >
          <div
            className="panel pointer-events-auto flex max-w-md items-start gap-2.5 px-3.5 py-2.5"
            style={{ boxShadow: 'var(--shadow-pop)' }}
          >
            <Icon
              name={toast.tone === 'error' ? 'info' : 'check'}
              size={15}
              className={toast.tone === 'error' ? 'mt-0.5 text-[var(--danger)]' : 'mt-0.5 text-[var(--ok)]'}
            />
            <p className="text-[12.5px] leading-snug">{toast.message}</p>
            <button
              type="button"
              className="btn btn-ghost btn-sm -my-1 -mr-2 !px-1.5"
              aria-label="Dismiss"
              onClick={dismissToast}
            >
              <Icon name="close" size={13} />
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function Wordmark({ compact }: { compact?: boolean }) {
  return (
    <span className="flex items-center gap-2">
      {/* A stylised waveform envelope — the app's only piece of ornament. */}
      <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
        <g stroke="var(--accent)" strokeWidth="1.6" strokeLinecap="round">
          <path d="M2 10h2.2" />
          <path d="M6.4 5.4v9.2" />
          <path d="M10 2.6v14.8" />
          <path d="M13.6 6.8v6.4" />
          <path d="M17.2 9v2" />
        </g>
      </svg>
      <span className="grid leading-none">
        <span className="text-[13.5px] font-semibold tracking-[-0.02em]">Resonant</span>
        {!compact && <span className="t-label mt-1">Studio · all free</span>}
      </span>
    </span>
  )
}
