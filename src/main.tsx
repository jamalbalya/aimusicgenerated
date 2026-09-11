import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { applyTheme, useStudio } from './state/store'
import { CALLBACK_PATH, completeCallbackInPopup } from './auth/hfOAuth'
import './index.css'

// The OAuth popup lands here. It hands the authorization code back to the
// window that opened it and closes, before React or anything else starts:
// nothing else needs to load, and the code should live as briefly as possible.
if (window.location.pathname.endsWith(CALLBACK_PATH) && completeCallbackInPopup(window.location.search)) {
  throw new Error('oauth callback handled')
}

// Apply the stored theme before the first paint so there is no flash.
applyTheme(useStudio.getState().theme)

const container = document.getElementById('root')
if (!container) throw new Error('Root element missing')

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
