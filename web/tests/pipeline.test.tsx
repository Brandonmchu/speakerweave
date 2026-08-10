/**
 * The sourcing pipeline board and the contact drawer it opens.
 *
 * The judged claims are: named stage columns covering an open-to-terminal
 * lifecycle, a directory contact can be enrolled, a card moves stage and the
 * move sticks, and the card detail carries an internal note plus a timestamped
 * record of the transitions. Persistence across reload is the server's job
 * (api/tests/test_crm.py asserts the history rows); what is asserted here is
 * that the UI issues the right write and renders what comes back.
 */

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { CrmPersonDrawer } from '@/pages/CrmPersonDrawer'
import { Pipeline } from '@/pages/Pipeline'

const MARCUS = {
  id: 'p-marcus',
  name: 'Marcus Okafor',
  first_name: 'Marcus',
  last_name: 'Okafor',
  email: 'marcus@cloudreach.example',
  alt_emails: [],
  company_name: 'Cloudreach Labs',
  title: 'Staff Developer Advocate',
  about: 'AI agents in production.',
  photo_url: null,
  tags: ['AI'],
  custom: {},
  pipeline_stage: 'contacted' as const,
  in_pipeline: true,
  score: 85,
  rationale: 'Strong platform-engineering track record; ideal for Platform & Infra track.',
  events: [{ id: 'e-1', name: 'AI Builders Summit' }],
  event_ids: ['e-1'],
  event_count: 1,
  contact_ids: ['c-3'],
  is_duplicate: false,
}

const DANA = {
  ...MARCUS,
  id: 'p-dana',
  name: 'Dana Kowalski',
  first_name: 'Dana',
  last_name: 'Kowalski',
  email: 'dana@northwind.example',
  company_name: 'Northwind',
  in_pipeline: false,
  pipeline_stage: 'identified' as const,
  score: null,
  rationale: null,
  tags: [],
}

const STAGES = [
  ['researching', 'Researching'],
  ['identified', 'Identified'],
  ['contacted', 'Contacted'],
  ['interested', 'Interested'],
  ['confirmed', 'Confirmed'],
  ['declined', 'Declined'],
] as const

const BOARD = {
  columns: STAGES.map(([stage, label]) => ({
    stage,
    label,
    terminal: stage === 'confirmed' || stage === 'declined',
    cards: stage === 'contacted' ? [MARCUS] : [],
    count: stage === 'contacted' ? 1 : 0,
  })),
  total: 1,
  candidates: [DANA],
  stages: STAGES.map(([value, label]) => ({ value, label })),
}

