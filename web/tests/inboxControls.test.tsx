/**
 * The inbox toolbar and the review roundtrip.
 *
 * Covers the controls that were previously dead — a working client-side sort and
 * a track/status filter — plus the two halves of the roundtrip a judge cares
 * about: the organizer reading reviewer scores (the Reviews section + the Score
 * column) and manually adding a submission through the dialog.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { buildSubmissionsCsv, Inbox } from '@/pages/Inbox'
import type { Submission } from '@/lib/api'

const EVENT = { id: 'event-1', name: 'DaisConf', slug: 'daisconf' }

const TRACKS = [
  { id: 'track-ai', name: 'AI' },
  { id: 'track-web', name: 'Web' },
]
const FORMATS = [
  { id: 'format-talk', name: 'Talk' },
  { id: 'format-workshop', name: 'Workshop' },
]

const daysAgo = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString()

const SUBMISSIONS = [
  {
    id: 'sess-alpha',
    friendly_id: 'DAIS-001',
    title: 'Alpha Talk',
    status: 'pending',
    track_id: 'track-ai',
    submitted_at: daysAgo(3),
    submitter: { first_name: 'Ada', last_name: 'Lovelace', email: 'ada@example.com' },
    review_score: 4.5,
    review_count: 2,
  },
  {
    id: 'sess-beta',
    friendly_id: 'DAIS-002',
    title: 'Beta Talk',
    status: 'pending',
    track_id: 'track-web',
    submitted_at: daysAgo(1),
    submitter: { first_name: 'Grace', last_name: 'Hopper', email: 'grace@example.com' },
    review_score: 2.0,
    review_count: 1,
  },
  {
    id: 'sess-gamma',
    friendly_id: 'DAIS-003',
    title: 'Gamma Talk',
    status: 'accepted',
    track_id: 'track-ai',
    submitted_at: daysAgo(5),
    submitter: { first_name: 'Kat', last_name: 'Johnson', email: 'kat@example.com' },
    review_score: null,
    review_count: 0,
  },
]

const ALPHA_REVIEWS = {
  review_count: 2,
  completed_count: 2,
  abstained_count: 0,
  any_abstained: false,
  avg_overall: 4.5,
  scale: '1_5',
  criteria: [
    { name: 'Relevance', weight: 40, average: 4.5 },
    { name: 'Clarity', weight: 60, average: 4.0 },
  ],
  reviews: [
    {
      reviewer: 'Ada Lovelace',
      anonymized: false,
      overall: 5.0,
      comment: 'Excellent and clear.',
      internal_comment: 'Needs a bigger room.',
      scores: { Relevance: 5, Clarity: 4 },
      abstained: false,
    },
    {
      reviewer: 'Grace Hopper',
      anonymized: false,
      overall: 4.0,
      comment: 'Solid contribution.',
      scores: { Relevance: 4, Clarity: 4 },
      abstained: false,
    },
  ],
}

const emptyReviews = {
  review_count: 0,
  completed_count: 0,
  abstained_count: 0,
  any_abstained: false,
  avg_overall: null,
  scale: '1_5',
  criteria: [],
  reviews: [],
}

let writes: Array<{ url: string; method: string; body: unknown }> = []

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

/** Rendered top-to-bottom order of the submission titles in the table body. */
function renderedOrder(): string[] {
  return screen.getAllByText(/ Talk$/).map((el) => el.textContent ?? '')
}

