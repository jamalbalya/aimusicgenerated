import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { applyTheme, useStudio } from './state/store'
import { consumeCallback, redirectUri } from './auth/hfOAuth'
import './index.css'

// The sign-in comes back to this same root, because the root is the redirect
// URI registered with Hugging Face. It is dealt with here, before React starts,
// so a valid callback never flashes the login page on its way through.
const callback = consumeCallback()

if (callback.kind === 'handed-off') {
  // Another window owns this sign-in and has been told. This one is finished:
  // it will usually close itself, but a window whose opener was severed by the
  // provider may not be allowed to, and an empty page with no explanation is
  // worse than a sentence. Deliberately not the application, and deliberately
  // not the login page — signing in again here would strand the other window.
  const root = document.getElementById('root')
  if (root) {
    root.innerHTML = ''
    const panel = document.createElement('div')
    panel.setAttribute('role', 'status')
    panel.setAttribute('data-testid', 'oauth-handoff')
    panel.style.cssText = 'display:grid;gap:12px;place-content:center;min-height:100vh;'
      + 'padding:24px;text-align:center;font:15px/1.5 system-ui,sans-serif'
    const said = document.createElement('p')
    said.textContent = 'Signed in. You can close this window.'
    const back = document.createElement('a')
    back.href = redirectUri()
    back.textContent = 'Back to the studio'
    panel.append(said, back)
    root.append(panel)
  }
} else {
  // Apply the stored theme before the first paint so there is no flash.
  applyTheme(useStudio.getState().theme)

  const container = document.getElementById('root')
  if (!container) throw new Error('Root element missing')

  createRoot(container).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
}
