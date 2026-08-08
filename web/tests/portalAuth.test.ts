import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  fetchMe,
  redeemToken,
  scrubTokenFromUrl,
  type PortalContext,
} from '@/lib/portalAuth'

interface FetchCall {
  url: string
  init: RequestInit
}

let calls: FetchCall[] = []
let status = 200
let payload: unknown = {}

beforeEach(() => {
  calls = []
  status = 200
  payload = {}
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      calls.push({ url: String(url), init })
      return new Response(JSON.stringify(payload), {
        status,
        headers: { 'Content-Type': 'application/json' },
      })
    })
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
  window.history.replaceState({}, '', '/')
})

describe('portal auth', () => {
  it('redeems anonymously while including credentials', async () => {
    payload = { purpose: 'portal', org_id: 'org-1', contact_id: 'contact-1' }

    const context: PortalContext = await redeemToken('raw-token')

    expect(context).toEqual(payload)
    expect(calls[0].url).toBe('/public/session/redeem')
    expect(calls[0].init.method).toBe('POST')
    expect(calls[0].init.credentials).toBe('include')
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ token: 'raw-token' })
    expect(new Headers(calls[0].init.headers).has('Authorization')).toBe(false)
  })

  it('maps an unauthenticated me response to null', async () => {
    status = 401
    payload = { detail: 'expired' }

    expect(await fetchMe()).toBeNull()
    expect(calls[0].url).toBe('/public/session/me')
    expect(calls[0].init.credentials).toBe('include')
  })

  it('scrubs path and query tokens without reloading', () => {
    window.history.replaceState(
      { retained: true },
      '',
      '/review/raw-secret?token=query-secret&source=email#ready'
    )

    scrubTokenFromUrl()

    expect(window.location.pathname).toBe('/review')
    expect(window.location.search).toBe('?source=email')
    expect(window.location.hash).toBe('#ready')
    expect(window.history.state).toEqual({ retained: true })
  })
})
