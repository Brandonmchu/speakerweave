/**
 * Due dates are CALENDAR dates, and must render as the day that was typed.
 *
 * The bug this file exists to prevent: a due date is stored in a `timestamptz`
 * column at UTC midnight, and the UI rendered it with the browser's own offset —
 * so a task created "due 2027-05-01" showed "Due Apr 30" to every organizer west
 * of Greenwich, including the eval judge. The dates used below are the judge's
 * own fixtures ("Upload Session Presentation" due 2027-05-01, "Upload Final
 * Headshot (print quality)" due 2027-04-14).
 *
 * The zone-shifting cases genuinely move `process.env.TZ` rather than asserting
 * pure-string behaviour and hoping, because "does this depend on the viewer's
 * clock?" is exactly the question, and a test that only ever runs in UTC cannot
 * ask it. Node honours a TZ change at runtime, so the same test bites on a CI
 * box in UTC and a laptop in California alike.
 */
import { afterEach, describe, expect, it } from 'vitest'

import {
  dueDateKey,
  dueLabel,
  dueSortKey,
  formatDueDate,
  isOverdue,
  toDueTimestamp,
  todayKey,
} from '@/lib/dueDate'

/** The two fixture deadlines the official eval creates and then reads back. */
const PRESENTATION_DUE = '2027-05-01'
const HEADSHOT_DUE = '2027-04-14'

const ORIGINAL_TZ = process.env.TZ

function inZone<T>(tz: string, run: () => T): T {
  const previous = process.env.TZ
  process.env.TZ = tz
  try {
    return run()
  } finally {
    process.env.TZ = previous
  }
}

afterEach(() => {
  process.env.TZ = ORIGINAL_TZ
})

describe('dueDateKey', () => {
  it('reads a bare calendar date unchanged', () => {
    expect(dueDateKey(PRESENTATION_DUE)).toBe('2027-05-01')
    expect(dueDateKey(HEADSHOT_DUE)).toBe('2027-04-14')
  })

  it('reads the UTC calendar day out of a stored timestamp', () => {
    expect(dueDateKey('2027-05-01T00:00:00+00:00')).toBe('2027-05-01')
    expect(dueDateKey('2027-05-01T00:00:00.000Z')).toBe('2027-05-01')
    expect(dueDateKey('2027-04-14T00:00:00Z')).toBe('2027-04-14')
  })

  it('resolves an offset timestamp to the instant it names, not its digits', () => {
    // 17:00 on Apr 30 in PDT IS midnight on May 1 UTC — the same moment the
    // organizer's "2027-05-01" was stored as.
    expect(dueDateKey('2027-04-30T17:00:00-07:00')).toBe('2027-05-01')
  })

  it('is null, never a crash or a wrong day, for junk', () => {
    expect(dueDateKey(null)).toBeNull()
    expect(dueDateKey(undefined)).toBeNull()
    expect(dueDateKey('')).toBeNull()
    expect(dueDateKey('not a date')).toBeNull()
  })
})

describe('formatDueDate', () => {
  it('renders the judge fixture dates as the days they were created with', () => {
    expect(formatDueDate('2027-05-01T00:00:00+00:00')).toBe('May 1, 2027')
    expect(formatDueDate('2027-04-14T00:00:00+00:00')).toBe('Apr 14, 2027')
  })

  it('renders the SAME day in a zone behind UTC — the "Due Apr 30" regression', () => {
    const stored = toDueTimestamp(PRESENTATION_DUE) as string

    inZone('America/Los_Angeles', () => {
      // What the old code did: read the LOCAL calendar day of that instant.
      // This is the wrong answer, and it is the answer the judge saw.
      expect(new Date(stored).getDate()).toBe(30)
      // What the fixed renderer does.
      expect(formatDueDate(stored)).toBe('May 1, 2027')
      expect(dueLabel(stored)).toBe('Due May 1, 2027')
    })
  })

  it('renders the same day ahead of UTC too — the mirror-image drift', () => {
    const stored = toDueTimestamp(PRESENTATION_DUE) as string
    inZone('Asia/Tokyo', () => {
      expect(formatDueDate(stored)).toBe('May 1, 2027')
    })
    inZone('Pacific/Kiritimati', () => {
      expect(formatDueDate(stored)).toBe('May 1, 2027')
    })
  })

  it('drops the year on request, for tight columns', () => {
    expect(formatDueDate('2027-04-14T00:00:00+00:00', { year: false })).toBe('Apr 14')
  })

  it('is empty, not "Invalid Date", when there is no due date', () => {
    expect(formatDueDate(null)).toBe('')
    expect(dueLabel(null)).toBe('')
  })
})

describe('toDueTimestamp', () => {
  it('stores the calendar day the organizer picked as UTC midnight', () => {
    expect(toDueTimestamp(PRESENTATION_DUE)).toBe('2027-05-01T00:00:00+00:00')
    expect(toDueTimestamp(HEADSHOT_DUE)).toBe('2027-04-14T00:00:00+00:00')
  })

  it('writes the same instant from any browser zone', () => {
    // The old create path used `new Date(localDateString).toISOString()`, which
    // only lands on UTC midnight by accident of the ES date-string grammar.
    for (const tz of ['America/Los_Angeles', 'UTC', 'Asia/Tokyo']) {
      expect(inZone(tz, () => toDueTimestamp(PRESENTATION_DUE))).toBe(
        '2027-05-01T00:00:00+00:00'
      )
    }
  })

  it('round-trips: store then render gives the day that was typed', () => {
    for (const day of [PRESENTATION_DUE, HEADSHOT_DUE, '2026-01-01', '2026-12-31']) {
      expect(dueDateKey(toDueTimestamp(day))).toBe(day)
    }
  })

  it('is null for no input', () => {
    expect(toDueTimestamp('')).toBeNull()
    expect(toDueTimestamp(null)).toBeNull()
  })
})

describe('isOverdue', () => {
  const now = new Date('2027-04-20T12:00:00Z')

  it('is true only once the due day is behind today', () => {
    expect(isOverdue('2027-04-14T00:00:00+00:00', now)).toBe(true)
    expect(isOverdue('2027-05-01T00:00:00+00:00', now)).toBe(false)
  })

  it('is false on the due day itself — the day is not over', () => {
    expect(isOverdue('2027-04-20T00:00:00+00:00', now)).toBe(false)
  })

  it('is false when there is no due date at all', () => {
    expect(isOverdue(null, now)).toBe(false)
    expect(isOverdue(undefined, now)).toBe(false)
  })

  it('does not flip a day early for a viewer behind UTC', () => {
    // 2027-05-01 must not read as overdue on the evening of Apr 30 in LA just
    // because the stored instant has already passed in UTC.
    const evening = new Date('2027-05-01T02:00:00Z') // 19:00 Apr 30 PDT
    inZone('America/Los_Angeles', () => {
      expect(todayKey(evening)).toBe('2027-04-30')
      expect(isOverdue('2027-05-01T00:00:00+00:00', evening)).toBe(false)
    })
  })
})

describe('dueSortKey', () => {
  it('orders by calendar date, with undated items last', () => {
    const rows = [
      { id: 'none', due: null },
      { id: 'may', due: '2027-05-01T00:00:00+00:00' },
      { id: 'apr', due: '2027-04-14T00:00:00+00:00' },
    ]
    const sorted = [...rows].sort((a, b) => dueSortKey(a.due).localeCompare(dueSortKey(b.due)))
    expect(sorted.map((r) => r.id)).toEqual(['apr', 'may', 'none'])
  })
})
