import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './styles.css'

const root = ReactDOM.createRoot(document.getElementById('root')!)

root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)

// Reveal the app only after it has actually painted, then retire the splash.
function dismissSplash() {
  const splash = document.getElementById('splash')
  if (!splash || splash.classList.contains('splash-out')) return
  // Two rAFs: the first flushes style/layout, the second confirms a real paint.
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      splash.classList.add('splash-out')
      const cleanup = () => splash.remove()
      splash.addEventListener('transitionend', cleanup, { once: true })
      // Safety net if transitionend never fires (e.g. reduced motion).
      window.setTimeout(cleanup, 900)
    })
  })
}

if (document.readyState === 'complete') {
  window.setTimeout(dismissSplash, 120)
} else {
  window.addEventListener('load', () => window.setTimeout(dismissSplash, 120))
}
