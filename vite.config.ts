import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadEnv } from 'vite'
import { defineConfig, type Plugin } from 'vitest/config'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

/**
 * Static hosts serve `404.html` for any unknown path. Copying the built
 * index there is what makes a deep link like /toolkit survive a hard reload
 * on GitHub Pages, which has no server-side rewrite.
 */
const projectRoot = dirname(fileURLToPath(import.meta.url))

function spaFallback(): Plugin {
  return {
    name: 'spa-fallback',
    apply: 'build',
    closeBundle() {
      const index = resolve(projectRoot, 'dist/index.html')
      if (existsSync(index)) copyFileSync(index, resolve(projectRoot, 'dist/404.html'))
    },
  }
}

// The public deployment lives at https://<user>.github.io/<repo>/, so the base
// path has to match the repository name. Override with VITE_BASE when hosting
// at a domain root (Netlify, Vercel, Cloudflare Pages, a custom domain, ...).
const base = process.env.VITE_BASE ?? '/'

/**
 * Single-file mode bundles everything — including the worker — into one HTML
 * document, so the studio can be opened straight from disk or hosted anywhere
 * that serves a single page. It costs a larger initial download, so the normal
 * build keeps its separate, cacheable chunks.
 */
const singleFile = process.env.VITE_SINGLE_FILE === '1'
const outDir = singleFile ? 'dist-single' : 'dist'

/** Folds the built script and stylesheet into index.html. */
function inlineEverything(directory: string): Plugin {
  return {
    name: 'inline-everything',
    apply: 'build',
    closeBundle() {
      const dist = resolve(projectRoot, directory)
      const indexPath = resolve(dist, 'index.html')
      if (!existsSync(indexPath)) return

      let html = readFileSync(indexPath, 'utf8')

      /** Built assets can sit at the dist root or under assets/. */
      const findAsset = (reference: string): string | null => {
        const name = reference.split('/').pop() ?? ''
        for (const candidate of [resolve(dist, name), resolve(dist, 'assets', name)]) {
          if (existsSync(candidate)) return candidate
        }
        return null
      }

      html = html.replace(
        /<script[^>]*src="([^"]+)"[^>]*><\/script>/g,
        (match, src: string) => {
          const file = findAsset(src)
          if (!file) return match
          return `<script type="module">\n${readFileSync(file, 'utf8')}\n</script>`
        },
      )
      html = html.replace(
        /<link[^>]*rel="stylesheet"[^>]*href="([^"]+)"[^>]*>/g,
        (match, href: string) => {
          const file = findAsset(href)
          if (!file) return match
          return `<style>\n${readFileSync(file, 'utf8')}\n</style>`
        },
      )
      // The manifest points at icons that are not bundled into the document.
      html = html.replace(/<link[^>]*rel="manifest"[^>]*>/g, '')
      // Nothing else is fetched, so drop the preload hints for files that are
      // now embedded in the document.
      html = html.replace(/<link[^>]*rel="modulepreload"[^>]*>/g, '')

      writeFileSync(resolve(dist, 'resonant-studio.html'), html)
      writeFileSync(indexPath, html)
    },
  }
}

/**
 * The neural settings a build may carry into the browser, and nothing else.
 *
 * An allowlist on purpose: `.env` is also where a deploy token can live, and
 * the only way a value reaches the bundle is by being named here.
 */
export const NEURAL_SETTINGS = [
  'API_URL', 'API_KEY', 'MODEL', 'LM_MODEL',
  'BACKEND', 'SPACE_URL', 'SPACE_AUTO_DURATION', 'SPACE_MAX_DURATION', 'SPACE_TIMEOUT_SECONDS',
] as const

/**
 * The build metadata a build may carry into the browser, and nothing else.
 *
 * A second allowlist rather than an addition to the first, because these come
 * from a different place: `NEURAL_SETTINGS` are read from `.env`, where a deploy
 * token also lives, while these are read only from the process environment that
 * CI sets. Neither list can reach the other's source.
 */
export const BUILD_SETTINGS = ['APP_VERSION', 'BUILD_SHA', 'BUILD_TIME'] as const

/** Seven characters, which is what `git log --oneline` and GitHub both show. */
const SHORT_SHA = 7

