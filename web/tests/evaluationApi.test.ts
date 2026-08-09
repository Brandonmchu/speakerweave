import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  addEvaluator,
  assignEvaluationSessions,
  getEvaluationPlan,
  getReviewerSubmission,
  listEvaluationPlans,
  saveReviewerReview,
  updateEvaluator,
} from '@/lib/evaluationApi'

interface CapturedCall {
  url: string
  method?: string
  credentials?: RequestCredentials
  body?: unknown
}

let calls: CapturedCall[] = []
let payload: unknown = {}

beforeEach(() => {
  calls = []
  payload = {}
  window.localStorage.setItem('dais.token', 'evaluation-token')
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      calls.push({
        url: String(input),
        method: init.method,
        credentials: init.credentials,
        body: init.body ? JSON.parse(String(init.body)) : undefined,
      })
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    })
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
  window.localStorage.clear()
})

describe('evaluation API', () => {
  it('uses the event-scoped plan URL and unwraps the plans envelope', async () => {
    payload = { plans: [{ id: 'plan-1', name: 'Committee' }] }
    const plans = await listEvaluationPlans('event/a')

    expect(calls[0].url).toBe('/api/events/event/a/evaluation-plans')
    expect(calls[0].method).toBe('GET')
    expect(plans[0].name).toBe('Committee')
  })

  it('always declares all-to-all assignment mode', async () => {
    payload = { created: 2, total: 2, session_count: 2, evaluator_count: 1 }
    await assignEvaluationSessions('plan-1', { session_ids: ['session-1', 'session-2'] })

    expect(calls[0]).toMatchObject({
      url: '/api/evaluation-plans/plan-1/assign',
      method: 'POST',
      body: { session_ids: ['session-1', 'session-2'], mode: 'all_to_all' },
    })
  })

  it('can ask for by-track assignment instead', async () => {
    payload = { created: 1, total: 1, session_count: 1, evaluator_count: 1 }
    await assignEvaluationSessions('plan-1', { mode: 'by_track' })

    expect(calls[0]).toMatchObject({
      url: '/api/evaluation-plans/plan-1/assign',
      method: 'POST',
      body: { mode: 'by_track' },
    })
  })

  it('carries the tracks a reviewer covers on create and on edit', async () => {
    payload = { evaluator: { id: 'evaluator-1', track_ids: ['track-a'] } }
    const created = await addEvaluator('plan-1', {
      email: 'ada@example.com',
      name: 'Ada',
      track_ids: ['track-a'],
    })
    expect(calls[0]).toMatchObject({
      url: '/api/evaluation-plans/plan-1/evaluators',
      method: 'POST',
      body: { email: 'ada@example.com', name: 'Ada', track_ids: ['track-a'] },
    })
    expect(created.track_ids).toEqual(['track-a'])

    // an empty list is a real value — "reviews every track" — not an omission
    payload = { evaluator: { id: 'evaluator-1', track_ids: [] } }
    await updateEvaluator('plan-1', 'evaluator-1', { track_ids: [] })
    expect(calls[1]).toMatchObject({
      url: '/api/evaluation-plans/plan-1/evaluators/evaluator-1',
      method: 'PATCH',
      body: { track_ids: [] },
    })
  })

  it('reads the event tracks and each session’s tracks off the plan detail', async () => {
    payload = {
      plan: { id: 'plan-1', name: 'Committee' },
      tracks: [{ id: 'track-a', name: 'Platform', color: '#4962E2' }],
      evaluators: [{ id: 'evaluator-1', track_ids: ['track-a'], tracks: [{ id: 'track-a', name: 'Platform', color: '#4962E2' }] }],
      assignments: {
        total: 1,
        reviewed: 0,
        complete: 0,
        by_session: [
          {
            session_id: 'session-1',
            title: 'Talk',
            track_id: 'track-a',
            tracks: [{ id: 'track-a', name: 'Platform', color: '#4962E2' }],
            assignment_count: 1,
            review_count: 0,
          },
        ],
      },
    }
    const detail = await getEvaluationPlan('plan-1')

    expect(calls[0].url).toBe('/api/evaluation-plans/plan-1')
    expect(detail.tracks?.[0].name).toBe('Platform')
    expect(detail.evaluators[0].track_ids).toEqual(['track-a'])
    expect(detail.assignments.by_session[0].tracks?.[0].id).toBe('track-a')
    // the primary track is still exposed under its original name
    expect(detail.assignments.by_session[0].track_id).toBe('track-a')
  })

  it('sends reviewer reads and writes with the portal cookie', async () => {
    payload = { assignment_id: 'assignment-1', session: { id: 'session-1', title: 'Talk' }, review: null }
    await getReviewerSubmission('assignment-1')
    expect(calls[0]).toMatchObject({
      url: '/public/review/submissions/assignment-1',
      method: 'GET',
      credentials: 'include',
    })

    payload = { review: { assignment_id: 'assignment-1', scores: {}, abstained: true, is_draft: false } }
    await saveReviewerReview('assignment-1', {
      scores: {},
      abstained: true,
      abstain_reason: 'Conflict',
      is_draft: false,
    })
    expect(calls[1]).toMatchObject({
      url: '/public/review/submissions/assignment-1',
      method: 'PUT',
      credentials: 'include',
      body: {
        scores: {},
        abstained: true,
        abstain_reason: 'Conflict',
        is_draft: false,
      },
    })
  })
})
