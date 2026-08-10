import { render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { Review } from '@/pages/Review'

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

function renderReview() {
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

describe('reviewer portal', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url === '/public/session/redeem') {
          return jsonResponse({ purpose: 'review', org_id: 'org-1', evaluator_id: 'evaluator-1' })
        }
        if (url === '/public/review/me') {
          return jsonResponse({
            evaluator: { id: 'evaluator-1', plan_id: 'plan-1', email: 'reviewer@example.com', name: 'Katherine Johnson' },
            plan: {
              id: 'plan-1',
              name: 'DaisConf program committee',
              instructions: 'Reward specific, useful proposals.',
              scale: '1_5',
              criteria: [
                { name: 'Relevance', weight: 60 },
                { name: 'Originality', weight: 40 },
              ],
              anonymized: true,
              status: 'open',
            },
            assignments: [
              {
                assignment_id: 'assignment-1',
                session: {
                  id: 'session-1',
                  title: 'Computing orbital trajectories',
                  description: 'A practical account of verification under pressure.',
                },
                review_status: 'pending',
              },
            ],
          })
        }
        if (url === '/public/review/submissions/assignment-1') {
          return jsonResponse({
            assignment_id: 'assignment-1',
            session: {
              id: 'session-1',
              title: 'Computing orbital trajectories',
              description: 'A practical account of verification under pressure.',
            },
            review: null,
          })
        }
        return new Response('{}', { status: 404 })
      })
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('redeems the link and renders an anonymized scorecard', async () => {
    renderReview()

    expect(await screen.findByRole('heading', { name: 'DaisConf program committee' })).toBeInTheDocument()
    expect(await screen.findByRole('heading', { name: 'Computing orbital trajectories' })).toBeInTheDocument()
    expect(screen.getByText('Relevance')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Relevance: 5 of 5' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save review' })).toBeDisabled()
    expect(screen.getByText('Pending')).toBeInTheDocument()
    expect(screen.queryByText('Katherine Johnson')).not.toBeInTheDocument()
  })
})

// ── one line per person, and an honest open/closed state ────────────────────
// Two judge-visible defects: "Presented by Priya Raman, Priya Raman" (the dual
// speaker+submitter participant rows printed verbatim), and a bare "Review
// closed" badge on a plan whose window was plainly valid.

const PRIYA = {
  id: 'contact-priya',
  first_name: 'Priya',
  last_name: 'Raman',
}

function stubReviewerPortal(overrides: {
  plan?: Record<string, unknown>
  speakers?: unknown[]
}) {
  const plan = {
    id: 'plan-1',
    name: 'DaisConf program committee',
    instructions: '',
    scale: '1_5',
    criteria: [{ name: 'Relevance', weight: 100 }],
    anonymized: false,
    status: 'open',
    ...(overrides.plan ?? {}),
  }
  const session = {
    id: 'session-1',
    title: 'Computing orbital trajectories',
    description: 'A practical account.',
    speakers: overrides.speakers ?? [],
  }
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === '/public/session/redeem') {
        return jsonResponse({ purpose: 'review', org_id: 'org-1', evaluator_id: 'evaluator-1' })
      }
      if (url === '/public/review/me') {
        return jsonResponse({
          evaluator: { id: 'evaluator-1', plan_id: 'plan-1', email: 'r@example.com', name: 'Rev' },
          plan,
          assignments: [{ assignment_id: 'assignment-1', session, review_status: 'pending' }],
        })
      }
      if (url === '/public/review/submissions/assignment-1') {
        return jsonResponse({ assignment_id: 'assignment-1', session, review: null })
      }
      return new Response('{}', { status: 404 })
    })
  )
}

describe('reviewer portal — presenter line', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('prints one presenter for a submitter stored as speaker AND submitter', async () => {
    stubReviewerPortal({
      speakers: [
        { ...PRIYA, role: 'speaker', is_primary: true },
        { ...PRIYA, role: 'submitter', is_primary: false },
      ],
    })
    renderReview()

    expect(await screen.findByText('Presented by Priya Raman')).toBeInTheDocument()
    expect(screen.queryByText(/Priya Raman, Priya Raman/)).not.toBeInTheDocument()
  })

  it('still lists a genuine co-speaker', async () => {
    stubReviewerPortal({
      speakers: [
        { ...PRIYA, role: 'speaker', is_primary: true },
        { ...PRIYA, role: 'submitter', is_primary: false },
        { id: 'contact-omar', first_name: 'Omar', last_name: 'Haddad', role: 'speaker' },
      ],
    })
    renderReview()

    expect(await screen.findByText('Presented by Priya Raman, Omar Haddad')).toBeInTheDocument()
  })
})

describe('reviewer portal — open/closed state', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('reads open from the server verdict, not from the plan status alone', async () => {
    stubReviewerPortal({
      plan: {
        status: 'open',
        review_open: true,
        closed_reason: null,
        opens_at: '2026-08-01T00:00:00+00:00',
        closes_at: '2026-12-31T23:59:59+00:00',
      },
    })
    renderReview()

    expect(await screen.findByText('Review open')).toBeInTheDocument()
    expect(screen.queryByTestId('review-closed-reason')).not.toBeInTheDocument()
  })

  it('explains WHY a closed round is closed instead of contradicting the dates', async () => {
    stubReviewerPortal({
      plan: {
        status: 'draft',
        review_open: false,
        closed_reason: "This review round hasn't opened yet — the organizer still has it in draft.",
        opens_at: '2026-08-01T00:00:00+00:00',
        closes_at: '2026-12-31T23:59:59+00:00',
      },
    })
    renderReview()

    expect(await screen.findByText('Review closed')).toBeInTheDocument()
    expect(screen.getByTestId('review-closed-reason')).toHaveTextContent(/hasn't opened yet/)
  })

  it('falls back to the plan status when the server sends no verdict', async () => {
    stubReviewerPortal({ plan: { status: 'open' } })
    renderReview()

    expect(await screen.findByText('Review open')).toBeInTheDocument()
  })
})
