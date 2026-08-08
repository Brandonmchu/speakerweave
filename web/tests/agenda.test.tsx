/**
 * The agenda grid, on real event data.
 *
 * The page used to render five hardcoded sessions in two hardcoded rooms
 * regardless of the event, so the thing worth pinning down is that every column,
 * card, chip and conflict on screen now came out of the API — and that an event
 * with nothing accepted says so instead of drawing an empty lattice.
 */
import { render, screen, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { Agenda } from '@/pages/Agenda'

const EVENT = { id: 'event-1', name: 'DaisConf', slug: 'daisconf' }

const AGENDA = {
  event: {
    id: 'event-1',
    name: 'DaisConf',
    timezone: 'America/Los_Angeles',
    starts_at: '2026-10-12T09:00:00+00:00',
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
      friendly_id: 'SESS-1',
      title: 'Shipping on Fridays',
      status: 'accepted',
      starts_at: '2026-10-12T09:00:00+00:00',
      ends_at: '2026-10-12T10:00:00+00:00',
      room_id: 'room-a',
      track_id: 'track-1',
      duration_min: 60,
      speakers: [{ contact_id: 'c-1', first_name: 'Marie', last_name: 'Curie' }],
    },
    {
      id: 'sess-2',
      friendly_id: 'SESS-2',
      title: 'Postgres for Programme Chairs',
      status: 'accepted',
      starts_at: '2026-10-12T09:30:00+00:00',
      ends_at: '2026-10-12T10:00:00+00:00',
      room_id: 'room-a',
      track_id: 'track-1',
      duration_min: 30,
      speakers: [{ contact_id: 'c-2', first_name: 'Katherine', last_name: 'Johnson' }],
    },
    {
      id: 'sess-3',
      friendly_id: 'SESS-3',
      title: 'Waiting in the Wings',
      status: 'pending',
      starts_at: null,
      ends_at: null,
      room_id: null,
      track_id: null,
      duration_min: 45,
      speakers: [],
    },
  ],
}

const CONFLICTS = {
  conflicts: [
    {
      type: 'room_overlap',
      session_ids: ['sess-1', 'sess-2'],
      detail: 'Auditorium is double-booked at 09:30',
    },
  ],
}

const SEEDED_MULTI_DAY_AGENDA = {
  ...AGENDA,
  rooms: [
    { id: 'room-main', name: 'Main Stage', capacity: 400, order: 0 },
    { id: 'room-a', name: 'Workshop A', capacity: 80, order: 1 },
    { id: 'room-b', name: 'Workshop B', capacity: 80, order: 2 },
  ],
  sessions: [
    {
      id: 'main-day-1',
      title: 'Day 1 keynote',
      status: 'accepted',
      starts_at: '2026-10-12T16:00:00+00:00',
      ends_at: '2026-10-12T16:45:00+00:00',
      room_id: 'room-main',
      track_id: 'track-1',
      duration_min: 45,
      speakers: [],
    },
    {
      id: 'main-day-2',
      title: 'Day 2 keynote',
      status: 'accepted',
      starts_at: '2026-10-13T16:00:00+00:00',
      ends_at: '2026-10-13T16:45:00+00:00',
      room_id: 'room-main',
      track_id: 'track-1',
      duration_min: 45,
      speakers: [],
    },
    {
      id: 'workshop-a-day-1',
      title: 'Day 1 Workshop A',
      status: 'accepted',
      starts_at: '2026-10-12T17:00:00+00:00',
      ends_at: '2026-10-12T17:30:00+00:00',
      room_id: 'room-a',
      track_id: 'track-1',
      duration_min: 30,
      speakers: [{ contact_id: 'priya', first_name: 'Priya', last_name: 'Raman' }],
    },
    {
      id: 'workshop-b-day-1',
      title: 'Day 1 Workshop B',
      status: 'accepted',
      starts_at: '2026-10-12T17:00:00+00:00',
      ends_at: '2026-10-12T17:30:00+00:00',
      room_id: 'room-b',
      track_id: 'track-1',
      duration_min: 30,
      speakers: [{ contact_id: 'priya', first_name: 'Priya', last_name: 'Raman' }],
    },
    {
      id: 'workshop-a-day-2',
      title: 'Day 2 Workshop A',
      status: 'accepted',
      starts_at: '2026-10-13T17:00:00+00:00',
      ends_at: '2026-10-13T17:30:00+00:00',
      room_id: 'room-a',
      track_id: 'track-1',
      duration_min: 30,
      speakers: [],
    },
    {
      id: 'workshop-b-day-2',
      title: 'Day 2 Workshop B',
      status: 'accepted',
      starts_at: '2026-10-13T17:00:00+00:00',
      ends_at: '2026-10-13T18:30:00+00:00',
      room_id: 'room-b',
      track_id: 'track-1',
      duration_min: 90,
      speakers: [],
    },
  ],
}

