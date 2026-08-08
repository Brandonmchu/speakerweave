import { ApiError, request } from '@/lib/api'

export interface PortalContext {
  purpose: 'portal' | 'review'
  org_id: string
  contact_id?: string
  evaluator_id?: string
}

export function redeemToken(token: string): Promise<PortalContext> {
  return request<PortalContext>('/public/session/redeem', {
    method: 'POST',
    anonymous: true,
    credentials: 'include',
    body: { token },
  })
}

export async function fetchMe(): Promise<PortalContext | null> {
  try {
    return await request<PortalContext>('/public/session/me', {
      method: 'GET',
      anonymous: true,
      credentials: 'include',
    })
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) return null
    throw error
  }
}

/** Remove a redeemed path/query token without navigating or reloading. */
export function scrubTokenFromUrl(): void {
  const url = new URL(window.location.href)
  url.pathname = url.pathname.replace(/^\/(portal|review)\/[^/]+\/?$/, '/$1')
  url.searchParams.delete('token')
  window.history.replaceState(
    window.history.state,
    document.title,
    `${url.pathname}${url.search}${url.hash}`
  )
}
