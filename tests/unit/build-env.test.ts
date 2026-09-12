/**
 * What configuration reaches the browser bundle, and what never can.
 *
 * `neuralDefines` in `vite.config.ts` is the only door between `.env` (or the
 * CI environment) and the public JavaScript every visitor downloads. `.env`
 * on the developer's machine also holds a Hugging Face deploy token. So the
 * door is an allowlist, and these tests hold it shut for everything else.
 */

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { AUTH_SETTINGS, BUILD_SETTINGS, NEURAL_SETTINGS, authDefines, buildDefines, neuralDefines, packageVersion } from '../../vite.config'
import { BUILD_INFO, buildLabel, buildTimeLabel } from '../../src/lib/buildInfo'

const baked = (env: Record<string, string>, name: string) =>
  JSON.parse(neuralDefines(env)[`import.meta.env.VITE_ACE_STEP_${name}`] ?? 'null') as string | null

describe('the browser bundle carries the neural settings and nothing else', () => {
  it('allows exactly the documented settings — none of them a secret', () => {
    expect([...NEURAL_SETTINGS].sort()).toEqual([
      'API_KEY', 'API_URL', 'BACKEND', 'LM_MODEL', 'MODEL',
      'SPACE_AUTO_DURATION', 'SPACE_MAX_DURATION', 'SPACE_TIMEOUT_SECONDS', 'SPACE_URL',
    ])
    // API_KEY is the local backend's optional key, documented as public by
    // nature once it is in a bundle. Nothing token-, secret- or password-named.
    expect(NEURAL_SETTINGS.filter((name) => /TOKEN|SECRET|PASSWORD|PRIVATE/.test(name))).toEqual([])
  })

  it('never lets anything outside the allowlist through, whatever it is called', () => {
    const env = {
      'hugging-face-token': 'hf_should_never_ship',
      HF_TOKEN: 'hf_should_never_ship',
      VITE_HF_TOKEN: 'hf_should_never_ship',
      ACE_STEP_SECRET: 'hf_should_never_ship',
      VITE_ACE_STEP_TOKEN: 'hf_should_never_ship',
      ACE_STEP_SPACE_URL: 'https://owner-space.hf.space',
    }
    const defines = neuralDefines(env)
    expect(Object.keys(defines).sort())
      .toEqual(NEURAL_SETTINGS.map((name) => `import.meta.env.VITE_ACE_STEP_${name}`).sort())
    expect(JSON.stringify(defines)).not.toContain('hf_should_never_ship')
  })

  it('takes the plain name, so .env needs each setting only once', () => {
    expect(baked({ ACE_STEP_BACKEND: 'zerogpu' }, 'BACKEND')).toBe('zerogpu')
    expect(baked({ ACE_STEP_SPACE_URL: 'https://owner-space.hf.space' }, 'SPACE_URL')).toBe('https://owner-space.hf.space')
  })

  it('lets the VITE_ spelling override, and ignores it when blank', () => {
    expect(baked({ ACE_STEP_BACKEND: 'local', VITE_ACE_STEP_BACKEND: 'zerogpu' }, 'BACKEND')).toBe('zerogpu')
    // An unset CI variable arrives as "", and must not hide the other spelling.
    expect(baked({ ACE_STEP_BACKEND: 'zerogpu', VITE_ACE_STEP_BACKEND: '  ' }, 'BACKEND')).toBe('zerogpu')
  })

  it('bakes an empty value for anything unset, which the app reads as unset', () => {
    expect(baked({}, 'SPACE_URL')).toBe('')
    expect(baked({}, 'BACKEND')).toBe('')
  })
})

/* ------------------------------------------------ version and build ------ */

const bakedBuild = (env: Record<string, string | undefined>, name: string, version = '1.2.3') =>
  JSON.parse(buildDefines(env, version)[`import.meta.env.VITE_${name}`] ?? 'null') as string | null

