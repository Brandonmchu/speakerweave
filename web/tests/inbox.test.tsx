/**
 * The organizer inbox: row → detail panel → decision.
 *
 * The panel is where a reviewer actually reads a submission, so what's covered
 * here is that the answers arrive rendered (labels in form order, a checkbox as
 * Yes/No), that participants show their roles, and that the minimum review
 * decision flow confirms and POSTs optional speaker feedback.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { decideSubmission } from '@/lib/api'
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

let writes: Array<{ url: string; method: string; body: unknown }> = []
let currentStatus = SUBMISSION.status

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
    writes = []
    currentStatus = SUBMISSION.status
    window.localStorage.setItem('dais.token', 'test-token')
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        if (init?.method === 'POST' && url.endsWith('/decision')) {
          const body = JSON.parse(String(init.body ?? '{}'))
          writes.push({ url, method: 'POST', body })
          currentStatus =
            body.decision === 'approve'
              ? 'accepted'
              : body.decision === 'maybe'
                ? 'accept_queue'
                : 'declined'
          return jsonResponse({
            session: { ...SUBMISSION, status: currentStatus },
            onboarding: { tasks_assigned: body.decision === 'approve' ? 6 : 0 },
            emailed: Boolean(body.email_speaker && body.feedback),
          })
        }
        if (init?.method === 'PATCH') {
          const body = JSON.parse(String(init.body ?? '{}'))
          writes.push({ url, method: 'PATCH', body })
          currentStatus = body.status
          return jsonResponse({ session: { ...SUBMISSION, status: currentStatus } })
        }
        if (url.endsWith('/api/events')) return jsonResponse({ events: [EVENT] })
        if (url.includes('/submissions')) {
          return jsonResponse({
            event: EVENT,
            submissions: [{ ...SUBMISSION, status: currentStatus }],
            count: 1,
          })
        }
        if (url.includes('/api/sessions/')) {
          return jsonResponse({ ...DETAIL, session: { ...SUBMISSION, status: currentStatus } })
        }
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
    expect(screen.getByRole('button', { name: 'Approve' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Maybe' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Deny' })).toBeInTheDocument()
  })

  it('confirms a decision, sends speaker feedback, and updates the status', async () => {
    renderInbox()
    fireEvent.click(await screen.findByText('Analytical Engines'))
    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }))

    expect(screen.getByText('Confirm approve', { selector: 'p' })).toBeInTheDocument()
    const emailCheckbox = screen.getByRole('checkbox', {
      name: 'Email this decision to the speaker',
    })
    expect(emailCheckbox).toBeDisabled()

    fireEvent.change(screen.getByLabelText('Message to speaker (optional)'), {
      target: { value: 'Please send the final abstract by Friday.' },
    })
    fireEvent.click(emailCheckbox)
    fireEvent.click(screen.getByRole('button', { name: 'Confirm approve' }))

    await waitFor(() => expect(writes).toHaveLength(1))
    expect(writes[0]).toEqual({
      url: '/api/sessions/session-1/decision',
      method: 'POST',
      body: {
        decision: 'approve',
        feedback: 'Please send the final abstract by Friday.',
        email_speaker: true,
      },
    })
    // Optimistic: the badge moves without waiting for a refetch.
    expect(await screen.findAllByText('Accepted')).not.toHaveLength(0)
  })

  it('decideSubmission posts to the encoded decision URL', async () => {
    await decideSubmission('session/with space', { decision: 'maybe' })

    expect(writes[0]).toEqual({
      url: '/api/sessions/session%2Fwith%20space/decision',
      method: 'POST',
      body: { decision: 'maybe' },
    })
  })
})
