import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  assignEvaluationSessions,
  getReviewerSubmission,
  listEvaluationPlans,
  saveReviewerReview,
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
