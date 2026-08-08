import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { recipientsPreview, sendCommunication } from '@/lib/commsApi'

interface Call {
  url: string
  method?: string
  body?: unknown
  headers: Headers
}

let calls: Call[] = []
let nextPayload: unknown = {}

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
        headers: new Headers(init.headers),
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

describe('communications endpoints', () => {
  it('encodes repeated role and status filters in the recipients-preview URL', async () => {
    nextPayload = { count: 3, sample: ['Ada Lovelace'] }

    const result = await recipientsPreview('event/one', {
      roles: ['speaker', 'moderator'],
      statuses: ['accepted'],
    })

    expect(calls[0].url).toBe(
      '/api/events/event%2Fone/comms/recipients-preview?roles=speaker&roles=moderator&statuses=accepted'
    )
    expect(calls[0].method).toBe('GET')
    expect(calls[0].headers.get('Authorization')).toBe('Bearer test-token')
    expect(result.count).toBe(3)
  })

  it('posts a template send under the event', async () => {
    nextPayload = { sent: 2, failed: 0, total: 2 }

    await sendCommunication('event-1', {
      template_key: 'reminder',
      audience: { roles: ['speaker'], statuses: ['accepted'] },
    })

    expect(calls[0]).toMatchObject({
      url: '/api/events/event-1/comms/send',
      method: 'POST',
      body: {
        template_key: 'reminder',
        audience: { roles: ['speaker'], statuses: ['accepted'] },
      },
    })
  })
})
