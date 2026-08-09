/**
 * The public schedule page: it renders the published program, filters it
 * client-side, and — when embedded — drops its chrome and posts its height to
 * the parent iframe.
 */
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
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
          id: 'sess-1',
          friendly_id: 'SESS-1',
          title: 'Opening Keynote',
          description: '<p>Scaling frontier models.</p>',
          starts_at: '2026-10-12T16:00:00+00:00',
          ends_at: '2026-10-12T16:45:00+00:00',
          room: 'Main Hall',
          track: { name: 'Engineering', color: '#123456' },
          format: 'Keynote',
          speakers: [{ name: 'Zed Zeta', title: 'Staff Engineer', company: 'Zeta Corp', photo_url: null }],
        },
        {
          id: 'sess-2',
          friendly_id: 'SESS-2',
          title: 'Vector Databases',
          description: '<p>ANN internals.</p>',
          starts_at: '2026-10-12T17:00:00+00:00',
          ends_at: '2026-10-12T17:30:00+00:00',
          room: 'Room A',
          track: { name: 'Research', color: '#654321' },
          format: 'Talk',
          speakers: [{ name: 'Alice Alpha', title: null, company: null, photo_url: null }],
        },
      ],
    },
    {
      date: '2026-10-13',
      sessions: [
        {
          id: 'sess-3',
          friendly_id: 'SESS-3',
          title: 'Closing Notes',
          description: '<p>Wrap up.</p>',
          starts_at: '2026-10-13T16:00:00+00:00',
          ends_at: '2026-10-13T16:30:00+00:00',
          room: 'Main Hall',
          track: { name: 'Engineering', color: '#123456' },
          format: 'Talk',
          speakers: [{ name: 'Bob Beta', title: null, company: null, photo_url: null }],
        },
      ],
    },
  ],
}

const KEYNOTE_DETAIL = {
  event: { name: 'AI Builders Summit', timezone: 'UTC', location: 'San Francisco, CA' },
  session: {
    id: 'sess-1',
    friendly_id: 'SESS-1',
    title: 'Opening Keynote',
    description: '<p>Scaling frontier models across many thousands of GPUs.</p>',
    starts_at: '2026-10-12T16:00:00+00:00',
    ends_at: '2026-10-12T16:45:00+00:00',
    room: 'Main Hall',
    track: { name: 'Engineering', color: '#123456' },
    format: 'Keynote',
    speakers: [
      {
        name: 'Zed Zeta',
        title: 'Staff Engineer',
        company: 'Zeta Corp',
        photo_url: null,
        bio: 'Zed builds very large models.',
        linkedin_url: 'https://linkedin.com/in/zed',
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
      if (url.includes('/public/program/') && url.includes('/session/')) {
        return jsonResponse(KEYNOTE_DETAIL)
      }
      if (url.includes('/public/program/') && url.includes('/schedule')) {
        return jsonResponse(SCHEDULE)
      }
      return jsonResponse({}, 404)
    })
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  window.localStorage.clear()
})

