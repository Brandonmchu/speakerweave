/**
 * The organizer inbox: row → detail panel → decision.
 *
 * The panel is where a reviewer actually reads a submission, so what's covered
 * here is that the answers arrive rendered (labels in form order, a checkbox as
 * Yes/No), that participants show their roles, and that a decision button
 * PATCHes the status and moves the badge before the round trip returns.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { Inbox } from '@/pages/Inbox'

const EVENT = { id: 'event-1', name: 'DaisConf', slug: 'daisconf' }

const SUBMISSION = {
  id: 'session-1',
  friendly_id: 'DAIS-001',
  title: 'Analytical Engines',
  description: 'A talk about the first computers.',
  status: 'pending',
  submitted_at: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString(),
  submitter: { first_name: 'Ada', last_name: 'Lovelace', email: 'ada@example.com' },
}

const DETAIL = {
  session: SUBMISSION,
  answers: [
    { field_id: 'f1', label: 'Abstract', field_type: 'textarea', value: 'Engines, explained.' },
    { field_id: 'f2', label: 'Spoken before?', field_type: 'checkbox', value: true },
    { field_id: 'f3', label: 'Topics', field_type: 'multi_select', value: ['history', 'compute'] },
  ],
  participants: [
    {
      contact_id: 'c1',
      role: 'speaker',
      is_primary: true,
      first_name: 'Ada',
      last_name: 'Lovelace',
      email: 'ada@example.com',
    },
  ],
}

let patches: Array<{ url: string; body: unknown }> = []

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function renderInbox() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <MemoryRouter>
      <QueryClientProvider client={queryClient}>
        <Inbox />
      </QueryClientProvider>
    </MemoryRouter>
  )
}

describe('Inbox detail panel', () => {
  beforeEach(() => {
    patches = []
    window.localStorage.setItem('dais.token', 'test-token')
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        if (init?.method === 'PATCH') {
          const body = JSON.parse(String(init.body ?? '{}'))
          patches.push({ url, body })
          return jsonResponse({ session: { ...SUBMISSION, ...body } })
        }
        if (url.endsWith('/api/events')) return jsonResponse({ events: [EVENT] })
        if (url.includes('/submissions')) {
          return jsonResponse({ event: EVENT, submissions: [SUBMISSION], count: 1 })
        }
        if (url.includes('/api/sessions/')) return jsonResponse(DETAIL)
        return jsonResponse({}, 404)
      })
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    window.localStorage.clear()
  })

  it('lists the friendly id and a relative submitted date', async () => {
    renderInbox()
    expect(await screen.findByText('DAIS-001')).toBeInTheDocument()
    expect(screen.getByText('3 days ago')).toBeInTheDocument()
  })

  it('opens a submission and renders its answers and participants', async () => {
    renderInbox()
    fireEvent.click(await screen.findByText('Analytical Engines'))

    expect(await screen.findByText('Abstract')).toBeInTheDocument()
    expect(screen.getByText('Engines, explained.')).toBeInTheDocument()
    // A checkbox answer reads as Yes/No, not `true`.
    expect(screen.getByText('Spoken before?')).toBeInTheDocument()
    expect(screen.getByText('Yes')).toBeInTheDocument()
    expect(screen.getByText('history, compute')).toBeInTheDocument()
    // Participants with their role.
    expect(screen.getByText('speaker')).toBeInTheDocument()
    expect(screen.getByText('Primary')).toBeInTheDocument()
  })

  it('patches the status from a decision button', async () => {
    renderInbox()
    fireEvent.click(await screen.findByText('Analytical Engines'))
    fireEvent.click(await screen.findByRole('button', { name: 'Accept' }))

    await waitFor(() => expect(patches).toHaveLength(1))
    expect(patches[0].url).toContain('/api/sessions/session-1')
    expect(patches[0].body).toEqual({ status: 'accepted' })
    // Optimistic: the badge moves without waiting for a refetch.
    expect(await screen.findAllByText('Accepted')).not.toHaveLength(0)
  })
})
