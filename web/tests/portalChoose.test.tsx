/**
 * The speaker's conference picker (`/portal/choose?token=…`).
 *
 * A speaker can be on several conferences run by different organizations, so
 * the emailed link resolves to a list rather than straight into a portal. What
 * matters: every conference is reachable and labelled with whose it is, the
 * pick posts that conference's own contact_id, and the two ways a mailed link
 * goes wrong (expired, or only one option) both end somewhere useful.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import App from '@/App'

const TOKEN = 'link-token-abc'

const CHOICES = [
  {
    contact_id: 'contact-1',
    org_id: 'org-alpha',
    org_name: 'Alpha Events',
    event_id: 'event-1',
    event_name: 'AI Builders Summit',
    starts_at: '2026-09-14T16:00:00Z',
    ends_at: '2026-09-16T23:00:00Z',
  },
  {
    contact_id: 'contact-2',
    org_id: 'org-alpha',
    org_name: 'Alpha Events',
    event_id: 'event-2',
    event_name: 'Alpha Devcon',
    starts_at: '2027-02-02T16:00:00Z',
    ends_at: '2027-02-03T23:00:00Z',
  },
  {
    contact_id: 'contact-3',
    org_id: 'org-beta',
    org_name: 'Beta Conferences',
    event_id: 'event-3',
    event_name: 'Beta World',
    starts_at: null,
    ends_at: null,
  },
]

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function LocationProbe() {
  const { pathname } = useLocation()
  return <div data-testid="pathname">{pathname}</div>
}

const pathname = () => screen.getByTestId('pathname').textContent

let choosePosts: Array<Record<string, unknown>>

function renderPicker(token: string | null = TOKEN) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 0 } },
  })
  const path = token === null ? '/portal/choose' : `/portal/choose?token=${token}`
  return render(
    <MemoryRouter initialEntries={[path]}>
      <QueryClientProvider client={queryClient}>
        <App />
        <LocationProbe />
      </QueryClientProvider>
    </MemoryRouter>
  )
}

beforeEach(() => {
  choosePosts = []
  window.localStorage.clear()
})

afterEach(() => {
  vi.unstubAllGlobals()
  window.localStorage.clear()
})

/** Serves the portal-choice contract; `choices` drives what the link resolves to. */
function stubPortal(choices: unknown[], { choicesStatus = 200 }: { choicesStatus?: number } = {}) {
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.includes('/public/portal/choices')) {
      if (choicesStatus !== 200) return jsonResponse({ detail: 'expired' }, choicesStatus)
      return jsonResponse({ email: 'grace@example.com', choices })
    }
    if (url.endsWith('/public/portal/choose')) {
      choosePosts.push(JSON.parse(String(init?.body ?? '{}')))
      return new Response(null, { status: 204 })
    }
    return jsonResponse({}, 404)
  })
  vi.stubGlobal('fetch', fetch)
  return fetch
}

describe('Speaker conference picker', () => {
  it('renders one row per conference under its organization and posts that row’s contact_id', async () => {
    stubPortal(CHOICES)
    renderPicker()

    expect(await screen.findByRole('heading', { name: 'Choose a conference' })).toBeInTheDocument()
    // The route is not swallowed by /portal/:token.
    expect(pathname()).toBe('/portal/choose')

    // Three conferences, grouped under the two organizations that run them.
    const rows = screen.getAllByRole('button')
    expect(rows).toHaveLength(3)
    expect(screen.getByRole('button', { name: /AI Builders Summit/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Alpha Devcon/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Beta World/ })).toBeInTheDocument()
    expect(screen.getByText('Alpha Events')).toBeInTheDocument()
    expect(screen.getByText('Beta Conferences')).toBeInTheDocument()
    // A conference with no dates still renders rather than blanking the row.
    expect(screen.getByRole('button', { name: /Dates to be confirmed/ })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /Beta World/ }))

    await waitFor(() => expect(choosePosts).toHaveLength(1))
    expect(choosePosts[0]).toEqual({ token: TOKEN, contact_id: 'contact-3' })
    await waitFor(() => expect(pathname()).toBe('/portal'))
  })

  it('sends the whole choice payload with credentials so the portal cookie sticks', async () => {
    const fetch = stubPortal(CHOICES)
    renderPicker()
    await screen.findByRole('heading', { name: 'Choose a conference' })

    fireEvent.click(screen.getByRole('button', { name: /AI Builders Summit/ }))
    await waitFor(() => expect(choosePosts).toHaveLength(1))

    const chooseCall = fetch.mock.calls.find((call) =>
      String(call[0]).endsWith('/public/portal/choose')
    )
    expect(chooseCall?.[1]?.credentials).toBe('include')
    // Public endpoint — never carries the organizer bearer token.
    expect(new Headers(chooseCall?.[1]?.headers).get('Authorization')).toBeNull()
  })

  it('auto-selects when the link resolves to exactly one conference', async () => {
    stubPortal([CHOICES[0]])
    renderPicker()

    await waitFor(() => expect(choosePosts).toHaveLength(1))
    expect(choosePosts[0]).toEqual({ token: TOKEN, contact_id: 'contact-1' })
    // Never asked them to pick from a list of one.
    expect(screen.queryByRole('heading', { name: 'Choose a conference' })).not.toBeInTheDocument()
    await waitFor(() => expect(pathname()).toBe('/portal'))
  })

  it('offers a fresh link when the token has expired, instead of crashing', async () => {
    stubPortal([], { choicesStatus: 401 })
    renderPicker()

    expect(
      await screen.findByRole('heading', { name: 'This sign-in link has expired' })
    ).toBeInTheDocument()
    const recovery = screen.getByRole('link', { name: /Request a new link/ })
    expect(recovery).toHaveAttribute('href', '/speaker-signin')
    expect(choosePosts).toHaveLength(0)
  })

  it('offers a fresh link when the URL arrived without a token', async () => {
    stubPortal(CHOICES)
    renderPicker(null)

    expect(
      await screen.findByRole('heading', { name: 'This sign-in link is incomplete' })
    ).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Request a new link/ })).toHaveAttribute(
      'href',
      '/speaker-signin'
    )
  })
})
