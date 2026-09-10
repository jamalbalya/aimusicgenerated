import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { applyTheme, useStudio } from './state/store'
import './index.css'

// Apply the stored theme before the first paint so there is no flash.
applyTheme(useStudio.getState().theme)

const container = document.getElementById('root')
if (!container) throw new Error('Root element missing')

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
