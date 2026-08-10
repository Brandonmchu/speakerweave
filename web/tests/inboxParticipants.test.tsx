/**
 * Editing a submission's participants from the inbox drawer (ABS-11).
 *
 * Co-speakers used to be writable only on the CFP form and frozen the moment
 * it was submitted — exactly backwards, since people join a talk, drop off it
 * and hand over the lead for months afterwards. These tests pin the three
 * moves the organizer needs (add, promote, remove), the guard that stops a
 * talk losing its lead, and the display dedupe that keeps the CFP's
 * two-rows-per-submitter storage out of the UI.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { Inbox } from '@/pages/Inbox'
import { Toaster } from '@/ui/toaster'

const EVENT = { id: 'event-1', name: 'DaisConf', slug: 'daisconf' }

const SUBMISSION = {
  id: 'session-ci',
  friendly_id: 'DAIS-001',
  title: 'Taming 40-Minute CI',
  description: 'Incremental builds at monorepo scale.',
  status: 'pending',
  submitted_at: new Date(Date.now() - 86_400_000).toISOString(),
  submitter: { first_name: 'Priya', last_name: 'Raman', email: 'priya@example.com' },
}

/** Exactly what the CFP writes: the submitter twice, once per role. */
const PRIYA_ROWS = [
  {
    contact_id: 'contact-priya',
    role: 'speaker',
    is_primary: true,
    first_name: 'Priya',
    last_name: 'Raman',
    email: 'priya@example.com',
  },
  {
    contact_id: 'contact-priya',
    role: 'submitter',
    is_primary: false,
    first_name: 'Priya',
    last_name: 'Raman',
    email: 'priya@example.com',
  },
]

const MARCUS_ROW = {
  contact_id: 'contact-marcus',
  role: 'speaker',
  is_primary: false,
  first_name: 'Marcus',
  last_name: 'Okafor',
  email: 'marcus@example.com',
}

let writes: Array<{ url: string; method: string; body: unknown }> = []
let participants: unknown[] = []

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
        <Toaster />
      </QueryClientProvider>
    </MemoryRouter>
  )
}

/** Open the drawer straight into edit mode, the way the pencil does. */
async function openEditor() {
  fireEvent.click(await screen.findByTestId('edit-session'))
  return screen.findByTestId('session-title-input')
}

