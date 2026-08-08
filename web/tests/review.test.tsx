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
