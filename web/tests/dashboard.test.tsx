/**
 * The onboarding dashboard (requirement #6).
 *
 * The page is a read-only view over one aggregate payload, so what's worth
 * asserting is that the payload becomes the right *answer*: the stat cards, the
 * three onboarding states (done / owing / not started), the outstanding-first
 * order, and the filter that hides everyone who's finished.
 */
import { fireEvent, render, screen, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { Dashboard } from '@/pages/Dashboard'

const EVENT = { id: 'event-1', name: 'DaisConf', slug: 'daisconf' }

const DAY = 24 * 60 * 60 * 1000

const PAYLOAD = {
  submission_funnel: {
    pending: 4,
    accept_queue: 2,
    accepted: 6,
    decline_queue: 0,
    declined: 1,
    withdrawn: 0,
    total: 14,
  },
  speakers: [
    {
      contact_id: 'c-grace',
      name: 'Grace Hopper',
      email: 'grace@example.com',
      session_count: 1,
      status_summary: { accepted: 1 },
      tasks_total: 3,
      tasks_done: 1,
      tasks_outstanding: 2,
      last_portal_access_at: new Date(Date.now() - 2 * DAY).toISOString(),
      last_email: {
        template_key: 'portal_invite',
        status: 'cancelled',
        sent_at: null,
        last_error: 'demo address — delivery suppressed',
      },
      onboarding_complete: false,
    },
    {
      contact_id: 'c-ada',
      name: 'Ada Lovelace',
      email: 'ada@example.com',
      session_count: 2,
      status_summary: { accepted: 2 },
      tasks_total: 2,
      tasks_done: 2,
      tasks_outstanding: 0,
      last_portal_access_at: new Date(Date.now() - 3 * DAY).toISOString(),
      last_email: { template_key: 'acceptance', status: 'sent', sent_at: null, last_error: null },
      onboarding_complete: true,
    },
    {
      contact_id: 'c-alan',
      name: 'Alan Turing',
      email: 'alan@example.com',
      session_count: 1,
      status_summary: { pending: 1 },
      tasks_total: 0,
      tasks_done: 0,
      tasks_outstanding: 0,
      last_portal_access_at: null,
      last_email: null,
      onboarding_complete: false,
    },
  ],
  totals: { speakers: 3, onboarded: 1, outstanding_tasks: 2 },
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function renderDashboard() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <MemoryRouter>
      <QueryClientProvider client={queryClient}>
        <Dashboard />
      </QueryClientProvider>
    </MemoryRouter>
  )
}

/**
 * The stat row is a label beneath a mono number — read the number paired with it.
 */
function statValue(label: string): string {
  const block = screen
    .getAllByText(label)
    .map((node) => node.parentElement)
    .find((node): node is HTMLElement => /^\d+$/.test(node?.firstElementChild?.textContent ?? ''))
  if (!block) throw new Error(`No stat block labelled "${label}"`)
  return block.firstElementChild?.textContent ?? ''
}

let requestedUrls: string[] = []

describe('Dashboard', () => {
  beforeEach(() => {
    requestedUrls = []
    window.localStorage.setItem('dais.token', 'test-token')
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        requestedUrls.push(url)
        if (url.endsWith('/api/events')) return jsonResponse({ events: [EVENT] })
        if (url.includes('/dashboard')) return jsonResponse(PAYLOAD)
        return jsonResponse({}, 404)
      })
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    window.localStorage.clear()
  })

  it('renders the header while the first payload is still loading', async () => {
    renderDashboard()
    expect(screen.getByRole('heading', { name: 'Today' })).toBeInTheDocument()
    // Nothing is claimed about the numbers until they arrive.
    expect(screen.queryByText('Speaker onboarding')).not.toBeInTheDocument()
    expect(await screen.findByText('Speaker onboarding')).toBeInTheDocument()
  })

  it('fetches the dashboard for the org’s first event', async () => {
    renderDashboard()
    await screen.findByText('Grace Hopper')
    expect(requestedUrls).toContain('/api/events/event-1/dashboard')
  })

  it('shows the totals and the submission funnel', async () => {
    renderDashboard()
    await screen.findByText('Grace Hopper')

    expect(statValue('Total speakers')).toBe('3')
    expect(statValue('Onboarded')).toBe('1')
    expect(statValue('Outstanding tasks')).toBe('2')
    expect(screen.getByText(/33% of speakers/)).toBeInTheDocument()

    const funnel = screen.getByText('Submission funnel').parentElement as HTMLElement
    expect(statValue('Submission funnel')).toBe('14')
    expect(within(funnel).getByText('Accept queue')).toBeInTheDocument()
    expect(within(funnel).getByText('Accepted')).toBeInTheDocument()
  })

  it('renders the three onboarding states distinctly', async () => {
    renderDashboard()

    // Owing: progress + an explicit count.
    const grace = (await screen.findByText('Grace Hopper')).closest('tr') as HTMLElement
    expect(within(grace).getByText('1/3 done')).toBeInTheDocument()
    expect(within(grace).getByText(/2 outstanding/)).toBeInTheDocument()
    expect(within(grace).getByText('2 days ago')).toBeInTheDocument()
    expect(within(grace).getByText('Portal invite')).toBeInTheDocument()
    expect(within(grace).getByText('suppressed')).toBeInTheDocument()
    expect(within(grace).queryByText('cancelled')).not.toBeInTheDocument()

    // Done: the green badge, no numbers to read.
    const ada = screen.getByText('Ada Lovelace').closest('tr') as HTMLElement
    expect(within(ada).getByText('Onboarded')).toBeInTheDocument()
    expect(within(ada).getByText('2 sessions')).toBeInTheDocument()

    // Not started: nothing assigned, never signed in.
    const alan = screen.getByText('Alan Turing').closest('tr') as HTMLElement
    expect(within(alan).getByText('No tasks assigned')).toBeInTheDocument()
    expect(within(alan).getByText('Never signed in')).toBeInTheDocument()
  })

  it('puts the speakers who owe something first', async () => {
    renderDashboard()
    await screen.findByText('Grace Hopper')

    const names = screen
      .getAllByRole('row')
      .slice(1)
      .map((row) => row.querySelector('td')?.textContent ?? '')

    expect(names[0]).toContain('Grace Hopper')
    // The onboarded speaker sinks below the one who hasn't started.
    expect(names[names.length - 1]).toContain('Ada Lovelace')
  })

  it('filters down to only the speakers with outstanding tasks', async () => {
    renderDashboard()
    await screen.findByText('Ada Lovelace')

    fireEvent.click(screen.getByRole('button', { name: /only outstanding/i }))

    expect(screen.getByText('Grace Hopper')).toBeInTheDocument()
    expect(screen.queryByText('Ada Lovelace')).not.toBeInTheDocument()
    expect(screen.queryByText('Alan Turing')).not.toBeInTheDocument()
  })

  it('offers an empty state before any speaker exists', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url.endsWith('/api/events')) return jsonResponse({ events: [EVENT] })
        return jsonResponse({
          submission_funnel: { ...PAYLOAD.submission_funnel, total: 0 },
          speakers: [],
          totals: { speakers: 0, onboarded: 0, outstanding_tasks: 0 },
        })
      })
    )
    renderDashboard()

    expect(await screen.findByText('No speakers yet')).toBeInTheDocument()
  })

  it('surfaces a failed load with a retry', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ detail: 'Event not found' }, 404))
    )
    renderDashboard()

    expect(await screen.findByText("Couldn't load the dashboard")).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument()
  })
})
