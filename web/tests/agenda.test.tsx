/**
 * The agenda grid, on real event data.
 *
 * The page used to render five hardcoded sessions in two hardcoded rooms
 * regardless of the event, so the thing worth pinning down is that every column,
 * card, chip and conflict on screen now came out of the API — and that an event
 * with nothing accepted says so instead of drawing an empty lattice.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { Agenda } from '@/pages/Agenda'

const EVENT = { id: 'event-1', name: 'DaisConf', slug: 'daisconf' }

// Times are stored the way the real event stores them: an explicit event-tz
// offset (PDT, -07:00), so 09:00 on the grid is the instant that IS 09:00 in
// America/Los_Angeles (16:00 UTC), not 09:00 UTC. The builder renders them back
// in the event zone, so "09:00" appears on the grid — matching the public page.
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
      friendly_id: 'SESS-1',
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
      friendly_id: 'SESS-2',
      title: 'Postgres for Programme Chairs',
      status: 'accepted',
      starts_at: '2026-10-12T09:30:00-07:00',
      ends_at: '2026-10-12T10:00:00-07:00',
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

interface Patch {
  url: string
  body: Record<string, unknown>
}

/**
 * Like stubApi, but records every PATCH to /schedule and echoes the placement
 * back as the saved session — so a click-to-assign flow can be asserted end to
 * end (select → click slot → the exact room/time the grid sent).
 */
