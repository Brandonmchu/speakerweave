/**
 * The CSV import result summary has to be HONEST about a partly-understood file.
 *
 * The defect this covers: a sheet headed `name,email,title,company,bio` reported
 * "3 added" with no hint that anything had been dropped, while every display
 * name silently became the speaker's email address. The parser now understands
 * those headings — and anything it still cannot place comes back named, so the
 * organizer can see exactly what was ignored instead of trusting a clean-looking
 * success.
 */
import { fireEvent, render, screen, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { Speakers } from '@/pages/Speakers'

const EVENT = { id: 'event-1', name: 'DaisConf', slug: 'daisconf' }
const ADA = 'c-ada'

/** One roster row, so the page is past its loading state before we click. */
const ROSTER = [
  {
    contact_id: ADA,
    name: 'Ada Lovelace',
    email: 'ada@example.com',
    photo_url: null,
    session_count: 0,
    last_portal_access_at: null,
    tasks_total: 0,
    tasks_done: 0,
    tasks_outstanding: 0,
    invited: false,
  },
]

/** What POST /speakers/import answers with for this test. */
let importResult: Record<string, unknown>

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
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

/** Render, wait for the roster, and open the import dialog. */
async function openImportDialog() {
  renderSpeakers()
  await screen.findByTestId(`speaker-row-${ADA}`)
  fireEvent.click(screen.getByRole('button', { name: 'Import CSV' }))
  return screen.findByRole('dialog')
}

/** Open the import dialog, paste `csv`, submit, and hand back the summary box. */
async function runImport(csv: string) {
  await openImportDialog()
  fireEvent.change(await screen.findByTestId('csv-textarea'), { target: { value: csv } })
  fireEvent.click(screen.getByRole('button', { name: 'Import' }))
  return screen.findByTestId('import-result')
}

beforeEach(() => {
  importResult = { created: 1, updated: 0, skipped: 0, errors: [], ignored_columns: [], total: 1 }
  window.localStorage.setItem('dais.token', 'test-token')
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      if (url.endsWith('/api/events') && method === 'GET') return json({ events: [EVENT] })
      if (url.endsWith('/speakers/import') && method === 'POST') return json(importResult)
      if (url.endsWith('/speaker-statuses') && method === 'GET') return json({ statuses: [] })
      if (url.endsWith('/speakers') && method === 'GET') {
        return json({ event: EVENT, speakers: ROSTER })
      }
      return json({}, 404)
    })
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
  window.localStorage.clear()
})

describe('Speakers → CSV import result (SPK-03)', () => {
  it('names every column the importer ignored', async () => {
    importResult = {
      created: 3,
      updated: 0,
      skipped: 0,
      errors: [],
      ignored_columns: ['Dietary', 'T-Shirt'],
      total: 3,
    }

    const summary = await runImport('name,email,Dietary,T-Shirt\nPriya Raman,priya@x.com,Vegan,M')

    expect(within(summary).getByText('3 added')).toBeInTheDocument()
    const notice = within(summary).getByTestId('import-ignored-columns')
    expect(notice).toHaveTextContent('2 columns ignored:')
    expect(notice).toHaveTextContent('Dietary, T-Shirt')
  })

  it('says nothing about ignored columns when the whole file was understood', async () => {
    const summary = await runImport('name,email,title,company,bio\nPriya Raman,priya@x.com,PE,Lattice,Hi')

    expect(within(summary).getByText('1 added')).toBeInTheDocument()
    expect(within(summary).queryByTestId('import-ignored-columns')).not.toBeInTheDocument()
  })

  it('uses the singular for a single ignored column', async () => {
    importResult = {
      created: 1,
      updated: 0,
      skipped: 0,
      errors: [],
      ignored_columns: ['Dietary'],
      total: 1,
    }

    const summary = await runImport('name,email,Dietary\nPriya Raman,priya@x.com,Vegan')

    expect(within(summary).getByTestId('import-ignored-columns')).toHaveTextContent(
      '1 column ignored:'
    )
  })

  it('shows the ignored-columns notice alongside row errors', async () => {
    importResult = {
      created: 1,
      updated: 0,
      skipped: 0,
      errors: [{ line: 3, email: 'nope', message: 'Missing or invalid email address.' }],
      ignored_columns: ['Dietary'],
      total: 2,
    }

    const summary = await runImport('name,email,Dietary\nPriya Raman,priya@x.com,Vegan\nBad,nope,X')

    expect(within(summary).getByTestId('import-ignored-columns')).toBeInTheDocument()
    expect(within(summary).getByText(/Missing or invalid email address/)).toBeInTheDocument()
  })

  it('documents that a single name column and an email column are what it needs', async () => {
    const dialog = await openImportDialog()

    expect(dialog).toHaveTextContent('first_name,last_name,email,company,title')
    expect(dialog).toHaveTextContent(/A single\s+name\s+column works too/)
    expect(dialog).toHaveTextContent(/email\s+column is required/)
  })
})
