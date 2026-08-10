/**
 * The speaker CRM: roster → profile drawer, search/filter, import, add, edit.
 *
 * A blind browser agent has to be able to DO these by clicking, so the tests
 * drive the real controls: open the drawer off a row, narrow the roster with
 * the search box and the onboarding filter, paste a CSV and read the result
 * summary, and confirm that adding/editing refetches the roster.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { speakersToCsv, onboardingStatusLabel, Speakers } from '@/pages/Speakers'
import type { EventSpeaker } from '@/lib/speakersApi'

const EVENT = { id: 'event-1', name: 'DaisConf', slug: 'daisconf' }

const ADA = 'c-ada'
const BEN = 'c-ben'

function speaker(overrides: Partial<EventSpeaker> & { contact_id: string; name: string }): EventSpeaker {
  return {
    email: null,
    photo_url: null,
    session_count: 0,
    last_portal_access_at: null,
    tasks_total: 0,
    tasks_done: 0,
    tasks_outstanding: 0,
    invited: false,
    ...overrides,
  }
}

let roster: EventSpeaker[]
let rosterGetCount: number
let importCalls: unknown[]
let patchCalls: Array<{ contactId: string; body: Record<string, unknown> }>
/** GET /api/events/{id}/speaker-statuses — {contact_id, speaker_status} rows. */
let statusRows: Array<{ contact_id: string; speaker_status: string }>

const PROFILE = {
  event: EVENT,
  speaker: {
    contact_id: ADA,
    name: 'Ada Lovelace',
    first_name: 'Ada',
    last_name: 'Lovelace',
    email: 'ada@example.com',
    company_name: 'Analytical Engines',
    title: 'Mathematician',
    about: 'The first programmer.',
    logistics_notes: null as string | null,
    speaker_status: null as string | null,
    photo_url: null,
    pronouns: null,
    linkedin_url: null,
    twitter_url: null,
    phone: null,
    last_portal_access_at: null,
    invited: true,
    session_count: 1,
    submission_count: 1,
    tasks_total: 3,
    tasks_done: 1,
    tasks_outstanding: 2,
  },
  submissions: [{ id: 's1', title: 'On the Analytical Engine', status: 'pending' }],
  sessions: [
    {
      id: 'sess1',
      title: 'Keynote: The Future',
      status: 'accepted',
      starts_at: '2026-09-01T17:00:00Z',
      ends_at: null,
      room: 'Main Hall',
      role: 'speaker',
      is_primary: true,
      scheduled: true,
    },
  ],
  onboarding: [
    {
      assignment_id: 'a1',
      task_id: 't1',
      name: 'Upload your slides',
      kind: 'file_request',
      status: 'submitted',
      due_at: null,
      required: true,
      completed_at: null,
    },
  ],
  communications: [
    {
      id: 'e1',
      template_key: 'accept',
      subject: "You're accepted!",
      status: 'sent',
      sent_at: '2026-07-05T00:00:00Z',
      created_at: '2026-07-05T00:00:00Z',
      error: null,
    },
  ],
}

const IMPORT_RESULT = { created: 1, updated: 0, skipped: 0, errors: [], total: 1 }

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function renderSpeakers() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <MemoryRouter>
      <QueryClientProvider client={queryClient}>
        <Speakers />
      </QueryClientProvider>
    </MemoryRouter>
  )
}

