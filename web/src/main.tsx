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
      // Preserve warm route data across a normal working session. Mutations
      // already update or invalidate affected keys, so eviction needn't turn
      // every back-navigation into another loading state.
      gcTime: 15 * 60_000,
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
})

// Event metadata and taxonomy lists change through mutations that invalidate
// these keys. Treat them as reference data between those writes.
queryClient.setQueryDefaults(['events'], { staleTime: 5 * 60_000 })
queryClient.setQueryDefaults(['tracks'], { staleTime: 10 * 60_000 })
queryClient.setQueryDefaults(['formats'], { staleTime: 10 * 60_000 })
queryClient.setQueryDefaults(['taxonomy'], { staleTime: 10 * 60_000 })

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
