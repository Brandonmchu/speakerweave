/**
 * How someone REACHES the CRM.
 *
 * The org-level directory only counts if it can be found: it has to live in the
 * top-level navigation (not nested inside one event's menu), and the URLs a
 * person guesses first — /crm, /contacts, /people — have to land on it rather
 * than bouncing to the submissions inbox, which is what they did before this
 * area existed.
 */

import { render, screen, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import App from '@/App'

const EMPTY_DIRECTORY = {
  people: [],
  total: 0,
  total_all: 0,
  filters: {},
  segment_id: null,
  segments: [],
  duplicate_count: 0,
  facets: { companies: [], titles: [], tags: [], stages: [], events: [] },
  custom_fields: [],
}

const EMPTY_BOARD = { columns: [], total: 0, candidates: [], stages: [] }

function stubFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const path = String(url)
      const payload = path.startsWith('/api/crm/directory')
        ? EMPTY_DIRECTORY
        : path.startsWith('/api/crm/pipeline')
          ? EMPTY_BOARD
          : path.startsWith('/api/events')
            ? { events: [{ id: 'evt-1', name: 'Summit', slug: 'summit' }] }
            : {}
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    })
  )
}

function renderApp(initialPath: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0 } } })
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    </MemoryRouter>
  )
}

describe('CRM routes', () => {
  beforeEach(() => {
    window.localStorage.setItem('dais.token', 'test-token')
    stubFetch()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    window.localStorage.clear()
  })

  it('renders the directory at /directory', async () => {
    renderApp('/directory')
    expect(await screen.findByRole('heading', { name: 'Speaker Directory' })).toBeInTheDocument()
  })

  it('renders the pipeline at /pipeline', async () => {
    renderApp('/pipeline')
    expect(await screen.findByRole('heading', { name: 'Speaker Pipeline' })).toBeInTheDocument()
  })

  it.each(['/crm', '/contacts', '/people', '/speaker-database'])(
    'sends %s to the directory instead of the submissions inbox',
    async (path) => {
      renderApp(path)
      expect(await screen.findByRole('heading', { name: 'Speaker Directory' })).toBeInTheDocument()
    }
  )

  it.each(['/sourcing', '/prospects'])('sends %s to the pipeline', async (path) => {
    renderApp(path)
    expect(await screen.findByRole('heading', { name: 'Speaker Pipeline' })).toBeInTheDocument()
  })

  it('lists the CRM section in the top-level navigation, outside any event', async () => {
    renderApp('/directory')
    await screen.findByRole('heading', { name: 'Speaker Directory' })

    const nav = screen.getByRole('navigation')
    expect(within(nav).getByText('CRM')).toBeInTheDocument()
    expect(within(nav).getByRole('link', { name: 'Directory' })).toHaveAttribute('href', '/directory')
    expect(within(nav).getByRole('link', { name: 'Pipeline' })).toHaveAttribute('href', '/pipeline')
  })
})
