import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  buildScheduleIcs,
  buildSessionIcs,
  embedIframeSnippet,
  embedScriptSnippet,
  embedScriptUrl,
  formatTimeZoneNote,
  getProgramSchedule,
  getProgramSession,
  getProgramSpeakers,
  publicProgramPath,
  publicProgramUrl,
  readStarredIds,
  toggleStarredId,
  writeStarredIds,
} from '@/lib/programApi'

interface Call {
  url: string
  method?: string
  headers: Headers
}

let calls: Call[] = []
let nextPayload: unknown = {}

function stubFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      calls.push({ url: String(url), method: init.method, headers: new Headers(init.headers) })
      return new Response(JSON.stringify(nextPayload), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    })
  )
}

const last = () => calls[calls.length - 1]

beforeEach(() => {
  calls = []
  nextPayload = {}
  stubFetch()
})

afterEach(() => {
  vi.unstubAllGlobals()
  window.localStorage.clear()
})

describe('program API fetchers', () => {
  it('getProgramSchedule GETs the public path with the tz query and no auth header', async () => {
    // Even with an admin token present, /public paths must go out anonymous.
    window.localStorage.setItem('dais.token', 'admin-token')
    nextPayload = { event: { name: 'X', timezone: 'UTC' }, days: [] }

    await getProgramSchedule('ai-builders-summit', 'America/New_York')

    expect(last().url).toBe(
      '/public/program/ai-builders-summit/schedule?tz=America%2FNew_York'
    )
    expect(last().method).toBe('GET')
    expect(last().headers.has('Authorization')).toBe(false)
  })

  it('getProgramSchedule omits the tz query when none is given', async () => {
    nextPayload = { event: { name: 'X' }, days: [] }
    await getProgramSchedule('my-event')
    expect(last().url).toBe('/public/program/my-event/schedule')
  })

  it('getProgramSpeakers GETs the public speakers path anonymously', async () => {
    nextPayload = { event: { name: 'X' }, speakers: [] }
    await getProgramSpeakers('ai-builders-summit')
    expect(last().url).toBe('/public/program/ai-builders-summit/speakers')
    expect(last().headers.has('Authorization')).toBe(false)
  })

  it('getProgramSession GETs the public session-detail path anonymously', async () => {
    window.localStorage.setItem('dais.token', 'admin-token')
    nextPayload = { event: { name: 'X', timezone: 'UTC', location: null }, session: {} }
    await getProgramSession('ai-builders-summit', 'sess-1')
    expect(last().url).toBe('/public/program/ai-builders-summit/session/sess-1')
    expect(last().method).toBe('GET')
    expect(last().headers.has('Authorization')).toBe(false)
  })

  it('getProgramSchedule sends no tz — the page renders in the event zone', async () => {
    nextPayload = { event: { name: 'X', timezone: 'America/Los_Angeles' }, days: [] }
    await getProgramSchedule('ai-builders-summit')
    // No ?tz query: the API falls back to the event's own timezone.
    expect(last().url).toBe('/public/program/ai-builders-summit/schedule')
  })
})

describe('formatTimeZoneNote', () => {
  it('names the zone the times are shown in', () => {
    expect(formatTimeZoneNote('UTC', '2026-10-12T16:00:00Z')).toContain('UTC')
    expect(formatTimeZoneNote('America/Los_Angeles', '2026-10-12T16:00:00Z')).toContain(
      'America/Los_Angeles'
    )
  })

  it('is empty when there is no zone', () => {
    expect(formatTimeZoneNote(null)).toBe('')
    expect(formatTimeZoneNote(undefined)).toBe('')
  })
})

describe('buildSessionIcs', () => {
  it('emits a single VEVENT with UTC times and RFC 5545-escaped text', () => {
    const ics = buildSessionIcs(
      {
        id: 's1',
        friendly_id: 'SESS-1',
        title: 'RAG; in, Prod',
        description: 'Line one\nLine two',
        starts_at: '2026-10-12T16:00:00+00:00',
        ends_at: '2026-10-12T16:45:00+00:00',
        location: 'Room A',
      },
      new Date('2026-01-01T00:00:00Z')
    )
    expect(ics).toContain('BEGIN:VCALENDAR')
    expect(ics).toContain('BEGIN:VEVENT')
    expect(ics).toContain('UID:SESS-1@dais')
    expect(ics).toContain('DTSTART:20261012T160000Z')
    expect(ics).toContain('DTEND:20261012T164500Z')
    expect(ics).toContain('SUMMARY:RAG\\; in\\, Prod')
    expect(ics).toContain('DESCRIPTION:Line one\\nLine two')
    expect(ics).toContain('LOCATION:Room A')
    expect(ics.endsWith('END:VCALENDAR')).toBe(true)
  })

  it('falls back to a one-hour block when no end time is given', () => {
    const ics = buildSessionIcs({
      id: 's2',
      title: 'Open Mic',
      starts_at: '2026-10-12T16:00:00+00:00',
      ends_at: null,
    })
    expect(ics).toContain('DTSTART:20261012T160000Z')
    expect(ics).toContain('DTEND:20261012T170000Z')
  })

  it('returns an empty string for a session with no start', () => {
    expect(buildSessionIcs({ id: 's', title: 'x', starts_at: null, ends_at: null })).toBe('')
  })
})

