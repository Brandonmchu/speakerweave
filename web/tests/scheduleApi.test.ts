/**
 * The agenda wire layer: which URL each call hits, and the timestamp⇄minute
 * maths the grid does on every drop.
 *
 * The conversions matter more than they look. A placement is written as an
 * explicit-UTC timestamp and read back by its UTC clock, so "09:30 on the grid"
 * must survive the round trip byte for byte — if it doesn't, every session
 * quietly moves by the operator's own offset.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  DEFAULT_DAY_START_MIN,
  DEFAULT_SLOT_MINUTES,
  addMinutesToIso,
  agendaDay,
  agendaDays,
  buildTimestamp,
  buildZonedTimestamp,
  getAgenda,
  getAgendaConflicts,
  gridGeometry,
  localEpochMinutes,
  outsideEventDays,
  parseClockMinutes,
  publishSchedule,
  scheduleSession,
  timestampDay,
  timestampEpochMinutes,
  timestampMinutes,
  zoneHint,
  zonedDay,
  zonedMinutes,
  type Agenda,
} from '@/lib/scheduleApi'

interface Call {
  url: string
  method?: string
  body?: unknown
}

let calls: Call[] = []
let nextPayload: unknown = {}

const last = () => calls[calls.length - 1]

beforeEach(() => {
  calls = []
  nextPayload = {}
  window.localStorage.setItem('dais.token', 'test-token')
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      calls.push({
        url: String(url),
        method: init.method,
        body: init.body ? JSON.parse(String(init.body)) : undefined,
      })
      return new Response(JSON.stringify(nextPayload), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    })
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
  window.localStorage.clear()
})

describe('agenda endpoints', () => {
  it('reads the whole board off the event', async () => {
    nextPayload = {
      event: { id: 'evt-1', day_start: '09:00:00' },
      rooms: [{ id: 'room-a', name: 'Main Hall' }],
      tracks: [],
      sessions: [{ id: 's1', title: 'Keynote', status: 'accepted', duration_min: 45, speakers: [] }],
    }

    const agenda = await getAgenda('evt-1')

    expect(last().url).toBe('/api/events/evt-1/agenda')
    expect(last().method).toBe('GET')
    expect(agenda.sessions[0].title).toBe('Keynote')
    expect(agenda.rooms[0].id).toBe('room-a')
  })

  it('survives a payload missing its lists', async () => {
    nextPayload = { event: { id: 'evt-1' } }
    const agenda = await getAgenda('evt-1')
    expect(agenda.sessions).toEqual([])
    expect(agenda.rooms).toEqual([])
    expect(agenda.tracks).toEqual([])
  })

  it('reads conflicts out of the envelope', async () => {
    nextPayload = {
      conflicts: [
        { type: 'room_overlap', session_ids: ['a', 'b'], detail: 'Main Hall is double-booked at 09:30' },
      ],
    }

    const conflicts = await getAgendaConflicts('evt-1')

    expect(last().url).toBe('/api/events/evt-1/agenda/conflicts')
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0].type).toBe('room_overlap')
  })

  it('PATCHes a placement onto the session', async () => {
    nextPayload = { session: { id: 's1', room_id: 'room-a' } }

    const session = await scheduleSession('s1', {
      room_id: 'room-a',
      starts_at: '2026-10-12T09:30:00+00:00',
      ends_at: '2026-10-12T10:15:00+00:00',
    })

    expect(last().url).toBe('/api/sessions/s1/schedule')
    expect(last().method).toBe('PATCH')
    expect(last().body).toEqual({
      room_id: 'room-a',
      starts_at: '2026-10-12T09:30:00+00:00',
      ends_at: '2026-10-12T10:15:00+00:00',
    })
    expect(session.room_id).toBe('room-a')
  })

  it('unschedules with explicit nulls, not omissions', async () => {
    nextPayload = { session: { id: 's1', room_id: null } }
    await scheduleSession('s1', { room_id: null, starts_at: null, ends_at: null })
    expect(last().body).toEqual({ room_id: null, starts_at: null, ends_at: null })
  })

  it('encodes ids into the path', async () => {
    nextPayload = { session: {} }
    await scheduleSession('a/b', { room_id: null, starts_at: null, ends_at: null })
    expect(last().url).toBe('/api/sessions/a%2Fb/schedule')
  })
})

describe('grid geometry', () => {
  it('takes the day window and slot width from the event', () => {
    const grid = gridGeometry({ id: 'e', day_start: '08:00:00', day_end: '18:00:00', slot_minutes: 30 })
    expect(grid).toEqual({ dayStartMin: 480, dayEndMin: 1080, slotMinutes: 30, slotCount: 20 })
  })

  it('falls back when the event has no geometry', () => {
    const grid = gridGeometry(null)
    expect(grid.dayStartMin).toBe(DEFAULT_DAY_START_MIN)
    expect(grid.slotMinutes).toBe(DEFAULT_SLOT_MINUTES)
    expect(grid.slotCount).toBe(32)
  })

  it('refuses a day that ends before it starts', () => {
    // A zero-row grid would swallow every card, so this must not propagate.
    const grid = gridGeometry({ id: 'e', day_start: '10:00', day_end: '09:00' })
    expect(grid.dayEndMin).toBeGreaterThan(grid.dayStartMin)
    expect(grid.slotCount).toBeGreaterThan(0)
  })

  it('parses a Postgres time with or without seconds', () => {
    expect(parseClockMinutes('09:00:00')).toBe(540)
    expect(parseClockMinutes('9:30')).toBe(570)
    expect(parseClockMinutes('nonsense')).toBeNull()
    expect(parseClockMinutes(null)).toBeNull()
  })
})

describe('timestamps', () => {
  it('round-trips a placement through the wire', () => {
    const wire = buildTimestamp('2026-10-12', 570)
    expect(wire).toBe('2026-10-12T09:30:00+00:00')
    expect(timestampMinutes(wire)).toBe(570)
    expect(timestampDay(wire)).toBe('2026-10-12')
  })

  it('reads a zoneless timestamp as UTC, not as browser-local', () => {
    expect(timestampMinutes('2026-10-12T09:30:00')).toBe(570)
  })

  it('normalises an offset timestamp before reading the clock', () => {
    expect(timestampMinutes('2026-10-12T11:30:00+02:00')).toBe(570)
    expect(timestampMinutes('2026-10-12T09:30:00.000Z')).toBe(570)
  })

  it('preserves the day when converting timestamps for conflict detection', () => {
    const dayOne = timestampEpochMinutes('2026-10-12T09:30:00+00:00')
    const dayTwo = timestampEpochMinutes('2026-10-13T09:30:00+00:00')

    expect(dayOne).not.toBeNull()
    expect(dayTwo).toBe((dayOne ?? 0) + 1440)
  })

  it('is null, never NaN, for anything unparseable', () => {
    expect(timestampMinutes(null)).toBeNull()
    expect(timestampMinutes('')).toBeNull()
    expect(timestampMinutes('tomorrow')).toBeNull()
    expect(timestampEpochMinutes('tomorrow')).toBeNull()
    expect(timestampDay(undefined)).toBeNull()
  })

  it('rolls a past-midnight offset into the next day', () => {
    expect(buildTimestamp('2026-10-12', 1470)).toBe('2026-10-13T00:30:00+00:00')
  })
})

describe('agendaDay', () => {
  const agenda = (over: Partial<Agenda>): Agenda => ({
    event: null,
    rooms: [],
    tracks: [],
    sessions: [],
    ...over,
  })

  it('prefers the event day', () => {
    expect(
      agendaDay(
        agenda({
          event: { id: 'e', starts_at: '2026-10-12T16:00:00+00:00' },
          sessions: [
            { id: 's', title: 't', status: 'accepted', duration_min: 30, speakers: [], starts_at: '2026-11-01T09:00:00+00:00' },
          ],
        })
      )
    ).toBe('2026-10-12')
  })

  it('falls back to the earliest day something is already scheduled on', () => {
    expect(
      agendaDay(
        agenda({
          sessions: [
            { id: 'b', title: 'b', status: 'accepted', duration_min: 30, speakers: [], starts_at: '2026-11-02T09:00:00+00:00' },
            { id: 'a', title: 'a', status: 'accepted', duration_min: 30, speakers: [], starts_at: '2026-11-01T09:00:00+00:00' },
          ],
        })
      )
    ).toBe('2026-11-01')
  })

  it('falls back to today when nothing is dated', () => {
    expect(agendaDay(agenda({}))).toBe(new Date().toISOString().slice(0, 10))
  })
})

describe('event-timezone conversions', () => {
  const LA = 'America/Los_Angeles'

  it('reads an instant back in the event zone, not UTC', () => {
    // 16:00 UTC is 09:00 in Los Angeles (PDT) on this October day.
    expect(zonedMinutes('2026-10-12T16:00:00+00:00', LA)).toBe(9 * 60)
    expect(zonedDay('2026-10-12T16:00:00+00:00', LA)).toBe('2026-10-12')
    // A small-hours UTC instant still belongs to the previous local day.
    expect(zonedDay('2026-10-13T05:00:00+00:00', LA)).toBe('2026-10-12') // 22:00 PDT
  })

  it('falls back to plain UTC when the event carries no zone', () => {
    expect(zonedMinutes('2026-10-12T16:00:00+00:00', null)).toBe(16 * 60)
    expect(zonedDay('2026-10-12T16:00:00+00:00', null)).toBe('2026-10-12')
  })

  it('round-trips a placement through the event zone', () => {
    // Place at local 09:00 on Oct 12 -> stored 16:00 UTC -> reads back 09:00.
    const wire = buildZonedTimestamp('2026-10-12', 9 * 60, LA)
    expect(wire).toBe('2026-10-12T16:00:00+00:00')
    expect(zonedMinutes(wire, LA)).toBe(9 * 60)
    expect(zonedDay(wire, LA)).toBe('2026-10-12')
  })

  it('with no zone builds the same explicit-UTC stamp as before', () => {
    expect(buildZonedTimestamp('2026-10-12', 570, null)).toBe('2026-10-12T09:30:00+00:00')
  })

  it('derives an end that preserves duration across a DST fall-back', () => {
    // 2026-11-01 LA falls back 02:00 -> 01:00. A 60-minute talk placed at 01:30
    // must stay 60 REAL minutes: deriving the end from the start instant does
    // that, where converting the 02:30 wall-time on its own would double it.
    const start = buildZonedTimestamp('2026-11-01', 90, LA) // 01:30 local
    const end = addMinutesToIso(start, 60)
    const startEpoch = timestampEpochMinutes(start)
    const endEpoch = timestampEpochMinutes(end)
    expect(startEpoch).not.toBeNull()
    expect((endEpoch as number) - (startEpoch as number)).toBe(60)
  })

  it('addMinutesToIso keeps the explicit-UTC form and no-ops on junk', () => {
    expect(addMinutesToIso('2026-10-12T16:00:00+00:00', 45)).toBe('2026-10-12T16:45:00+00:00')
    expect(addMinutesToIso('not a timestamp', 30)).toBe('not a timestamp')
  })

  it('shifts the shared conflict clock into the event zone without aliasing days', () => {
    const a = localEpochMinutes('2026-10-12T17:00:00+00:00', LA)
    const b = localEpochMinutes('2026-10-13T17:00:00+00:00', LA)
    expect(a).not.toBeNull()
    expect((a as number) % 1440).toBe(10 * 60) // 17:00 UTC -> 10:00 PDT
    expect(b).toBe((a as number) + 1440) // one calendar day apart, still
  })

  it('formats a tz hint like the public schedule', () => {
    expect(zoneHint(LA, '2026-10-12T16:00:00+00:00')).toBe('America/Los_Angeles (PDT)')
    expect(zoneHint(null)).toBe('')
  })
})

describe('agendaDays', () => {
  const LA = 'America/Los_Angeles'
  const agenda = (over: Partial<Agenda>): Agenda => ({
    event: null,
    rooms: [],
    tracks: [],
    sessions: [],
    ...over,
  })

  it('spans the event start->end inclusive, in the event zone', () => {
    const days = agendaDays(
      agenda({
        event: {
          id: 'e',
          starts_at: '2026-10-12T15:00:00+00:00', // 08:00 PDT Oct 12
          ends_at: '2026-10-14T01:00:00+00:00', // 18:00 PDT Oct 13
        },
      }),
      LA
    )
    expect(days).toEqual(['2026-10-12', '2026-10-13'])
  })

  it('is the event span ONLY — a stray placement never invents a day tab', () => {
    // A conference day is a fact about the EVENT. Unioning in whatever days
    // sessions happened to sit on made the switcher a mirror of the data's
    // mistakes: one placement left behind by a date change and the builder grew
    // a tab for a day the conference does not run.
    const board = agenda({
      event: { id: 'e', starts_at: '2026-10-12T16:00:00+00:00' },
      sessions: [
        {
          id: 's',
          title: 't',
          status: 'accepted',
          duration_min: 30,
          speakers: [],
          starts_at: '2026-10-13T16:00:00+00:00',
        },
      ],
    })

    expect(agendaDays(board, LA)).toEqual(['2026-10-12'])
    // ...and the stray is not swallowed either: it is reported, so the builder
    // can show it under "Outside event dates" with a way to fix it.
    expect(outsideEventDays(board, LA).map((s) => s.id)).toEqual(['s'])
  })

  it('reports nothing outside the span when every placement is on a real day', () => {
    const board = agenda({
      event: {
        id: 'e',
        starts_at: '2026-10-12T16:00:00+00:00',
        ends_at: '2026-10-14T01:00:00+00:00',
      },
      sessions: [
        {
          id: 'in-range',
          title: 'Day 2 talk',
          status: 'accepted',
          duration_min: 30,
          speakers: [],
          starts_at: '2026-10-13T16:00:00+00:00',
        },
        {
          id: 'tray',
          title: 'Unscheduled',
          status: 'accepted',
          duration_min: 30,
          speakers: [],
          starts_at: null,
        },
      ],
    })

    expect(agendaDays(board, LA)).toEqual(['2026-10-12', '2026-10-13'])
    // An unscheduled session sits on no day at all — it belongs to the tray, not
    // to the out-of-range problem list.
    expect(outsideEventDays(board, LA)).toEqual([])
  })

  it('is a single day for a single-day event', () => {
    expect(
      agendaDays(agenda({ event: { id: 'e', starts_at: '2026-10-12T16:00:00+00:00' } }), LA)
    ).toEqual(['2026-10-12'])
  })

  it('clamps nothing when the event has no configured span', () => {
    // No window, no clamp — the same rule the public schedule and the
    // auto-placer apply. Calling every placement "outside the event dates" for
    // an event that HAS no dates would be a lie about the data.
    const board = agenda({
      event: { id: 'e' },
      sessions: [
        {
          id: 'a',
          title: 'a',
          status: 'accepted',
          duration_min: 30,
          speakers: [],
          starts_at: '2026-10-12T16:00:00+00:00',
        },
        {
          id: 'b',
          title: 'b',
          status: 'accepted',
          duration_min: 30,
          speakers: [],
          starts_at: '2026-11-20T17:00:00+00:00',
        },
      ],
    })

    expect(agendaDays(board, LA)).toEqual(['2026-10-12', '2026-11-20'])
    expect(outsideEventDays(board, LA)).toEqual([])
  })

  it('does not add a stray day for an event ending exactly at local midnight', () => {
    const days = agendaDays(
      agenda({
        event: {
          id: 'e',
          starts_at: '2026-10-12T08:00:00-07:00', // Oct 12 local
          ends_at: '2026-10-14T00:00:00-07:00', // exclusive midnight -> ends Oct 13
        },
      }),
      LA
    )
    expect(days).toEqual(['2026-10-12', '2026-10-13'])
  })
})

describe('publishSchedule', () => {
  it('POSTs to the publish endpoint and returns the public URL', async () => {
    nextPayload = {
      event: {
        id: 'e',
        slug: 'daisconf',
        program_published_at: '2026-08-09T12:00:00+00:00',
      },
      public_url: '/e/daisconf/schedule',
    }

    const result = await publishSchedule('event-1')

    expect(last().url).toBe('/api/events/event-1/schedule/publish')
    expect(last().method).toBe('POST')
    expect(result.public_url).toBe('/e/daisconf/schedule')
  })
})
