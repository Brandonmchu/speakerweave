import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  addContentComment,
  contentExportPath,
  fetchContentBundle,
  getContentItem,
  listContent,
  postPortalComment,
  remindOutstanding,
  restoreContentVersion,
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

  it('restoreContentVersion POSTs the version to restore', async () => {
    nextPayload = {
      item: {},
      versions: [],
      comments: [],
      restored: { version: 1, file_id: 'f1', changed: true },
    }
    const result = await restoreContentVersion('assign-9', 1)
    expect(last().url).toBe('/api/task-assignments/assign-9/restore')
    expect(last().method).toBe('POST')
    expect(JSON.parse(String(last().body))).toEqual({ version: 1 })
    expect(result.restored.version).toBe(1)
  })

  it('contentExportPath builds the authed export path', () => {
    expect(contentExportPath('e1')).toBe('/api/events/e1/content/export')
  })

  it('contentExportPath appends only the ids that were picked', () => {
    expect(contentExportPath('e1', ['a1', 'a2'])).toBe(
      '/api/events/e1/content/export?assignment_ids=a1%2Ca2'
    )
    // An empty selection means "the whole event", not "an empty bundle".
    expect(contentExportPath('e1', [])).toBe('/api/events/e1/content/export')
  })

  it('fetchContentBundle downloads a blob with the bearer token', async () => {
    nextBlob = new Blob(['PKzip'], { type: 'application/zip' })
    const blob = await fetchContentBundle('e1')
    expect(last().url).toBe('/api/events/e1/content/export')
    expect(last().headers.get('Authorization')).toBe('Bearer admin-token')
    // Realm-agnostic Blob check: on Node 20 the fetch mock's Blob comes from a
    // different global than the test's, so instanceof fails while the value is
    // a perfectly good Blob. Assert the contract instead of the constructor.
    expect(typeof blob.size).toBe('number')
    expect(blob.size).toBeGreaterThan(0)
    expect(typeof blob.type).toBe('string')
  })

  it('fetchContentBundle carries the selected ids through to the request', async () => {
    nextBlob = new Blob(['PKzip'], { type: 'application/zip' })
    await fetchContentBundle('e1', ['a1', 'a2'])
    expect(last().url).toBe('/api/events/e1/content/export?assignment_ids=a1%2Ca2')
    expect(last().headers.get('Authorization')).toBe('Bearer admin-token')
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