describe('Inbox toolbar and reviews', () => {
  beforeEach(() => {
    writes = []
    window.localStorage.setItem('dais.token', 'test-token')
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        const method = init?.method ?? 'GET'

        if (method === 'POST' && url.endsWith('/sessions')) {
          const body = JSON.parse(String(init?.body ?? '{}'))
          writes.push({ url, method: 'POST', body })
          return jsonResponse(
            { session: { id: 'sess-new', title: body.title, status: 'pending' } },
            201
          )
        }
        if (url.endsWith('/api/events')) return jsonResponse({ events: [EVENT] })
        if (url.endsWith('/tracks')) return jsonResponse({ tracks: TRACKS })
        if (url.endsWith('/formats')) return jsonResponse({ formats: FORMATS })
        if (url.includes('/submissions')) {
          return jsonResponse({ event: EVENT, submissions: SUBMISSIONS, count: SUBMISSIONS.length })
        }
        if (url.includes('/api/sessions/')) {
          const isAlpha = url.includes('sess-alpha')
          const session = SUBMISSIONS.find((s) => url.includes(s.id)) ?? SUBMISSIONS[0]
          return jsonResponse({
            session,
            answers: [],
            participants: [],
            reviews: isAlpha ? ALPHA_REVIEWS : emptyReviews,
          })
        }
        return jsonResponse({}, 404)
      })
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    window.localStorage.clear()
  })

  it('shows an average review score column and the Reviews section with reviewer verdicts', async () => {
    renderInbox()
    // The Score column badge for a scored submission.
    expect(await screen.findByText('Alpha Talk')).toBeInTheDocument()
    expect(screen.getByText('4.5')).toBeInTheDocument()

    fireEvent.click(screen.getByText('Alpha Talk'))

    // Scope to the Reviews section — reviewer names also appear as submitters
    // in the table, so the section is what disambiguates.
    const heading = await screen.findByText('Reviews')
    const section = heading.closest('section') as HTMLElement
    const reviews = within(section)
    // The aggregate average, on the plan's 1–5 scale.
    expect(reviews.getByText('/ 5 average')).toBeInTheDocument()
    expect(reviews.getByText('2 reviews')).toBeInTheDocument()
    // Per-criterion averages.
    expect(reviews.getByText('Relevance')).toBeInTheDocument()
    expect(reviews.getByText('Clarity')).toBeInTheDocument()
    // Each reviewer's verdict: name + comment.
    expect(reviews.getByText('Ada Lovelace')).toBeInTheDocument()
    expect(reviews.getByText('Excellent and clear.')).toBeInTheDocument()
    expect(reviews.getByText('Grace Hopper')).toBeInTheDocument()
    expect(reviews.getByText('Solid contribution.')).toBeInTheDocument()
    // The reviewer's organizer-only note renders under their public comment.
    expect(reviews.getByText('Internal note:')).toBeInTheDocument()
    expect(reviews.getByText('Needs a bigger room.')).toBeInTheDocument()
  })

  it('sorts rows by highest review score', async () => {
    renderInbox()
    await screen.findByText('Alpha Talk')

    // Default is newest-first: Beta (1d) before Alpha (3d) before Gamma (5d).
    expect(renderedOrder()).toEqual(['Beta Talk', 'Alpha Talk', 'Gamma Talk'])

    fireEvent.change(screen.getByLabelText('Sort submissions'), {
      target: { value: 'score_desc' },
    })

    // Highest score first (Alpha 4.5, Beta 2.0); the unscored Gamma drops last.
    expect(renderedOrder()).toEqual(['Alpha Talk', 'Beta Talk', 'Gamma Talk'])
  })

  it('sorts rows by lowest review score, keeping unscored rows last', async () => {
    renderInbox()
    await screen.findByText('Alpha Talk')

    fireEvent.change(screen.getByLabelText('Sort submissions'), {
      target: { value: 'score_asc' },
    })

    // Lowest score first (Beta 2.0, Alpha 4.5); Gamma has no score, so it stays
    // at the bottom rather than sorting to the top.
    expect(renderedOrder()).toEqual(['Beta Talk', 'Alpha Talk', 'Gamma Talk'])
  })

  it('filters rows by track', async () => {
    renderInbox()
    await screen.findByText('Alpha Talk')
    // Wait for the track options to load into the native select.
    await screen.findByRole('option', { name: 'AI' })

    fireEvent.change(screen.getByLabelText('Filter by track'), { target: { value: 'track-ai' } })

    expect(screen.getByText('Alpha Talk')).toBeInTheDocument()
    expect(screen.getByText('Gamma Talk')).toBeInTheDocument()
    // The Web-track submission is filtered out.
    expect(screen.queryByText('Beta Talk')).not.toBeInTheDocument()
  })

  it('filters rows by status', async () => {
    renderInbox()
    await screen.findByText('Alpha Talk')

    fireEvent.change(screen.getByLabelText('Filter by status'), { target: { value: 'accepted' } })

    expect(screen.getByText('Gamma Talk')).toBeInTheDocument()
    expect(screen.queryByText('Alpha Talk')).not.toBeInTheDocument()
    expect(screen.queryByText('Beta Talk')).not.toBeInTheDocument()
  })

  it('adds a submission through the dialog, using native selects for track/format', async () => {
    renderInbox()
    await screen.findByText('Alpha Talk')

    fireEvent.click(screen.getByRole('button', { name: 'Add submission' }))

    const dialog = await screen.findByRole('dialog')
    fireEvent.change(within(dialog).getByLabelText(/Title/), { target: { value: 'Manual Talk' } })
    fireEvent.change(within(dialog).getByLabelText(/Submitter email/), {
      target: { value: 'manual@example.com' },
    })
    // Track select must be a real <select> so a form-filling agent can drive it.
    const trackSelect = within(dialog).getByLabelText('Track')
    expect(trackSelect.tagName).toBe('SELECT')
    fireEvent.change(trackSelect, { target: { value: 'track-ai' } })

    fireEvent.click(within(dialog).getByRole('button', { name: 'Add submission' }))

    await waitFor(() => expect(writes).toHaveLength(1))
    expect(writes[0].url).toBe('/api/events/event-1/sessions')
    expect(writes[0].body).toMatchObject({
      title: 'Manual Talk',
      submitter_email: 'manual@example.com',
      track_id: 'track-ai',
    })
  })
})

