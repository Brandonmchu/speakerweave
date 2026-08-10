/**
 * The organizer's side of the review round, one layer deeper again.
 *
 *   ABS-06 — "Assign sessions" picks a SUBSET (and can still assign everything
 *            in one click), and several assignments come off together instead
 *            of one X at a time.
 *   ABS-05 — accepted/declined work can join a later round, but only when the
 *            organizer asks for it.
 *   ABS-13 — the scores CSV is reachable from the results table, not only from
 *            a menu on another page.
 *   ABS-14 — AI triage produces a ranked first pass with a score, a suggestion
 *            and a rationale, is labelled as machine-generated, and a human
 *            override persists.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { Evaluation, buildScoresCsv } from '@/pages/Evaluation'
import { Toaster } from '@/ui/toaster'

const EVENT = { id: 'event-1', name: 'DaisConf', slug: 'daisconf' }

const PLAN = {
  id: 'plan-1',
  event_id: EVENT.id,
  name: 'Initial Review',
  instructions: '',
  anonymized: false,
  scale: '1_5',
  criteria: [{ name: 'Relevance', weight: 100 }],
  status: 'open',
  evaluator_count: 1,
  assignment_count: 2,
  review_count: 1,
}

const ADA = {
  id: 'evaluator-ada',
  plan_id: PLAN.id,
  email: 'ada@example.com',
  name: 'Ada Lovelace',
  track_ids: [],
  tracks: [],
  assignment_count: 2,
  review_count: 1,
  complete_count: 1,
}

const DETAIL = {
  plan: PLAN,
  tracks: [],
  evaluators: [ADA],
  assignments: { total: 2, reviewed: 1, complete: 1, by_session: [] },
}

const PENDING_SESSIONS = [
  {
    session_id: 'session-a',
    title: 'Taming 40-Minute CI',
    friendly_id: 'SESS-1',
    status: 'pending',
    tracks: [],
    assignments: [
      {
        assignment_id: 'assignment-1',
        evaluator_id: ADA.id,
        name: ADA.name,
        email: ADA.email,
        review_status: 'reviewed',
      },
    ],
  },
  {
    session_id: 'session-b',
    title: 'Your AI Pair Programmer',
    friendly_id: 'SESS-2',
    status: 'pending',
    tracks: [],
    assignments: [
      {
        assignment_id: 'assignment-2',
        evaluator_id: ADA.id,
        name: ADA.name,
        email: ADA.email,
        review_status: 'pending',
      },
    ],
  },
]

const DECIDED_SESSION = {
  session_id: 'session-old',
  title: 'Last year, accepted',
  friendly_id: 'SESS-9',
  status: 'accepted',
  tracks: [],
  assignments: [],
}

const SUMMARY = {
  started: 1,
  in_progress: 0,
  complete: 1,
  assignment_count: 2,
  per_session: [
    {
      session_id: 'session-b',
      title: 'Your AI Pair Programmer',
      friendly_id: 'SESS-2',
      status: 'pending',
      tracks: [],
      avg_overall: 5,
      review_count: 1,
      completed_count: 1,
      abstained_count: 0,
      score_range: 0,
    },
    {
      session_id: 'session-a',
      title: 'Taming 40-Minute CI',
      friendly_id: 'SESS-1',
      status: 'pending',
      tracks: [],
      avg_overall: 3.33,
      review_count: 1,
      completed_count: 1,
      abstained_count: 0,
      score_range: 0,
    },
  ],
  top_sessions: [],
  thought_provoking: [],
}

const TRIAGE = {
  plan_id: PLAN.id,
  triage: {
    generated_at: '2026-08-10T12:00:00+00:00',
    source: 'anthropic' as const,
    model: 'claude-haiku-4-5',
    scale: '1_5',
    stored: true,
    items: [
      {
        session_id: 'session-b',
        title: 'Your AI Pair Programmer',
        summary: 'Verification patterns for code an AI wrote.',
        score: 4.5,
        suggestion: 'advance' as const,
        rationale: 'Concrete verification patterns; strong AI Engineering fit.',
        override_score: null,
      },
      {
        session_id: 'session-a',
        title: 'Taming 40-Minute CI',
        summary: 'Cutting a 40-minute monorepo CI pipeline with incremental builds.',
        score: 3,
        suggestion: 'discuss' as const,
        rationale: 'Useful build-tooling material, but a crowded topic this year.',
        override_score: null,
      },
    ],
  },
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

let calls: Array<{ url: string; method: string; body: unknown }> = []
let gets: string[] = []
let triageState: unknown = { plan_id: PLAN.id, triage: null }
let includeDecidedInBoard = false

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

describe('Evaluation — subset assignment, later rounds, export, AI triage', () => {
  beforeEach(() => {
    calls = []
    gets = []
    triageState = { plan_id: PLAN.id, triage: null }
    includeDecidedInBoard = false
    window.localStorage.setItem('dais.token', 'test-token')
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
        const url = String(input)
        const method = init.method ?? 'GET'
        if (method === 'GET') gets.push(url)
        else calls.push({ url, method, body: init.body ? JSON.parse(String(init.body)) : undefined })

        if (url.endsWith('/api/events')) return jsonResponse({ events: [EVENT] })
        if (url.endsWith('/evaluation-plans') && method === 'GET') {
          return jsonResponse({ plans: [PLAN] })
        }
        if (url.includes('/ai-triage')) {
          if (method === 'POST') {
            triageState = TRIAGE
            return jsonResponse(TRIAGE)
          }
          if (method === 'PATCH') {
            const body = JSON.parse(String(init.body))
            triageState = {
              plan_id: PLAN.id,
              triage: {
                ...TRIAGE.triage,
                items: TRIAGE.triage.items.map((item) =>
                  url.endsWith(`/${item.session_id}`)
                    ? { ...item, override_score: body.score }
                    : item
                ),
              },
            }
            return jsonResponse(triageState)
          }
          return jsonResponse(triageState)
        }
        if (url.includes('/assignments')) {
          includeDecidedInBoard = url.includes('include_decided=true')
          return jsonResponse({
            include_decided: includeDecidedInBoard,
            evaluators: [{ id: ADA.id, name: ADA.name, email: ADA.email, track_ids: [] }],
            sessions: includeDecidedInBoard
              ? [...PENDING_SESSIONS, DECIDED_SESSION]
              : PENDING_SESSIONS,
          })
        }
        if (url.endsWith('/unassign')) return jsonResponse({ removed: 2, assignment_ids: [] })
        if (url.endsWith('/assign')) {
          return jsonResponse({ created: 2, total: 2, session_count: 2, evaluator_count: 1 })
        }
        if (url.endsWith('/summary')) return jsonResponse(SUMMARY)
        if (url.endsWith('/api/evaluation-plans/plan-1')) return jsonResponse(DETAIL)
        return jsonResponse({}, 404)
      })
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    window.localStorage.clear()
  })

  // ── ABS-06: pick a subset, and take assignments back in bulk ─────────────

  it('opens with everything ticked and assigns only what stays ticked', async () => {
    renderEvaluation()

    fireEvent.click(await screen.findByRole('button', { name: 'Assign sessions' }))
    const untick = await screen.findByRole('checkbox', { name: 'Assign Taming 40-Minute CI' })
    // Select-all is the default: the fast path is still one confirm away.
    expect(untick).toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'Assign Your AI Pair Programmer' })).toBeChecked()

    fireEvent.click(untick)
    fireEvent.click(await screen.findByRole('button', { name: 'Assign 1 selected' }))

    await waitFor(() => expect(calls).toHaveLength(1))
    expect(calls[0].url).toBe('/api/evaluation-plans/plan-1/assign')
    expect(calls[0].body).toMatchObject({
      mode: 'all_to_all',
      session_ids: ['session-b'],
      evaluator_ids: [ADA.id],
      include_decided: false,
    })
  })

  it('keeps one-click assign-all as the fast path', async () => {
    renderEvaluation()

    fireEvent.click(await screen.findByRole('button', { name: 'Assign sessions' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Assign all to everyone' }))

    await waitFor(() => expect(calls).toHaveLength(1))
    expect(calls[0].body).toMatchObject({ mode: 'all_to_all' })
    expect(calls[0].body).not.toHaveProperty('session_ids')
  })

  it('removes several assignments in one stroke', async () => {
    renderEvaluation()
    await openTab('Assignments')

    fireEvent.click(
      await screen.findByRole('checkbox', {
        name: 'Select Ada Lovelace on Taming 40-Minute CI',
      })
    )
    fireEvent.click(
      screen.getByRole('checkbox', { name: 'Select Ada Lovelace on Your AI Pair Programmer' })
    )
    expect(screen.getByText('2 assignments selected')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /Unassign selected/ }))

    await waitFor(() => expect(calls).toHaveLength(1))
    expect(calls[0]).toMatchObject({ url: '/api/plans/plan-1/unassign', method: 'POST' })
    expect(calls[0].body).toMatchObject({ assignment_ids: ['assignment-1', 'assignment-2'] })
  })

  // ── ABS-05: decided work in a later round, only on request ───────────────

  it('leaves decided submissions out until the organizer asks for them', async () => {
    renderEvaluation()
    await openTab('Assignments')

    await screen.findByText('Taming 40-Minute CI')
    expect(screen.queryByText('Last year, accepted')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('checkbox', { name: 'Include decided submissions' }))

    expect(await screen.findByText('Last year, accepted')).toBeInTheDocument()
    expect(gets.some((url) => url.includes('/assignments?include_decided=true'))).toBe(true)
  })

  // ── ABS-13: the export lives with the numbers it exports ─────────────────

  it('offers the scores export from the results table', async () => {
    renderEvaluation()
    await openTab('Summary & decisions')

    const exportButton = await screen.findByRole('button', { name: 'Export scores' })
    fireEvent.click(exportButton)

    expect(await screen.findByText('Exported scores')).toBeInTheDocument()
    expect(screen.getByText(/initial-review-scores\.csv/)).toBeInTheDocument()
  })

  it('builds a scores CSV with one quoted row per submission', () => {
    const csv = buildScoresCsv(SUMMARY.per_session)
    const [header, first] = csv.split('\n')

    expect(header).toContain('"Average score"')
    // Quoted throughout, so a comma in a title never shifts a column.
    expect(first).toBe('"SESS-2","Your AI Pair Programmer","pending","5.00","1","0","0.00"')
  })

  // ── ABS-14: AI triage ────────────────────────────────────────────────────

  it('runs triage and shows a ranked list with scores, suggestions and reasons', async () => {
    renderEvaluation()

    fireEvent.click(await screen.findByRole('button', { name: 'AI triage' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Run AI triage' }))

    await waitFor(() => expect(calls).toHaveLength(1))
    expect(calls[0]).toMatchObject({ url: '/api/plans/plan-1/ai-triage', method: 'POST' })

    const top = await screen.findByTestId('triage-session-b')
    expect(within(top).getByText('Advance')).toBeInTheDocument()
    expect(within(top).getByText('4.50')).toBeInTheDocument()
    expect(
      within(top).getByText(/Concrete verification patterns/)
    ).toBeInTheDocument()

    const second = screen.getByTestId('triage-session-a')
    expect(within(second).getByText('Discuss')).toBeInTheDocument()
    // Ranked, not in submission order.
    const rows = screen.getAllByTestId(/^triage-session-/)
    expect(rows.map((row) => row.dataset.testid)).toEqual([
      'triage-session-b',
      'triage-session-a',
    ])
  })

  it('says plainly that the triage is machine-generated and by which model', async () => {
    renderEvaluation()

    fireEvent.click(await screen.findByRole('button', { name: 'AI triage' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Run AI triage' }))

    expect(await screen.findByText(/AI-generated — review before acting/)).toBeInTheDocument()
    expect(screen.getByText(/Model claude-haiku-4-5/)).toBeInTheDocument()
  })

  it('persists a human override of an AI score', async () => {
    renderEvaluation()

    fireEvent.click(await screen.findByRole('button', { name: 'AI triage' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Run AI triage' }))
    await screen.findByTestId('triage-session-a')

    const row = screen.getByTestId('triage-session-a')
    fireEvent.change(within(row).getByLabelText('Override score'), { target: { value: '4.5' } })
    fireEvent.click(within(row).getByRole('button', { name: 'Save override' }))

    await waitFor(() => expect(calls).toHaveLength(2))
    expect(calls[1]).toMatchObject({
      url: '/api/plans/plan-1/ai-triage/session-a',
      method: 'PATCH',
      body: { score: 4.5 },
    })
    // The override is shown as a correction OF the AI value, not as the AI's.
    expect(
      await within(screen.getByTestId('triage-session-a')).findByText('Override')
    ).toBeInTheDocument()
  })

  it('shows the AI score beside the human average, labelled', async () => {
    triageState = TRIAGE
    renderEvaluation()
    await openTab('Summary & decisions')

    const row = await screen.findByRole('row', { name: /Your AI Pair Programmer/ })
    // 5.00 is the committee's; 4.50 is the machine's, and it says so.
    expect(within(row).getByText('5.00')).toBeInTheDocument()
    expect(within(row).getByText('AI')).toBeInTheDocument()
    expect(within(row).getByText('4.50')).toBeInTheDocument()
  })
})

const HEURISTIC = {
  plan_id: PLAN.id,
  triage: {
    generated_at: '2026-08-10T12:00:00+00:00',
    source: 'heuristic' as const,
    model: null,
    stored: true,
    items: [
      {
        session_id: 'session-a',
        title: 'Taming 40-Minute CI',
        summary: 'Incremental builds at monorepo scale.',
        score: 3.33,
        suggestion: 'discuss' as const,
        rationale: "Ranked from the committee's own numbers.",
        override_score: null,
      },
    ],
  },
}

describe('Evaluation — AI triage without a key', () => {
  beforeEach(() => {
    calls = []
    triageState = { plan_id: PLAN.id, triage: null }
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
        if (url.includes('/ai-triage')) {
          if (method === 'POST') {
            triageState = HEURISTIC
            return jsonResponse(HEURISTIC)
          }
          return jsonResponse(triageState)
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

  it('never passes a score heuristic off as model-written prose', async () => {
    renderEvaluation()

    fireEvent.click(await screen.findByRole('button', { name: 'AI triage' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Run AI triage' }))

    expect(
      await screen.findByText(/No AI key configured: ranked from reviewer scores/)
    ).toBeInTheDocument()
    expect(screen.queryByText(/Model claude/)).not.toBeInTheDocument()
  })
})
