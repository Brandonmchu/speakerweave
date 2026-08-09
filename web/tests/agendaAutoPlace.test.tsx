/**
 * "Auto-place remaining" — the one-action fill of the unscheduled tray.
 *
 * The interesting behaviour is not the request; it is what surrounds it. The
 * affordance has to announce how much work is left (a button that says
 * "Auto-place remaining" with no number is a dare), the board has to be REREAD
 * afterwards rather than guessed at — the server chose the slots, so the client
 * has nothing to optimistically apply — and the run's outcome has to survive on
 * screen, because the half that matters is what could NOT be placed and why.
 *
 * Placement itself (which slot, in which room, on which day, without creating a
 * conflict) is the server's job and is pinned down in api/tests/test_auto_place.py
 * against the shared rule engine.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { Agenda } from '@/pages/Agenda'
import { autoPlaceSchedule } from '@/lib/scheduleApi'
import { Toaster } from '@/ui/toaster'

const EVENT = { id: 'event-1', name: 'DaisConf', slug: 'daisconf' }

const AGENDA = {
  event: {
    id: 'event-1',
    name: 'DaisConf',
    slug: 'daisconf',
    timezone: 'America/Los_Angeles',
    starts_at: '2026-10-12T08:00:00-07:00',
    day_start: '09:00:00',
    day_end: '17:00:00',
    slot_minutes: 15,
  },
  rooms: [
    { id: 'room-a', name: 'Auditorium', capacity: 250, order: 0 },
    { id: 'room-b', name: 'Studio', capacity: null, order: 1 },
  ],
  tracks: [{ id: 'track-1', name: 'Platform', color: '#4F46E5' }],
  sessions: [
    {
      id: 'sess-1',
      title: 'Shipping on Fridays',
      status: 'accepted',
      starts_at: '2026-10-12T09:00:00-07:00',
      ends_at: '2026-10-12T10:00:00-07:00',
      room_id: 'room-a',
      track_id: 'track-1',
      duration_min: 60,
      speakers: [{ contact_id: 'c-1', first_name: 'Marie', last_name: 'Curie' }],
    },
    {
      id: 'sess-2',
      title: 'Postgres for Programme Chairs',
      status: 'accepted',
      starts_at: null,
      ends_at: null,
      room_id: null,
      track_id: 'track-1',
      duration_min: 30,
      speakers: [{ contact_id: 'c-2', first_name: 'Katherine', last_name: 'Johnson' }],
    },
    {
      id: 'sess-3',
      title: 'Waiting in the Wings',
      status: 'pending',
      starts_at: null,
      ends_at: null,
      room_id: null,
      track_id: null,
      duration_min: 600,
      speakers: [],
    },
  ],
}

/** The board the server returns after the run: sess-2 is now on the grid. */
const AGENDA_AFTER = {
  ...AGENDA,
  sessions: AGENDA.sessions.map((session) =>
    session.id === 'sess-2'
      ? {
          ...session,
          starts_at: '2026-10-12T17:00:00+00:00',
          ends_at: '2026-10-12T17:30:00+00:00',
          room_id: 'room-b',
        }
      : session
  ),
}

const AUTO_PLACE_RESULT = {
  placed: [
    {
      id: 'sess-2',
      title: 'Postgres for Programme Chairs',
      room_id: 'room-b',
      starts_at: '2026-10-12T17:00:00+00:00',
      ends_at: '2026-10-12T17:30:00+00:00',
    },
  ],
  skipped: [
    {
      id: 'sess-3',
      title: 'Waiting in the Wings',
      reason: '600 min is longer than the 09:00–17:00 day.',
    },
  ],
}

interface Call {
  url: string
  method: string
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

/**
 * Records every request and swaps the agenda payload once auto-place has run —
 * so "did it refetch the board" is answered by the board itself changing, not
 * by counting calls.
 */
function stubApi(options: { autoPlace?: () => Response } = {}): Call[] {
  const calls: Call[] = []
  let placed = false

  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input)
      const method = init.method ?? 'GET'
      calls.push({ url, method })

      if (method === 'POST' && url.includes('/schedule/auto-place')) {
        if (options.autoPlace) return options.autoPlace()
        placed = true
        return jsonResponse(AUTO_PLACE_RESULT)
      }
      if (url.endsWith('/api/events')) return jsonResponse({ events: [EVENT] })
      // Longest path first — /agenda is a prefix of /agenda/conflicts.
      if (url.includes('/agenda/conflicts')) return jsonResponse({ conflicts: [] })
      if (url.includes('/agenda')) return jsonResponse(placed ? AGENDA_AFTER : AGENDA)
      return jsonResponse({}, 404)
    })
  )
  return calls
}

function renderAgenda({ withToaster = false } = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <MemoryRouter>
      <QueryClientProvider client={queryClient}>
        <Agenda />
        {withToaster && <Toaster />}
      </QueryClientProvider>
    </MemoryRouter>
  )
}

