/**
 * Non-numeric criteria (ABS-03), from both sides of the scorecard.
 *
 * A criterion used to be one thing: a weighted 1–N rating. It can now also ask
 * for a CHOICE from a fixed list or for free TEXT. The organizer builds those
 * rows in the plan editor and the reviewer answers them in the portal, so the
 * two halves are tested together here — including the half that must not have
 * changed at all: a plan whose criteria carry no `kind` still renders, saves,
 * and scores exactly as it did.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { Evaluation } from '@/pages/Evaluation'
import { Review } from '@/pages/Review'

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

type SentRequest = { url: string; method: string; body: Record<string, unknown> | undefined }

let sent: SentRequest[] = []

function recordRequest(url: string, init: RequestInit) {
  const method = init.method ?? 'GET'
  if (method !== 'GET') {
    sent.push({ url, method, body: init.body ? JSON.parse(String(init.body)) : undefined })
  }
}

/* ── the organizer's plan editor ─────────────────────────────────────────── */

const EVENT = { id: 'event-1', name: 'DaisConf', slug: 'daisconf' }

const SCALE_ONLY_PLAN = {
  id: 'plan-1',
  event_id: EVENT.id,
  name: 'Program committee',
  instructions: '',
  anonymized: false,
  scale: '1_5',
  criteria: [{ name: 'Relevance', weight: 100 }],
  status: 'draft',
  evaluator_count: 0,
  assignment_count: 0,
  review_count: 0,
}

function planDetail(plan: typeof SCALE_ONLY_PLAN) {
  return {
    plan,
    tracks: [],
    evaluators: [],
    assignments: { total: 0, reviewed: 0, complete: 0, by_session: [] },
  }
}

function renderEvaluation(plan = SCALE_ONLY_PLAN) {
  window.localStorage.setItem('dais.token', 'test-token')
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input)
      recordRequest(url, init)
      const method = init.method ?? 'GET'
      if (url.endsWith('/api/events')) return jsonResponse({ events: [EVENT] })
      if (url.endsWith('/evaluation-plans') && method === 'GET') {
        return jsonResponse({ plans: [plan] })
      }
      if (url.endsWith('/api/evaluation-plans/plan-1')) {
        if (method === 'PATCH') return jsonResponse({ plan })
        return jsonResponse(planDetail(plan))
      }
      return jsonResponse({}, 404)
    })
  )
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <MemoryRouter>
      <QueryClientProvider client={queryClient}>
        <Evaluation />
      </QueryClientProvider>
    </MemoryRouter>
  )
}

describe('plan editor — criterion types', () => {
  beforeEach(() => {
    sent = []
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    window.localStorage.clear()
  })

  it('adds a Choice criterion with its options and saves it beside the scored one', async () => {
    renderEvaluation()

    // The pre-existing scale criterion is untouched: still a name and a weight.
    expect(await screen.findByLabelText('Criterion 1 name')).toHaveValue('Relevance')
    expect(screen.getByLabelText('Relevance weight')).toHaveValue(100)
    expect(screen.getByLabelText('Relevance type')).toHaveValue('scale')

    fireEvent.click(screen.getByRole('button', { name: /Add criterion/ }))
    fireEvent.change(screen.getByLabelText('Criterion 2 name'), {
      target: { value: 'Track fit' },
    })
    fireEvent.change(screen.getByLabelText('Track fit type'), { target: { value: 'select' } })

    // Choosing Choice reveals the options field — and nothing else changed.
    const choices = await screen.findByLabelText('Track fit choices')
    fireEvent.change(choices, { target: { value: 'Yes, No, Unsure' } })
    expect(choices).toHaveValue('Yes, No, Unsure')
    expect(screen.queryByLabelText('Track fit weight')).not.toBeInTheDocument()
    // The 100% total still counts only the scored criterion.
    expect(screen.getByText('100%')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /Save settings/ }))

    await waitFor(() => expect(sent.some((call) => call.method === 'PATCH')).toBe(true))
    const patch = sent.find((call) => call.method === 'PATCH')!
    expect(patch.body!.criteria).toEqual([
      { name: 'Relevance', weight: 100 },
      { name: 'Track fit', weight: 0, kind: 'select', options: ['Yes', 'No', 'Unsure'] },
    ])
  })

  it('a text criterion carries no weight, and an unscored plan can still be saved', async () => {
    renderEvaluation()

    fireEvent.change(await screen.findByLabelText('Relevance type'), {
      target: { value: 'text' },
    })

    expect(screen.queryByLabelText('Relevance weight')).not.toBeInTheDocument()
    expect(screen.getAllByText('No weight').length).toBe(1)
    // Nothing left to weight, so the 100% rule steps aside rather than blocking.
    expect(screen.getByText('Unscored')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /Save settings/ }))

    await waitFor(() => expect(sent.some((call) => call.method === 'PATCH')).toBe(true))
    const patch = sent.find((call) => call.method === 'PATCH')!
    expect(patch.body!.criteria).toEqual([{ name: 'Relevance', weight: 0, kind: 'text' }])
  })

  it('leaves a scale-only plan saving exactly the shape it had', async () => {
    renderEvaluation()

    fireEvent.change(await screen.findByLabelText('Criterion 1 name'), {
      target: { value: 'Relevance to builders' },
    })
    fireEvent.click(screen.getByRole('button', { name: /Save settings/ }))

    await waitFor(() => expect(sent.some((call) => call.method === 'PATCH')).toBe(true))
    const patch = sent.find((call) => call.method === 'PATCH')!
    expect(patch.body!.criteria).toEqual([{ name: 'Relevance to builders', weight: 100 }])
  })
})

