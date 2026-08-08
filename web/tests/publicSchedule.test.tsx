/**
 * The public schedule page: it renders the published program, filters it
 * client-side, and — when embedded — drops its chrome and posts its height to
 * the parent iframe.
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { PublicSchedule } from '@/pages/PublicSchedule'

const SCHEDULE = {
  event: {
    name: 'AI Builders Summit',
    starts_at: '2026-10-12T16:00:00+00:00',
    ends_at: '2026-10-13T18:00:00+00:00',
    timezone: 'UTC',
    location: 'San Francisco, CA',
  },
  days: [
    {
      date: '2026-10-12',
      sessions: [
        {
          friendly_id: 'SESS-1',
          title: 'Opening Keynote',
          description: '<p>Scaling frontier models.</p>',
          starts_at: '2026-10-12T16:00:00+00:00',
          ends_at: '2026-10-12T16:45:00+00:00',
          room: 'Main Hall',
          track: { name: 'Engineering', color: '#123456' },
          speakers: [{ name: 'Zed Zeta', title: 'Staff Engineer', company: 'Zeta Corp', photo_url: null }],
        },
        {
          friendly_id: 'SESS-2',
          title: 'Vector Databases',
          description: '<p>ANN internals.</p>',
          starts_at: '2026-10-12T17:00:00+00:00',
          ends_at: '2026-10-12T17:30:00+00:00',
          room: 'Room A',
          track: { name: 'Research', color: '#654321' },
          speakers: [{ name: 'Alice Alpha', title: null, company: null, photo_url: null }],
        },
      ],
    },
    {
      date: '2026-10-13',
      sessions: [
        {
          friendly_id: 'SESS-3',
          title: 'Closing Notes',
          description: '<p>Wrap up.</p>',
          starts_at: '2026-10-13T16:00:00+00:00',
          ends_at: '2026-10-13T16:30:00+00:00',
          room: 'Main Hall',
          track: { name: 'Engineering', color: '#123456' },
          speakers: [{ name: 'Bob Beta', title: null, company: null, photo_url: null }],
        },
      ],
    },
  ],
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function renderAt(path: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <MemoryRouter initialEntries={[path]}>
      <QueryClientProvider client={queryClient}>
        <Routes>
          <Route path="/e/:slug/schedule" element={<PublicSchedule />} />
        </Routes>
      </QueryClientProvider>
    </MemoryRouter>
  )
}

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/public/program/') && url.includes('/schedule')) {
        return jsonResponse(SCHEDULE)
      }
      return jsonResponse({}, 404)
    })
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('PublicSchedule', () => {
  it('renders sessions with their speakers and the site chrome', async () => {
    renderAt('/e/ai-builders-summit/schedule')
    expect(await screen.findByText('Opening Keynote')).toBeInTheDocument()
    expect(screen.getByText('Zed Zeta')).toBeInTheDocument()
    expect(screen.getByText('Vector Databases')).toBeInTheDocument()
    // Track filter + public chrome are present.
    expect(screen.getByText('All tracks')).toBeInTheDocument()
    expect(screen.getByText('Powered by dais')).toBeInTheDocument()
    expect(screen.getByText('San Francisco, CA')).toBeInTheDocument()
  })

  it('filters the visible day by keyword search', async () => {
    renderAt('/e/ai-builders-summit/schedule')
    await screen.findByText('Opening Keynote')

    fireEvent.change(screen.getByLabelText('Search sessions'), { target: { value: 'vector' } })

    expect(screen.getByText('Vector Databases')).toBeInTheDocument()
    expect(screen.queryByText('Opening Keynote')).not.toBeInTheDocument()
  })

  it('in embed mode drops the chrome and posts its height to the parent', async () => {
    Object.defineProperty(document.documentElement, 'scrollHeight', {
      configurable: true,
      value: 900,
    })
    const postMessage = vi.spyOn(window.parent, 'postMessage')

    renderAt('/e/ai-builders-summit/schedule?embed=1')
    await screen.findByText('Opening Keynote')

    // Chrome-less: no site footer/brand.
    expect(screen.queryByText('Powered by dais')).not.toBeInTheDocument()
    await waitFor(() =>
      expect(postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'dais-embed-height' }),
        '*'
      )
    )
  })
})