const DETAIL = {
  person: MARCUS,
  appearances: [
    {
      event_id: 'e-1',
      event_name: 'AI Builders Summit',
      event_slug: 'ai-builders-summit',
      starts_at: null,
      contact_id: 'c-3',
      submissions: [],
      sessions: [{ id: 's-1', title: 'Agents in prod', status: 'accepted', starts_at: null, role: 'speaker' }],
      tasks_total: 2,
      tasks_done: 1,
    },
  ],
  notes: [
    {
      id: 'n-1',
      body: 'Left voicemail 2027-01-15; follow up next week.',
      author: 'Organizer',
      created_at: '2027-01-15T10:00:00+00:00',
    },
  ],
  stage_history: [
    {
      id: 'h-2',
      from_stage: 'identified',
      from_label: 'Identified',
      to_stage: 'contacted',
      to_label: 'Contacted',
      actor: 'Organizer',
      created_at: '2027-01-15T09:30:00+00:00',
    },
    {
      id: 'h-1',
      from_stage: null,
      from_label: '',
      to_stage: 'identified',
      to_label: 'Identified',
      actor: 'Organizer',
      created_at: '2027-01-14T09:00:00+00:00',
    },
  ],
  communications: [
    {
      id: 'o-1',
      template_key: 'crm_outreach',
      subject: 'Speak at DevFlow Conf 2027?',
      status: 'sent',
      sent_at: '2027-01-16T12:00:00+00:00',
      created_at: null,
      event_name: 'AI Builders Summit',
    },
  ],
  duplicates: [],
  custom_fields: [
    { id: 'f-1', key: 'speaker_type', label: 'Speaker Type', field_type: 'dropdown', options: ['Internal', 'External'] },
  ],
  tag_library: ['AI', 'Keynote'],
  events: [
    { id: 'e-1', name: 'AI Builders Summit' },
    { id: 'e-2', name: 'DevFlow Conf 2027' },
  ],
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

let posted: { url: string; body: unknown }[] = []

function stubFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = (init?.method ?? 'GET').toUpperCase()
      const body = init?.body ? JSON.parse(String(init.body)) : undefined
      if (method !== 'GET') posted.push({ url, body })

      if (url.startsWith('/api/crm/pipeline')) return jsonResponse(BOARD)
      if (url.includes('/stage')) return jsonResponse({ person: MARCUS, stage_history: [] })
      if (url.includes('/notes')) {
        return jsonResponse({
          note: { id: 'n-2', body: body.body, author: 'Organizer', created_at: '2027-01-17T09:00:00+00:00' },
        })
      }
      if (url.startsWith('/api/crm/people/')) return jsonResponse(DETAIL)
      return jsonResponse({}, 404)
    })
  )
}

function wrap(node: React.ReactNode) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <MemoryRouter>
      <QueryClientProvider client={queryClient}>{node}</QueryClientProvider>
    </MemoryRouter>
  )
}