function stubApiCapturing(agenda: unknown = AGENDA, conflicts: unknown = CONFLICTS): Patch[] {
  const patches: Patch[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input)
      const method = init.method ?? 'GET'
      if (method === 'PATCH' && url.includes('/schedule')) {
        const body = init.body ? JSON.parse(String(init.body)) : {}
        patches.push({ url, body })
        const id = url.split('/').slice(-2)[0]
        return jsonResponse({ session: { id, ...body } })
      }
      if (url.endsWith('/api/events')) return jsonResponse({ events: [EVENT] })
      if (url.includes('/agenda/conflicts')) return jsonResponse(conflicts)
      if (url.includes('/agenda')) return jsonResponse(agenda)
      return jsonResponse({}, 404)
    })
  )
  return patches
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
    // The overlap is at 17:00 UTC, which is 10:00 in the event zone (PDT). The
    // builder shows the conflict in the EVENT's clock — the same time the grid
    // draws the cards at — even though the server's fixture reports it in UTC.
    expect(within(panel).getByText('Priya Raman is in two rooms at 10:00')).toBeInTheDocument()
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

  it('schedules an unscheduled session by click-to-assign (select → click slot)', async () => {
    vi.unstubAllGlobals()
    const patches = stubApiCapturing()
    renderAgenda()

    // Arm the tray card with its "Place" affordance.
    fireEvent.click(await screen.findByTestId('place-sess-3'))
    // The armed card is called out, and the empty slot is a real, tagged target.
    expect(screen.getByTestId('placement-banner')).toHaveTextContent('Waiting in the Wings')
    const slot = screen.getByTestId('slot-room-b-1100')
    expect(slot).toHaveAttribute('aria-label', 'Studio 11:00')

    // Click 11:00 in Studio — no drag involved.
    fireEvent.click(slot)

    await waitFor(() => expect(patches).toHaveLength(1))
    expect(patches[0].url).toContain('/api/sessions/sess-3/schedule')
    expect(patches[0].body).toEqual({
      room_id: 'room-b',
      // 45-minute session dropped at the 11:00 slot. 11:00 is the EVENT-zone
      // clock (PDT), so it is stored as the instant that is 11:00 in LA — 18:00
      // UTC — the same convention the public schedule reads back.
      starts_at: '2026-10-12T18:00:00+00:00',
      ends_at: '2026-10-12T18:45:00+00:00',
    })
    // Placing it disarms the selection.
    await waitFor(() =>
      expect(screen.queryByTestId('placement-banner')).not.toBeInTheDocument()
    )
  })

  it('moves a placed session by selecting its card and clicking a new slot', async () => {
    vi.unstubAllGlobals()
    const patches = stubApiCapturing()
    renderAgenda()

    // A click (never a drag) on a grid card arms it for a move.
    const card = (await screen.findByText('Postgres for Programme Chairs')).closest(
      '[data-session-id]'
    )
    expect(card).not.toBeNull()
    fireEvent.click(card as Element)
    expect(screen.getByTestId('placement-banner')).toHaveTextContent('move')

    fireEvent.click(screen.getByTestId('slot-room-b-1400'))

    await waitFor(() => expect(patches).toHaveLength(1))
    expect(patches[0].url).toContain('/api/sessions/sess-2/schedule')
    expect(patches[0].body).toEqual({
      room_id: 'room-b',
      // 14:00 on the grid is 14:00 in the event zone (PDT) -> 21:00 UTC.
      starts_at: '2026-10-12T21:00:00+00:00',
      ends_at: '2026-10-12T21:30:00+00:00',
    })
  })

  it('unschedules a placed session from its ×/Unschedule button', async () => {
    vi.unstubAllGlobals()
    const patches = stubApiCapturing()
    renderAgenda()

    fireEvent.click(await screen.findByTestId('unschedule-sess-1'))

    await waitFor(() => expect(patches).toHaveLength(1))
    expect(patches[0].url).toContain('/api/sessions/sess-1/schedule')
    // Explicit nulls send it back to the tray — the same contract the drag uses.
    expect(patches[0].body).toEqual({ room_id: null, starts_at: null, ends_at: null })
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

  it('labels times in the event timezone, not UTC, with a tz hint', async () => {
    renderAgenda() // the default event is in America/Los_Angeles

    // sess-1 is stored at 16:00 UTC (09:00 PDT). The grid must read it back in
    // the EVENT zone — 09:00 — never the 16:00 UTC clock a naive reader would
    // show. The 16:00–17:00 UTC range must not appear on the card.
    expect(await screen.findByText(/09:00 – 10:00/)).toBeInTheDocument()
    expect(screen.queryByText(/16:00 – 17:00/)).not.toBeInTheDocument()

    // And the grid says which zone its clock is, exactly like the public page.
    expect(screen.getByTestId('agenda-tz-note')).toHaveTextContent('America/Los_Angeles')
  })

  it('shows a day switcher for a multi-day event and filters the grid to the day', async () => {
    vi.unstubAllGlobals()
    stubApi(SEEDED_MULTI_DAY_AGENDA, SEEDED_MULTI_DAY_CONFLICTS)
    renderAgenda()

    // One tab per conference day, keyed by the event-zone date.
    expect(await screen.findByTestId('day-switcher')).toBeInTheDocument()
    expect(screen.getByTestId('agenda-day-tab-2026-10-12')).toBeInTheDocument()
    expect(screen.getByTestId('agenda-day-tab-2026-10-13')).toBeInTheDocument()

    // Day 1 is in view by default: only its sessions are on the grid.
    expect(screen.getByText('Day 1 keynote')).toBeInTheDocument()
    expect(screen.queryByText('Day 2 keynote')).not.toBeInTheDocument()

    // Switching days swaps the grid to that day's sessions.
    fireEvent.click(screen.getByTestId('agenda-day-tab-2026-10-13'))
    expect(await screen.findByText('Day 2 keynote')).toBeInTheDocument()
    expect(screen.queryByText('Day 1 keynote')).not.toBeInTheDocument()
  })

  it('places onto the day in view after switching tabs, not the card’s original day', async () => {
    vi.unstubAllGlobals()
    const patches = stubApiCapturing(SEEDED_MULTI_DAY_AGENDA, SEEDED_MULTI_DAY_CONFLICTS)
    renderAgenda()

    // Arm a day-1 card (the keynote) for a move while day 1 is in view.
    const card = (await screen.findByText('Day 1 keynote')).closest('[data-session-id]')
    expect(card).not.toBeNull()
    fireEvent.click(card as Element)
    expect(screen.getByTestId('placement-banner')).toHaveTextContent('Day 1 keynote')

    // Switch to day 2, then drop it into a day-2 slot. It must land on the day
    // the user is looking at (day 2), NOT be written back to its original day 1
    // and NOT no-op because the clock/room happen to match.
    fireEvent.click(screen.getByTestId('agenda-day-tab-2026-10-13'))
    fireEvent.click(screen.getByTestId('slot-room-main-1000'))

    await waitFor(() => expect(patches).toHaveLength(1))
    expect(patches[0].url).toContain('/api/sessions/main-day-1/schedule')
    // 10:00 in the event zone on 2026-10-13 (PDT) -> 17:00 UTC, and the 45-min
    // keynote keeps its length (end derived from the start instant).
    expect(patches[0].body).toEqual({
      room_id: 'room-main',
      starts_at: '2026-10-13T17:00:00+00:00',
      ends_at: '2026-10-13T17:45:00+00:00',
    })
  })

  it('single-day events show no day switcher', async () => {
    renderAgenda() // the default AGENDA is a single day
    await screen.findByText('Shipping on Fridays')
    expect(screen.queryByTestId('day-switcher')).not.toBeInTheDocument()
  })

  it('publishes the schedule and shows the public URL with a link', async () => {
    vi.unstubAllGlobals()
    const publishBody = {
      event: {
        id: 'event-1',
        slug: 'daisconf',
        program_published_at: '2026-08-09T12:00:00+00:00',
      },
      public_url: '/e/daisconf/schedule',
    }
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
        const url = String(input)
        const method = init.method ?? 'GET'
        if (method === 'POST' && url.includes('/schedule/publish')) {
          return jsonResponse(publishBody)
        }
        if (url.endsWith('/api/events')) return jsonResponse({ events: [EVENT] })
        if (url.includes('/agenda/conflicts')) return jsonResponse(CONFLICTS)
        if (url.includes('/agenda')) return jsonResponse(AGENDA)
        return jsonResponse({}, 404)
      })
    )
    renderAgenda()

    // Wait for the board to load so the publish button is enabled (it stays
    // disabled while there is no event / nothing to publish).
    await screen.findByText('Shipping on Fridays')
    fireEvent.click(screen.getByTestId('publish-schedule'))

    const banner = await screen.findByTestId('publish-success')
    expect(banner).toHaveTextContent('/e/daisconf/schedule')
    const link = screen.getByTestId('view-public-page')
    expect(link).toHaveAttribute('href', '/e/daisconf/schedule')
  })
})
