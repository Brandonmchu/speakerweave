/**
 * The browser detector and the server detector, held to one fixture file.
 *
 * `lib/schedule.ts` runs while a card is being dragged, so the ghost can go red
 * before the drop; `api/services/scheduling.py` runs on load and is the
 * authority. Two implementations of one rule silently drift — a half-open
 * comparison flipped to closed on one side, a detail string reworded on the
 * other — and the grid starts disagreeing with its own server.
 *
 * So both read api/tests/fixtures/schedule_conflicts.json. api/tests/
 * test_schedule.py runs the same cases against the Python copy; if either side
 * changes without the other, one of the two suites goes red.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import { detectConflicts, type ScheduleLabels, type SpikeSession } from '@/lib/schedule'

interface FixtureSession {
  id: string
  room_id: string
  start_min: number
  duration_min: number
  speaker_ids?: string[]
}

interface FixtureCase {
  name: string
  sessions: FixtureSession[]
  expected: Array<{ type: string; session_ids: string[]; detail: string }>
  labels?: ScheduleLabels | null
}

interface Fixture {
  labels: ScheduleLabels
  cases: FixtureCase[]
}

// Relative to vitest's root, which is web/. `import.meta.url` is not a file URL
// under the jsdom environment, so it cannot be used to locate this.
const FIXTURE_PATH = resolve(process.cwd(), '../api/tests/fixtures/schedule_conflicts.json')

const FIXTURE: Fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'))

function toSession(row: FixtureSession): SpikeSession {
  return {
    id: row.id,
    title: `Session ${row.id}`,
    speakerIds: row.speaker_ids ?? [],
    durationMin: row.duration_min,
    color: 'indigo',
    roomId: row.room_id,
    startMin: row.start_min,
  }
}

describe('detectConflicts matches the shared fixture', () => {
  it('has cases to run', () => {
    expect(FIXTURE.cases.length).toBeGreaterThan(0)
  })

  for (const testCase of FIXTURE.cases) {
    it(testCase.name, () => {
      const labels = 'labels' in testCase ? (testCase.labels ?? {}) : FIXTURE.labels
      const found = detectConflicts(testCase.sessions.map(toSession), labels).map((conflict) => ({
        type: conflict.type,
        session_ids: [...conflict.sessionIds],
        detail: conflict.detail,
      }))
      expect(found).toEqual(testCase.expected)
    })
  }
})
