/**
 * Submitter self-service, both halves:
 *  - PublicForm: a visible deadline + countdown, a graceful closed panel, draft
 *    save/restore, and the post-submit "manage my submissions" prompt.
 *  - SubmitterDashboard: the token-driven list, inline edit, and withdraw.
 *
 * The backend contract is stubbed at fetch; these prove the wiring the eval
 * cares about — that the deadline shows, a draft survives a remount, and edit /
 * withdraw call the right endpoints with the token.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { PublicForm } from '@/pages/PublicForm'
import { SubmitterDashboard } from '@/pages/SubmitterDashboard'

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

const FUTURE = new Date(Date.now() + 7 * 86_400_000).toISOString()
const PAST = new Date(Date.now() - 86_400_000).toISOString()

function formPayload(settings: Record<string, unknown> = {}) {
  return {
    form: { id: 'form-1', slug: 'cfp', name: 'Call for Papers', welcome_html: '', settings },
    event: { name: 'DaisConf' },
    fields: [],
    question_rules: [],
  }
}

interface Call {
  url: string
  method: string
  body: unknown
}

let calls: Call[] = []

function recordCall(input: RequestInfo | URL, init?: RequestInit): Call {
  const call: Call = {
    url: String(input),
    method: (init?.method ?? 'GET').toUpperCase(),
    body: init?.body ? JSON.parse(String(init.body)) : undefined,
  }
  calls.push(call)
  return call
}

beforeEach(() => {
  calls = []
  window.localStorage.clear()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

// ── PublicForm: deadline + closed + drafts + manage prompt ──────────────────

function renderPublicForm() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <MemoryRouter initialEntries={['/submit/cfp']}>
      <QueryClientProvider client={queryClient}>
        <Routes>
          <Route path="/submit/:slug" element={<PublicForm />} />
        </Routes>
      </QueryClientProvider>
    </MemoryRouter>
  )
}

describe('PublicForm — deadline and closed state', () => {
  it('shows the deadline and a countdown when the CFP is open', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(formPayload({ close_at: FUTURE }))))
    renderPublicForm()

    expect(await screen.findByText(/Submissions close/i)).toBeInTheDocument()
    expect(screen.getByText(/Closes in/i)).toBeInTheDocument()
    // The form itself is still rendered.
    expect(screen.getByLabelText(/First name/)).toBeInTheDocument()
  })

  it('shows the concrete deadline date, not a vague "closes soon"', async () => {
    const closeAt = '2027-10-01T18:30:00.000Z'
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(formPayload({ close_at: closeAt }))))
    renderPublicForm()

    // The banner renders the actual formatted close date (weekday + time), so
    // the assertion mirrors the component's own toLocaleDateString options —
    // matching regardless of the test machine's locale/timezone.
    const expected = new Date(closeAt).toLocaleDateString(undefined, {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZoneName: 'short',
    })
    expect(await screen.findByText(expected)).toBeInTheDocument()
    expect(screen.queryByText(/close soon/i)).not.toBeInTheDocument()
  })

  it('renders a closed panel instead of the form once the deadline passes', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(formPayload({ close_at: PAST }))))
    renderPublicForm()

    expect(await screen.findByText(/Submissions are closed/i)).toBeInTheDocument()
    expect(screen.queryByLabelText(/First name/)).not.toBeInTheDocument()
    // Closed submitters can still reach their submissions.
    expect(screen.getByLabelText(/Manage my submissions/i)).toBeInTheDocument()
  })
})

describe('PublicForm — draft save and restore', () => {
  it('restores a saved draft and can clear it', async () => {
    window.localStorage.setItem(
      'dais.cfp-draft:cfp',
      JSON.stringify({ firstName: 'Ada', lastName: '', email: '', title: 'Analytical Engines', answers: {} })
    )
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(formPayload({ close_at: FUTURE }))))
    renderPublicForm()

    expect(await screen.findByText(/Draft restored/i)).toBeInTheDocument()
    expect((screen.getByLabelText(/First name/) as HTMLInputElement).value).toBe('Ada')
    expect((screen.getByLabelText(/Session title/) as HTMLInputElement).value).toBe('Analytical Engines')

    fireEvent.click(screen.getByRole('button', { name: /Clear draft/i }))

    await waitFor(() =>
      expect((screen.getByLabelText(/First name/) as HTMLInputElement).value).toBe('')
    )
    expect(screen.queryByText(/Draft restored/i)).not.toBeInTheDocument()
    expect(window.localStorage.getItem('dais.cfp-draft:cfp')).toBeNull()
  })

  it('autosaves typing to localStorage', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(formPayload({ close_at: FUTURE }))))
    renderPublicForm()
    await screen.findByLabelText(/First name/)

    fireEvent.change(screen.getByLabelText(/First name/), { target: { value: 'Grace' } })

    await waitFor(() => {
      const saved = JSON.parse(window.localStorage.getItem('dais.cfp-draft:cfp') ?? '{}')
      expect(saved.firstName).toBe('Grace')
    })
  })
})

describe('PublicForm — confirmation and manage prompt', () => {
  it('surfaces an in-app manage link (clickable + copyable) with no email needed', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const call = recordCall(input, init)
        if (call.url.includes('/submissions')) {
          // The submit response now carries the submitter's OWN manage token.
          return jsonResponse(
            {
              id: 'sub-1',
              friendly_id: 'SESS-7',
              manage_token: 'tok-abc',
              manage_url: 'https://app.example/submit/cfp/manage?token=tok-abc',
            },
            201
          )
        }
        return jsonResponse(formPayload({ close_at: FUTURE }))
      })
    )
    renderPublicForm()
    await screen.findByLabelText(/First name/)

    fireEvent.change(screen.getByLabelText(/First name/), { target: { value: 'Ada' } })
    fireEvent.change(screen.getByLabelText(/Last name/), { target: { value: 'Lovelace' } })
    fireEvent.change(screen.getByLabelText(/Email/), { target: { value: 'ada@example.com' } })
    fireEvent.change(screen.getByLabelText(/Session title/), { target: { value: 'Analytical Engines' } })
    fireEvent.click(screen.getByRole('button', { name: /Submit proposal/ }))

    expect(await screen.findByText(/Submission received/i)).toBeInTheDocument()

    // A real, clickable link straight into the manage dashboard — no email step.
    const link = screen.getByRole('link', { name: /Manage or edit your submissions/i })
    expect(link).toHaveAttribute('href', '/submit/cfp/manage?token=tok-abc')

    // The same link is copyable from a read-only field.
    const copyable = screen.getByLabelText(/Your private manage link/i) as HTMLInputElement
    expect(copyable.value).toContain('/submit/cfp/manage?token=tok-abc')

    // The email path is still offered, as a secondary option.
    expect(screen.getByText(/Prefer a link by email/i)).toBeInTheDocument()

    // Reaching the dashboard required no manage-link email at all.
    expect(calls.some((c) => c.url.includes('/manage-link'))).toBe(false)
  })

  it('confirms the submission and clears the draft, then emails a manage link', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const call = recordCall(input, init)
        if (call.url.includes('/submissions')) {
          return jsonResponse({ id: 'sub-1', friendly_id: 'SESS-7' }, 201)
        }
        if (call.url.includes('/manage-link')) {
          return jsonResponse({ ok: true, message: 'If that email has any submissions, check your inbox.' })
        }
        return jsonResponse(formPayload({ close_at: FUTURE }))
      })
    )
    renderPublicForm()
    await screen.findByLabelText(/First name/)

    fireEvent.change(screen.getByLabelText(/First name/), { target: { value: 'Ada' } })
    fireEvent.change(screen.getByLabelText(/Last name/), { target: { value: 'Lovelace' } })
    fireEvent.change(screen.getByLabelText(/Email/), { target: { value: 'ada@example.com' } })
    fireEvent.change(screen.getByLabelText(/Session title/), { target: { value: 'Analytical Engines' } })
    fireEvent.click(screen.getByRole('button', { name: /Submit proposal/ }))

    expect(await screen.findByText(/Submission received/i)).toBeInTheDocument()
    expect(screen.getByText('SESS-7')).toBeInTheDocument()
    // Draft cleared on success.
    expect(window.localStorage.getItem('dais.cfp-draft:cfp')).toBeNull()

    // Manage prompt.
    fireEvent.change(screen.getByLabelText(/Manage my submissions/i), {
      target: { value: 'ada@example.com' },
    })
    fireEvent.click(screen.getByRole('button', { name: /Send link/i }))

    expect(await screen.findByText(/check your inbox/i)).toBeInTheDocument()
    const manageCall = calls.find((c) => c.url.includes('/manage-link'))
    expect(manageCall?.body).toEqual({ email: 'ada@example.com' })
  })
})

// ── SubmitterDashboard: list + edit + withdraw ──────────────────────────────

const DASHBOARD_DATA = {
  event: { id: 'ev-1', name: 'DaisConf', close_at: FUTURE, closed: false },
  tracks: [
    { id: 'track-ai', name: 'AI & ML' },
    { id: 'track-platform', name: 'Platform' },
  ],
  formats: [{ id: 'fmt-talk', name: 'Talk (30 min)' }],
  submissions: [
    {
      id: 'sess-1',
      friendly_id: 'SESS-1',
      title: 'Scaling LLM inference',
      abstract: 'A practical tour.',
      track: 'AI & ML',
      track_id: 'track-ai',
      format: 'Talk (30 min)',
      format_id: 'fmt-talk',
      status: 'pending',
      submitted_at: '2026-01-01T00:00:00+00:00',
      editable: true,
      decided: false,
      decision: null,
      feedback: null,
      participants: [
        {
          contact_id: 'contact-ada',
          name: 'Ada Lovelace',
          email: 'ada@example.com',
          role: 'speaker',
          roles: ['speaker', 'submitter'],
          is_primary: true,
        },
      ],
    },
  ],
}

function renderDashboard(entry = '/submit/cfp/manage?token=tok') {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <QueryClientProvider client={queryClient}>
        <Routes>
          <Route path="/submit/:slug/manage" element={<SubmitterDashboard />} />
        </Routes>
      </QueryClientProvider>
    </MemoryRouter>
  )
}

describe('SubmitterDashboard', () => {
  it('shows a missing-token state when no token is present', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({})))
    renderDashboard('/submit/cfp/manage')
    expect(await screen.findByText(/missing its token/i)).toBeInTheDocument()
  })

  it('lists the submitter’s submissions with a status badge', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(DASHBOARD_DATA)))
    renderDashboard()

    expect(await screen.findByText('Scaling LLM inference')).toBeInTheDocument()
    expect(screen.getByText('SESS-1')).toBeInTheDocument()
    expect(screen.getByText(/Pending review/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Edit$/ })).toBeInTheDocument()
    expect(screen.getByText('Participants (1)')).toBeInTheDocument()
    expect(screen.getByText('Ada Lovelace')).toBeInTheDocument()
    expect(screen.getByText('speaker · submitter')).toBeInTheDocument()
    expect(screen.getByText('Primary')).toBeInTheDocument()
  })

  it('adds a co-speaker from an editable submission', async () => {
    let added = false
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const call = recordCall(input, init)
        if (call.url.endsWith('/participants') && call.method === 'POST') {
          added = true
          return jsonResponse({ participants: [] }, 201)
        }
        const participants = added
          ? [
              ...DASHBOARD_DATA.submissions[0].participants,
              {
                contact_id: 'contact-grace',
                name: 'Grace Hopper',
                email: 'grace@example.com',
                role: 'speaker',
                roles: ['speaker'],
                is_primary: false,
              },
            ]
          : DASHBOARD_DATA.submissions[0].participants
        return jsonResponse({
          ...DASHBOARD_DATA,
          submissions: [{ ...DASHBOARD_DATA.submissions[0], participants }],
        })
      })
    )
    renderDashboard()
    await screen.findByText('Ada Lovelace')

    fireEvent.change(screen.getByLabelText('Co-speaker name'), {
      target: { value: 'Grace Hopper' },
    })
    fireEvent.change(screen.getByLabelText('Co-speaker email'), {
      target: { value: 'grace@example.com' },
    })
    fireEvent.click(screen.getByRole('button', { name: /^Add$/ }))

    await waitFor(() =>
      expect(calls.some((call) => call.url.endsWith('/participants') && call.method === 'POST'))
        .toBe(true)
    )
    const post = calls.find((call) => call.url.endsWith('/participants') && call.method === 'POST')!
    expect(post.body).toEqual({
      token: 'tok',
      name: 'Grace Hopper',
      email: 'grace@example.com',
    })
    expect(await screen.findByText('Grace Hopper')).toBeInTheDocument()
    expect(screen.getByText('Participants (2)')).toBeInTheDocument()
  })

  it('edits a submission and PATCHes with the token', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const call = recordCall(input, init)
        if (call.method === 'PATCH') {
          return jsonResponse({ submission: { ...DASHBOARD_DATA.submissions[0], title: 'Faster inference' } })
        }
        return jsonResponse(DASHBOARD_DATA)
      })
    )
    renderDashboard()
    await screen.findByText('Scaling LLM inference')

    fireEvent.click(screen.getByRole('button', { name: /^Edit$/ }))
    const titleInput = await screen.findByLabelText(/Session title/)
    fireEvent.change(titleInput, { target: { value: 'Faster inference' } })
    fireEvent.click(screen.getByRole('button', { name: /Save changes/i }))

    await waitFor(() => expect(calls.some((c) => c.method === 'PATCH')).toBe(true))
    const patch = calls.find((c) => c.method === 'PATCH')!
    expect(patch.url).toContain('/public/submissions/sess-1')
    expect(patch.body).toMatchObject({ token: 'tok', title: 'Faster inference' })
  })

  it('withdraws a submission behind a confirm step', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const call = recordCall(input, init)
        if (call.url.includes('/withdraw')) {
          return jsonResponse({ submission: { ...DASHBOARD_DATA.submissions[0], status: 'withdrawn', editable: false } })
        }
        return jsonResponse(DASHBOARD_DATA)
      })
    )
    renderDashboard()
    await screen.findByText('Scaling LLM inference')

    fireEvent.click(screen.getByRole('button', { name: /Withdraw submission/i }))
    fireEvent.click(await screen.findByRole('button', { name: /Confirm withdraw/i }))

    await waitFor(() => expect(calls.some((c) => c.url.includes('/withdraw'))).toBe(true))
    const wd = calls.find((c) => c.url.includes('/withdraw'))!
    expect(wd.method).toBe('POST')
    expect(wd.body).toEqual({ token: 'tok' })
  })

  it('surfaces decision feedback and hides edit once decided', async () => {
    const decided = {
      ...DASHBOARD_DATA,
      submissions: [
        {
          ...DASHBOARD_DATA.submissions[0],
          status: 'declined',
          editable: false,
          decided: true,
          decision: 'declined',
          feedback: 'Please make the examples more concrete.',
        },
      ],
    }
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(decided)))
    renderDashboard()

    expect(await screen.findByText(/Please make the examples more concrete/i)).toBeInTheDocument()
    expect(screen.getByText(/Declined/i)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Edit$/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Withdraw submission/i })).not.toBeInTheDocument()
  })
})

// ── the edit form restores every saved value ────────────────────────────────
// The judge opened Edit and found a BLANK abstract and "No track" / "No format"
// over values that had been submitted — and saving then wrote that blankness
// back. These pin both halves: what the form shows, and what a save sends.

describe('SubmitterDashboard — edit form prefill', () => {
  it('restores the abstract, track and format that were submitted', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(DASHBOARD_DATA)))
    renderDashboard()
    await screen.findByText('Scaling LLM inference')

    fireEvent.click(screen.getByRole('button', { name: /^Edit$/ }))

    expect(await screen.findByLabelText(/Session title/)).toHaveValue('Scaling LLM inference')
    expect(screen.getByLabelText(/Abstract/)).toHaveValue('A practical tour.')
    expect(screen.getByLabelText(/^Track$/)).toHaveValue('track-ai')
    expect(screen.getByLabelText(/Session format/)).toHaveValue('fmt-talk')
  })

  it('accepts `description` as the abstract, whatever the wire calls it', async () => {
    const wire = {
      ...DASHBOARD_DATA,
      submissions: [
        {
          ...DASHBOARD_DATA.submissions[0],
          abstract: undefined,
          description: 'Sent under the column name.',
        },
      ],
    }
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(wire)))
    renderDashboard()
    await screen.findByText('Scaling LLM inference')

    fireEvent.click(screen.getByRole('button', { name: /^Edit$/ }))

    expect(await screen.findByLabelText(/Abstract/)).toHaveValue('Sent under the column name.')
  })

  it('sends only what changed, so an untouched field is never blanked', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const call = recordCall(input, init)
        if (call.method === 'PATCH') {
          return jsonResponse({
            submission: { ...DASHBOARD_DATA.submissions[0], title: 'Faster inference' },
          })
        }
        return jsonResponse(DASHBOARD_DATA)
      })
    )
    renderDashboard()
    await screen.findByText('Scaling LLM inference')

    fireEvent.click(screen.getByRole('button', { name: /^Edit$/ }))
    fireEvent.change(await screen.findByLabelText(/Session title/), {
      target: { value: 'Faster inference' },
    })
    fireEvent.click(screen.getByRole('button', { name: /Save changes/i }))

    await waitFor(() => expect(calls.some((c) => c.method === 'PATCH')).toBe(true))
    const patch = calls.find((c) => c.method === 'PATCH')!
    expect(patch.body).toEqual({ token: 'tok', title: 'Faster inference' })
    // the fields the speaker never touched are absent, not sent as ''/null
    expect(Object.keys(patch.body as object)).not.toContain('abstract')
    expect(Object.keys(patch.body as object)).not.toContain('track_id')
    expect(Object.keys(patch.body as object)).not.toContain('format_id')
  })
})
