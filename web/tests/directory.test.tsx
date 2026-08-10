/**
 * The org-level Speaker Directory.
 *
 * What matters is that this page is the CROSS-EVENT view: a person appears once
 * with every event they have spoken at, search and attribute filters narrow the
 * same list, a filtered view can be saved as a segment, near-duplicates are
 * flagged and mergeable, and a contact can be pushed into an event without
 * re-keying. Those are the claims the area is judged on, so those are the
 * assertions here — not that a heading renders.
 */

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { DirectoryPerson } from '@/lib/crmApi'
import { Directory } from '@/pages/Directory'

const PRIYA: DirectoryPerson = {
  id: 'p-priya',
  name: 'Priya Raman',
  first_name: 'Priya',
  last_name: 'Raman',
  email: 'priya@latticework.example',
  alt_emails: [],
  company_name: 'Latticework Systems',
  title: 'Principal Engineer',
  about: 'Build tooling.',
  photo_url: null,
  tags: ['AI'],
  custom: {},
  pipeline_stage: 'identified' as const,
  in_pipeline: false,
  score: null,
  rationale: null,
  events: [
    { id: 'e-1', name: 'AI Builders Summit' },
    { id: 'e-2', name: 'DevFlow Conf 2027' },
  ],
  event_ids: ['e-1', 'e-2'],
  event_count: 2,
  contact_ids: ['c-1', 'c-2'],
  is_duplicate: true,
}

const PRIYA_ALT: DirectoryPerson = {
  ...PRIYA,
  id: 'p-priya-alt',
  email: 'priya.raman.alt@sbek-test.example.com',
  company_name: null,
  title: null,
  about: null,
  tags: [],
  events: [],
  event_ids: [],
  event_count: 0,
  contact_ids: [],
  is_duplicate: true,
}

const MARCUS: DirectoryPerson = {
  ...PRIYA,
  id: 'p-marcus',
  name: 'Marcus Okafor',
  first_name: 'Marcus',
  last_name: 'Okafor',
  email: 'marcus@cloudreach.example',
  company_name: 'Cloudreach Labs',
  title: 'Staff Developer Advocate',
  about: null,
  tags: [],
  events: [{ id: 'e-1', name: 'AI Builders Summit' }],
  event_ids: ['e-1'],
  event_count: 1,
  contact_ids: ['c-3'],
  is_duplicate: false,
}

const ALL: DirectoryPerson[] = [MARCUS, PRIYA, PRIYA_ALT]

const FACETS = {
  companies: ['Cloudreach Labs', 'Latticework Systems'],
  titles: ['Principal Engineer', 'Staff Developer Advocate'],
  tags: ['AI', 'Keynote'],
  stages: [
    { value: 'researching', label: 'Researching' },
    { value: 'identified', label: 'Identified' },
    { value: 'contacted', label: 'Contacted' },
    { value: 'interested', label: 'Interested' },
    { value: 'confirmed', label: 'Confirmed' },
    { value: 'declined', label: 'Declined' },
  ],
  events: [
    { id: 'e-1', name: 'AI Builders Summit' },
    { id: 'e-2', name: 'DevFlow Conf 2027' },
  ],
}

const OVERVIEW = {
  totals: { contacts: 3, events: 2, returning_speakers: 1, in_pipeline: 0, confirmed: 0, tagged: 1 },
  top_companies: [
    { name: 'Cloudreach Labs', count: 1 },
    { name: 'Latticework Systems', count: 1 },
  ],
  top_titles: [],
  top_tags: [{ name: 'AI', count: 1 }],
  by_stage: [],
  by_event: [{ id: 'e-1', name: 'AI Builders Summit', count: 2 }],
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

/** The fake directory endpoint honours q/company/tag so filters really narrow. */
function directoryPayload(url: string) {
  const params = new URL(url, 'http://localhost').searchParams
  const q = (params.get('q') ?? '').toLowerCase()
  const company = params.get('company') ?? ''
  const tag = params.get('tag') ?? ''
  const segment = params.get('segment_id') ?? ''

  let people = ALL
  if (q) people = people.filter((person) => person.name.toLowerCase().includes(q))
  if (company) people = people.filter((person) => person.company_name === company)
  if (tag) people = people.filter((person) => person.tags.includes(tag))
  if (segment === 'seg-ai') people = ALL.filter((person) => person.tags.includes('AI'))

  return {
    people,
    total: people.length,
    total_all: ALL.length,
    filters: Object.fromEntries(params.entries()),
    segment_id: segment || null,
    segments: segments,
    duplicate_count: 2,
    facets: FACETS,
    custom_fields: [],
  }
}

let segments: { id: string; name: string; kind: string; filter: Record<string, string>; member_ids: string[]; member_count: number }[] = []
let posted: { url: string; body: unknown }[] = []

function renderDirectory() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <MemoryRouter>
      <QueryClientProvider client={queryClient}>
        <Directory />
      </QueryClientProvider>
    </MemoryRouter>
  )
}

