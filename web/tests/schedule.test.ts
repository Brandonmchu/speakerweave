import { describe, expect, it } from 'vitest'

import {
  assignLanes,
  clampStartSlot,
  conflictedSessionIds,
  conflictsForSession,
  detectConflicts,
  formatMinutes,
  minutesToSlot,
  slotToMinutes,
  type ScheduledSession,
  type ScheduleLabels,
  type SpikeSession,
} from '@/lib/schedule'

const LABELS: ScheduleLabels = {
  speakers: { ada: 'Ada Lovelace', grace: 'Grace Hopper', alan: 'Alan Turing' },
  rooms: { 'room-a': 'Main Hall', 'room-b': 'Workshop Room' },
}

function session(overrides: Partial<SpikeSession> & Pick<SpikeSession, 'id'>): SpikeSession {
  return {
    title: `Session ${overrides.id}`,
    speakerIds: [],
    durationMin: 30,
    color: 'indigo',
    roomId: null,
    startMin: null,
    ...overrides,
  }
}

/** 09:30 -> 570 etc., so the fixtures read like the grid does. */
function at(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number)
  return h * 60 + m
}

describe('detectConflicts — room overlap', () => {
  it('flags two sessions overlapping in the same room', () => {
    const conflicts = detectConflicts(
      [
        session({ id: 'a', roomId: 'room-a', startMin: at('09:00'), durationMin: 60 }),
        session({ id: 'b', roomId: 'room-a', startMin: at('09:30'), durationMin: 30 }),
      ],
      LABELS
    )

    expect(conflicts).toHaveLength(1)
    expect(conflicts[0].type).toBe('room_overlap')
    expect(conflicts[0].sessionIds).toEqual(['a', 'b'])
    expect(conflicts[0].detail).toBe('Main Hall is double-booked at 09:30')
  })

  it('flags a session fully contained inside another', () => {
    const conflicts = detectConflicts([
      session({ id: 'a', roomId: 'room-a', startMin: at('09:00'), durationMin: 120 }),
      session({ id: 'b', roomId: 'room-a', startMin: at('09:45'), durationMin: 30 }),
    ])

    expect(conflicts.map((c) => c.type)).toEqual(['room_overlap'])
  })

  it('does not flag the same time in different rooms', () => {
    const conflicts = detectConflicts([
      session({ id: 'a', roomId: 'room-a', startMin: at('09:00'), durationMin: 60 }),
      session({ id: 'b', roomId: 'room-b', startMin: at('09:00'), durationMin: 60 }),
    ])

    expect(conflicts).toEqual([])
  })
})

describe('detectConflicts — half-open intervals', () => {
  it('treats back-to-back sessions as clean', () => {
    const conflicts = detectConflicts([
      session({ id: 'a', roomId: 'room-a', startMin: at('09:00'), durationMin: 30 }),
      session({ id: 'b', roomId: 'room-a', startMin: at('09:30'), durationMin: 45 }),
    ])

    expect(conflicts).toEqual([])
  })

  it('treats a shared speaker back-to-back as clean too', () => {
    const conflicts = detectConflicts([
      session({
        id: 'a',
        roomId: 'room-a',
        startMin: at('09:00'),
        durationMin: 45,
        speakerIds: ['ada'],
      }),
      session({
        id: 'b',
        roomId: 'room-b',
        startMin: at('09:45'),
        durationMin: 60,
        speakerIds: ['ada'],
      }),
    ])

    expect(conflicts).toEqual([])
  })

  it('flags an overlap of a single minute', () => {
    const conflicts = detectConflicts([
      session({ id: 'a', roomId: 'room-a', startMin: at('09:00'), durationMin: 31 }),
      session({ id: 'b', roomId: 'room-a', startMin: at('09:30'), durationMin: 30 }),
    ])

    expect(conflicts).toHaveLength(1)
  })
})