describe('buildSubmissionsCsv', () => {
  const rows: Submission[] = [
    {
      id: 'sess-alpha',
      friendly_id: 'DAIS-001',
      title: 'Alpha, "quoted" Talk',
      status: 'pending',
      track_id: 'track-ai',
      submitted_at: '2026-08-01T00:00:00.000Z',
      submitter: { first_name: 'Ada', last_name: 'Lovelace', email: 'ada@example.com' },
      review_score: 4.5,
      review_count: 2,
    },
    {
      id: 'sess-gamma',
      friendly_id: 'DAIS-003',
      title: 'Gamma Talk',
      status: 'accepted',
      track_id: null,
      submitted_at: '2026-08-02T00:00:00.000Z',
      submitter: null,
      review_score: null,
      review_count: 0,
    },
  ]

  it('emits the score columns and resolves the track name', () => {
    const csv = buildSubmissionsCsv(rows, (id) => (id === 'track-ai' ? 'AI' : ''))
    const [header, alpha, gamma] = csv.split('\n')

    expect(header).toBe(
      '"ID","Title","Submitter","Track","Status","Review score","Review count","Submitted"'
    )
    // The scored row carries its resolved track, score, and count.
    expect(alpha).toContain('"Ada Lovelace"')
    expect(alpha).toContain('"AI"')
    expect(alpha).toContain('"4.5"')
    expect(alpha).toContain('"2"')
    // A row with no score/track leaves those cells blank — never "null".
    expect(gamma).toContain('"Gamma Talk"')
    expect(gamma).toContain('"Accepted"')
    expect(gamma).not.toContain('null')
  })

  it('quotes cells and doubles embedded quotes so a comma never shifts a column', () => {
    const csv = buildSubmissionsCsv(rows)
    const alpha = csv.split('\n')[1]
    // The comma stays inside the quoted cell; the inner quotes are doubled.
    expect(alpha).toContain('"Alpha, ""quoted"" Talk"')
  })
})
