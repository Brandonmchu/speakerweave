/**
 * Multi-organization support, organizer side.
 *
 * The load-bearing assertion in this file is the *negative* one: an organizer
 * with a single membership must never meet the picker, and the demo entrance
 * must never be routed through it. Everything else here is the affordance that
 * only appears once someone genuinely has more than one workspace.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import App from '@/App'
import { DevLogin } from '@/pages/DevLogin'
import { AppShell } from '@/shell/AppShell'

const SOLO_ORG = { org_id: 'org-alpha', name: 'Alpha Events', role: 'owner', events: 3, is_current: true }
const BETA_ORG = { org_id: 'org-beta', name: 'Beta Conferences', role: 'admin', events: 7, is_current: false }
const GAMMA_ORG = { org_id: 'org-gamma', name: 'Gamma Summits', role: 'member', events: 1, is_current: false }

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

/** Reports the live router location so we can assert where a redirect landed. */
function LocationProbe() {
  const { pathname } = useLocation()
  return <div data-testid="pathname">{pathname}</div>
}

const pathname = () => screen.getByTestId('pathname').textContent

let switchPosts: string[]

/** Serves the multi-org contract and empties everything else. */
function stubApi(organizations: Array<Record<string, unknown>>) {
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    if (url.endsWith('/api/me/organizations') && method === 'GET') {
      return jsonResponse({ organizations })
    }
    const switchMatch = url.match(/\/api\/me\/organizations\/([^/]+)\/token$/)
    if (switchMatch && method === 'POST') {
      switchPosts.push(switchMatch[1])
      return jsonResponse({ token: `token-for-${switchMatch[1]}` })
    }
    if (url.includes('/public/demo-token')) return jsonResponse({ token: 'demo-token' })
    if (url.endsWith('/api/events')) return jsonResponse({ events: [] })
    return jsonResponse([])
  })
  vi.stubGlobal('fetch', fetch)
  return fetch
}

function renderApp(initialPath: string) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 0 } },
  })
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <QueryClientProvider client={queryClient}>
        <App />
        <LocationProbe />
      </QueryClientProvider>
    </MemoryRouter>
  )
}

beforeEach(() => {
  switchPosts = []
  window.localStorage.clear()
})

afterEach(() => {
  vi.unstubAllGlobals()
  window.localStorage.clear()
})

describe('Organizer workspace picker', () => {
  it('never shows the picker to a single-org organizer — it lands them in the app', async () => {
    window.localStorage.setItem('dais.token', 'test-token')
    stubApi([SOLO_ORG])

    renderApp('/choose-workspace')

    expect(await screen.findByRole('heading', { name: 'Submissions' })).toBeInTheDocument()
    expect(pathname()).toBe('/submissions')
    expect(screen.queryByRole('heading', { name: 'Choose a workspace' })).not.toBeInTheDocument()
  })

  it('falls through to the app when the membership list cannot be loaded', async () => {
    window.localStorage.setItem('dais.token', 'test-token')
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url.endsWith('/api/me/organizations')) return jsonResponse({ detail: 'nope' }, 404)
        if (url.endsWith('/api/events')) return jsonResponse({ events: [] })
        return jsonResponse([])
      })
    )

    renderApp('/choose-workspace')

    expect(await screen.findByRole('heading', { name: 'Submissions' })).toBeInTheDocument()
    expect(pathname()).toBe('/submissions')
  })

  it('shows one row per org and switching stores that org’s token', async () => {
    window.localStorage.setItem('dais.token', 'alpha-token')
    stubApi([SOLO_ORG, BETA_ORG, GAMMA_ORG])

    renderApp('/choose-workspace')

    expect(await screen.findByRole('heading', { name: 'Choose a workspace' })).toBeInTheDocument()
    // One row per membership and nothing else clickable on the page.
    expect(screen.getAllByRole('button')).toHaveLength(3)
    expect(screen.getByRole('button', { name: /Alpha Events/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /7 events/ })).toBeInTheDocument()
    // The row carries the role and marks where the caller already is.
    expect(screen.getByRole('button', { name: /Owner/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Current/ })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /Beta Conferences/ }))

    await waitFor(() => expect(switchPosts).toEqual(['org-beta']))
    await waitFor(() => expect(window.localStorage.getItem('dais.token')).toBe('token-for-org-beta'))
    expect(await screen.findByRole('heading', { name: 'Submissions' })).toBeInTheDocument()
    expect(pathname()).toBe('/submissions')
  })

  it('keeps the demo entrance one click — it goes straight to the workspace', async () => {
    // Even with three memberships on file, the demo button must not detour.
    stubApi([SOLO_ORG, BETA_ORG, GAMMA_ORG])
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <MemoryRouter initialEntries={['/dev-login']}>
        <QueryClientProvider client={queryClient}>
          <Routes>
            <Route path="/dev-login" element={<DevLogin />} />
            <Route path="/dashboard" element={<p>Workspace</p>} />
            <Route path="/choose-workspace" element={<p>Choose a workspace</p>} />
          </Routes>
          <LocationProbe />
        </QueryClientProvider>
      </MemoryRouter>
    )

    fireEvent.click(screen.getByRole('button', { name: /Enter the demo workspace/i }))

    expect(await screen.findByText('Workspace')).toBeInTheDocument()
    expect(pathname()).toBe('/dashboard')
    expect(screen.queryByText('Choose a workspace')).not.toBeInTheDocument()
  })
})