/**
 * Version, commit and build time for the browser.
 *
 * The commit comes from the environment CI already provides — `GITHUB_SHA` is a
 * default variable in every Actions step — with `BUILD_SHA` as an explicit
 * override for a build made anywhere else. It is shortened here so the full
 * hash never reaches the bundle, and a build made without either says `dev`,
 * which is the useful answer: a screenshot showing `dev` was not built by CI,
 * so it cannot be a stale deployment of anything.
 *
 * `env` is `process.env`, never `loadEnv`. A `.env` file cannot reach this.
 */
export function buildDefines(
  env: Record<string, string | undefined>,
  version: string,
  now: Date = new Date(),
): Record<string, string> {
  const sha = (env.BUILD_SHA ?? env.GITHUB_SHA ?? '').trim()
  const values: Record<(typeof BUILD_SETTINGS)[number], string> = {
    APP_VERSION: version,
    BUILD_SHA: /^[0-9a-f]{7,40}$/i.test(sha) ? sha.slice(0, SHORT_SHA).toLowerCase() : 'dev',
    BUILD_TIME: now.toISOString(),
  }
  const defines: Record<string, string> = {}
  for (const name of BUILD_SETTINGS) defines[`import.meta.env.VITE_${name}`] = JSON.stringify(values[name])
  return defines
}

/**
 * The application version, from `package.json` — the one place it is set.
 *
 * Read here rather than imported by the app, so the bundle carries the version
 * string and not the whole manifest.
 */
export function packageVersion(root: string = projectRoot): string {
  try {
    const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as { version?: unknown }
    return typeof pkg.version === 'string' && pkg.version ? pkg.version : '0.0.0'
  } catch {
    return '0.0.0'
  }
}

/**
 * One name per setting.
 *
 * Vite only exposes variables prefixed VITE_ to the browser bundle, which would
 * otherwise mean every neural setting needs writing twice — once as
 * ACE_STEP_API_URL for the scripts and once as VITE_ACE_STEP_API_URL for the
 * app — and the two drifting apart is a matter of time. So the plain name is
 * the authoritative one and is baked in here; the VITE_ form stays as an
 * override for anyone who prefers it.
 *
 * `env` comes from `loadEnv`, not `process.env`. Vite never copies a `.env`
 * file's plain keys into `process.env` — it expands them into a copy — so
 * reading `process.env` here saw only variables exported in the shell, and a
 * setting written in `.env`, as `.env.example` says to, never arrived.
 */
export function neuralDefines(env: Record<string, string>): Record<string, string> {
  // Blank counts as unset: a CI variable that was never defined arrives as an
  // empty string, and must not shadow the other spelling of the same setting.
  const set = (value: string | undefined) => (value && value.trim() ? value.trim() : undefined)
  const defines: Record<string, string> = {}
  for (const name of NEURAL_SETTINGS) {
    const value = set(env[`VITE_ACE_STEP_${name}`]) ?? set(env[`ACE_STEP_${name}`]) ?? ''
    defines[`import.meta.env.VITE_ACE_STEP_${name}`] = JSON.stringify(value)
  }
  return defines
}

export default defineConfig(({ mode }) => ({
  base: singleFile ? './' : base,
  plugins: [react(), tailwindcss(), ...(singleFile ? [inlineEverything(outDir)] : [spaFallback()])],
  define: {
    // A compile-time constant, so the branch it guards is removed entirely
    // from whichever build does not need it.
    'import.meta.env.VITE_INLINE_WORKER': JSON.stringify(singleFile),
    // The shell wins over `.env`, as everywhere else in Vite. Unit tests get
    // nothing baked in at all, so a developer's `.env` — which may well point
    // at the live Space — cannot change what they see.
    ...neuralDefines(process.env.VITEST ? {} : loadEnv(mode, projectRoot, '')),
    ...buildDefines(process.env, packageVersion()),
  },
  build: {
    outDir,
    target: 'es2022',
    sourcemap: false,
    chunkSizeWarningLimit: singleFile ? 4000 : 1200,
    assetsInlineLimit: singleFile ? Number.MAX_SAFE_INTEGER : 4096,
    cssCodeSplit: !singleFile,
    rollupOptions: singleFile
      ? { output: { inlineDynamicImports: true, entryFileNames: 'app.js', assetFileNames: 'app[extname]' } }
      : {},
  },
  worker: {
    format: 'es',
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/unit/**/*.test.ts'],
    testTimeout: 30_000,
  },
}))