describe('the build identifies itself', () => {
  it('takes the version from package.json, the one place it is set', () => {
    const declared = (JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as
      { version: string }).version
    expect(packageVersion()).toBe(declared)
    expect(declared).toMatch(/^\d+\.\d+\.\d+/)
    // And the app reports that same version rather than one of its own.
    expect(BUILD_INFO.version).toBe(declared)
  })

  it('takes the commit from the environment CI already provides, shortened', () => {
    const sha = '18c76921c0ffee1234567890abcdef1234567890'
    expect(bakedBuild({ GITHUB_SHA: sha }, 'BUILD_SHA')).toBe('18c7692')
    // BUILD_SHA is the explicit override, for a build made outside Actions.
    expect(bakedBuild({ GITHUB_SHA: sha, BUILD_SHA: 'deadbee' }, 'BUILD_SHA')).toBe('deadbee')
    // The full hash never reaches the bundle.
    expect(JSON.stringify(buildDefines({ GITHUB_SHA: sha }, '1.2.3'))).not.toContain(sha)
  })

  it('falls back to dev, so a local build never looks like a deployed one', () => {
    expect(bakedBuild({}, 'BUILD_SHA')).toBe('dev')
    expect(bakedBuild({ GITHUB_SHA: '' }, 'BUILD_SHA')).toBe('dev')
    expect(bakedBuild({ GITHUB_SHA: '   ' }, 'BUILD_SHA')).toBe('dev')
    // Anything that is not a commit hash is not treated as one.
    expect(bakedBuild({ GITHUB_SHA: 'refs/heads/main' }, 'BUILD_SHA')).toBe('dev')
    expect(bakedBuild({ GITHUB_SHA: 'hf_a_token_shaped_thing' }, 'BUILD_SHA')).toBe('dev')
  })

  it('records when it was built, as a timestamp and nothing more', () => {
    const at = new Date('2026-09-11T14:02:33.000Z')
    const defines = buildDefines({}, '1.2.3', at)
    expect(JSON.parse(defines['import.meta.env.VITE_BUILD_TIME']!)).toBe('2026-09-11T14:02:33.000Z')
  })

  it('bakes exactly three names, none of them a secret', () => {
    expect([...BUILD_SETTINGS].sort()).toEqual(['APP_VERSION', 'BUILD_SHA', 'BUILD_TIME'])
    expect(BUILD_SETTINGS.filter((name) => /TOKEN|SECRET|PASSWORD|PRIVATE|KEY/.test(name))).toEqual([])
  })

  it('lets nothing else out, however the environment is dressed up', () => {
    // A whole GitHub Actions environment, secrets and all, offered at once.
    const env = {
      GITHUB_SHA: '18c76921c0ffee1234567890abcdef1234567890',
      GITHUB_TOKEN: 'ghp_should_never_ship',
      HF_TOKEN: 'hf_should_never_ship',
      ACTIONS_RUNTIME_TOKEN: 'should_never_ship',
      AWS_SECRET_ACCESS_KEY: 'should_never_ship',
      NPM_TOKEN: 'should_never_ship',
      GITHUB_ACTOR: 'somebody',
      GITHUB_REPOSITORY: 'owner/repo',
      HOME: '/home/runner',
    }
    const defines = buildDefines(env, '1.2.3')
    expect(Object.keys(defines).sort())
      .toEqual(BUILD_SETTINGS.map((name) => `import.meta.env.VITE_${name}`).sort())
    const baked = JSON.stringify(defines)
    for (const secret of ['should_never_ship', 'ghp_', 'hf_', 'somebody', 'owner/repo', '/home/runner']) {
      expect(baked, `${secret} must not reach the bundle`).not.toContain(secret)
    }
  })

  it('gives the page one line to show, and a real one', () => {
    expect(buildLabel({ version: '1.0.0', commit: '18c7692', builtAt: '', fromCommit: true }))
      .toBe('v1.0.0 · build 18c7692')
    expect(buildLabel({ version: '1.0.0', commit: 'dev', builtAt: '', fromCommit: false }))
      .toBe('v1.0.0 · build dev')

    // The live values, as the About page will render them.
    expect(buildLabel()).toBe(`v${BUILD_INFO.version} · build ${BUILD_INFO.commit}`)
    expect(BUILD_INFO.commit).toMatch(/^([0-9a-f]{7}|dev)$/)
    expect(BUILD_INFO.fromCommit).toBe(BUILD_INFO.commit !== 'dev')
  })

  it('shows a build time only when it has a usable one', () => {
    expect(buildTimeLabel({ version: '1.0.0', commit: 'dev', builtAt: '', fromCommit: false })).toBe('')
    expect(buildTimeLabel({ version: '1.0.0', commit: 'dev', builtAt: 'not a date', fromCommit: false })).toBe('')
    // Written on the reader's clock, so the zone is named rather than assumed;
    // `build-time.test.ts` covers the conversion itself.
    expect(buildTimeLabel(
      { version: '1.0.0', commit: 'dev', builtAt: '2026-09-11T14:02:33.000Z', fromCommit: false },
      { locale: 'en-GB', timeZone: 'UTC' },
    )).toBe('11 Sept 2026, 14:02 UTC')
  })
})

