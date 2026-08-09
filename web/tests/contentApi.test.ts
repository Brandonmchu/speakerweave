import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  addContentComment,
  contentExportPath,
  fetchContentBundle,
  getContentItem,
  listContent,
  postPortalComment,
  remindOutstanding,
} from '@/lib/contentApi'

interface Call {
  url: string
  method?: string
  credentials?: RequestCredentials
  body: unknown
  headers: Headers
}

let calls: Call[] = []
let nextPayload: unknown = {}
let nextBlob: Blob | null = null

function stubFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      calls.push({
        url: String(url),
        method: init.method,
        credentials: init.credentials,
        body: init.body,
        headers: new Headers(init.headers),
      })
      if (nextBlob) {
        return new Response(nextBlob, { status: 200 })
      }
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
  nextBlob = null
  window.localStorage.setItem('dais.token', 'admin-token')
  stubFetch()
})

afterEach(() => {
  vi.unstubAllGlobals()
  window.localStorage.clear()
})

describe('organizer content library fetchers', () => {
  it('listContent encodes only the filters that are set, with the bearer token', async () => {
    nextPayload = { event: { id: 'e1' }, items: [], counts: {}, outstanding: [] }
    await listContent('e1', { type: 'slides', status: 'all' })
    expect(last().url).toBe('/api/events/e1/content?type=slides')
    expect(last().method).toBe('GET')
    expect(last().headers.get('Authorization')).toBe('Bearer admin-token')
  })

  it('listContent omits the query string entirely when unfiltered', async () => {
    nextPayload = { event: { id: 'e1' }, items: [], counts: {}, outstanding: [] }
    await listContent('e1')
    expect(last().url).toBe('/api/events/e1/content')
  })

  it('getContentItem GETs the item detail', async () => {
    nextPayload = { item: {}, versions: [], comments: [] }
    await getContentItem('assign-9')
    expect(last().url).toBe('/api/task-assignments/assign-9/content')
    expect(last().method).toBe('GET')
  })

  it('addContentComment POSTs body + notify', async () => {
    nextPayload = { comment: { id: 'k1' } }
    await addContentComment('assign-9', 'headshot too low-res')
    expect(last().url).toBe('/api/task-assignments/assign-9/comments')
    expect(last().method).toBe('POST')
    expect(JSON.parse(String(last().body))).toEqual({ body: 'headshot too low-res', notify: true })
  })

  it('remindOutstanding POSTs the reminder options', async () => {
    nextPayload = { reminded: 3, contacts: ['a', 'b', 'c'] }
    const result = await remindOutstanding('e1', { required_only: true })
    expect(last().url).toBe('/api/events/e1/content/remind')
    expect(last().method).toBe('POST')
    expect(JSON.parse(String(last().body))).toEqual({ required_only: true })
    expect(result.reminded).toBe(3)
  })

  it('contentExportPath builds the authed export path', () => {
    expect(contentExportPath('e1')).toBe('/api/events/e1/content/export')
  })

  it('fetchContentBundle downloads a blob with the bearer token', async () => {
    nextBlob = new Blob(['PKzip'], { type: 'application/zip' })
    const blob = await fetchContentBundle('e1')
    expect(last().url).toBe('/api/events/e1/content/export')
    expect(last().headers.get('Authorization')).toBe('Bearer admin-token')
    expect(blob).toBeInstanceOf(Blob)
  })
})

describe('speaker portal reply', () => {
  beforeEach(() => {
    // No bearer — the speaker surface is cookie-only.
    window.localStorage.clear()
  })

  it('postPortalComment posts anonymously with the cookie', async () => {
    nextPayload = { comment: { id: 'c1', author_role: 'speaker' } }
    await postPortalComment('assign-2', 'fixed and re-uploaded')
    expect(last().url).toBe('/public/portal/tasks/assign-2/comments')
    expect(last().method).toBe('POST')
    expect(last().credentials).toBe('include')
    expect(last().headers.has('Authorization')).toBe(false)
    expect(JSON.parse(String(last().body))).toEqual({ body: 'fixed and re-uploaded' })
  })
})
