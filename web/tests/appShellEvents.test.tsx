import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { AppShell } from '@/shell/AppShell'

const CURRENT_EVENT = {
  id: 'event-current',
  name: 'DaisConf',
  slug: 'daisconf',
  starts_at: '2026-09-01T00:00:00Z',
  ends_at: '2026-09-02T00:00:00Z',
  timezone: 'UTC',
  location: 'Toronto',
}

const ORIGINAL_TZ = process.env.TZ

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function renderShell() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <MemoryRouter initialEntries={['/dashboard']}>
      <QueryClientProvider client={queryClient}>
        <Routes>
          <Route element={<AppShell />}>
            <Route path="/dashboard" element={<p>Dashboard content</p>} />
          </Route>
        </Routes>
      </QueryClientProvider>
    </MemoryRouter>
  )
}

describe('AppShell event switcher', () => {
  let posts: Array<Record<string, unknown>>

  beforeEach(() => {
    posts = []
    window.localStorage.setItem('dais.token', 'test-token')
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        const method = init?.method ?? 'GET'
        if (url.endsWith('/api/events') && method === 'GET') {
          return jsonResponse({ events: [CURRENT_EVENT] })
        }
        if (url.endsWith('/api/events') && method === 'POST') {
          posts.push(JSON.parse(String(init?.body ?? '{}')))
          return jsonResponse(
            {
              event: {
                id: 'event-new',
                name: 'Builder Summit',
                slug: 'builder-summit',
                ...posts[0],
              },
            },
            201
          )
        }
        return jsonResponse({}, 404)
      })
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    window.localStorage.clear()
    process.env.TZ = ORIGINAL_TZ
  })

  it('renders the event range in the event timezone, not the viewer timezone', async () => {
    process.env.TZ = 'America/New_York'
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          events: [
            {
              ...CURRENT_EVENT,
              starts_at: '2026-10-12T07:00:00.000Z',
              ends_at: '2026-10-14T06:59:59.999Z',
              timezone: 'America/Los_Angeles',
            },
          ],
        })
      )
    )

    renderShell()

    expect(await screen.findByText('Oct 12 – Oct 13, 2026')).toBeInTheDocument()
    expect(screen.queryByText('Oct 12 – Oct 14, 2026')).not.toBeInTheDocument()
  })

  it('focuses Find or ask with /', async () => {
    renderShell()

    const search = await screen.findByLabelText('Find or ask')
    expect(search).not.toHaveFocus()
    fireEvent.keyDown(window, { key: '/' })
    expect(search).toHaveFocus()
  })

  it('creates a dated event from the switcher and selects it', async () => {
    renderShell()
    const switcher = await screen.findByRole('button', { name: /DaisConf/ })
    fireEvent.keyDown(switcher, { key: 'Enter', code: 'Enter' })
    fireEvent.click(await screen.findByRole('menuitem', { name: 'New event' }))

    const dialog = await screen.findByRole('dialog')
    fireEvent.change(within(dialog).getByLabelText(/Name/), {
      target: { value: 'Builder Summit' },
    })
    fireEvent.change(within(dialog).getByLabelText('Start date'), {
      target: { value: '2027-05-01' },
    })
    fireEvent.change(within(dialog).getByLabelText('End date'), {
      target: { value: '2027-05-03' },
    })
    fireEvent.change(within(dialog).getByLabelText('Timezone'), {
      target: { value: 'UTC' },
    })
    fireEvent.change(within(dialog).getByLabelText('Location'), {
      target: { value: 'Metro Convention Centre' },
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create event' }))

    await waitFor(() => expect(posts).toHaveLength(1))
    expect(posts[0]).toMatchObject({
      name: 'Builder Summit',
      timezone: 'UTC',
      location: 'Metro Convention Centre',
    })
    expect(String(posts[0].starts_at)).toContain('2027-05-01')
    expect(String(posts[0].ends_at)).toContain('2027-05-03')
    expect(await screen.findByRole('button', { name: /Builder Summit/ })).toBeInTheDocument()
    expect(window.localStorage.getItem('dais.active-event-id')).toBe('event-new')
  })
})
