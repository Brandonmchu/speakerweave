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
      id: 'c-alice',
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
          track: { name: 'Research', color: '#654321' },
          format: 'Talk',
        },
      ],
    },
    {
      id: 'c-bob',
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

/** A gallery payload whose speaker list is whatever `speakers` says it is. */
function galleryOf(speakers: unknown[]) {
  return { event: { name: 'AI Builders Summit', timezone: 'UTC' }, speakers }
}

function speakerRow(overrides: Record<string, unknown>) {
  return {
    id: null,
    name: 'Priya Raman',
    title: 'Principal Engineer',
    company: 'Latticework Systems',
    photo_url: null,
    bio: null,
    linkedin_url: null,
    twitter_url: null,
    sessions: [],
    ...overrides,
  }
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

/** The gallery payload this test wants back; reset to SPEAKERS each time. */
let gallery: unknown

beforeEach(() => {
  gallery = SPEAKERS
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/public/program/') && url.includes('/session/')) {
        return jsonResponse(SESSION_DETAIL)
      }
      if (url.includes('/public/program/') && url.includes('/speakers')) {
        return jsonResponse(gallery)
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
    expect(screen.getByText('Powered by SpeakerWeave')).toBeInTheDocument()
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

  it('pre-filters speakers to people with a session in the requested track', async () => {
    renderAt('/e/ai-builders-summit/speakers?track=Research')

    expect(await screen.findByText('Alice Alpha')).toBeInTheDocument()
    expect(screen.queryByText('Bob Beta')).not.toBeInTheDocument()
    expect(screen.getByTestId('speaker-result-count')).toHaveTextContent('1 speaker')
  })

  it('counts the speakers a search matches (EMB-05/12)', async () => {
    renderAt('/e/ai-builders-summit/speakers')
    await screen.findByText('Alice Alpha')

    // No query → the count states the size of the whole lineup.
    expect(screen.getByTestId('speaker-result-count')).toHaveTextContent('2 speakers')

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

  it('shows a bio Show more that expands in place (EMB-12/13)', async () => {
    const long = `${'Priya has spent a decade shrinking build times. '.repeat(12)}End of bio.`
    gallery = galleryOf([speakerRow({ id: 'c-priya', bio: long })])
    renderAt('/e/ai-builders-summit/speakers')
    fireEvent.click(await screen.findByText('Priya Raman'))

    const toggle = await screen.findByTestId('speaker-bio-toggle')
    expect(screen.getByTestId('speaker-bio').textContent ?? '').not.toContain('End of bio.')

    fireEvent.click(toggle)
    expect(screen.getByTestId('speaker-bio').textContent).toContain('End of bio.')
    expect(screen.getByTestId('speaker-bio-toggle')).toHaveTextContent('Show less')

    fireEvent.click(screen.getByTestId('speaker-bio-toggle'))
    expect(screen.getByTestId('speaker-bio').textContent ?? '').not.toContain('End of bio.')
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

/**
 * The count and the cards are one list or they are a bug.
 *
 * The defect this covers: searching "Priya Raman" reported "2 speakers match"
 * above three rendered cards. The list was keyed by display name, so duplicate
 * names produced duplicate React keys and a stale card survived the filter.
 */
describe('PublicSpeakers → count/card consistency (EMB-12)', () => {
  const countOf = () => Number((screen.getByTestId('speaker-result-count').textContent ?? '').match(/\d+/)?.[0])
  const cards = () => screen.getAllByTestId('speaker-card')

  it('renders exactly as many cards as the count claims, before and after a search', async () => {
    gallery = galleryOf([
      speakerRow({ id: 'c-1', name: 'Priya Raman', company: 'Latticework Systems' }),
      speakerRow({ id: 'c-2', name: 'Priya Raman', company: 'Northwind Labs' }),
      speakerRow({ id: 'c-3', name: 'Priya Ramanathan', company: 'Helio' }),
      speakerRow({ id: 'c-4', name: 'Marcus Okafor', company: 'Northwind Labs' }),
    ])
    renderAt('/e/ai-builders-summit/speakers')
    await screen.findByText('Marcus Okafor')

    expect(countOf()).toBe(cards().length)
    expect(cards()).toHaveLength(4)

    fireEvent.change(screen.getByLabelText('Search speakers'), {
      target: { value: 'Priya Raman' },
    })
    expect(cards()).toHaveLength(3) // Raman ×2 + Ramanathan
    expect(countOf()).toBe(3)

    fireEvent.change(screen.getByLabelText('Search speakers'), { target: { value: 'Okafor' } })
    expect(cards()).toHaveLength(1)
    expect(countOf()).toBe(1)

    // Clearing restores every card, and the count follows.
    fireEvent.change(screen.getByLabelText('Search speakers'), { target: { value: '' } })
    expect(cards()).toHaveLength(4)
    expect(countOf()).toBe(4)
  })

  it('renders one card per contact even when the same contact arrives twice', async () => {
    gallery = galleryOf([
      speakerRow({ id: 'c-priya', name: 'Priya Raman' }),
      speakerRow({ id: 'c-priya', name: 'Priya Raman' }), // same contact, duplicated row
      speakerRow({ id: 'c-marcus', name: 'Marcus Okafor', company: 'Northwind Labs' }),
    ])
    renderAt('/e/ai-builders-summit/speakers')
    await screen.findByText('Marcus Okafor')

    expect(cards()).toHaveLength(2)
    expect(screen.getAllByText('Priya Raman')).toHaveLength(1)
    expect(countOf()).toBe(2)
  })

  it('merges two contacts that share a name AND company into one card', async () => {
    gallery = galleryOf([
      speakerRow({
        id: 'c-priya-manual',
        name: 'Priya Raman',
        company: 'Latticework Systems',
        sessions: [
          { id: 'sess-a', title: 'Taming 40-Minute CI', starts_at: '2027-05-12T17:00:00+00:00', room: 'Room 2A', format: 'Talk' },
        ],
      }),
      speakerRow({
        id: 'c-priya-import',
        name: '  priya   raman ', // same human, sloppier data
        company: 'Latticework Systems',
        bio: 'Builds CI at scale.',
        sessions: [
          { id: 'sess-b', title: 'Monorepo Q&A', starts_at: '2027-05-13T17:00:00+00:00', room: 'Room 3B', format: 'Panel' },
        ],
      }),
    ])
    renderAt('/e/ai-builders-summit/speakers')
    await screen.findByText('Priya Raman')

    expect(cards()).toHaveLength(1)
    expect(countOf()).toBe(1)

    // The single card owns BOTH of their sessions, and the richer bio survived.
    fireEvent.click(screen.getByText('Priya Raman'))
    expect(await screen.findByText('Builds CI at scale.')).toBeInTheDocument()
    expect(screen.getByText('Sessions (2)')).toBeInTheDocument()
    expect(screen.getByText('Taming 40-Minute CI')).toBeInTheDocument()
    expect(screen.getByText('Monorepo Q&A')).toBeInTheDocument()
  })

  it('keeps same-name speakers from different companies as separate, labelled cards', async () => {
    gallery = galleryOf([
      speakerRow({ id: 'c-1', name: 'Priya Raman', company: 'Latticework Systems' }),
      speakerRow({ id: 'c-2', name: 'Priya Raman', company: 'Northwind Labs', title: 'Staff SRE' }),
    ])
    renderAt('/e/ai-builders-summit/speakers')
    await screen.findByText(/Northwind Labs/)

    // Two different people: two cards, told apart by company on the card itself.
    expect(cards()).toHaveLength(2)
    expect(countOf()).toBe(2)
    expect(screen.getByText(/Latticework Systems/)).toBeInTheDocument()
    expect(screen.getByText(/Northwind Labs/)).toBeInTheDocument()
  })

  it('offers a list view distinct from the photo grid, over the same filtered set', async () => {
    gallery = galleryOf([
      speakerRow({
        id: 'c-priya',
        name: 'Priya Raman',
        sessions: [
          { id: 'sess-a', title: 'Taming 40-Minute CI', starts_at: '2027-05-12T17:00:00+00:00', room: 'Room 2A', format: 'Talk' },
        ],
      }),
      speakerRow({ id: 'c-marcus', name: 'Marcus Okafor', company: 'Northwind Labs' }),
    ])
    renderAt('/e/ai-builders-summit/speakers')
    await screen.findByText('Marcus Okafor')

    // Default: the photo grid.
    expect(screen.getByTestId('speaker-gallery-grid')).toBeInTheDocument()
    expect(screen.queryByTestId('speaker-directory-list')).not.toBeInTheDocument()

    fireEvent.click(screen.getByTestId('speaker-view-list'))
    expect(screen.getByTestId('speaker-directory-list')).toBeInTheDocument()
    expect(screen.queryByTestId('speaker-gallery-grid')).not.toBeInTheDocument()
    // The directory pairs each person with their sessions (EMB-04).
    expect(screen.getByText('Sessions (1)')).toBeInTheDocument()
    expect(screen.getByText(/Taming 40-Minute CI/)).toBeInTheDocument()

    // The search still governs both the cards and the count in this view.
    fireEvent.change(screen.getByLabelText('Search speakers'), { target: { value: 'Okafor' } })
    expect(cards()).toHaveLength(1)
    expect(countOf()).toBe(1)
  })

  it('deep-links the list view with ?view=list', async () => {
    gallery = galleryOf([speakerRow({ id: 'c-priya' })])
    renderAt('/e/ai-builders-summit/speakers?view=list')
    await screen.findByText('Priya Raman')

    expect(screen.getByTestId('speaker-directory-list')).toBeInTheDocument()
  })
})