describe('Inbox drawer — participants editor', () => {
  beforeEach(() => {
    writes = []
    participants = [...PRIYA_ROWS]
    window.localStorage.setItem('dais.token', 'test-token')
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        const method = init?.method ?? 'GET'

        if (method !== 'GET') {
          writes.push({
            url,
            method,
            body: init?.body ? JSON.parse(String(init.body)) : undefined,
          })
        }

        if (url.includes('/participants')) {
          if (method === 'POST' && url.endsWith('/primary')) {
            participants = participants.map((row) => {
              const entry = row as { contact_id: string; role: string }
              return {
                ...entry,
                is_primary: entry.contact_id === 'contact-marcus' && entry.role === 'speaker',
              }
            })
          } else if (method === 'POST') {
            participants = [...participants, MARCUS_ROW]
          } else if (method === 'DELETE') {
            participants = participants.filter(
              (row) => (row as { contact_id: string }).contact_id !== 'contact-marcus'
            )
          }
          return jsonResponse({ participants })
        }

        if (url.endsWith('/api/events')) return jsonResponse({ events: [EVENT] })
        if (url.includes('/submissions')) {
          return jsonResponse({ event: EVENT, submissions: [SUBMISSION], count: 1 })
        }
        if (url.includes('/api/sessions/')) {
          return jsonResponse({
            session: SUBMISSION,
            answers: [],
            participants,
            reviews: {
              review_count: 0,
              completed_count: 0,
              abstained_count: 0,
              any_abstained: false,
              avg_overall: null,
              scale: '1_5',
              criteria: [],
              reviews: [],
            },
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

  it('shows the submitter once, not once per stored row', async () => {
    renderInbox()
    fireEvent.click(await screen.findByText('Taming 40-Minute CI'))
    await openEditor()

    // Two rows in storage (speaker + submitter of record), one human on screen.
    const rows = await screen.findAllByTestId(/^edit-participant-/)
    expect(rows).toHaveLength(1)
    expect(within(rows[0]).getByText('Priya Raman')).toBeInTheDocument()
    expect(within(rows[0]).getByText('speaker · submitter')).toBeInTheDocument()
    expect(within(rows[0]).getByText('Primary')).toBeInTheDocument()
  })

  it('adds a co-speaker after the submission was already sent', async () => {
    renderInbox()
    fireEvent.click(await screen.findByText('Taming 40-Minute CI'))
    await openEditor()

    fireEvent.change(screen.getByLabelText('Co-speaker name'), {
      target: { value: 'Marcus Okafor' },
    })
    fireEvent.change(screen.getByLabelText('Co-speaker email'), {
      target: { value: 'marcus@example.com' },
    })
    fireEvent.click(screen.getByRole('button', { name: /^Add$/ }))

    await waitFor(() => expect(writes).toHaveLength(1))
    expect(writes[0]).toMatchObject({
      url: '/api/sessions/session-ci/participants',
      method: 'POST',
      body: { name: 'Marcus Okafor', email: 'marcus@example.com', role: 'speaker' },
    })
    expect(await screen.findByText('Marcus Okafor')).toBeInTheDocument()
    expect(await screen.findByText('Co-speaker added')).toBeInTheDocument()
  })

  it('will not let the primary speaker be removed out from under the talk', async () => {
    renderInbox()
    fireEvent.click(await screen.findByText('Taming 40-Minute CI'))
    await openEditor()

    const row = (await screen.findAllByTestId(/^edit-participant-/))[0]
    expect(within(row).getByRole('button', { name: 'Remove Priya Raman' })).toBeDisabled()
    // …and there is no "make primary" on somebody who already is.
    expect(within(row).queryByRole('button', { name: 'Make primary' })).not.toBeInTheDocument()
  })

  it('hands the lead to a co-speaker, which then frees the old primary', async () => {
    participants = [...PRIYA_ROWS, MARCUS_ROW]
    renderInbox()
    fireEvent.click(await screen.findByText('Taming 40-Minute CI'))
    await openEditor()

    const marcusRow = await screen.findByTestId('edit-participant-contact-marcus')
    fireEvent.click(within(marcusRow).getByRole('button', { name: 'Make primary' }))

    await waitFor(() => expect(writes).toHaveLength(1))
    expect(writes[0]).toMatchObject({
      url: '/api/sessions/session-ci/participants/contact-marcus/primary',
      method: 'POST',
    })

    // Priya is no longer the lead, so removing her is now allowed.
    await waitFor(() =>
      expect(
        within(screen.getByTestId('edit-participant-contact-priya')).getByRole('button', {
          name: 'Remove Priya Raman',
        })
      ).toBeEnabled()
    )
  })

  it('removes a co-speaker', async () => {
    participants = [...PRIYA_ROWS, MARCUS_ROW]
    renderInbox()
    fireEvent.click(await screen.findByText('Taming 40-Minute CI'))
    await openEditor()

    const marcusRow = await screen.findByTestId('edit-participant-contact-marcus')
    fireEvent.click(within(marcusRow).getByRole('button', { name: 'Remove Marcus Okafor' }))

    await waitFor(() => expect(writes).toHaveLength(1))
    expect(writes[0]).toMatchObject({
      url: '/api/sessions/session-ci/participants/contact-marcus',
      method: 'DELETE',
    })
    await waitFor(() =>
      expect(screen.queryByTestId('edit-participant-contact-marcus')).not.toBeInTheDocument()
    )
  })

  it('surfaces the reason the server gave when an edit is refused', async () => {
    renderInbox()
    fireEvent.click(await screen.findByText('Taming 40-Minute CI'))
    await openEditor()

    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({ detail: 'A submission needs at least one speaker.' }, 400)
      )
    )
    fireEvent.change(screen.getByLabelText('Co-speaker email'), {
      target: { value: 'nope@example.com' },
    })
    fireEvent.click(screen.getByRole('button', { name: /^Add$/ }))

    expect(await screen.findByText("Couldn't add that person")).toBeInTheDocument()
    expect(
      await screen.findByText('A submission needs at least one speaker.')
    ).toBeInTheDocument()
  })

  it('leaves the read-only roster in place when the drawer is not being edited', async () => {
    participants = [...PRIYA_ROWS, MARCUS_ROW]
    renderInbox()
    fireEvent.click(await screen.findByText('Taming 40-Minute CI'))

    // Read mode shows the participants panel, but no editing affordances.
    expect(await screen.findByTestId('participant-contact-marcus')).toBeInTheDocument()
    expect(screen.queryByLabelText('Co-speaker email')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Make primary' })).not.toBeInTheDocument()
  })
})
