/**
 * What configuration reaches the browser bundle, and what never can.
 *
 * `neuralDefines` in `vite.config.ts` is the only door between `.env` (or the
 * CI environment) and the public JavaScript every visitor downloads. `.env`
 * on the developer's machine also holds a Hugging Face deploy token. So the
 * door is an allowlist, and these tests hold it shut for everything else.
 */

import { describe, expect, it } from 'vitest'
import { NEURAL_SETTINGS, neuralDefines } from '../../vite.config'

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