describe('detectConflicts — speaker overlap', () => {
  it('flags a speaker double-booked across two different rooms', () => {
    const conflicts = detectConflicts(
      [
        session({
          id: 'keynote',
          roomId: 'room-a',
          startMin: at('09:30'),
          durationMin: 45,
          speakerIds: ['ada'],
        }),
        session({
          id: 'workshop',
          roomId: 'room-b',
          startMin: at('09:30'),
          durationMin: 60,
          speakerIds: ['ada', 'grace'],
        }),
      ],
      LABELS
    )

    expect(conflicts).toHaveLength(1)
    expect(conflicts[0]).toEqual({
      type: 'speaker_overlap',
      sessionIds: ['keynote', 'workshop'],
      detail: 'Ada Lovelace is in two rooms at 09:30',
    })
  })

  it('reports one conflict per shared speaker', () => {
    const conflicts = detectConflicts(
      [
        session({
          id: 'a',
          roomId: 'room-a',
          startMin: at('10:00'),
          durationMin: 60,
          speakerIds: ['ada', 'grace', 'alan'],
        }),
        session({
          id: 'b',
          roomId: 'room-b',
          startMin: at('10:30'),
          durationMin: 30,
          speakerIds: ['grace', 'ada'],
        }),
      ],
      LABELS
    )

    expect(conflicts.map((c) => c.detail)).toEqual([
      'Ada Lovelace is in two rooms at 10:30',
      'Grace Hopper is in two rooms at 10:30',
    ])
  })

  it('reports both a room and a speaker conflict for the same pair', () => {
    const conflicts = detectConflicts(
      [
        session({
          id: 'a',
          roomId: 'room-a',
          startMin: at('11:00'),
          durationMin: 60,
          speakerIds: ['alan'],
        }),
        session({
          id: 'b',
          roomId: 'room-a',
          startMin: at('11:15'),
          durationMin: 30,
          speakerIds: ['alan'],
        }),
      ],
      LABELS
    )

    expect(conflicts.map((c) => c.type)).toEqual(['room_overlap', 'speaker_overlap'])
    expect(conflicts[1].detail).toBe('Alan Turing is booked twice at 11:15')
  })

  it('ignores speakers that are not shared', () => {
    const conflicts = detectConflicts([
      session({
        id: 'a',
        roomId: 'room-a',
        startMin: at('09:00'),
        durationMin: 60,
        speakerIds: ['ada'],
      }),
      session({
        id: 'b',
        roomId: 'room-b',
        startMin: at('09:00'),
        durationMin: 60,
        speakerIds: ['grace'],
      }),
    ])

    expect(conflicts).toEqual([])
  })
})

describe('detectConflicts — unscheduled sessions', () => {
  it('ignores sessions with no room and no start', () => {
    const conflicts = detectConflicts([
      session({ id: 'a', roomId: 'room-a', startMin: at('09:00'), durationMin: 60, speakerIds: ['ada'] }),
      session({ id: 'b', speakerIds: ['ada'], durationMin: 60 }),
      session({ id: 'c', speakerIds: ['ada'], durationMin: 60 }),
    ])

    expect(conflicts).toEqual([])
  })

  it('ignores a half-placed session (room but no time, or time but no room)', () => {
    const conflicts = detectConflicts([
      session({ id: 'a', roomId: 'room-a', startMin: at('09:00'), durationMin: 60, speakerIds: ['ada'] }),
      session({ id: 'b', roomId: 'room-a', startMin: null, durationMin: 60, speakerIds: ['ada'] }),
      session({ id: 'c', roomId: null, startMin: at('09:00'), durationMin: 60, speakerIds: ['ada'] }),
    ])

    expect(conflicts).toEqual([])
  })

  it('returns nothing for an empty schedule', () => {
    expect(detectConflicts([])).toEqual([])
  })
})