describe('Auto-place remaining', () => {
  beforeEach(() => {
    window.localStorage.setItem('dais.token', 'test-token')
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    window.localStorage.clear()
  })

  it('offers the action with the number of sessions still in the tray', async () => {
    stubApi()
    renderAgenda()

    const button = await screen.findByTestId('auto-place')
    expect(button).toHaveTextContent('Auto-place remaining (2)')
  })

  it('is not offered once everything is on the grid', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url.endsWith('/api/events')) return jsonResponse({ events: [EVENT] })
        if (url.includes('/agenda/conflicts')) return jsonResponse({ conflicts: [] })
        if (url.includes('/agenda')) {
          return jsonResponse({ ...AGENDA, sessions: [AGENDA.sessions[0]] })
        }
        return jsonResponse({}, 404)
      })
    )
    renderAgenda()

    await screen.findByText('Shipping on Fridays')
    expect(screen.queryByTestId('auto-place')).not.toBeInTheDocument()
  })

  it('places the tray, rereads the board and reports what it did', async () => {
    const calls = stubApi()
    renderAgenda({ withToaster: true })

    fireEvent.click(await screen.findByTestId('auto-place'))

    // One POST to the event's auto-place endpoint — no per-session PATCHes; the
    // server placed them all in a single action.
    await waitFor(() =>
      expect(
        calls.filter(
          (call) => call.method === 'POST' && call.url.includes('/schedule/auto-place')
        )
      ).toHaveLength(1)
    )
    expect(calls.some((call) => call.method === 'PATCH')).toBe(false)
    expect(
      calls.find((call) => call.url.includes('/schedule/auto-place'))?.url
    ).toContain('/api/events/event-1/schedule/auto-place')

    // The board was reread: the placed session is now on the grid at the slot
    // the server chose (17:00 UTC = 10:00 in the event zone) and the header's
    // tray count has dropped.
    const summary = await screen.findByTestId('auto-place-summary')
    expect(summary).toHaveAttribute('data-placed', '1')
    expect(summary).toHaveAttribute('data-skipped', '1')
    await waitFor(() =>
      expect(screen.getByText('2 scheduled · 1 unscheduled')).toBeInTheDocument()
    )
    expect(await screen.findByText(/10:00 – 10:30/)).toBeInTheDocument()

    // And the skipped session is still named, with the reason it stayed put.
    const skipped = within(summary).getByTestId('auto-place-skipped-sess-3')
    expect(skipped).toHaveTextContent('Waiting in the Wings')
    expect(skipped).toHaveTextContent('600 min is longer than the 09:00–17:00 day.')

    // The same headline lands as a toast for anyone not looking at the panel.
    expect(await screen.findByText('Placed 1 session, skipped 1')).toBeInTheDocument()
  })

  it('keeps offering the action for whatever is still unplaced', async () => {
    stubApi()
    renderAgenda()

    fireEvent.click(await screen.findByTestId('auto-place'))

    // sess-3 could not be placed, so the button stays — with the count that is
    // actually left, not the one it started with.
    await waitFor(() =>
      expect(screen.getByTestId('auto-place')).toHaveTextContent('Auto-place remaining (1)')
    )
  })

  it('can be dismissed once the organizer has read it', async () => {
    stubApi()
    renderAgenda()

    fireEvent.click(await screen.findByTestId('auto-place'))
    fireEvent.click(await screen.findByTestId('auto-place-dismiss'))

    expect(screen.queryByTestId('auto-place-summary')).not.toBeInTheDocument()
  })

  it('leaves the board alone when the run fails', async () => {
    stubApi({ autoPlace: () => jsonResponse({ detail: 'Nope' }, 500) })
    renderAgenda()

    fireEvent.click(await screen.findByTestId('auto-place'))

    await waitFor(() =>
      expect(screen.queryByTestId('auto-place-summary')).not.toBeInTheDocument()
    )
    // The tray is untouched and the action is still there to retry.
    expect(screen.getByText('1 scheduled · 2 unscheduled')).toBeInTheDocument()
    expect(screen.getByTestId('auto-place')).toBeInTheDocument()
  })
})

describe('autoPlaceSchedule', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    window.localStorage.clear()
  })

  it('posts to the event and normalises a payload missing either list', async () => {
    window.localStorage.setItem('dais.token', 'test-token')
    const seen: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        seen.push(String(input))
        return jsonResponse({ placed: [{ id: 'a', room_id: 'r', starts_at: 's', ends_at: 'e' }] })
      })
    )

    const result = await autoPlaceSchedule('event 1')

    expect(seen[0]).toContain('/api/events/event%201/schedule/auto-place')
    expect(result.placed).toHaveLength(1)
    // A response without `skipped` is an empty tray of skips, never undefined —
    // the caller renders `.length` straight away.
    expect(result.skipped).toEqual([])
  })
})
