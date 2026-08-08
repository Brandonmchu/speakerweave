import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

import App from '@/App'
import { MaybeClerkProvider } from '@/auth/clerk'
import '@/index.css'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Operators tab away constantly during a review session — refetching on
      // every focus makes the app feel like it's reloading under them.
      staleTime: 60_000,
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
})

const container = document.getElementById('root')
if (!container) throw new Error('#root not found — index.html is out of sync with main.tsx')

createRoot(container).render(
  <StrictMode>
    <BrowserRouter>
      <MaybeClerkProvider>
        <QueryClientProvider client={queryClient}>
          <App />
        </QueryClientProvider>
      </MaybeClerkProvider>
    </BrowserRouter>
  </StrictMode>
)
