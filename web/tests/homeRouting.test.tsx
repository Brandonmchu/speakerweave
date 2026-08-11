import { render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import App from '@/App'

/** Reports the live router location so we can assert where a redirect landed. */
function LocationProbe() {
  const { pathname } = useLocation()
  return <div data-testid="pathname">{pathname}</div>
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

const pathname = () => screen.getByTestId('pathname').textContent

beforeEach(() => {
  window.localStorage.clear()
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } }))
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
  window.localStorage.clear()
})

describe('Home + public-alias routing', () => {
  it('renders the public landing at / for an unauthenticated visitor (no redirect)', async () => {
    renderApp('/')
    expect(
      await screen.findByRole('button', { name: /Enter the demo workspace/i })
    ).toBeInTheDocument()
    // Stayed on / — not bounced to the auth wall.
    expect(pathname()).toBe('/')
    expect(screen.queryByText('Developer sign-in')).not.toBeInTheDocument()
  })

  it('sends an authenticated organizer from / into the app', async () => {
    window.localStorage.setItem('dais.token', 'test-token')
    renderApp('/')
    expect(await screen.findByRole('heading', { name: 'Submissions' })).toBeInTheDocument()
    expect(pathname()).toBe('/submissions')
  })

  it('redirects the guessable /schedule alias to the featured event schedule', async () => {
    renderApp('/schedule')
    await screen.findByTestId('pathname')
    expect(pathname()).toBe('/e/ai-builders-summit/schedule')
  })

  it('redirects /gallery to the featured event speakers', async () => {
    renderApp('/gallery')
    await screen.findByTestId('pathname')
    expect(pathname()).toBe('/e/ai-builders-summit/speakers')
  })

  it('redirects bare /e/:slug to that event schedule', async () => {
    renderApp('/e/some-conf')
    await screen.findByTestId('pathname')
    expect(pathname()).toBe('/e/some-conf/schedule')
  })

  it('loads the deferred developer reference route', async () => {
    renderApp('/developers')
    expect(await screen.findByRole('heading', { name: 'SpeakerWeave API' })).toBeInTheDocument()
    expect(pathname()).toBe('/developers')
  })

  it('sends an unauthenticated /agenda guesser to the public schedule', async () => {
    renderApp('/agenda')
    await screen.findByTestId('pathname')
    expect(pathname()).toBe('/e/ai-builders-summit/schedule')
  })

  it('sends an unauthenticated /speakers guesser to the public speakers', async () => {
    renderApp('/speakers')
    await screen.findByTestId('pathname')
    expect(pathname()).toBe('/e/ai-builders-summit/speakers')
  })
})
