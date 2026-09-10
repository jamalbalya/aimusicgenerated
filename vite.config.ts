import { copyFileSync, existsSync } from 'node:fs'
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

export default defineConfig({
  base,
  plugins: [react(), tailwindcss(), spaFallback()],
  build: {
    target: 'es2022',
    sourcemap: false,
    chunkSizeWarningLimit: 1200,
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
