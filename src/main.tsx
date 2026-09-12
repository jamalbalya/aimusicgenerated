import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { applyTheme, useStudio } from './state/store'
import { completeCallbackInPopup } from './auth/hfOAuth'
import './index.css'

// The OAuth popup lands on this same root, because the root is the redirect
// URI registered with Hugging Face. It hands the authorization code back to the
// window that opened it and closes, before React or anything else starts:
// nothing else needs to load, and the code should live as briefly as possible.
//
// Recognised by what the URL carries rather than by its path, since there is no
// path of our own to recognise any more. `completeCallbackInPopup` refuses
// unless this window was opened by another, so an ordinary visit to a link
// someone pasted — code and all — loads the application as usual.
if (window.location.search.includes('code=') && completeCallbackInPopup(window.location.search)) {
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
