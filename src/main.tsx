import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { initStore } from './store'
import { ToastProvider } from './ui/Toast'
import { ConfirmProvider } from './ui/ConfirmDialog'

// Cookie storage must be read (async decompress) before the app reads store.data.
initStore()
  .catch((e) => console.error('Store init failed:', e))
  .finally(() => {
    createRoot(document.getElementById('root')!).render(
      <StrictMode>
        <ToastProvider>
          <ConfirmProvider>
            <App />
          </ConfirmProvider>
        </ToastProvider>
      </StrictMode>,
    )
  })