/** The `<article data-testid="session-card">` that contains the given title. */
function cardFor(title: string): HTMLElement {
  const card = screen
    .getAllByTestId('session-card')
    .find((c) => within(c).queryByText(title))
  if (!card) throw new Error(`no session card for "${title}"`)
  return card
}

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

  it('searches across ALL days by title and by speaker name (EMB-02)', async () => {
    renderAt('/e/ai-builders-summit/schedule')
    await screen.findByText('Opening Keynote')
    // Day 1 is active, so a day-2 session is not initially shown.
    expect(screen.queryByText('Closing Notes')).not.toBeInTheDocument()

    // Title match on the inactive day 2 surfaces anyway.
    fireEvent.change(screen.getByLabelText('Search sessions'), { target: { value: 'closing' } })
    expect(await screen.findByText('Closing Notes')).toBeInTheDocument()
    expect(screen.queryByText('Opening Keynote')).not.toBeInTheDocument()

    // Speaker-name match on the inactive day 2 (Bob Beta speaks on Closing Notes).
    fireEvent.change(screen.getByLabelText('Search sessions'), { target: { value: 'bob' } })
    expect(await screen.findByText('Closing Notes')).toBeInTheDocument()
  })

  it('notes that times are shown in the event timezone', async () => {
    renderAt('/e/ai-builders-summit/schedule')
    await screen.findByText('Opening Keynote')
    expect(screen.getByText(/Times shown in UTC/)).toBeInTheDocument()
  })

  it('opens a session detail modal with the full description, speaker bio, and add-to-calendar (EMB-08)', async () => {
    renderAt('/e/ai-builders-summit/schedule')
    fireEvent.click(await screen.findByText('Opening Keynote'))

    // Full (un-clamped) description from the detail endpoint.
    expect(await screen.findByText(/Scaling frontier models across many thousands of GPUs/)).toBeInTheDocument()
    // Speaker bio, which the card list omits.
    expect(screen.getByText('Zed builds very large models.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /add to calendar/i })).toBeInTheDocument()
  })

  it('renders a Format tag on each session card (EMB-01)', async () => {
    renderAt('/e/ai-builders-summit/schedule')
    await screen.findByText('Opening Keynote')
    // The keynote card carries its format beside the track chip.
    expect(within(cardFor('Opening Keynote')).getByText('Keynote')).toBeInTheDocument()
    expect(within(cardFor('Vector Databases')).getByText('Talk')).toBeInTheDocument()
  })

  it('shows the format in the session detail modal', async () => {
    renderAt('/e/ai-builders-summit/schedule')
    fireEvent.click(await screen.findByText('Opening Keynote'))
    const dialog = await screen.findByTestId('session-detail-dialog')
    expect(await within(dialog).findByText('Keynote')).toBeInTheDocument()
  })

  it('stars a session, persists it to localStorage, and filters to "My schedule" (EMB-10/11)', async () => {
    renderAt('/e/ai-builders-summit/schedule')
    await screen.findByText('Opening Keynote')

    // Star the keynote via its card toggle.
    fireEvent.click(within(cardFor('Opening Keynote')).getByTestId('star-toggle'))

    // Persisted under a per-slug key so a different event never inherits it.
    await waitFor(() => {
      const raw = window.localStorage.getItem('dais.mySchedule.ai-builders-summit')
      expect(raw && JSON.parse(raw)).toContain('sess-1')
    })

    // "My schedule" now shows only the starred session, hiding the rest.
    fireEvent.click(screen.getByTestId('my-schedule-toggle'))
    expect(screen.getByText('Opening Keynote')).toBeInTheDocument()
    expect(screen.queryByText('Vector Databases')).not.toBeInTheDocument()
    expect(screen.queryByText('Closing Notes')).not.toBeInTheDocument()
  })

  it('loads a previously saved schedule from localStorage across days', async () => {
    // A star saved on an earlier visit — for a day-2 session — is restored.
    window.localStorage.setItem('dais.mySchedule.ai-builders-summit', JSON.stringify(['sess-3']))
    renderAt('/e/ai-builders-summit/schedule')
    await screen.findByText('Opening Keynote')

    fireEvent.click(screen.getByTestId('my-schedule-toggle'))
    // The day-2 session surfaces even though day 1 is the active tab.
    expect(await screen.findByText('Closing Notes')).toBeInTheDocument()
    expect(screen.queryByText('Opening Keynote')).not.toBeInTheDocument()
  })

  it('exports the starred sessions as a valid multi-event .ics', async () => {
    // Capture the .ics text the download would write. jsdom's Blob has no
    // .text(), so intercept the Blob parts at construction instead.
    let capturedIcs = ''
    class FakeBlob {
      constructor(parts: unknown[]) {
        capturedIcs = String(parts?.[0] ?? '')
      }
    }
    vi.stubGlobal('Blob', FakeBlob)
    ;(URL as unknown as { createObjectURL: unknown }).createObjectURL = vi.fn(() => 'blob:mock')
    ;(URL as unknown as { revokeObjectURL: unknown }).revokeObjectURL = vi.fn()
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})

    renderAt('/e/ai-builders-summit/schedule')
    await screen.findByText('Opening Keynote')

    fireEvent.click(within(cardFor('Opening Keynote')).getByTestId('star-toggle'))
    fireEvent.click(await screen.findByTestId('export-my-schedule'))

    await waitFor(() => expect(capturedIcs).toContain('BEGIN:VCALENDAR'))
    expect(capturedIcs).toContain('BEGIN:VEVENT')
    expect(capturedIcs).toContain('SUMMARY:Opening Keynote')
    expect(capturedIcs.trim().endsWith('END:VCALENDAR')).toBe(true)
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
