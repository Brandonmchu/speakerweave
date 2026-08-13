import { render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import App from '@/App'

/** URL prefix → JSON payload. First match wins; unmatched paths 404. */
type Routes = Array<[string, unknown]>

function stubFetch(routes: Routes) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const path = String(url)
      for (const [prefix, payload] of routes) {
        if (path.startsWith(prefix)) {
          return new Response(JSON.stringify(payload), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        }
      }
      return new Response(JSON.stringify({ detail: 'not found' }), { status: 404 })
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

describe('organizer form-builder routes', () => {
  beforeEach(() => {
    window.localStorage.setItem('dais.token', 'test-token')
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    window.localStorage.clear()
  })

  it('sends an org with no event to onboarding', async () => {
    stubFetch([['/api/events', { events: [] }]])
    renderApp('/forms')
    expect(await screen.findByRole('heading', { name: 'Create your event' })).toBeInTheDocument()
  })

  it('renders the forms list once an event exists', async () => {
    stubFetch([
      ['/api/events/evt-1/forms', { forms: [] }],
      ['/api/events', { events: [{ id: 'evt-1', name: 'Summit', slug: 'summit' }] }],
    ])
    renderApp('/forms')
    expect(await screen.findByRole('heading', { name: 'Forms' })).toBeInTheDocument()
    expect(await screen.findByText('No forms yet')).toBeInTheDocument()
  })

  it('renders a form in the editor with its questions', async () => {
    stubFetch([
      [
        '/api/forms/form-1',
        {
          form: { id: 'form-1', slug: 'cfp', name: 'Call for Speakers', settings: {} },
          fields: [
            {
              form_field_id: 'ff-1',
              field_id: 'fld-1',
              page: 3,
              order: 1,
              required: true,
              public_name: 'Session abstract',
              field_type: 'textarea',
            },
          ],
          question_rules: [],
        },
      ],
      ['/api/events', { events: [{ id: 'evt-1', name: 'Summit', slug: 'summit' }] }],
    ])
    renderApp('/forms/form-1')
    expect(await screen.findByRole('heading', { name: 'Call for Speakers' })).toBeInTheDocument()
    expect(await screen.findByText('Session abstract')).toBeInTheDocument()
    expect(screen.getByText('Page 3 · Your session')).toBeInTheDocument()
  })

  it('renders event settings and the taxonomy sections', async () => {
    stubFetch([
      ['/api/events/evt-1/tracks', { tracks: [{ id: 't1', name: 'AI Engineering', color: '#4F46E5' }] }],
      ['/api/events/evt-1/rooms', { rooms: [] }],
      ['/api/events/evt-1/formats', { formats: [] }],
      ['/api/events/evt-1/levels', { levels: [] }],
      ['/api/events/evt-1/tags', { tags: [] }],
      ['/api/events', { events: [{ id: 'evt-1', name: 'Summit', slug: 'summit' }] }],
    ])
    renderApp('/settings/vocabulary')
    expect(await screen.findByRole('heading', { name: 'Settings' })).toBeInTheDocument()
    expect(await screen.findByText('AI Engineering')).toBeInTheDocument()
    for (const section of ['Tracks', 'Rooms', 'Formats', 'Levels', 'Tags']) {
      expect(screen.getByRole('heading', { name: section })).toBeInTheDocument()
    }
  })
})
