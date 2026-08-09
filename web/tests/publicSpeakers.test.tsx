/**
 * The public speakers gallery: it renders the announced lineup, filters it by a
 * client-side keyword search (EMB-05/12), and opens a per-speaker dialog with
 * bio + sessions.
 */
import { render, screen, fireEvent } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { PublicSpeakers } from '@/pages/PublicSpeakers'

const SPEAKERS = {
  event: { name: 'AI Builders Summit', timezone: 'UTC' },
  speakers: [
    {
      name: 'Alice Alpha',
      title: 'CTO',
      company: 'Alpha Corp',
      photo_url: null,
      bio: 'Alice builds retrieval systems.',
      linkedin_url: 'https://linkedin.com/in/alice',
      twitter_url: null,
      sessions: [
        { title: 'RAG in Production', starts_at: '2026-10-12T17:00:00+00:00', room: 'Room A' },
      ],
    },
    {
      name: 'Bob Beta',
      title: 'Engineer',
      company: 'Beta Inc',
      photo_url: null,
      bio: null,
      linkedin_url: null,
      twitter_url: null,
      sessions: [],
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
          <Route path="/e/:slug/speakers" element={<PublicSpeakers />} />
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
      if (url.includes('/public/program/') && url.includes('/speakers')) {
        return jsonResponse(SPEAKERS)
      }
      return jsonResponse({}, 404)
    })
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('PublicSpeakers', () => {
  it('renders the speaker gallery and site chrome', async () => {
    renderAt('/e/ai-builders-summit/speakers')
    expect(await screen.findByText('Alice Alpha')).toBeInTheDocument()
    expect(screen.getByText('Bob Beta')).toBeInTheDocument()
    expect(screen.getByText('Powered by dais')).toBeInTheDocument()
  })

  it('filters speakers by keyword across name, company and title (EMB-05/12)', async () => {
    renderAt('/e/ai-builders-summit/speakers')
    await screen.findByText('Alice Alpha')

    // Match by company.
    fireEvent.change(screen.getByLabelText('Search speakers'), { target: { value: 'beta inc' } })
    expect(screen.getByText('Bob Beta')).toBeInTheDocument()
    expect(screen.queryByText('Alice Alpha')).not.toBeInTheDocument()

    // Match by title.
    fireEvent.change(screen.getByLabelText('Search speakers'), { target: { value: 'cto' } })
    expect(screen.getByText('Alice Alpha')).toBeInTheDocument()
    expect(screen.queryByText('Bob Beta')).not.toBeInTheDocument()

    // No matches → empty state.
    fireEvent.change(screen.getByLabelText('Search speakers'), { target: { value: 'zzzz' } })
    expect(screen.getByText('No speakers match')).toBeInTheDocument()
  })

  it('opens a speaker dialog with bio and their sessions', async () => {
    renderAt('/e/ai-builders-summit/speakers')
    fireEvent.click(await screen.findByText('Alice Alpha'))

    expect(await screen.findByText('Alice builds retrieval systems.')).toBeInTheDocument()
    expect(screen.getByText('RAG in Production')).toBeInTheDocument()
  })
})
