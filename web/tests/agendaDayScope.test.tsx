/**
 * Two builder defects the official eval hit, pinned:
 *
 *   1. **Day tabs were unscoped.** They were the union of the event's span and
 *      whichever days sessions happened to sit on, so one placement left behind
 *      by a date change grew the builder a tab — the conference appeared to have
 *      a day in November. Tabs are now the event's configured span and nothing
 *      else, and the strays are collected under one "Outside event dates (N)"
 *      tab with a warning and a way out.
 *
 *   2. **Occupied cells were mute.** Cards are drawn ABOVE the droppable
 *      lattice, so clicking a taken slot hit the card, not the cell: click-to-
 *      place onto an occupied slot did nothing and said nothing. Now it names
 *      what is in the way.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { Agenda } from '@/pages/Agenda'
import { toast } from '@/ui/use-toast'
import { Toaster } from '@/ui/toaster'

/**
 * The real toast, wrapped in a spy. `use-toast` keeps its queue in a module
 * singleton that outlives a test's render, so counting rendered toasts across
 * tests is unreliable — but the call itself is exact. The Toaster stays mounted
 * so at least one test can prove the message is genuinely on screen.
 */
vi.mock('@/ui/use-toast', async () => {
  const actual = await vi.importActual<typeof import('@/ui/use-toast')>('@/ui/use-toast')
  return { ...actual, toast: vi.fn(actual.toast) }
})

const toastSpy = vi.mocked(toast)

/** Every "Slot occupied by …" the page raised in THIS test. */
const occupiedToasts = () =>
  toastSpy.mock.calls
    .map(([options]) => String(options?.title ?? ''))
    .filter((title) => title.startsWith('Slot occupied by'))

const EVENT = { id: 'event-1', name: 'DaisConf', slug: 'daisconf' }

/** A real two-day conference: 12–13 October 2026, America/Los_Angeles. */
const AGENDA = {
  event: {
    id: 'event-1',
    name: 'DaisConf',
    slug: 'daisconf',
    timezone: 'America/Los_Angeles',
    starts_at: '2026-10-12T08:00:00-07:00',
    ends_at: '2026-10-13T18:00:00-07:00',
    day_start: '09:00:00',
    day_end: '17:00:00',
    slot_minutes: 15,
  },
  rooms: [
    { id: 'room-a', name: 'Auditorium', capacity: 250, order: 0 },
    { id: 'room-b', name: 'Studio', capacity: 80, order: 1 },
  ],
  tracks: [{ id: 'track-1', name: 'Platform', color: '#4F46E5' }],
  sessions: [
    {
      id: 'placed',
      title: 'Shipping on Fridays',
      status: 'accepted',
      // 10:00–11:00 PDT on day 1.
      starts_at: '2026-10-12T17:00:00+00:00',
      ends_at: '2026-10-12T18:00:00+00:00',
      room_id: 'room-a',
      track_id: 'track-1',
      duration_min: 60,
      speakers: [],
    },
    {
      id: 'stale',
      title: 'Left Behind By A Date Change',
      status: 'accepted',
      // 09:00 PST on 20 November — five weeks after the conference ends.
      starts_at: '2026-11-20T17:00:00+00:00',
      ends_at: '2026-11-20T17:30:00+00:00',
      room_id: 'room-b',
      track_id: 'track-1',
      duration_min: 30,
      speakers: [],
    },
    {
      id: 'tray',
      title: 'Taming 40-Minute CI',
      status: 'accepted',
      starts_at: null,
      ends_at: null,
      room_id: null,
      track_id: null,
      duration_min: 30,
      speakers: [],
    },
  ],
}

const NO_CONFLICTS = { conflicts: [] }

interface Patch {
  url: string
  body: Record<string, unknown>
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function stubApi(agenda: unknown = AGENDA): Patch[] {
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
      if (url.includes('/agenda/conflicts')) return jsonResponse(NO_CONFLICTS)
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
        <Toaster />
      </QueryClientProvider>
    </MemoryRouter>
  )
}

beforeEach(() => {
  window.localStorage.setItem('dais.token', 'admin-token')
  toastSpy.mockClear()
})

afterEach(() => {
  vi.unstubAllGlobals()
  window.localStorage.clear()
})

