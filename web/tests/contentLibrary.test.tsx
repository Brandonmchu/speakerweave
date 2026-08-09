import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ContentLibrary } from '@/pages/ContentLibrary'

const LIBRARY = {
  event: { id: 'e1', name: 'AI Builders Summit' },
  items: [
    {
      item_id: 'a1',
      type: 'slides',
      title: 'Upload slides',
      required: true,
      due_at: null,
      assignment_status: 'submitted',
      status: 'received',
      current_version: 2,
      versions_count: 2,
      current_file: { file_id: 'f2', version: 2, filename: 'slides-v2.pdf', url: 'u2', created_at: null, is_current: true },
      comment_count: 1,
      updated_at: null,
      speaker: { contact_id: 'ada', name: 'Ada Lovelace', email: 'ada@example.com', photo_url: null },
    },
    {
      item_id: 'a2',
      type: 'headshot',
      title: 'Headshot photo',
      required: true,
      due_at: null,
      assignment_status: 'todo',
      status: 'missing',
      current_version: 0,
      versions_count: 0,
      current_file: null,
      comment_count: 0,
      updated_at: null,
      speaker: { contact_id: 'ben', name: 'Ben Franklin', email: 'ben@example.com', photo_url: null },
    },
  ],
  counts: { received: 1, missing: 1, needs_changes: 0 },
  outstanding: [{ contact_id: 'ben', name: 'Ben Franklin', email: 'ben@example.com', missing: ['Headshot photo'] }],
}

const DETAIL = {
  item: {
    item_id: 'a1',
    type: 'slides',
    title: 'Upload slides',
    required: true,
    assignment_status: 'submitted',
    status: 'received',
    current_version: 2,
    speaker: { contact_id: 'ada', name: 'Ada Lovelace', email: 'ada@example.com', photo_url: null },
  },
  versions: [
    { file_id: 'f2', version: 2, filename: 'slides-v2.pdf', url: 'u2', created_at: null, is_current: true },
    { file_id: 'f1', version: 1, filename: 'slides-v1.pdf', url: 'u1', created_at: null, is_current: false },
  ],
  comments: [
    { id: 'k1', author_role: 'organizer', author_label: 'Organizer', body: 'Please send a sharper deck.', created_at: null },
  ],
}

let calls: { url: string; method: string; body: unknown }[] = []

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function stub() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const u = String(url)
      const method = init.method ?? 'GET'
      calls.push({ url: u, method, body: init.body ? JSON.parse(String(init.body)) : undefined })
      if (u.includes('/content/remind')) return json({ reminded: 1, contacts: ['ben'] })
      if (u.includes('/content/export')) return new Response(new Blob(['zip']), { status: 200 })
      if (u.endsWith('/comments')) return json({ comment: { id: 'new', author_role: 'organizer' } })
      if (u.includes('/task-assignments/')) return json(DETAIL)
      if (u.includes('/content')) return json(LIBRARY)
      if (u.includes('/api/events')) return json([{ id: 'e1', name: 'AI Builders Summit', slug: 'summit' }])
      return json({})
    })
  )
}

function renderLibrary() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <MemoryRouter>
      <QueryClientProvider client={queryClient}>
        <ContentLibrary />
      </QueryClientProvider>
    </MemoryRouter>
  )
}

beforeEach(() => {
  calls = []
  window.localStorage.setItem('dais.token', 'admin-token')
  vi.stubGlobal('URL', {
    ...URL,
    createObjectURL: vi.fn(() => 'blob:mock'),
    revokeObjectURL: vi.fn(),
  } as unknown as typeof URL)
  stub()
})

afterEach(() => {
  vi.unstubAllGlobals()
  window.localStorage.clear()
})

describe('ContentLibrary', () => {
  it('lists content across speakers with type, status and version', async () => {
    renderLibrary()
    expect(await screen.findByText('Ada Lovelace')).toBeInTheDocument()
    // scope status assertions to the table — the filter dropdown reuses the labels
    const table = screen.getByRole('table')
    expect(within(table).getByText('Upload slides')).toBeInTheDocument()
    expect(within(table).getByText('Received')).toBeInTheDocument()
    expect(within(table).getByText('Missing')).toBeInTheDocument()
    expect(within(table).getByText('v2')).toBeInTheDocument()
    // outstanding summary drives the remind button label
    expect(screen.getByRole('button', { name: /Remind outstanding \(1\)/ })).toBeInTheDocument()
  })

  it('re-queries when a filter changes', async () => {
    renderLibrary()
    await screen.findByText('Ada Lovelace')

    fireEvent.change(screen.getByLabelText('Filter by status'), { target: { value: 'missing' } })
    await waitFor(() =>
      expect(calls.some((c) => c.url.includes('/content?status=missing'))).toBe(true)
    )
  })

  it('opens an item, shows version history + comments, and posts feedback', async () => {
    renderLibrary()
    await screen.findByText('Ada Lovelace')

    fireEvent.click(screen.getAllByRole('button', { name: 'Open' })[0])

    // dialog: both versions + the existing organizer comment
    const dialog = await screen.findByRole('dialog')
    expect(await within(dialog).findByText('slides-v1.pdf')).toBeInTheDocument()
    expect(within(dialog).getByText('slides-v2.pdf')).toBeInTheDocument()
    expect(within(dialog).getByText('Please send a sharper deck.')).toBeInTheDocument()

    fireEvent.change(within(dialog).getByRole('textbox'), {
      target: { value: 'Looks great now, approved.' },
    })
    fireEvent.click(within(dialog).getByRole('button', { name: /Send feedback/ }))

    await waitFor(() => {
      const post = calls.find((c) => c.url.endsWith('/task-assignments/a1/comments') && c.method === 'POST')
      expect(post).toBeTruthy()
      expect((post!.body as { body: string }).body).toBe('Looks great now, approved.')
    })
  })

  it('queues reminders to outstanding speakers', async () => {
    renderLibrary()
    await screen.findByText('Ada Lovelace')

    fireEvent.click(screen.getByRole('button', { name: /Remind outstanding/ }))
    await waitFor(() =>
      expect(calls.some((c) => c.url.includes('/content/remind') && c.method === 'POST')).toBe(true)
    )
  })

  it('exports the content bundle', async () => {
    renderLibrary()
    await screen.findByText('Ada Lovelace')

    fireEvent.click(screen.getByRole('button', { name: /Export all content/ }))
    await waitFor(() =>
      expect(calls.some((c) => c.url.includes('/content/export'))).toBe(true)
    )
  })
})