describe('Speaker Directory', () => {
  beforeEach(() => {
    segments = []
    posted = []
    window.localStorage.setItem('dais.token', 'test-token')
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        const method = (init?.method ?? 'GET').toUpperCase()
        const body = init?.body ? JSON.parse(String(init.body)) : undefined
        if (method !== 'GET') posted.push({ url, body })

        if (url.startsWith('/api/crm/directory') && method === 'GET') {
          return jsonResponse(directoryPayload(url))
        }
        if (url.startsWith('/api/crm/overview')) return jsonResponse(OVERVIEW)
        if (url.startsWith('/api/crm/segments') && method === 'POST') {
          const segment = {
            id: 'seg-ai',
            name: String(body.name),
            kind: String(body.kind),
            filter: body.filter ?? {},
            member_ids: body.member_ids ?? [],
            member_count: 2,
          }
          segments = [segment]
          return jsonResponse({ segment })
        }
        if (url.startsWith('/api/crm/merge')) {
          return jsonResponse({ person: PRIYA, total_all: 2 })
        }
        if (url.includes('/add-to-event')) {
          return jsonResponse({
            created: true,
            event: { id: 'e-2', name: 'DevFlow Conf 2027' },
            contact: {
              id: 'c-9',
              email: MARCUS.email,
              first_name: 'Marcus',
              last_name: 'Okafor',
              company_name: 'Cloudreach Labs',
              title: 'Staff Developer Advocate',
              about: null,
            },
          })
        }
        if (url.startsWith('/api/crm/outreach') && method === 'POST') {
          return jsonResponse({
            sent: 2,
            failed: 0,
            skipped: 0,
            total: 2,
            event: { id: 'e-1', name: 'AI Builders Summit' },
            recipients: [
              { person_id: MARCUS.id, name: MARCUS.name, email: MARCUS.email, subject: 'Speak at DevFlow Conf 2027?', status: 'sent' },
              { person_id: PRIYA.id, name: PRIYA.name, email: PRIYA.email, subject: 'Speak at DevFlow Conf 2027?', status: 'sent' },
            ],
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

  it('lists contacts across every event, with the events they appeared at', async () => {
    renderDirectory()
    expect(await screen.findByText('Marcus Okafor')).toBeInTheDocument()

    // The cross-event claim: ONE row for Priya carrying BOTH events. (Her
    // same-name duplicate is a second row — that is the point of the fixture.)
    const row = screen.getByText('priya@latticework.example').closest('tr') as HTMLElement
    expect(within(row).getByText('AI Builders Summit')).toBeInTheDocument()
    expect(within(row).getByText('DevFlow Conf 2027')).toBeInTheDocument()
    expect(within(row).getByText('priya@latticework.example')).toBeInTheDocument()
  })

  it('shows org-wide KPIs including the metric no single event can produce', async () => {
    renderDirectory()
    const label = await screen.findByText('Returning speakers')
    const card = label.closest('div') as HTMLElement
    await waitFor(() => expect(within(card).getByText('1')).toBeInTheDocument())
    expect(within(card).getByText('Appear at 2+ events')).toBeInTheDocument()

    const contacts = screen.getByText('Total contacts').closest('div') as HTMLElement
    expect(within(contacts).getByText('3')).toBeInTheDocument()
  })

  it('narrows on search and restores the full list when cleared', async () => {
    renderDirectory()
    await screen.findByText('Marcus Okafor')

    const search = screen.getByLabelText('Search contacts')
    fireEvent.change(search, { target: { value: 'Priya' } })
    await waitFor(() => expect(screen.queryByText('Marcus Okafor')).not.toBeInTheDocument())
    expect(await screen.findByText('priya@latticework.example')).toBeInTheDocument()

    fireEvent.change(search, { target: { value: '' } })
    expect(await screen.findByText('Marcus Okafor')).toBeInTheDocument()
  })

  it('narrows on an attribute filter and shows the active criterion', async () => {
    renderDirectory()
    await screen.findByText('priya@latticework.example')

    fireEvent.change(screen.getByLabelText('Company'), { target: { value: 'Cloudreach Labs' } })
    await waitFor(() =>
      expect(screen.queryByText('priya@latticework.example')).not.toBeInTheDocument()
    )
    expect(await screen.findByText('Marcus Okafor')).toBeInTheDocument()
    expect(screen.getByText('Company: Cloudreach Labs')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }))
    expect(await screen.findByText('priya@latticework.example')).toBeInTheDocument()
  })

  it('saves the current filter as a named segment and reopens it', async () => {
    renderDirectory()
    await screen.findByText('priya@latticework.example')

    fireEvent.change(screen.getByLabelText('Tag'), { target: { value: 'AI' } })
    await screen.findByText('Tag: AI')

    fireEvent.click(screen.getByRole('button', { name: 'Save segment' }))
    fireEvent.change(await screen.findByLabelText('Segment name'), { target: { value: 'AI Experts' } })
    // The dialog offers the dynamic/curated choice the spec asks about.
    expect(screen.getByLabelText('Segment type')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Save segment' }))

    await waitFor(() => {
      const call = posted.find((entry) => entry.url.includes('/api/crm/segments'))
      expect(call?.body).toMatchObject({ name: 'AI Experts', kind: 'dynamic', filter: { tag: 'AI' } })
    })
    expect(await screen.findByText(/Segment: AI Experts/)).toBeInTheDocument()
  })

  it('flags near-duplicates and merges them into one chosen primary record', async () => {
    renderDirectory()
    await screen.findByText('priya@latticework.example')

    expect(screen.getAllByText('Possible duplicate').length).toBeGreaterThan(0)
    fireEvent.click(screen.getByRole('button', { name: /Review & merge/ }))

    // The side-by-side comparison, the primary choice, and the warning.
    expect(await screen.findByText('Merge duplicate contacts')).toBeInTheDocument()
    expect(screen.getByText(/Merging cannot be undone/)).toBeInTheDocument()
    expect(screen.getAllByRole('radio', { name: /Priya Raman/ }).length).toBe(2)

    fireEvent.click(screen.getByRole('button', { name: 'Merge records' }))
    await waitFor(() => {
      const call = posted.find((entry) => entry.url.includes('/api/crm/merge'))
      expect(call?.body).toMatchObject({ primary_id: 'p-priya', duplicate_id: 'p-priya-alt' })
    })
  })

  it('pushes selected contacts into an event without re-keying', async () => {
    renderDirectory()
    await screen.findByText('Marcus Okafor')

    fireEvent.click(screen.getByLabelText('Select Marcus Okafor'))
    fireEvent.change(await screen.findByLabelText('Add selected contacts to event'), {
      target: { value: 'e-2' },
    })
    fireEvent.click(screen.getByRole('button', { name: /Add to event/ }))

    await waitFor(() => {
      const call = posted.find((entry) => entry.url.includes('/add-to-event'))
      expect(call?.url).toContain('p-marcus')
      expect(call?.body).toEqual({ event_id: 'e-2' })
    })
  })

  it('composes bulk email to 2+ selected contacts with resolved merge tags', async () => {
    renderDirectory()
    await screen.findByText('Marcus Okafor')

    fireEvent.click(screen.getByLabelText('Select Marcus Okafor'))
    fireEvent.click(screen.getAllByLabelText('Select Priya Raman')[0])
    expect(screen.getByText('2 contacts selected')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Send email' }))
    fireEvent.change(await screen.findByLabelText('Subject'), {
      target: { value: 'Speak at DevFlow Conf 2027?' },
    })

    // The preview resolves {{first_name}}/{{company}} to real values, and no
    // literal tag survives into what the organizer is about to send.
    const preview = screen.getByText(/Preview for/).parentElement as HTMLElement
    expect(within(preview).getByText(/Hi Marcus,/)).toBeInTheDocument()
    expect(within(preview).getByText(/Cloudreach Labs/)).toBeInTheDocument()
    expect(preview.textContent).not.toContain('{{first_name}}')

    fireEvent.click(screen.getByRole('button', { name: 'Send email' }))
    expect(await screen.findByText(/Sent 2, suppressed 0, failed 0 of 2 recipients/)).toBeInTheDocument()
  })

  it('drills through from a dashboard widget to the filtered list', async () => {
    renderDirectory()
    await screen.findByText('priya@latticework.example')

    fireEvent.click(await screen.findByRole('button', { name: /Cloudreach Labs 1/ }))
    await waitFor(() =>
      expect(screen.queryByText('priya@latticework.example')).not.toBeInTheDocument()
    )
    expect(screen.getByText('Company: Cloudreach Labs')).toBeInTheDocument()
  })
})
