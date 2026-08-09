/**
 * Abstract review, one layer deeper.
 *
 * Three things a program chair could not do from this page before:
 *   ABS-01 — say WHEN reviewing is open (the plan carried criteria and a pool,
 *            but no dates, so the deadline lived only in an email).
 *   ABS-05 — assign ONE named reviewer to ONE submission, not just a whole
 *            track at a time.
 *   ABS-09 — nudge only the reviewers who are behind, instead of re-emailing
 *            the entire committee.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { Evaluation } from '@/pages/Evaluation'
import { Toaster } from '@/ui/toaster'

const EVENT = { id: 'event-1', name: 'DaisConf', slug: 'daisconf' }

const PLAN = {
  id: 'plan-1',
  event_id: EVENT.id,
  name: 'Program committee',
  instructions: '',
  anonymized: false,
  scale: '1_5',
  criteria: [{ name: 'Relevance', weight: 100 }],
  status: 'open',
  opens_at: '2026-10-01T00:00:00+00:00',
  closes_at: '2026-10-10T23:59:59+00:00',
  evaluator_count: 2,
  assignment_count: 4,
  review_count: 3,
}

const ADA = {
  id: 'evaluator-ada',
  plan_id: PLAN.id,
  email: 'ada@example.com',
  name: 'Ada Lovelace',
  track_ids: [],
  tracks: [],
  assignment_count: 2,
  review_count: 2,
  complete_count: 2,
}

const GRACE = {
  id: 'evaluator-grace',
  plan_id: PLAN.id,
  email: 'grace@example.com',
  name: 'Grace Hopper',
  track_ids: [],
  tracks: [],
  assignment_count: 2,
  review_count: 1,
  // one assignment still unfinished — the only laggard
  complete_count: 1,
}

const DETAIL = {
  plan: PLAN,
  tracks: [],
  evaluators: [ADA, GRACE],
  assignments: { total: 4, reviewed: 3, complete: 3, by_session: [] },
}

const BOARD = {
  evaluators: [
    { id: ADA.id, name: ADA.name, email: ADA.email, track_ids: [] },
    { id: GRACE.id, name: GRACE.name, email: GRACE.email, track_ids: [] },
  ],
  sessions: [
    {
      session_id: 'session-a',
      title: 'A talk',
      friendly_id: 'SESS-1',
      status: 'pending',
      tracks: [],
      assignments: [
        {
          assignment_id: 'assignment-1',
          evaluator_id: ADA.id,
          name: ADA.name,
          email: ADA.email,
          review_status: 'in_progress',
        },
      ],
    },
    {
      session_id: 'session-b',
      title: 'B talk',
      friendly_id: 'SESS-2',
      status: 'pending',
      tracks: [],
      assignments: [],
    },
  ],
}

const REMINDER_RESULT = {
  reminded: 1,
  evaluators: ['Grace Hopper'],
  skipped: 0,
  already_reminded: [],
  incomplete_reviewers: 1,
  outstanding: 1,
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

let calls: Array<{ url: string; method: string; body: unknown }> = []

function renderEvaluation() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <MemoryRouter>
      <QueryClientProvider client={queryClient}>
        <Evaluation />
        <Toaster />
      </QueryClientProvider>
    </MemoryRouter>
  )
}

/** Radix tabs switch on mousedown, not click, and only mount the active panel. */
async function openTab(name: string) {
  const trigger = await screen.findByRole('tab', { name })
  fireEvent.mouseDown(trigger)
  fireEvent.click(trigger)
}

