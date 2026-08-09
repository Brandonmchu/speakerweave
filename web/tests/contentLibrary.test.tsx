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
    { file_id: 'f2', version: 2, filename: 'slides-v2.pdf', url: 'u2', created_at: '2026-08-05T10:00:00Z', is_current: true },
    { file_id: 'f1', version: 1, filename: 'slides-v1.pdf', url: 'u1', created_at: '2026-08-01T10:00:00Z', is_current: false },
  ],
  comments: [
    { id: 'k1', author_role: 'organizer', author_label: 'Organizer', body: 'Please send a sharper deck.', created_at: '2026-08-05T12:00:00Z' },
  ],
}

/** The same item after v1 has been restored: the pointer moved, history didn't. */
const RESTORED_DETAIL = {
  ...DETAIL,
  item: { ...DETAIL.item, current_version: 1 },
  versions: [
    { ...DETAIL.versions[0], is_current: false },
    { ...DETAIL.versions[1], is_current: true },
  ],
  comments: [
    ...DETAIL.comments,
    {
      id: 'k2',
      author_role: 'organizer',
      author_label: 'Organizer',
      body: 'Restored v1 (slides-v1.pdf) as the current version.',
      created_at: '2026-08-06T09:00:00Z',
    },
  ],
}

let calls: { url: string; method: string; body: unknown }[] = []
let restored = false

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
      if (u.endsWith('/restore')) {
        restored = true
        return json({ ...RESTORED_DETAIL, restored: { version: 1, file_id: 'f1', changed: true } })
      }
      // Once v1 has been restored the item detail reports it as current.
      if (u.includes('/task-assignments/')) return json(restored ? RESTORED_DETAIL : DETAIL)
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
  restored = false
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
    // the Version column is populated for received items and dashed when missing
    const versionCells = screen.getAllByTestId('content-version-cell')
    expect(versionCells[0]).toHaveTextContent('v2')
    expect(versionCells[1]).toHaveTextContent('—')
    // outstanding summary drives the remind button label
    expect(screen.getByRole('button', { name: /Remind outstanding \(1\)/ })).toBeInTheDocument()
  })

  it('detail is legible: labelled version list + comment thread with author and time', async () => {
    renderLibrary()
    await screen.findByText('Ada Lovelace')
    fireEvent.click(screen.getAllByRole('button', { name: 'Open' })[0])

    const dialog = await screen.findByRole('dialog')

    // version list: prior + current versions, each labelled, current called out
    const versionList = await within(dialog).findByTestId('content-version-list')
    expect(within(versionList).getByText('slides-v2.pdf')).toBeInTheDocument()
    expect(within(versionList).getByText('slides-v1.pdf')).toBeInTheDocument()
    expect(within(versionList).getByText(/Current: v2/)).toBeInTheDocument()
    expect(within(versionList).getAllByText(/ago/).length).toBeGreaterThan(0)

    // comment thread: the organizer comment with its author label + relative time
    const thread = within(dialog).getByTestId('content-comment-thread')
    expect(within(thread).getByText('Please send a sharper deck.')).toBeInTheDocument()
    expect(within(thread).getByText('Organizer')).toBeInTheDocument()
    expect(within(thread).getByText(/ago/)).toBeInTheDocument()

    // the add-comment control is discoverable by testid
    expect(within(dialog).getByTestId('content-add-comment')).toBeInTheDocument()
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

  it('reads as a change history: every version labelled with when it landed (CNT-11)', async () => {
    renderLibrary()
    await screen.findByText('Ada Lovelace')
    fireEvent.click(screen.getAllByRole('button', { name: 'Open' })[0])

    const list = await screen.findByTestId('content-version-list')
    expect(within(list).getByText(/History \(2 versions\)/)).toBeInTheDocument()
    expect(within(list).getAllByTestId('content-version-row')).toHaveLength(2)
    // each entry says when it was uploaded…
    expect(within(list).getAllByText(/Uploaded .* ago/)).toHaveLength(2)
    // …and which one is live right now.
    expect(within(list).getByText(/v2 · current/)).toBeInTheDocument()
  })

  it('restores a prior version: calls the endpoint and refreshes the item (CNT-11)', async () => {
    renderLibrary()
    await screen.findByText('Ada Lovelace')
    fireEvent.click(screen.getAllByRole('button', { name: 'Open' })[0])

    const dialog = await screen.findByRole('dialog')
    // Only the non-current versions offer a restore — v2 is already live.
    expect(await within(dialog).findByTestId('restore-version-1')).toBeInTheDocument()
    expect(within(dialog).queryByTestId('restore-version-2')).not.toBeInTheDocument()

    fireEvent.click(within(dialog).getByTestId('restore-version-1'))

    await waitFor(() => {
      const post = calls.find(
        (c) => c.url.endsWith('/task-assignments/a1/restore') && c.method === 'POST'
      )
      expect(post).toBeTruthy()
      expect((post!.body as { version: number }).version).toBe(1)
    })

    // The dialog refetches, so the restored version now reads as current…
    expect(await within(dialog).findByText(/v1 · current/)).toBeInTheDocument()
    expect(within(dialog).getByText(/Current: v1/)).toBeInTheDocument()
    // …the audit line is in the thread, and v2 is still there to restore back to.
    expect(
      within(dialog).getByText('Restored v1 (slides-v1.pdf) as the current version.')
    ).toBeInTheDocument()
    expect(within(dialog).getByTestId('restore-version-2')).toBeInTheDocument()
    // the library list is refreshed too
    await waitFor(() =>
      expect(calls.filter((c) => c.url.includes('/content?') || c.url.endsWith('/content')).length)
        .toBeGreaterThan(1)
    )
  })

  it('multi-selects rows and downloads just those items (CNT-14)', async () => {
    renderLibrary()
    await screen.findByText('Ada Lovelace')

    // Nothing ticked: the action is present but inert, with no count.
    const button = screen.getByTestId('download-selected')
    expect(button).toBeDisabled()
    expect(button).toHaveTextContent('Download selected')
    expect(button).not.toHaveTextContent('(')

    // A row with no uploaded file has nothing to bundle, so it can't be ticked.
    expect(screen.getByTestId('select-item-a2')).toBeDisabled()

    fireEvent.click(screen.getByTestId('select-item-a1'))
    expect(button).toBeEnabled()
    expect(button).toHaveTextContent('Download selected (1)')
    expect(screen.getByTestId('selection-summary')).toHaveTextContent('1 item selected')

    fireEvent.click(button)
    await waitFor(() => {
      const call = calls.find((c) => c.url.includes('/content/export?assignment_ids='))
      expect(call).toBeTruthy()
      expect(decodeURIComponent(call!.url)).toContain('assignment_ids=a1')
    })
    // "Export all content" is untouched — it still has no id filter.
    fireEvent.click(screen.getByTestId('export-all'))
    await waitFor(() =>
      expect(calls.some((c) => c.url.endsWith('/content/export'))).toBe(true)
    )
  })

  it('select-all ticks every downloadable row, and clearing empties the selection', async () => {
    renderLibrary()
    await screen.findByText('Ada Lovelace')

    fireEvent.click(screen.getByTestId('select-all-content'))
    // a1 has a file; a2 (missing) is skipped rather than silently exported empty
    expect(screen.getByTestId('select-item-a1')).toBeChecked()
    expect(screen.getByTestId('select-item-a2')).not.toBeChecked()
    expect(screen.getByTestId('download-selected')).toHaveTextContent('Download selected (1)')

    fireEvent.click(screen.getByTestId('clear-selection'))
    expect(screen.getByTestId('select-item-a1')).not.toBeChecked()
    expect(screen.getByTestId('download-selected')).toBeDisabled()
  })
})
