import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { getProgramSchedule, getProgramSpeakers } from '@/lib/programApi'

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
})