describe('Speakers CRM', () => {
  beforeEach(() => {
    roster = [
      speaker({
        contact_id: ADA,
        name: 'Ada Lovelace',
        email: 'ada@example.com',
        session_count: 2,
        tasks_total: 3,
        tasks_done: 1,
        tasks_outstanding: 2,
        invited: true,
      }),
      speaker({
        contact_id: BEN,
        name: 'Ben Franklin',
        email: 'ben@example.com',
        session_count: 1,
        tasks_total: 2,
        tasks_done: 2,
        tasks_outstanding: 0,
        invited: false,
      }),
    ]
    rosterGetCount = 0
    importCalls = []
    patchCalls = []
    // Ada has been confirmed; Ben has no workflow status set at all.
    statusRows = [{ contact_id: ADA, speaker_status: 'confirmed' }]
    window.localStorage.setItem('dais.token', 'test-token')
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        const method = init?.method ?? 'GET'
        if (url.endsWith('/api/events') && method === 'GET') return json({ events: [EVENT] })
        if (url.endsWith('/speakers/import') && method === 'POST') {
          importCalls.push(JSON.parse(String(init?.body ?? '{}')))
          return json(IMPORT_RESULT)
        }
        if (url.endsWith('/speaker-statuses') && method === 'GET') {
          return json({ statuses: statusRows })
        }
        if (url.endsWith('/speakers') && method === 'GET') {
          rosterGetCount += 1
          return json({ event: EVENT, speakers: roster })
        }
        const idMatch = url.match(/\/speakers\/([^/?]+)$/)
        if (idMatch && method === 'GET') return json(PROFILE)
        if (idMatch && method === 'PATCH') {
          const body = JSON.parse(String(init?.body ?? '{}'))
          patchCalls.push({ contactId: idMatch[1], body })
          return json({ speaker: { ...PROFILE.speaker, ...body } })
        }
        return json({}, 404)
      })
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    window.localStorage.clear()
  })

  it('renders the roster with a testid per row', async () => {
    renderSpeakers()
    expect(await screen.findByTestId(`speaker-row-${ADA}`)).toBeInTheDocument()
    expect(screen.getByTestId(`speaker-row-${BEN}`)).toBeInTheDocument()
  })

  it('opens the profile drawer and renders the full aggregate', async () => {
    renderSpeakers()
    fireEvent.click(await screen.findByText('Ada Lovelace'))

    // identity + company/title (rendered joined as "Mathematician · Analytical Engines")
    expect(await screen.findByText(/Analytical Engines/)).toBeInTheDocument()
    expect(screen.getByText('The first programmer.')).toBeInTheDocument()
    // submissions, sessions, onboarding, communications all render
    expect(screen.getByText('On the Analytical Engine')).toBeInTheDocument()
    expect(screen.getByText('Keynote: The Future')).toBeInTheDocument()
    expect(screen.getByText('Main Hall')).toBeInTheDocument()
    expect(screen.getByText('Upload your slides')).toBeInTheDocument()
    expect(screen.getByText("You're accepted!")).toBeInTheDocument()
  })

  it('search narrows the roster to matches', async () => {
    renderSpeakers()
    await screen.findByTestId(`speaker-row-${ADA}`)

    fireEvent.change(screen.getByTestId('speaker-search'), { target: { value: 'ada' } })
    expect(screen.getByTestId(`speaker-row-${ADA}`)).toBeInTheDocument()
    expect(screen.queryByTestId(`speaker-row-${BEN}`)).not.toBeInTheDocument()
  })

  it('the onboarding filter narrows the roster', async () => {
    renderSpeakers()
    await screen.findByTestId(`speaker-row-${ADA}`)

    // Only speakers with outstanding tasks — Ada, not the onboarded Ben.
    fireEvent.change(screen.getByTestId('filter-onboarding'), { target: { value: 'outstanding' } })
    expect(screen.getByTestId(`speaker-row-${ADA}`)).toBeInTheDocument()
    expect(screen.queryByTestId(`speaker-row-${BEN}`)).not.toBeInTheDocument()

    // Flip to onboarded — now only Ben.
    fireEvent.change(screen.getByTestId('filter-onboarding'), { target: { value: 'onboarded' } })
    expect(screen.getByTestId(`speaker-row-${BEN}`)).toBeInTheDocument()
    expect(screen.queryByTestId(`speaker-row-${ADA}`)).not.toBeInTheDocument()
  })

  it('imports a pasted CSV and shows a result summary', async () => {
    renderSpeakers()
    await screen.findByTestId(`speaker-row-${ADA}`)

    fireEvent.click(screen.getByRole('button', { name: 'Import CSV' }))
    fireEvent.change(await screen.findByTestId('csv-textarea'), {
      target: { value: 'first_name,last_name,email,company,title\nGrace,Hopper,grace@example.com,Navy,Admiral' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Import' }))

    const summary = await screen.findByTestId('import-result')
    expect(within(summary).getByText('1 added')).toBeInTheDocument()
    expect(importCalls).toHaveLength(1)
    expect((importCalls[0] as { csv: string }).csv).toContain('grace@example.com')
  })

  it('adds a speaker and refetches the roster', async () => {
    renderSpeakers()
    await screen.findByTestId(`speaker-row-${ADA}`)
    const before = rosterGetCount

    fireEvent.click(screen.getByRole('button', { name: 'Add speaker' }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.change(within(dialog).getByPlaceholderText('speaker@example.com'), {
      target: { value: 'grace@example.com' },
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add speaker' }))

    await waitFor(() => expect(importCalls).toHaveLength(1))
    expect((importCalls[0] as { rows: unknown[] }).rows).toBeTruthy()
    await waitFor(() => expect(rosterGetCount).toBeGreaterThan(before))
  })

  it('edits a speaker from the drawer and refetches the roster', async () => {
    renderSpeakers()
    fireEvent.click(await screen.findByText('Ada Lovelace'))
    fireEvent.click(await screen.findByTestId('edit-speaker'))

    const before = rosterGetCount
    fireEvent.change(screen.getByLabelText('Company'), { target: { value: 'Babbage & Co' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))

    await waitFor(() => expect(patchCalls).toHaveLength(1))
    expect(patchCalls[0].contactId).toBe(ADA)
    expect(patchCalls[0].body.company_name).toBe('Babbage & Co')
    await waitFor(() => expect(rosterGetCount).toBeGreaterThan(before))
  })

  // ── travel & logistics (SPK-15) ───────────────────────────────────────────
  // Flights and hotel nights are a property of the speaker, not an onboarding
  // task: the drawer has to show them at a glance and let an organizer edit
  // them inline.

  it('shows the travel & logistics recorded on the speaker', async () => {
    PROFILE.speaker.logistics_notes = 'UA 482 arrives Sep 1, 08:10. Hotel Marlowe, 2 nights.'
    renderSpeakers()
    fireEvent.click(await screen.findByText('Ada Lovelace'))

    expect(await screen.findByText('Travel & logistics')).toBeInTheDocument()
    expect(screen.getByTestId('logistics-notes')).toHaveTextContent('Hotel Marlowe, 2 nights')
    PROFILE.speaker.logistics_notes = null
  })

  it('shows the section with a prompt when nothing is recorded yet', async () => {
    renderSpeakers()
    fireEvent.click(await screen.findByText('Ada Lovelace'))

    // Present but empty — an organizer must be able to FIND the field, not
    // infer from its absence that travel isn't tracked.
    expect(await screen.findByTestId('logistics-notes')).toHaveTextContent(
      /No travel or logistics recorded/
    )
  })

  it('saves travel & logistics from the edit form', async () => {
    renderSpeakers()
    fireEvent.click(await screen.findByText('Ada Lovelace'))
    fireEvent.click(await screen.findByTestId('edit-speaker'))

    const notes = screen.getByTestId('logistics-notes')
    expect(notes.tagName).toBe('TEXTAREA')
    fireEvent.change(notes, { target: { value: 'BA 117, JFK→LHR, Sep 2. Gluten-free.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))

    await waitFor(() => expect(patchCalls).toHaveLength(1))
    expect(patchCalls[0].body.logistics_notes).toBe('BA 117, JFK→LHR, Sep 2. Gluten-free.')
    // …and the other profile fields ride along untouched.
    expect(patchCalls[0].body.company_name).toBe('Analytical Engines')
  })

  // ── speaker workflow status (SPK-04) ──────────────────────────────────────
  // Invited / Confirmed / Declined is the organizer's own record of where the
  // conversation stands — settable from the drawer, visible on every row, and
  // a filter of its own. It must stay distinct from the DERIVED portal-invite
  // signal that already lives on the roster.

  it('badges each roster row with its workflow status', async () => {
    renderSpeakers()
    expect(await screen.findByTestId(`speaker-status-${ADA}`)).toHaveTextContent('Confirmed')
    // Nothing set reads as an em dash, not as a fabricated state.
    expect(screen.getByTestId(`speaker-status-${BEN}`)).toHaveTextContent('—')
  })

  it('the status filter narrows the roster', async () => {
    statusRows = [
      { contact_id: ADA, speaker_status: 'confirmed' },
      { contact_id: BEN, speaker_status: 'declined' },
    ]
    renderSpeakers()
    await screen.findByTestId(`speaker-row-${ADA}`)

    fireEvent.change(screen.getByTestId('filter-speaker-status'), {
      target: { value: 'confirmed' },
    })
    expect(screen.getByTestId(`speaker-row-${ADA}`)).toBeInTheDocument()
    expect(screen.queryByTestId(`speaker-row-${BEN}`)).not.toBeInTheDocument()

    fireEvent.change(screen.getByTestId('filter-speaker-status'), {
      target: { value: 'declined' },
    })
    expect(screen.getByTestId(`speaker-row-${BEN}`)).toBeInTheDocument()
    expect(screen.queryByTestId(`speaker-row-${ADA}`)).not.toBeInTheDocument()
  })

  it('filters down to the speakers nobody has a status for yet', async () => {
    renderSpeakers()
    await screen.findByTestId(`speaker-row-${ADA}`)

    fireEvent.change(screen.getByTestId('filter-speaker-status'), { target: { value: 'unset' } })
    expect(screen.getByTestId(`speaker-row-${BEN}`)).toBeInTheDocument()
    expect(screen.queryByTestId(`speaker-row-${ADA}`)).not.toBeInTheDocument()
  })

  it('sets a speaker status from the profile drawer and refreshes the roster', async () => {
    renderSpeakers()
    fireEvent.click(await screen.findByText('Ada Lovelace'))

    const select = await screen.findByTestId('speaker-status-select')
    expect(select.tagName).toBe('SELECT')
    const before = rosterGetCount
    fireEvent.change(select, { target: { value: 'declined' } })

    await waitFor(() => expect(patchCalls).toHaveLength(1))
    expect(patchCalls[0].contactId).toBe(ADA)
    expect(patchCalls[0].body).toEqual({ speaker_status: 'declined' })
    await waitFor(() => expect(rosterGetCount).toBeGreaterThan(before))
  })

  it('clears a speaker status back to "not set"', async () => {
    PROFILE.speaker.speaker_status = 'invited'
    renderSpeakers()
    fireEvent.click(await screen.findByText('Ada Lovelace'))

    const select = (await screen.findByTestId('speaker-status-select')) as HTMLSelectElement
    expect(select.value).toBe('invited') // prefilled from the record
    fireEvent.change(select, { target: { value: '' } })

    await waitFor(() => expect(patchCalls).toHaveLength(1))
    expect(patchCalls[0].body).toEqual({ speaker_status: '' })
    PROFILE.speaker.speaker_status = null
  })

  it('keeps the derived portal-invite signal distinct from the workflow status', async () => {
    PROFILE.speaker.speaker_status = 'declined'
    renderSpeakers()
    fireEvent.click(await screen.findByText('Ada Lovelace'))

    // Ada has a portal link (derived) AND has declined (organizer-set). Both
    // are readable in the drawer, and neither is presented as the other.
    const drawer = within(await screen.findByRole('dialog'))
    expect((await drawer.findByTestId('speaker-status-select')) as HTMLSelectElement).toHaveValue(
      'declined'
    )
    expect(drawer.getByText('Portal invited')).toBeInTheDocument()
    PROFILE.speaker.speaker_status = null
  })

  it('prefills the edit form with the notes already on the record', async () => {
    PROFILE.speaker.logistics_notes = 'Arrives Sep 1, needs airport pickup.'
    renderSpeakers()
    fireEvent.click(await screen.findByText('Ada Lovelace'))
    fireEvent.click(await screen.findByTestId('edit-speaker'))

    expect((screen.getByTestId('logistics-notes') as HTMLTextAreaElement).value).toBe(
      'Arrives Sep 1, needs airport pickup.'
    )
    PROFILE.speaker.logistics_notes = null
  })

  describe('Speakers roster regressions', () => {
    const CAM = 'c-cam'

    beforeEach(() => {
      // A speaker just added by hand or imported: on the roster, nothing assigned.
      roster = [
        ...roster,
        speaker({ contact_id: CAM, name: 'Cam Newton', email: 'cam@example.com' }),
      ]
    })

    /**
     * Judge-observed: "Onboarded" also matched speakers with NO tasks assigned,
     * because zero outstanding was read as done. Nobody is onboarded before
     * anything has been asked of them.
     */
    it('the onboarded filter needs a finished task, not merely nothing to do', async () => {
      renderSpeakers()
      await screen.findByTestId(`speaker-row-${CAM}`)

      fireEvent.change(screen.getByTestId('filter-onboarding'), { target: { value: 'onboarded' } })
      // Ben finished 2/2 tasks; Cam has none assigned and Ada still owes work.
      expect(screen.getByTestId(`speaker-row-${BEN}`)).toBeInTheDocument()
      expect(screen.queryByTestId(`speaker-row-${CAM}`)).not.toBeInTheDocument()
      expect(screen.queryByTestId(`speaker-row-${ADA}`)).not.toBeInTheDocument()
      // and the row itself is honest about it in the unfiltered list
      expect(onboardingStatusLabel(speaker({ contact_id: CAM, name: 'Cam Newton' }))).toBe('No tasks')
    })

    /**
     * Judge-observed as "Add speaker silently fails": the new speaker sorts last
     * (no outstanding work) and any active filter can hide them, so the organizer
     * saw an unchanged list. Adding one now points the roster straight at them.
     */
    it('adding a speaker clears the filters and shows the new row', async () => {
      renderSpeakers()
      await screen.findByTestId(`speaker-row-${ADA}`)

      // an active filter that would otherwise hide a brand-new, task-less speaker
      fireEvent.change(screen.getByTestId('filter-onboarding'), { target: { value: 'outstanding' } })
      expect(screen.queryByTestId(`speaker-row-${CAM}`)).not.toBeInTheDocument()

      fireEvent.click(screen.getByRole('button', { name: 'Add speaker' }))
      const dialog = await screen.findByRole('dialog')
      fireEvent.change(within(dialog).getByPlaceholderText('speaker@example.com'), {
        target: { value: 'cam@example.com' },
      })
      fireEvent.click(within(dialog).getByRole('button', { name: 'Add speaker' }))

      await waitFor(() => expect(importCalls).toHaveLength(1))
      expect(await screen.findByTestId(`speaker-row-${CAM}`)).toBeInTheDocument()
      expect(screen.getByTestId('speaker-search')).toHaveValue('cam@example.com')
      expect(screen.getByTestId('filter-onboarding')).toHaveValue('all')
    })

    it('importing a CSV clears the filters so the imported rows are visible', async () => {
      renderSpeakers()
      await screen.findByTestId(`speaker-row-${ADA}`)
      fireEvent.change(screen.getByTestId('filter-onboarding'), { target: { value: 'outstanding' } })

      fireEvent.click(screen.getByRole('button', { name: 'Import CSV' }))
      fireEvent.change(await screen.findByTestId('csv-textarea'), {
        target: { value: 'first_name,last_name,email\nCam,Newton,cam@example.com' },
      })
      fireEvent.click(screen.getByRole('button', { name: 'Import' }))

      await screen.findByTestId('import-result')
      await waitFor(() => expect(screen.getByTestId('filter-onboarding')).toHaveValue('all'))
      expect(screen.getByTestId(`speaker-row-${CAM}`)).toBeInTheDocument()
    })
  })
})

describe('CSV export helpers', () => {
  it('labels onboarding status', () => {
    expect(onboardingStatusLabel(speaker({ contact_id: 'x', name: 'X' }))).toBe('No tasks')
    expect(
      onboardingStatusLabel(speaker({ contact_id: 'x', name: 'X', tasks_total: 2, tasks_done: 2, tasks_outstanding: 0 }))
    ).toBe('Onboarded')
    expect(
      onboardingStatusLabel(speaker({ contact_id: 'x', name: 'X', tasks_total: 3, tasks_done: 1, tasks_outstanding: 2 }))
    ).toBe('1/3 done')
  })

  it('builds a CSV with a header and quotes commas', () => {
    const csv = speakersToCsv([
      speaker({
        contact_id: 'x',
        name: 'Lovelace, Ada',
        email: 'ada@example.com',
        session_count: 2,
        tasks_total: 2,
        tasks_done: 2,
        tasks_outstanding: 0,
        invited: true,
        company_name: 'Analytical Engines',
      }),
    ])
    const lines = csv.split('\r\n')
    expect(lines[0]).toBe('Name,Email,Company,Status,Invited,Sessions')
    expect(lines[1]).toBe('"Lovelace, Ada",ada@example.com,Analytical Engines,Onboarded,Yes,2')
  })
})