describe('conflictsForSession — the drag-time delta', () => {
  const others: SpikeSession[] = [
    session({
      id: 'keynote',
      roomId: 'room-a',
      startMin: at('09:30'),
      durationMin: 45,
      speakerIds: ['ada'],
    }),
    session({
      id: 'workshop',
      roomId: 'room-b',
      startMin: at('11:00'),
      durationMin: 60,
      speakerIds: ['grace'],
    }),
    session({ id: 'unplaced', speakerIds: ['ada'], durationMin: 30 }),
  ]

  it('finds the conflicts a candidate placement would introduce', () => {
    const candidate = session({
      id: 'candidate',
      roomId: 'room-b',
      startMin: at('09:30'),
      durationMin: 30,
      speakerIds: ['ada'],
    })

    const conflicts = conflictsForSession(candidate, others, LABELS)
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0].detail).toBe('Ada Lovelace is in two rooms at 09:30')
  })

  it('returns nothing for a clean placement', () => {
    const candidate = session({
      id: 'candidate',
      roomId: 'room-a',
      startMin: at('10:15'),
      durationMin: 45,
      speakerIds: ['ada'],
    })

    expect(conflictsForSession(candidate, others, LABELS)).toEqual([])
  })

  it('never compares a session with itself', () => {
    const placed = others[0]
    expect(conflictsForSession(placed, others, LABELS)).toEqual([])
  })

  it('returns nothing when the candidate is not placed', () => {
    expect(conflictsForSession(session({ id: 'x', speakerIds: ['ada'] }), others)).toEqual([])
  })

  it('agrees with the full sweep for the same schedule', () => {
    const moved = { ...others[1], roomId: 'room-a', startMin: at('09:30') }
    const full = detectConflicts([others[0], moved, others[2]], LABELS)
    const delta = conflictsForSession(moved, others, LABELS)

    expect(delta.map((c) => c.type)).toEqual(full.map((c) => c.type))
    expect(delta.map((c) => c.detail)).toEqual(full.map((c) => c.detail))
  })
})

describe('assignLanes — side-by-side layout inside one room', () => {
  function placed(id: string, start: string, durationMin: number): ScheduledSession {
    return { ...session({ id, durationMin }), roomId: 'room-a', startMin: at(start) }
  }

  it('gives a single lane to sessions that never overlap', () => {
    const lanes = assignLanes([placed('a', '09:00', 30), placed('b', '09:30', 30)])
    expect([...lanes.values()]).toEqual([
      { lane: 0, lanes: 1 },
      { lane: 0, lanes: 1 },
    ])
  })

  it('splits two overlapping sessions into two lanes', () => {
    const lanes = assignLanes([placed('a', '09:00', 60), placed('b', '09:30', 30)])
    expect(lanes.get('a')).toEqual({ lane: 0, lanes: 2 })
    expect(lanes.get('b')).toEqual({ lane: 1, lanes: 2 })
  })

  it('shares one cluster width across transitively overlapping sessions', () => {
    // a overlaps b, b overlaps c, a does not overlap c — still one cluster.
    const lanes = assignLanes([placed('a', '09:00', 45), placed('b', '09:30', 45), placed('c', '10:00', 30)])
    expect([...lanes.values()].map((l) => l.lanes)).toEqual([2, 2, 2])
    expect(lanes.get('c')?.lane).toBe(0)
  })

  it('starts a fresh cluster once the room clears', () => {
    const lanes = assignLanes([placed('a', '09:00', 60), placed('b', '09:15', 30), placed('c', '11:00', 30)])
    expect(lanes.get('a')?.lanes).toBe(2)
    expect(lanes.get('c')).toEqual({ lane: 0, lanes: 1 })
  })

  it('handles an empty room', () => {
    expect(assignLanes([]).size).toBe(0)
  })
})

describe('helpers', () => {
  it('collects every session id touched by a conflict', () => {
    const conflicts = detectConflicts([
      session({ id: 'a', roomId: 'room-a', startMin: at('09:00'), durationMin: 60 }),
      session({ id: 'b', roomId: 'room-a', startMin: at('09:30'), durationMin: 30 }),
      session({ id: 'c', roomId: 'room-b', startMin: at('09:00'), durationMin: 30 }),
    ])

    expect(conflictedSessionIds(conflicts)).toEqual(new Set(['a', 'b']))
  })

  it('round-trips slots and minutes', () => {
    expect(slotToMinutes(0)).toBe(at('09:00'))
    expect(slotToMinutes(2)).toBe(at('09:30'))
    expect(minutesToSlot(at('16:45'))).toBe(31)
    expect(formatMinutes(at('09:05'))).toBe('09:05')
    expect(formatMinutes(at('16:45'))).toBe('16:45')
  })

  it('clamps a placement so a session cannot spill past the end of the day', () => {
    expect(clampStartSlot(-3, { durationMin: 30 })).toBe(0)
    // 32 slots total; a 60-minute session (4 slots) can start no later than 28.
    expect(clampStartSlot(31, { durationMin: 60 })).toBe(28)
    expect(clampStartSlot(20, { durationMin: 60 })).toBe(20)
  })
})