/* ── the reviewer's scorecard ────────────────────────────────────────────── */

const MIXED_CRITERIA = [
  { name: 'Relevance', weight: 100 },
  { name: 'Track fit', weight: 0, kind: 'select', options: ['Yes', 'No', 'Unsure'] },
  { name: 'Advice', weight: 0, kind: 'text' },
]

function renderReview(criteria: unknown[]) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input)
      recordRequest(url, init)
      if (url === '/public/session/redeem') {
        return jsonResponse({ purpose: 'review', org_id: 'org-1', evaluator_id: 'evaluator-1' })
      }
      if (url === '/public/review/me') {
        return jsonResponse({
          evaluator: { id: 'evaluator-1', plan_id: 'plan-1', email: 'r@example.com', name: 'Ada' },
          plan: {
            id: 'plan-1',
            name: 'DaisConf program committee',
            instructions: '',
            scale: '1_5',
            criteria,
            anonymized: false,
            status: 'open',
          },
          assignments: [
            {
              assignment_id: 'assignment-1',
              session: { id: 'session-1', title: 'Computing orbital trajectories' },
              review_status: 'pending',
            },
          ],
        })
      }
      if (url === '/public/review/submissions/assignment-1') {
        if ((init.method ?? 'GET') === 'PUT') return jsonResponse({ review: { is_draft: false } })
        return jsonResponse({
          assignment_id: 'assignment-1',
          session: { id: 'session-1', title: 'Computing orbital trajectories' },
          review: null,
        })
      }
      return jsonResponse({}, 404)
    })
  )
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <MemoryRouter initialEntries={['/review/reviewer-token']}>
      <QueryClientProvider client={queryClient}>
        <Routes>
          <Route path="/review/:token" element={<Review />} />
        </Routes>
      </QueryClientProvider>
    </MemoryRouter>
  )
}

describe('reviewer scorecard — criterion types', () => {
  beforeEach(() => {
    sent = []
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('renders a choice as a native select and text as a textarea, and submits strings', async () => {
    renderReview(MIXED_CRITERIA)

    // The rating keeps its button grid, exactly as before.
    const rating = await screen.findByRole('button', { name: 'Relevance: 5 of 5' })
    const choice = screen.getByLabelText('Track fit')
    const advice = screen.getByLabelText('Advice')
    expect(choice.tagName).toBe('SELECT')
    expect(advice.tagName).toBe('TEXTAREA')
    expect(Array.from(choice.querySelectorAll('option')).map((o) => o.textContent)).toEqual([
      'Select an option',
      'Yes',
      'No',
      'Unsure',
    ])

    // Free text alone doesn't unlock submit; the rating and the choice do.
    fireEvent.change(advice, { target: { value: 'Tighten the intro.' } })
    expect(screen.getByRole('button', { name: 'Save review' })).toBeDisabled()
    fireEvent.click(rating)
    expect(screen.getByRole('button', { name: 'Save review' })).toBeDisabled()
    fireEvent.change(choice, { target: { value: 'Yes' } })
    expect(screen.getByRole('button', { name: 'Save review' })).toBeEnabled()

    fireEvent.click(screen.getByRole('button', { name: 'Save review' }))

    await waitFor(() => expect(sent.some((call) => call.method === 'PUT')).toBe(true))
    const put = sent.find((call) => call.method === 'PUT')!
    expect(put.body!.scores).toEqual({
      Relevance: 5,
      'Track fit': 'Yes',
      Advice: 'Tighten the intro.',
    })
    expect(put.body!.is_draft).toBe(false)
  })

  it('leaves a scale-only plan submitting numbers, as it always did', async () => {
    renderReview([{ name: 'Relevance', weight: 100 }])

    fireEvent.click(await screen.findByRole('button', { name: 'Relevance: 4 of 5' }))
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Save review' }))

    await waitFor(() => expect(sent.some((call) => call.method === 'PUT')).toBe(true))
    expect(sent.find((call) => call.method === 'PUT')!.body!.scores).toEqual({ Relevance: 4 })
  })
})
