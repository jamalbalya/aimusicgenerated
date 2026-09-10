import { defineConfig, devices } from '@playwright/test'

/**
 * End-to-end tests run against the production build, which is what actually
 * ships — the dev server transforms modules differently and would not catch a
 * bundling or worker-URL mistake.
 */
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  timeout: 180_000,
  expect: { timeout: 20_000 },
  use: {
    baseURL: 'http://127.0.0.1:4173',
    trace: 'retain-on-failure',
    launchOptions: {
      // Deterministic, silent audio so playback can be tested anywhere.
      args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'],
      // Sandboxes that ship a Chromium build already can point at it instead
      // of downloading a second copy.
      ...(process.env.PLAYWRIGHT_CHROMIUM_PATH
        ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH }
        : {}),
    },
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 900 } } },
    { name: 'mobile', use: { ...devices['Pixel 7'] } },
  ],
  webServer: {
    command: 'npm run preview',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
})