describe('buildScheduleIcs (my schedule export)', () => {
  it('wraps every session in one VCALENDAR with a VEVENT each', () => {
    const ics = buildScheduleIcs(
      [
        { id: 's1', friendly_id: 'SESS-1', title: 'Keynote', starts_at: '2026-10-12T16:00:00+00:00', ends_at: '2026-10-12T16:45:00+00:00' },
        { id: 's2', friendly_id: 'SESS-2', title: 'Vector DBs', starts_at: '2026-10-12T17:00:00+00:00', ends_at: '2026-10-12T17:30:00+00:00' },
      ],
      new Date('2026-01-01T00:00:00Z')
    )
    // One calendar envelope…
    expect(ics.match(/BEGIN:VCALENDAR/g)).toHaveLength(1)
    expect(ics.match(/END:VCALENDAR/g)).toHaveLength(1)
    // …two events inside it.
    expect(ics.match(/BEGIN:VEVENT/g)).toHaveLength(2)
    expect(ics).toContain('SUMMARY:Keynote')
    expect(ics).toContain('SUMMARY:Vector DBs')
    expect(ics).toContain('UID:SESS-1@dais')
    expect(ics).toContain('UID:SESS-2@dais')
    expect(ics.endsWith('END:VCALENDAR')).toBe(true)
  })

  it('skips sessions with no start and returns "" when none remain', () => {
    const ics = buildScheduleIcs([
      { id: 'a', title: 'Placed', starts_at: '2026-10-12T16:00:00+00:00', ends_at: null },
      { id: 'b', title: 'Unplaced', starts_at: null, ends_at: null },
    ])
    expect(ics.match(/BEGIN:VEVENT/g)).toHaveLength(1)
    expect(buildScheduleIcs([{ id: 'b', title: 'Unplaced', starts_at: null, ends_at: null }])).toBe('')
    expect(buildScheduleIcs([])).toBe('')
  })
})

describe('public links + embed snippets (EMB-15)', () => {
  const SLUG = 'ai-builders-summit'
  const origin = () => window.location.origin

  it('builds the two public page URLs', () => {
    expect(publicProgramPath(SLUG)).toBe('/e/ai-builders-summit/schedule')
    expect(publicProgramPath(SLUG, 'speakers')).toBe('/e/ai-builders-summit/speakers')
    expect(publicProgramUrl(SLUG)).toBe(`${origin()}/e/ai-builders-summit/schedule`)
  })

  it('points the loader at the route the API actually serves', () => {
    // GET /public/program/{slug}/embed.js — same origin as the /e/ pages, which
    // is what the loader derives the iframe src from.
    expect(embedScriptUrl(SLUG)).toBe(
      `${origin()}/public/program/ai-builders-summit/embed.js`
    )
  })

  it('emits a script snippet carrying the loader’s data-* contract', () => {
    const snippet = embedScriptSnippet(SLUG, 'speakers')
    expect(snippet).toContain(`<script src="${embedScriptUrl(SLUG)}"`)
    expect(snippet).toContain('data-dais-event="ai-builders-summit"')
    expect(snippet).toContain('data-dais-widget="speakers"')
    expect(snippet.trimEnd().endsWith('</script>')).toBe(true)
    // async/defer would null out document.currentScript inside the loader.
    expect(snippet).not.toMatch(/\basync\b|\bdefer\b/)
  })

  it('attribute-escapes a hostile slug so the snippet stays inert markup', () => {
    const hostile = 'x" onload="alert(1)></script><script>evil()'
    const snippet = embedScriptSnippet(hostile)
    // The raw quote/angle characters must never survive into the attribute:
    // everything after `data-dais-event="` up to the widget attr is entity-safe.
    const attr = snippet.split('data-dais-event="')[1].split('"\n')[0]
    expect(attr).not.toMatch(/["<>]/)
    expect(attr).toContain('&quot;')
    expect(attr).toContain('&lt;')
    // And the URL half is percent-encoded by encodeURIComponent.
    expect(snippet).toContain(encodeURIComponent(hostile))
  })

  it('emits an iframe snippet in embed mode with a sane default height', () => {
    const snippet = embedIframeSnippet(SLUG)
    expect(snippet).toContain(`src="${origin()}/e/ai-builders-summit/schedule?embed=1"`)
    expect(snippet).toContain('style="width:100%;height:600px;border:0"')
    expect(snippet.trimEnd().endsWith('</iframe>')).toBe(true)
  })

  it('escapes a slug that would otherwise break the URL', () => {
    expect(publicProgramUrl('a b')).toBe(`${origin()}/e/a%20b/schedule`)
    expect(embedScriptUrl('a b')).toBe(`${origin()}/public/program/a%20b/embed.js`)
  })
})

describe('personal schedule (localStorage stars)', () => {
  const SLUG = 'ai-builders-summit'

  it('starts empty and round-trips a written selection', () => {
    expect(readStarredIds(SLUG)).toEqual([])
    writeStarredIds(SLUG, ['sess-1', 'sess-2', 'sess-1'])
    // De-duplicated on write.
    expect(readStarredIds(SLUG)).toEqual(['sess-1', 'sess-2'])
  })

  it('toggles an id on and off, returning the new list', () => {
    expect(toggleStarredId(SLUG, 'sess-1')).toEqual(['sess-1'])
    expect(readStarredIds(SLUG)).toEqual(['sess-1'])
    expect(toggleStarredId(SLUG, 'sess-1')).toEqual([])
    expect(readStarredIds(SLUG)).toEqual([])
  })

  it('keeps each event slug isolated', () => {
    toggleStarredId('event-a', 'x')
    expect(readStarredIds('event-a')).toEqual(['x'])
    expect(readStarredIds('event-b')).toEqual([])
  })

  it('tolerates corrupt stored JSON', () => {
    window.localStorage.setItem('dais.mySchedule.broken', '{not json')
    expect(readStarredIds('broken')).toEqual([])
  })
})