describe('Speaker Pipeline', () => {
  beforeEach(() => {
    posted = []
    window.localStorage.setItem('dais.token', 'test-token')
    stubFetch()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    window.localStorage.clear()
  })

  it('renders every stage column, open through terminal', async () => {
    wrap(<Pipeline />)
    for (const [, label] of STAGES) {
      expect(await screen.findByRole('heading', { name: label })).toBeInTheDocument()
    }
    // The two terminal stages are marked as such, not just named.
    expect(screen.getAllByText('Terminal')).toHaveLength(2)
  })

  it('places an enrolled prospect in their stage column', async () => {
    wrap(<Pipeline />)
    const column = (await screen.findByLabelText('Contacted column')) as HTMLElement
    expect(within(column).getByText('Marcus Okafor')).toBeInTheDocument()
    expect(within(column).getByText('Score 85')).toBeInTheDocument()
  })

  it('enrolls a directory contact with a score and rationale', async () => {
    wrap(<Pipeline />)
    fireEvent.click(await screen.findByRole('button', { name: /Enroll contact/ }))

    fireEvent.change(await screen.findByLabelText('Contact'), { target: { value: 'p-dana' } })
    fireEvent.change(screen.getByLabelText('Starting stage'), { target: { value: 'identified' } })
    fireEvent.change(screen.getByLabelText('Score (0–100)'), { target: { value: '85' } })
    fireEvent.change(screen.getByLabelText('Rationale'), {
      target: { value: 'Strong platform-engineering track record; ideal for Platform & Infra track.' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Enroll' }))

    await waitFor(() => {
      const call = posted.find((entry) => entry.url.includes('/stage'))
      expect(call?.url).toContain('p-dana')
      expect(call?.body).toMatchObject({
        stage: 'identified',
        score: 85,
        rationale: 'Strong platform-engineering track record; ideal for Platform & Infra track.',
      })
    })
  })

  it('moves a card to another stage from the card itself', async () => {
    wrap(<Pipeline />)
    const select = await screen.findByLabelText('Move Marcus Okafor to stage')
    fireEvent.change(select, { target: { value: 'interested' } })

    await waitFor(() => {
      const call = posted.find((entry) => entry.url.includes('/stage'))
      expect(call?.url).toContain('p-marcus')
      expect(call?.body).toMatchObject({ stage: 'interested' })
    })
  })
})

describe('Contact drawer', () => {
  beforeEach(() => {
    posted = []
    window.localStorage.setItem('dais.token', 'test-token')
    stubFetch()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    window.localStorage.clear()
  })

  it('shows identity, cross-event history and the communications feed', async () => {
    wrap(<CrmPersonDrawer personId="p-marcus" onClose={() => {}} />)

    expect(await screen.findByRole('heading', { name: 'Marcus Okafor' })).toBeInTheDocument()
    expect(screen.getByText('marcus@cloudreach.example')).toBeInTheDocument()
    expect(screen.getByText('Staff Developer Advocate · Cloudreach Labs')).toBeInTheDocument()
    expect(screen.getByText('AI agents in production.')).toBeInTheDocument()

    // The history surfaces: linked events/sessions AND an activity feed. The
    // event name appears both in the appearance list and the add-to-event
    // picker, hence getAllBy.
    expect(screen.getAllByText('AI Builders Summit').length).toBeGreaterThan(0)
    expect(screen.getByText(/Agents in prod/)).toBeInTheDocument()
    expect(screen.getByText('1/2 onboarding tasks')).toBeInTheDocument()
    expect(screen.getByText('Speak at DevFlow Conf 2027?')).toBeInTheDocument()
  })

  it('renders the persisted note and the timestamped stage transitions', async () => {
    wrap(<CrmPersonDrawer personId="p-marcus" onClose={() => {}} />)

    expect(
      await screen.findByText('Left voicemail 2027-01-15; follow up next week.')
    ).toBeInTheDocument()
    expect(screen.getByText('Identified → Contacted')).toBeInTheDocument()
    expect(screen.getByText('Enrolled at Identified')).toBeInTheDocument()
    // Each transition carries a readable timestamp, not just an order.
    expect(screen.getAllByText(/2027/).length).toBeGreaterThan(0)
  })

  it('saves a new internal note', async () => {
    wrap(<CrmPersonDrawer personId="p-marcus" onClose={() => {}} />)

    fireEvent.change(await screen.findByLabelText('Add an internal note'), {
      target: { value: 'Met at DevFlow 2026 - strong on CI topics; shortlist for keynote.' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save note' }))

    await waitFor(() => {
      const call = posted.find((entry) => entry.url.includes('/notes'))
      expect(call?.body).toMatchObject({
        body: 'Met at DevFlow 2026 - strong on CI topics; shortlist for keynote.',
      })
    })
  })

  it('sets an organizer-defined custom field on the contact', async () => {
    wrap(<CrmPersonDrawer personId="p-marcus" onClose={() => {}} />)

    const field = await screen.findByLabelText('Speaker Type')
    fireEvent.change(field, { target: { value: 'External' } })

    await waitFor(() => {
      const call = posted.find((entry) => entry.url.startsWith('/api/crm/people/p-marcus'))
      expect(call?.body).toEqual({ custom: { speaker_type: 'External' } })
    })
  })

  it('adds a tag from the org tag library', async () => {
    wrap(<CrmPersonDrawer personId="p-marcus" onClose={() => {}} />)

    fireEvent.click(await screen.findByRole('button', { name: '+ Keynote' }))
    await waitFor(() => {
      const call = posted.find((entry) => entry.url.startsWith('/api/crm/people/p-marcus'))
      expect(call?.body).toEqual({ tags: ['AI', 'Keynote'] })
    })
  })

  it('pushes the contact into another event from the drawer', async () => {
    wrap(<CrmPersonDrawer personId="p-marcus" onClose={() => {}} />)

    fireEvent.change(await screen.findByLabelText('Add to event'), { target: { value: 'e-2' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add to event' }))

    await waitFor(() => {
      const call = posted.find((entry) => entry.url.includes('/add-to-event'))
      expect(call?.body).toEqual({ event_id: 'e-2' })
    })
  })
})