/* -------------------------------------------------------- signing in ----- */

describe('the bundle carries the sign-in settings and nothing else', () => {
  it('allows exactly three, none of them a secret', () => {
    // The third is the allowlist the login page reads. A username is public —
    // it is on the account's own page — and the decision that matters is made
    // by the Space, which keeps its own copy where a browser cannot reach it.
    expect([...AUTH_SETTINGS].sort()).toEqual(['HF_ALLOWED_USERS', 'HF_CLIENT_ID', 'HF_PROVIDER_URL'])
    // A *public* client has no secret. Anything secret-shaped appearing beside
    // these would be a different kind of value that must never be baked in.
    expect(AUTH_SETTINGS.filter((name) => /SECRET|TOKEN|PASSWORD|PRIVATE/.test(name))).toEqual([])
  })

  it('bakes the client id, which is public by design', () => {
    const defines = authDefines({ VITE_HF_CLIENT_ID: 'a-public-client-id' })
    expect(JSON.parse(defines['import.meta.env.VITE_HF_CLIENT_ID']!)).toBe('a-public-client-id')
  })

  it('lets nothing else through, however the environment is dressed up', () => {
    const defines = authDefines({
      VITE_HF_CLIENT_ID: 'a-public-client-id',
      // The value this project does not have and must never acquire, offered
      // under every name something might try to smuggle it in as.
      VITE_HF_CLIENT_SECRET: 'should_never_ship',
      HF_CLIENT_SECRET: 'should_never_ship',
      OAUTH_CLIENT_SECRET: 'should_never_ship',
      VITE_HF_TOKEN: 'should_never_ship',
      ALLOWED_HF_USERS: 'should_never_ship',
    })
    expect(Object.keys(defines).sort())
      .toEqual(AUTH_SETTINGS.map((name) => `import.meta.env.VITE_${name}`).sort())
    expect(JSON.stringify(defines)).not.toContain('should_never_ship')
  })

  it('treats unset and blank alike, which the app reads as not configured', () => {
    expect(JSON.parse(authDefines({})['import.meta.env.VITE_HF_CLIENT_ID']!)).toBe('')
    expect(JSON.parse(authDefines({ VITE_HF_CLIENT_ID: '   ' })['import.meta.env.VITE_HF_CLIENT_ID']!)).toBe('')
  })
})

describe('the Pages workflow hands the build its commit', () => {
  const workflow = readFileSync(new URL('../../.github/workflows/deploy.yml', import.meta.url), 'utf8')

  it('passes the deployed commit to the build step', () => {
    // Without this the deployed About page would say `dev`, and a stale
    // deployment would be indistinguishable from a current one.
    expect(workflow).toMatch(/BUILD_SHA:\s*\$\{\{\s*github\.sha\s*\}\}/)
  })

  it('passes the OAuth public client id, without which the site cannot sign in', () => {
    // Dropping this does not fail the build or the deploy: it ships a site
    // whose neural engine is unusable. That is exactly the kind of regression
    // a deploy-time check cannot catch, so it is caught here instead.
    expect(workflow).toMatch(/VITE_HF_CLIENT_ID:\s*\$\{\{\s*vars\.VITE_HF_CLIENT_ID\s*\}\}/)
  })

  it('hands the build no secrets', () => {
    expect(workflow).not.toMatch(/secrets\.[A-Z_]+/)
    // A public client has no secret, so a client-secret name anywhere in the
    // workflow means one was introduced where the flow has no use for it.
    expect(workflow).not.toMatch(/CLIENT_SECRET/)
  })
})

describe('CI builds something the sign-in tests can actually exercise', () => {
  const workflow = readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8')

  it('gives the test build a client id, so the sign-in is on the page', () => {
    // Without one the control never renders, and every spec that drives a
    // neural generation fails for that reason rather than its own.
    expect(workflow).toMatch(/VITE_HF_CLIENT_ID:\s*\S+/)
  })

  it('uses a stand-in rather than the real application', () => {
    // CI must not depend on an OAuth application existing, and the value it
    // builds with must not be able to authenticate against a real one.
    expect(workflow).toMatch(/VITE_HF_CLIENT_ID:\s*not-a-real-oauth-client-id/)
    expect(workflow).not.toMatch(/vars\.VITE_HF_CLIENT_ID/)
    expect(workflow).not.toMatch(/secrets\.[A-Z_]+/)
  })
})
