/**
 * The public speakers gallery: it renders the announced lineup, filters it by a
 * client-side keyword search (EMB-05/12), and opens a per-speaker dialog with
 * bio + sessions.
 */
import { render, screen, fireEvent, within } from '@testing-library/react'
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
        {
          id: 'sess-2',
          title: 'RAG in Production',
          starts_at: '2026-10-12T17:00:00+00:00',
          room: 'Room A',
          format: 'Talk',
        },
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

const SESSION_DETAIL = {
  event: { name: 'AI Builders Summit', timezone: 'UTC', location: 'San Francisco, CA' },
  session: {
    id: 'sess-2',
    friendly_id: 'SESS-2',
    title: 'RAG in Production',
    description: '<p>Retrieval pipelines that survive real traffic.</p>',
    starts_at: '2026-10-12T17:00:00+00:00',
    ends_at: '2026-10-12T17:30:00+00:00',
    room: 'Room A',
    track: { name: 'Research', color: '#654321' },
    format: 'Talk',
    speakers: [
      {
        name: 'Alice Alpha',
        title: 'CTO',
        company: 'Alpha Corp',
        photo_url: null,
        bio: 'Alice builds retrieval systems.',
        linkedin_url: null,
        twitter_url: null,
      },
    ],
  },
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
      if (url.includes('/public/program/') && url.includes('/session/')) {
        return jsonResponse(SESSION_DETAIL)
      }
      if (url.includes('/public/program/') && url.includes('/speakers')) {
        return jsonResponse(SPEAKERS)
      }
      return jsonResponse({}, 404)
    })
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
  window.localStorage.clear()
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

  it('counts the speakers a search matches (EMB-05/12)', async () => {
    renderAt('/e/ai-builders-summit/speakers')
    await screen.findByText('Alice Alpha')

    // No query → no count.
    expect(screen.queryByTestId('speaker-result-count')).not.toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('Search speakers'), { target: { value: 'a' } })
    expect(screen.getByTestId('speaker-result-count')).toHaveTextContent('2 speakers match')

    fireEvent.change(screen.getByLabelText('Search speakers'), { target: { value: 'alpha' } })
    expect(screen.getByTestId('speaker-result-count')).toHaveTextContent('1 speaker matches')

    fireEvent.change(screen.getByLabelText('Search speakers'), { target: { value: 'zzzz' } })
    expect(screen.getByTestId('speaker-result-count')).toHaveTextContent('0 speakers match')
  })

  it('opens a speaker dialog with bio and their sessions', async () => {
    renderAt('/e/ai-builders-summit/speakers')
    fireEvent.click(await screen.findByText('Alice Alpha'))

    expect(await screen.findByText('Alice builds retrieval systems.')).toBeInTheDocument()
    expect(screen.getByText('RAG in Production')).toBeInTheDocument()
  })

  it("opens the session detail modal from a speaker's session (EMB-08)", async () => {
    renderAt('/e/ai-builders-summit/speakers')
    fireEvent.click(await screen.findByText('Alice Alpha'))

    // The speaker's session is an actionable row; clicking it opens the modal.
    fireEvent.click(await screen.findByTestId('speaker-session'))

    const dialog = await screen.findByTestId('session-detail-dialog')
    expect(
      await within(dialog).findByText(/Retrieval pipelines that survive real traffic/)
    ).toBeInTheDocument()
    // The modal offers add-to-calendar and the personal-schedule star.
    expect(within(dialog).getByRole('button', { name: /add to calendar/i })).toBeInTheDocument()
    expect(within(dialog).getByTestId('star-toggle-modal')).toBeInTheDocument()
  })
})