function renderShell() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <MemoryRouter initialEntries={['/dashboard']}>
      <QueryClientProvider client={queryClient}>
        <Routes>
          <Route element={<AppShell />}>
            <Route path="/dashboard" element={<p>Dashboard content</p>} />
          </Route>
        </Routes>
      </QueryClientProvider>
    </MemoryRouter>
  )
}

async function openAccountMenu() {
  const trigger = await screen.findByRole('button', { name: 'Account menu' })
  fireEvent.keyDown(trigger, { key: 'Enter', code: 'Enter' })
  return screen.findByRole('menu')
}

describe('Rail-foot workspace switcher', () => {
  it('lists every workspace and marks the current one', async () => {
    window.localStorage.setItem('dais.token', 'alpha-token')
    stubApi([SOLO_ORG, BETA_ORG])

    renderShell()
    const menu = await openAccountMenu()

    await waitFor(() =>
      expect(within(menu).getByRole('menuitem', { name: /Alpha Events/ })).toBeInTheDocument()
    )
    const current = within(menu).getByRole('menuitem', { name: /Alpha Events/ })
    expect(within(current).getByText('Current workspace')).toBeInTheDocument()
    const other = within(menu).getByRole('menuitem', { name: /Beta Conferences/ })
    expect(within(other).queryByText('Current workspace')).not.toBeInTheDocument()
    // The event count rides along as a machine value.
    expect(within(other).getByText('7')).toBeInTheDocument()
    expect(within(menu).getByRole('menuitem', { name: 'Sign out' })).toBeInTheDocument()

    fireEvent.click(other)
    await waitFor(() => expect(switchPosts).toEqual(['org-beta']))
    await waitFor(() => expect(window.localStorage.getItem('dais.token')).toBe('token-for-org-beta'))
  })

  it('signs out to the public site, not to a token-paste form', async () => {
    window.localStorage.setItem('dais.token', 'alpha-token')
    stubApi([SOLO_ORG])
    const assign = vi.fn()
    vi.stubGlobal('location', { ...window.location, assign })

    renderApp('/submissions')
    const menu = await openAccountMenu()
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Sign out' }))

    // A full load of `/`, deliberately: `/dev-login` means nothing to an
    // organizer who just left, `/demo` mints a fresh token and walks demo
    // visitors straight back in, and a client-side navigate loses the race with
    // the auth guard the moment the token clears.
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/'))
    expect(window.localStorage.getItem('dais.token')).toBeNull()
  })

  it('adds no workspace list when there is only one membership', async () => {
    window.localStorage.setItem('dais.token', 'alpha-token')
    stubApi([SOLO_ORG])

    renderShell()
    const menu = await openAccountMenu()

    expect(within(menu).getByRole('menuitem', { name: 'Sign out' })).toBeInTheDocument()
    expect(within(menu).queryByText('Workspaces')).not.toBeInTheDocument()
    expect(within(menu).queryByRole('menuitem', { name: /Alpha Events/ })).not.toBeInTheDocument()
  })
})
