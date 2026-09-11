import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
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
 * One name per setting.
 *
 * Vite only exposes variables prefixed VITE_ to the browser bundle, which would
 * otherwise mean every neural setting needs writing twice — once as
 * ACE_STEP_API_URL for the scripts and once as VITE_ACE_STEP_API_URL for the
 * app — and the two drifting apart is a matter of time. So the plain name is
 * the authoritative one and is baked in here; the VITE_ form stays as an
 * override for anyone who prefers it.
 */
function neuralSetting(name: string, fallback = ''): string {
  return process.env[`VITE_ACE_STEP_${name}`]
    ?? process.env[`ACE_STEP_${name}`]
    ?? fallback
}

export default defineConfig({
  base: singleFile ? './' : base,
  plugins: [react(), tailwindcss(), ...(singleFile ? [inlineEverything(outDir)] : [spaFallback()])],
  define: {
    // A compile-time constant, so the branch it guards is removed entirely
    // from whichever build does not need it.
    'import.meta.env.VITE_INLINE_WORKER': JSON.stringify(singleFile),
    'import.meta.env.VITE_ACE_STEP_API_URL': JSON.stringify(neuralSetting('API_URL')),
    'import.meta.env.VITE_ACE_STEP_API_KEY': JSON.stringify(neuralSetting('API_KEY')),
    'import.meta.env.VITE_ACE_STEP_MODEL': JSON.stringify(neuralSetting('MODEL')),
    'import.meta.env.VITE_ACE_STEP_LM_MODEL': JSON.stringify(neuralSetting('LM_MODEL')),
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
})