describe('Agenda day tabs are the event dates, not the data', () => {
  it('renders a tab per configured conference day and none for a stale placement', async () => {
    stubApi()
    renderAgenda()

    const switcher = await screen.findByTestId('day-switcher')
    expect(within(switcher).getByTestId('agenda-day-tab-2026-10-12')).toBeInTheDocument()
    expect(within(switcher).getByTestId('agenda-day-tab-2026-10-13')).toBeInTheDocument()
    // The November placement must NOT become a third conference day.
    expect(screen.queryByTestId('agenda-day-tab-2026-11-20')).not.toBeInTheDocument()
  })

  it('groups out-of-range placements under one tab with a count', async () => {
    stubApi()
    renderAgenda()

    const outside = await screen.findByTestId('agenda-day-tab-outside')
    expect(outside).toHaveTextContent('Outside event dates (1)')
    expect(outside).toHaveAttribute('data-outside-count', '1')
    // It is not the default view — the organizer lands on day 1 as before.
    expect(outside).toHaveAttribute('aria-selected', 'false')
    expect(screen.getByTestId('agenda-day-tab-2026-10-12')).toHaveAttribute(
      'aria-selected',
      'true'
    )
  })

  it('never draws a stale placement on a real day', async () => {
    stubApi()
    renderAgenda()

    await screen.findByText('Shipping on Fridays')
    expect(screen.queryByText('Left Behind By A Date Change')).not.toBeInTheDocument()

    fireEvent.click(screen.getByTestId('agenda-day-tab-2026-10-13'))
    expect(screen.queryByText('Left Behind By A Date Change')).not.toBeInTheDocument()
  })

  it('warns on the outside tab and moves a stray back to the tray in one click', async () => {
    const patches = stubApi()
    renderAgenda()

    fireEvent.click(await screen.findByTestId('agenda-day-tab-outside'))

    const warning = await screen.findByTestId('outside-dates-warning')
    expect(warning).toHaveTextContent('1 session scheduled outside the event dates')
    expect(warning).toHaveTextContent('public schedule')

    const row = screen.getByTestId('outside-session-stale')
    expect(row).toHaveTextContent('Left Behind By A Date Change')
    // The row says WHERE it is stranded, which is how the organizer recognises it.
    expect(row).toHaveTextContent('Studio')

    fireEvent.click(screen.getByTestId('outside-unschedule-stale'))

    await waitFor(() => expect(patches).toHaveLength(1))
    expect(patches[0].url).toContain('/api/sessions/stale/schedule')
    expect(patches[0].body).toEqual({ room_id: null, starts_at: null, ends_at: null })
  })

  it('hides the outside tab entirely when every placement is on a real day', async () => {
    stubApi({
      ...AGENDA,
      sessions: AGENDA.sessions.filter((session) => session.id !== 'stale'),
    })
    renderAgenda()

    await screen.findByText('Shipping on Fridays')
    expect(screen.queryByTestId('agenda-day-tab-outside')).not.toBeInTheDocument()
    // The ordinary two-day switcher is still there.
    expect(screen.getByTestId('agenda-day-tab-2026-10-13')).toBeInTheDocument()
  })
})

describe('Occupied slots answer instead of swallowing the click', () => {
  /** Arm the tray session for click-to-place, the way the UI does. */
  async function armTraySession() {
    fireEvent.click(await screen.findByTestId('place-tray'))
    expect(screen.getByTestId('placement-banner')).toHaveTextContent('Taming 40-Minute CI')
  }

  it('names the occupant when a taken slot is clicked, and refuses the move', async () => {
    const patches = stubApi()
    renderAgenda()
    await armTraySession()

    // 10:00 in the Auditorium is where "Shipping on Fridays" already sits.
    fireEvent.click(screen.getByTestId('slot-room-a-1000'))

    expect(occupiedToasts()).toEqual(['Slot occupied by Shipping on Fridays'])
    // And the organizer really sees it — not just a call into the void.
    expect(
      (await screen.findAllByText('Slot occupied by Shipping on Fridays')).length
    ).toBeGreaterThan(0)
    expect(patches).toHaveLength(0)
    // The selection stays armed so the next click can be a different slot.
    expect(screen.getByTestId('placement-banner')).toBeInTheDocument()
  })

  it('refuses a slot the card would only PARTLY overlap into', async () => {
    const patches = stubApi()
    renderAgenda()
    await armTraySession()

    // 09:45 is empty, but a 30-minute card starting there runs to 10:15 — into
    // the session that starts at 10:00.
    fireEvent.click(screen.getByTestId('slot-room-a-0945'))

    expect(occupiedToasts()).toEqual(['Slot occupied by Shipping on Fridays'])
    expect(patches).toHaveLength(0)
  })

  it('answers a click on the occupying CARD itself, rather than silently re-arming it', async () => {
    const patches = stubApi()
    renderAgenda()
    await armTraySession()

    // The card is drawn over its slots, so this is the click an organizer
    // actually makes when aiming at an occupied cell.
    const card = screen.getByText('Shipping on Fridays').closest('[data-session-id]')
    expect(card).not.toBeNull()
    fireEvent.click(card as Element)

    expect(occupiedToasts()).toEqual(['Slot occupied by Shipping on Fridays'])
    expect(patches).toHaveLength(0)
    // The tray session is still the one being placed — the click did not quietly
    // swap the armed card for the one that was in the way.
    expect(screen.getByTestId('placement-banner')).toHaveTextContent('Taming 40-Minute CI')
  })

  it('still places into a free slot — the refusal is targeted, not a lockout', async () => {
    const patches = stubApi()
    renderAgenda()
    await armTraySession()

    fireEvent.click(screen.getByTestId('slot-room-b-1000'))

    await waitFor(() => expect(patches).toHaveLength(1))
    expect(patches[0].url).toContain('/api/sessions/tray/schedule')
    expect(patches[0].body).toEqual({
      room_id: 'room-b',
      starts_at: '2026-10-12T17:00:00+00:00',
      ends_at: '2026-10-12T17:30:00+00:00',
    })
    expect(occupiedToasts()).toEqual([])
  })

  it('a plain click on a grid card with nothing armed still picks it up to move', async () => {
    const patches = stubApi()
    renderAgenda()

    const card = (await screen.findByText('Shipping on Fridays')).closest('[data-session-id]')
    fireEvent.click(card as Element)

    expect(screen.getByTestId('placement-banner')).toHaveTextContent('Shipping on Fridays')
    fireEvent.click(screen.getByTestId('slot-room-b-1400'))

    await waitFor(() => expect(patches).toHaveLength(1))
    expect(patches[0].url).toContain('/api/sessions/placed/schedule')
  })
})