describe('Evaluation — review window, per-submission assignment, targeted reminders', () => {
  beforeEach(() => {
    calls = []
    window.localStorage.setItem('dais.token', 'test-token')
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
        const url = String(input)
        const method = init.method ?? 'GET'
        if (method !== 'GET') {
          calls.push({ url, method, body: init.body ? JSON.parse(String(init.body)) : undefined })
        }
        if (url.endsWith('/api/events')) return jsonResponse({ events: [EVENT] })
        if (url.endsWith('/evaluation-plans') && method === 'GET') {
          return jsonResponse({ plans: [PLAN] })
        }
        if (url.endsWith('/api/plans/plan-1/remind-laggards')) {
          return jsonResponse(REMINDER_RESULT)
        }
        if (url.startsWith('/api/plans/plan-1/assignments/')) {
          return new Response(null, { status: 204 })
        }
        if (url.endsWith('/api/plans/plan-1/assignments')) {
          if (method === 'GET') return jsonResponse(BOARD)
          return jsonResponse(
            {
              assignment: {
                id: 'assignment-new',
                plan_id: PLAN.id,
                evaluator_id: GRACE.id,
                session_id: 'session-b',
                evaluator_name: GRACE.name,
                evaluator_email: GRACE.email,
                session_title: 'B talk',
                review_status: 'pending',
              },
            },
            201
          )
        }
        if (url.endsWith('/api/evaluation-plans/plan-1')) {
          if (method === 'PATCH') return jsonResponse({ plan: PLAN })
          return jsonResponse(DETAIL)
        }
        return jsonResponse({}, 404)
      })
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    window.localStorage.clear()
  })

  // ── ABS-01: the plan carries its own dates ────────────────────────────────

  it('shows the review window on the plan card and in the header', async () => {
    renderEvaluation()

    // wait for the plan workspace, not just the sidebar card
    await screen.findByRole('heading', { name: 'Program committee' })
    // formatted in UTC, so the day the organizer picked is the day shown
    expect(screen.getAllByText('Reviews open Oct 1 – Oct 10').length).toBeGreaterThanOrEqual(2)
  })

  it('edits the window with native date inputs and saves both bounds', async () => {
    renderEvaluation()

    const opens = (await screen.findByLabelText('Reviews open')) as HTMLInputElement
    const closes = screen.getByLabelText('Reviews close') as HTMLInputElement
    expect(opens.type).toBe('date')
    expect(opens.value).toBe('2026-10-01')
    expect(closes.value).toBe('2026-10-10')

    fireEvent.change(closes, { target: { value: '2026-10-20' } })
    fireEvent.click(screen.getByRole('button', { name: /Save settings/ }))

    await waitFor(() => expect(calls).toHaveLength(1))
    expect(calls[0]).toMatchObject({
      url: '/api/evaluation-plans/plan-1',
      method: 'PATCH',
    })
    expect(calls[0].body).toMatchObject({ opens_at: '2026-10-01', closes_at: '2026-10-20' })
  })

  it('clearing a date clears the bound rather than leaving it stale', async () => {
    renderEvaluation()

    fireEvent.change(await screen.findByLabelText('Reviews open'), { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: /Save settings/ }))

    await waitFor(() => expect(calls).toHaveLength(1))
    expect(calls[0].body).toMatchObject({ opens_at: null })
  })

  // ── ABS-05: one reviewer, one submission ─────────────────────────────────

  it('assigns a named reviewer to a named submission through a native select', async () => {
    renderEvaluation()
    await openTab('Assignments')

    const select = (await screen.findByLabelText(
      'Assign a reviewer to B talk'
    )) as HTMLSelectElement
    expect(select.tagName).toBe('SELECT')
    // both reviewers are offered on a submission nobody is on yet
    expect(
      Array.from(select.options)
        .map((option) => option.text)
        .filter((text) => text !== 'Add reviewer…')
    ).toEqual(['Ada Lovelace', 'Grace Hopper'])

    fireEvent.change(select, { target: { value: GRACE.id } })

    await waitFor(() => expect(calls).toHaveLength(1))
    expect(calls[0]).toMatchObject({
      url: '/api/plans/plan-1/assignments',
      method: 'POST',
      body: { evaluator_id: GRACE.id, session_id: 'session-b' },
    })
  })

  it('lists who is already on a submission and removes one of them', async () => {
    renderEvaluation()
    await openTab('Assignments')

    const row = await screen.findByRole('row', { name: /A talk/ })
    expect(within(row).getByText('Ada Lovelace')).toBeInTheDocument()
    // already-assigned reviewers drop out of that row's picker
    const select = within(row).getByLabelText('Assign a reviewer to A talk') as HTMLSelectElement
    expect(
      Array.from(select.options)
        .map((option) => option.text)
        .filter((text) => text !== 'Add reviewer…')
    ).toEqual(['Grace Hopper'])

    fireEvent.click(
      within(row).getByRole('button', { name: 'Unassign Ada Lovelace from A talk' })
    )

    await waitFor(() => expect(calls).toHaveLength(1))
    expect(calls[0]).toMatchObject({
      url: '/api/plans/plan-1/assignments/assignment-1',
      method: 'DELETE',
    })
  })

  // ── ABS-09: nudge only the people who are behind ─────────────────────────

  it('counts the reviewers who are behind and names the ones it reminded', async () => {
    renderEvaluation()

    // Ada finished all of hers; only Grace is counted
    const remind = await screen.findByRole('button', {
      name: 'Remind incomplete reviewers (1)',
    })
    fireEvent.click(remind)

    await waitFor(() => expect(calls).toHaveLength(1))
    expect(calls[0]).toMatchObject({
      url: '/api/plans/plan-1/remind-laggards',
      method: 'POST',
    })
    const title = await screen.findByText('Reminded 1 reviewer')
    // the toast names who got the nudge, so it's obvious it wasn't everyone
    const notification = title.closest('li') as HTMLElement
    expect(within(notification).getByText('Grace Hopper')).toBeInTheDocument()
    expect(within(notification).queryByText('Ada Lovelace')).not.toBeInTheDocument()
  })
})