const SEEDED_MULTI_DAY_CONFLICTS = {
  conflicts: [
    {
      type: 'speaker_overlap',
      session_ids: ['workshop-a-day-1', 'workshop-b-day-1'],
      detail: 'Priya Raman is in two rooms at 17:00',
    },
  ],
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function stubApi(agenda: unknown = AGENDA, conflicts: unknown = CONFLICTS) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/api/events')) return jsonResponse({ events: [EVENT] })
      // Longest path first — /agenda is a prefix of /agenda/conflicts.
      if (url.includes('/agenda/conflicts')) return jsonResponse(conflicts)
      if (url.includes('/agenda')) return jsonResponse(agenda)
      return jsonResponse({}, 404)
    })
  )
}

function renderAgenda() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <MemoryRouter>
      <QueryClientProvider client={queryClient}>
        <Agenda />
      </QueryClientProvider>
    </MemoryRouter>
  )
}

describe('Agenda on real event data', () => {
  beforeEach(() => {
    window.localStorage.setItem('dais.token', 'test-token')
    stubApi()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    window.localStorage.clear()
  })

  it('draws one column per room, with the room capacity', async () => {
    renderAgenda()

    expect(await screen.findByText('Auditorium')).toBeInTheDocument()
    expect(screen.getByText('Capacity 250')).toBeInTheDocument()
    // A room with no capacity set still gets a column.
    expect(screen.getByText('Studio')).toBeInTheDocument()
    expect(screen.getByText('Capacity —')).toBeInTheDocument()
    // The demo rooms are gone.
    expect(screen.queryByText('Main Hall')).not.toBeInTheDocument()
  })

  it('renders the real sessions, not the old hardcoded ones', async () => {
    renderAgenda()

    expect(await screen.findByText('Shipping on Fridays')).toBeInTheDocument()
    expect(screen.getByText('Postgres for Programme Chairs')).toBeInTheDocument()
    expect(screen.queryByText(/Analytical Engine/)).not.toBeInTheDocument()
  })

  it('places a card at the time the API gave it', async () => {
    renderAgenda()
    // 09:00 + 60 minutes, read straight off starts_at/ends_at.
    expect(await screen.findByText(/09:00 – 10:00/)).toBeInTheDocument()
  })

  it('puts starts_at-null sessions in the unscheduled tray', async () => {
    renderAgenda()

    const tray = await screen.findByTestId('unscheduled-panel')
    expect(within(tray).getByText('Waiting in the Wings')).toBeInTheDocument()
    expect(screen.getByText('2 scheduled · 1 unscheduled')).toBeInTheDocument()
  })

  it('shows speaker initials from the real contacts', async () => {
    renderAgenda()
    expect(await screen.findByTitle('Marie Curie')).toHaveTextContent('MC')
    expect(screen.getByTitle('Katherine Johnson')).toHaveTextContent('KJ')
  })

  it('flags the overlap in the conflict banner', async () => {
    renderAgenda()

    const panel = await screen.findByTestId('conflicts-panel')
    expect(panel).toHaveAttribute('data-conflict-count', '1')
    expect(within(panel).getByText('Auditorium is double-booked at 09:30')).toBeInTheDocument()
  })

  it('does not alias equal room times from different conference days', async () => {
    vi.unstubAllGlobals()
    stubApi(SEEDED_MULTI_DAY_AGENDA, SEEDED_MULTI_DAY_CONFLICTS)
    renderAgenda()

    const panel = await screen.findByTestId('conflicts-panel')
    expect(panel).toHaveAttribute('data-conflict-count', '1')
    expect(within(panel).getByText('Priya Raman is in two rooms at 17:00')).toBeInTheDocument()
    expect(within(panel).queryByText(/double-booked/)).not.toBeInTheDocument()
  })

  it('tells the organizer what to do when nothing is accepted yet', async () => {
    vi.unstubAllGlobals()
    stubApi({ ...AGENDA, sessions: [] }, { conflicts: [] })
    renderAgenda()

    expect(
      await screen.findByText('No accepted sessions yet — accept submissions to build the agenda')
    ).toBeInTheDocument()
  })

  it('surfaces a failed load instead of an empty grid', async () => {
    vi.unstubAllGlobals()
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url.endsWith('/api/events')) return jsonResponse({ events: [EVENT] })
        return jsonResponse({ detail: 'Event not found' }, 404)
      })
    )
    renderAgenda()

    expect(await screen.findByText("Couldn't load the agenda")).toBeInTheDocument()
  })
})
