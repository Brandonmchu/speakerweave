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
  agendaDay,
  buildTimestamp,
  getAgenda,
  getAgendaConflicts,
  gridGeometry,
  parseClockMinutes,
  scheduleSession,
  timestampDay,
  timestampMinutes,
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

  it('is null, never NaN, for anything unparseable', () => {
    expect(timestampMinutes(null)).toBeNull()
    expect(timestampMinutes('')).toBeNull()
    expect(timestampMinutes('tomorrow')).toBeNull()
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
