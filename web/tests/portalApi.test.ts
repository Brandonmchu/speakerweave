import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  completePortalTask,
  fetchPortalMe,
  updatePortalProfile,
  uploadPortalHeadshot,
  uploadPortalTaskFile,
} from '@/lib/portalApi'
import {
  createSpeakerTask,
  listEventSpeakers,
  reviewTaskAssignment,
  sendPortalInvite,
} from '@/lib/speakersApi'

interface Call {
  url: string
  method?: string
  credentials?: RequestCredentials
  body: unknown
  headers: Headers
}

let calls: Call[] = []
let nextPayload: unknown = {}

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

describe('public portal fetchers', () => {
  it('fetchPortalMe GETs with the cookie and no bearer token', async () => {
    nextPayload = { contact: {}, event: {}, portal: {}, sessions: [], tasks: [] }
    await fetchPortalMe()
    expect(last().url).toBe('/public/portal/me')
    expect(last().method).toBe('GET')
    expect(last().credentials).toBe('include')
    expect(last().headers.has('Authorization')).toBe(false)
  })

  it('updatePortalProfile PATCHes the sanitized fields', async () => {
    nextPayload = { contact: {} }
    await updatePortalProfile({ about: 'hi', title: 'Engineer' })
    expect(last().url).toBe('/public/portal/profile')
    expect(last().method).toBe('PATCH')
    expect(last().credentials).toBe('include')
    expect(JSON.parse(String(last().body))).toEqual({ about: 'hi', title: 'Engineer' })
  })

  it('completePortalTask POSTs to the assignment', async () => {
    await completePortalTask('assign-1')
    expect(last().url).toBe('/public/portal/tasks/assign-1/complete')
    expect(last().method).toBe('POST')
    expect(last().credentials).toBe('include')
  })

  it('uploadPortalTaskFile sends multipart with the cookie', async () => {
    nextPayload = { status: 'submitted', file: { filename: 'a.pdf', url: 'u' } }
    await uploadPortalTaskFile('assign-2', new File(['x'], 'a.pdf', { type: 'application/pdf' }))
    expect(last().url).toBe('/public/portal/tasks/assign-2/upload')
    expect(last().method).toBe('POST')
    expect(last().credentials).toBe('include')
    expect(last().body).toBeInstanceOf(FormData)
    // never JSON-encode a multipart upload
    expect(last().headers.has('Content-Type')).toBe(false)
  })

  it('uploadPortalHeadshot posts a headshot form', async () => {
    nextPayload = { photo_url: 'https://cdn/x.png' }
    const result = await uploadPortalHeadshot(new File(['x'], 'me.png', { type: 'image/png' }))
    expect(result.photo_url).toBe('https://cdn/x.png')
    expect(last().url).toBe('/public/portal/headshot')
    expect(last().body).toBeInstanceOf(FormData)
  })
})

describe('admin speaker fetchers', () => {
  beforeEach(() => {
    window.localStorage.setItem('dais.token', 'admin-token')
  })

  it('listEventSpeakers GETs with the bearer token', async () => {
    nextPayload = { event: { id: 'e1' }, speakers: [] }
    await listEventSpeakers('e1')
    expect(last().url).toBe('/api/events/e1/speakers')
    expect(last().headers.get('Authorization')).toBe('Bearer admin-token')
  })

  it('sendPortalInvite POSTs to the contact', async () => {
    nextPayload = { ok: true }
    await sendPortalInvite('c1')
    expect(last().url).toBe('/api/contacts/c1/portal-invite')
    expect(last().method).toBe('POST')
  })

  it('createSpeakerTask POSTs the task payload', async () => {
    nextPayload = { task: { id: 't1' }, assignments_created: 2 }
    await createSpeakerTask('e1', { name: 'Slides', kind: 'file_request', contact_ids: ['a', 'b'] })
    expect(last().url).toBe('/api/events/e1/tasks')
    expect(JSON.parse(String(last().body))).toMatchObject({
      name: 'Slides',
      kind: 'file_request',
      contact_ids: ['a', 'b'],
    })
  })

  it('reviewTaskAssignment PATCHes the decision', async () => {
    nextPayload = { assignment: { id: 'x', status: 'denied' } }
    await reviewTaskAssignment('x', 'denied')
    expect(last().url).toBe('/api/task-assignments/x/review')
    expect(last().method).toBe('PATCH')
    expect(JSON.parse(String(last().body))).toEqual({ decision: 'denied' })
  })
})
