import { render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import App from '@/App'

function renderApp(initialPath: string) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 0 } },
  })
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    </MemoryRouter>
  )
}

describe('app shell smoke', () => {
  beforeEach(() => {
    window.localStorage.clear()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } }))
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('sends a tokenless visitor to /dev-login', async () => {
    renderApp('/submissions')
    expect(await screen.findByText('Developer sign-in')).toBeInTheDocument()
  })

  it('renders the submissions inbox once a token exists', async () => {
    window.localStorage.setItem('dais.token', 'test-token')
    renderApp('/submissions')
    expect(await screen.findByRole('heading', { name: 'Submissions' })).toBeInTheDocument()
    expect(await screen.findByText('No events yet')).toBeInTheDocument()
  })
})
