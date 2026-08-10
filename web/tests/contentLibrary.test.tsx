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
      // The judge's own fixture deadline, stored the way the API stores it:
      // UTC midnight on the calendar day the organizer typed.
      due_at: '2027-05-01T00:00:00+00:00',
      approved: false,
      uploaded_at: '2026-08-05T10:00:00Z',
      session: { id: 'session-1', title: 'Analytical Engines in Practice' },
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
      due_at: '2027-04-14T00:00:00+00:00',
      approved: false,
      uploaded_at: null,
      session: null,
      assignment_status: 'todo',
      status: 'missing',
      current_version: 0,
      versions_count: 0,
      current_file: null,
      comment_count: 0,
      updated_at: null,
      speaker: { contact_id: 'ben', name: 'Ben Franklin', email: 'ben@example.com', photo_url: null },
    },
    {
      item_id: 'a3',
      type: 'bio',
      title: 'Speaker bio',
      required: false,
      // Long past for any plausible run date — the overdue treatment has to be
      // provable without freezing the clock.
      due_at: '2020-03-01T00:00:00+00:00',
      approved: false,
      uploaded_at: null,
      session: null,
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
  counts: { received: 1, missing: 2, needs_changes: 0 },
  outstanding: [{ contact_id: 'ben', name: 'Ben Franklin', email: 'ben@example.com', missing: ['Headshot photo'] }],
}

