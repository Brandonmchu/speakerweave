/**
 * Multi-track evaluation, from the organizer's side.
 *
 * A talk is submitted to one or more tracks and a reviewer reviews one or
 * more, so the plan workspace has to make two things obvious: which tracks
 * each reviewer covers, and that assigning by track is a distinct action from
 * assigning everything to everyone.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { Evaluation } from '@/pages/Evaluation'

const EVENT = { id: 'event-1', name: 'DaisConf', slug: 'daisconf' }
const PLATFORM = { id: 'track-a', name: 'Platform', color: '#4962E2' }
const AI = { id: 'track-b', name: 'AI', color: '#0F766E' }

const PLAN = {
  id: 'plan-1',
  event_id: EVENT.id,
  name: 'Program committee',
  instructions: '',
  anonymized: false,
  scale: '1_5',
  criteria: [{ name: 'Relevance', weight: 100 }],
  status: 'draft',
  evaluator_count: 2,
  assignment_count: 0,
  review_count: 0,
}

const DETAIL = {
  plan: PLAN,
  tracks: [PLATFORM, AI],
  evaluators: [
    {
      id: 'evaluator-platform',
      plan_id: PLAN.id,
      email: 'ada@example.com',
      name: 'Ada Lovelace',
      track_ids: [PLATFORM.id],
      tracks: [PLATFORM],
      assignment_count: 0,
      review_count: 0,
      complete_count: 0,
    },
    {
      id: 'evaluator-everything',
      plan_id: PLAN.id,
      email: 'grace@example.com',
      name: 'Grace Hopper',
      track_ids: [],
      tracks: [],
      assignment_count: 0,
      review_count: 0,
      complete_count: 0,
    },
  ],
  assignments: { total: 0, reviewed: 0, complete: 0, by_session: [] },
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

let posted: Array<{ url: string; body: unknown }> = []

function renderEvaluation() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <MemoryRouter>
      <QueryClientProvider client={queryClient}>
        <Evaluation />
      </QueryClientProvider>
    </MemoryRouter>
  )
}

describe('Evaluation — multi-track', () => {
  beforeEach(() => {
    posted = []
    window.localStorage.setItem('dais.token', 'test-token')
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
        const url = String(input)
        const method = init.method ?? 'GET'
        if (method !== 'GET') {
          posted.push({ url, body: init.body ? JSON.parse(String(init.body)) : undefined })
        }
        if (url.endsWith('/api/events')) return jsonResponse({ events: [EVENT] })
        if (url.endsWith('/evaluation-plans') && method === 'GET') {
          return jsonResponse({ plans: [PLAN] })
        }
        if (url.endsWith('/assign')) {
          return jsonResponse({ created: 2, total: 2, session_count: 2, evaluator_count: 2 })
        }
        if (url.includes('/evaluators/')) {
          return jsonResponse({ evaluator: { ...DETAIL.evaluators[1], track_ids: [AI.id] } })
        }
        if (url.endsWith('/api/evaluation-plans/plan-1')) return jsonResponse(DETAIL)
        return jsonResponse({}, 404)
      })
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    window.localStorage.clear()
  })

  it('shows the tracks each reviewer covers, and says so when they cover all', async () => {
    renderEvaluation()

    const covered = await screen.findByRole('row', { name: /Ada Lovelace/ })
    expect(within(covered).getByText('Platform')).toBeInTheDocument()
    expect(within(covered).queryByText('All tracks')).not.toBeInTheDocument()

    const everything = screen.getByRole('row', { name: /Grace Hopper/ })
    expect(within(everything).getByText('All tracks')).toBeInTheDocument()
  })

  it('assigns by track as its own action, alongside assign-everything', async () => {
    renderEvaluation()

    const byTrack = await screen.findByRole('button', { name: 'Assign by track' })
    fireEvent.click(byTrack)

    await waitFor(() => expect(posted).toHaveLength(1))
    expect(posted[0].url).toBe('/api/evaluation-plans/plan-1/assign')
    expect(posted[0].body).toMatchObject({ mode: 'by_track' })

    fireEvent.click(screen.getByRole('button', { name: 'Assign sessions' }))
    await waitFor(() => expect(posted).toHaveLength(2))
    expect(posted[1].body).toMatchObject({ mode: 'all_to_all' })
  })

  it('edits the tracks a reviewer covers in place', async () => {
    renderEvaluation()

    fireEvent.click(await screen.findByRole('button', { name: 'Edit tracks for Grace Hopper' }))
    const row = screen.getByRole('row', { name: /Grace Hopper/ })
    fireEvent.click(within(row).getByRole('checkbox', { name: /AI/ }))
    fireEvent.click(within(row).getByRole('button', { name: /Save/ }))

    await waitFor(() => expect(posted).toHaveLength(1))
    expect(posted[0].url).toBe(
      '/api/evaluation-plans/plan-1/evaluators/evaluator-everything'
    )
    expect(posted[0].body).toEqual({ track_ids: [AI.id] })
  })

  it('offers a track selection when adding a reviewer, defaulting to all tracks', async () => {
    renderEvaluation()

    expect(await screen.findByText('Tracks reviewed')).toBeInTheDocument()
    expect(
      screen.getByText('No selection — this reviewer can review every track.')
    ).toBeInTheDocument()
  })
})