const DETAIL = {
  item: {
    item_id: 'a1',
    type: 'slides',
    title: 'Upload slides',
    required: true,
    due_at: '2027-05-01T00:00:00+00:00',
    approved: false,
    uploaded_at: '2026-08-05T10:00:00Z',
    session: { id: 'session-1', title: 'Analytical Engines in Practice' },
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
let approved = false

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
      if (u.endsWith('/review') && method === 'PATCH') {
        approved = true
        return json({ assignment: { id: 'a1', status: 'approved' } })
      }
      if (u.endsWith('/restore')) {
        restored = true
        return json({ ...RESTORED_DETAIL, restored: { version: 1, file_id: 'f1', changed: true } })
      }
      // Once v1 has been restored the item detail reports it as current.
      if (u.includes('/task-assignments/')) {
        const detail = restored ? RESTORED_DETAIL : DETAIL
        return json(
          approved
            ? { ...detail, item: { ...detail.item, approved: true, assignment_status: 'approved' } }
            : detail
        )
      }
      if (u.includes('/content')) {
        return json(
          approved
            ? {
                ...LIBRARY,
                items: LIBRARY.items.map((item) =>
                  item.item_id === 'a1'
                    ? { ...item, approved: true, assignment_status: 'approved' }
                    : item
                ),
              }
            : LIBRARY
        )
      }
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
  approved = false
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
    // Two rows are outstanding, so the badge is not unique any more.
    expect(within(table).getAllByText('Missing')).toHaveLength(2)
    // the Version column is populated for received items and dashed when missing
    const versionCells = screen.getAllByTestId('content-version-cell')
    expect(versionCells[0]).toHaveTextContent('v2')
    expect(versionCells[1]).toHaveTextContent('—')
    // outstanding summary drives the remind button label
    expect(screen.getByRole('button', { name: /Remind outstanding \(1\)/ })).toBeInTheDocument()
  })

  it('shows the linked session and the current version upload date in the row', async () => {
    renderLibrary()
    await screen.findByText('Ada Lovelace')

    const table = screen.getByRole('table')
    expect(within(table).getByText('Analytical Engines in Practice')).toBeInTheDocument()
    expect(screen.getByTestId('uploaded-cell-a1')).toHaveTextContent('5 Aug 2026')
    expect(screen.getByTestId('uploaded-cell-a2')).toHaveTextContent('—')
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

  it('sets an explicit approval and refreshes the list and detail chips', async () => {
    renderLibrary()
    await screen.findByText('Ada Lovelace')
    fireEvent.click(screen.getAllByRole('button', { name: 'Open' })[0])

    const dialog = await screen.findByRole('dialog')
    fireEvent.click(await within(dialog).findByRole('button', { name: /Approve/ }))

    await waitFor(() => {
      const call = calls.find((entry) => entry.url.endsWith('/task-assignments/a1/review'))
      expect(call?.method).toBe('PATCH')
      expect(call?.body).toEqual({ decision: 'approved' })
    })
    expect(await within(dialog).findByText('Approved')).toBeInTheDocument()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }))
    await waitFor(() => expect(within(screen.getByRole('table')).getByText('Approved')).toBeInTheDocument())
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

  /**
   * CNT-01/CNT-07: the judge reads deadlines off THIS table. Before, the
   * organizer's deliverables view carried no due date at all — the only place a
   * deadline appeared was the speaker's own portal, and there it rendered a day
   * early.
   */
  it('shows a DUE column with the calendar day each task was created with', async () => {
    renderLibrary()
    await screen.findByText('Ada Lovelace')

    // Not "Apr 30": the stored instant is UTC midnight on the 1st, and that is
    // the day the organizer typed.
    expect(screen.getByTestId('due-cell-a1')).toHaveTextContent('May 1, 2027')
    expect(screen.getByTestId('due-cell-a2')).toHaveTextContent('Apr 14, 2027')
  })

  it('marks a past-due outstanding item overdue, and leaves delivered ones alone', async () => {
    renderLibrary()
    await screen.findByText('Ada Lovelace')

    const overdue = screen.getByTestId('due-cell-a3')
    expect(overdue).toHaveTextContent('Mar 1, 2020')
    expect(overdue).toHaveTextContent('overdue')
    expect(within(overdue).getByText('overdue').closest('span')).toBeTruthy()

    // A received item is not "late" — the work is in; the deadline is history.
    expect(screen.getByTestId('due-cell-a1')).not.toHaveTextContent('overdue')
  })

  it('sorts by due date on demand, and back to the server order', async () => {
    renderLibrary()
    await screen.findByText('Ada Lovelace')

    const dueOrder = () =>
      screen
        .getAllByTestId(/^due-cell-/)
        .map((cell) => cell.getAttribute('data-testid'))

    // Default: whatever order the server sent, untouched.
    expect(dueOrder()).toEqual(['due-cell-a1', 'due-cell-a2', 'due-cell-a3'])

    fireEvent.click(screen.getByTestId('sort-due'))
    expect(screen.getByTestId('sort-due')).toHaveAttribute('data-sort', 'asc')
    expect(dueOrder()).toEqual(['due-cell-a3', 'due-cell-a2', 'due-cell-a1'])

    fireEvent.click(screen.getByTestId('sort-due'))
    expect(dueOrder()).toEqual(['due-cell-a1', 'due-cell-a2', 'due-cell-a3'])

    // A third press turns sorting off rather than cycling forever.
    fireEvent.click(screen.getByTestId('sort-due'))
    expect(screen.getByTestId('sort-due')).toHaveAttribute('data-sort', 'none')
    expect(dueOrder()).toEqual(['due-cell-a1', 'due-cell-a2', 'due-cell-a3'])
  })

  it('repeats the deadline in the item detail dialog', async () => {
    renderLibrary()
    await screen.findByText('Ada Lovelace')
    fireEvent.click(screen.getAllByRole('button', { name: 'Open' })[0])

    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByTestId('content-item-due')).toHaveTextContent('Due May 1, 2027')
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

/**
 * Judge-observed: a library row read "Received" while its detail read
 * "History (0 versions) — Nothing uploaded yet", because the badge and the
 * history were reading different linkages. The server now resolves both from
 * one place; the UI's job is to show WHICH linkage delivered the file, and to
 * not offer a restore for a version that isn't part of the task's own history.
 */
describe('ContentLibrary — a headshot delivered from the portal profile', () => {
  const PROFILE_LIBRARY = {
    ...LIBRARY,
    items: [
      {
        ...LIBRARY.items[1],
        status: 'received',
        current_version: 1,
        versions_count: 1,
        current_file: {
          file_id: 'pf1',
          version: 1,
          filename: 'ben-headshot.png',
          url: 'https://files.test/ben.png',
          created_at: '2026-08-07T08:00:00Z',
          is_current: true,
          source: 'profile',
        },
      },
    ],
    counts: { received: 1, missing: 0, needs_changes: 0 },
    outstanding: [],
  }

  const PROFILE_DETAIL = {
    item: {
      item_id: 'a2',
      type: 'headshot',
      title: 'Headshot photo',
      required: true,
      assignment_status: 'todo',
      status: 'received',
      current_version: 1,
      speaker: { contact_id: 'ben', name: 'Ben Franklin', email: 'ben@example.com', photo_url: null },
    },
    versions: [
      {
        file_id: 'pf1',
        version: 1,
        filename: 'ben-headshot.png',
        url: 'https://files.test/ben.png',
        created_at: '2026-08-07T08:00:00Z',
        is_current: true,
        source: 'profile',
      },
    ],
    comments: [],
  }

  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const u = String(url)
        if (u.includes('/task-assignments/')) return json(PROFILE_DETAIL)
        if (u.includes('/content')) return json(PROFILE_LIBRARY)
        if (u.includes('/api/events')) return json([{ id: 'e1', name: 'AI Builders Summit', slug: 'summit' }])
        return json({})
      })
    )
  })

  it('shows what made the row "Received", where it came from, and when', async () => {
    renderLibrary()
    await screen.findByText('Ben Franklin')
    fireEvent.click(screen.getAllByRole('button', { name: 'Open' })[0])

    const list = await screen.findByTestId('content-version-list')
    expect(within(list).getByText(/History \(1 version\)/)).toBeInTheDocument()
    expect(within(list).queryByText('Nothing uploaded yet.')).not.toBeInTheDocument()
    expect(within(list).getByText('ben-headshot.png')).toBeInTheDocument()
    expect(within(list).getByTestId('version-source-profile')).toHaveTextContent(
      'From portal profile'
    )
    expect(within(list).getByTestId('version-timestamp')).toHaveTextContent(/7 Aug 2026/)
  })

  it('does not offer a restore for a version outside the task history', async () => {
    renderLibrary()
    await screen.findByText('Ben Franklin')
    fireEvent.click(screen.getAllByRole('button', { name: 'Open' })[0])

    const list = await screen.findByTestId('content-version-list')
    expect(within(list).queryByTestId('restore-version-1')).not.toBeInTheDocument()
    // the file is still downloadable — it just isn't a pointer we can move
    expect(within(list).getByRole('link', { name: /Download/ })).toHaveAttribute(
      'href',
      'https://files.test/ben.png'
    )
  })
})
