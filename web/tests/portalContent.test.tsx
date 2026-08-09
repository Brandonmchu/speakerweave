import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { Portal } from '@/pages/Portal'

const ME = {
  contact: {
    id: 'c1',
    first_name: 'Ada',
    last_name: 'Lovelace',
    email: 'ada@example.com',
    about: '',
    company_name: '',
    title: '',
    pronouns: '',
    photo_url: null,
    linkedin_url: '',
    twitter_url: '',
    phone: '',
  },
  event: { name: 'AI Builders Summit' },
  portal: { name: 'Speakers', welcome_html: '', accent_color: '#4962E2', logo_url: null },
  sessions: [],
  tasks: [
    {
      assignment_id: 'a1',
      status: 'submitted',
      completed_at: null,
      task: {
        id: 't1',
        name: 'Upload slides',
        description: 'Your talk deck.',
        kind: 'file_request',
        link_url: null,
        due_at: null,
        required: true,
      },
      file: { filename: 'slides-v2.pdf', url: 'u2', version: 2 },
      versions: [
        { file_id: 'f2', version: 2, filename: 'slides-v2.pdf', url: 'u2', created_at: null, is_current: true },
        { file_id: 'f1', version: 1, filename: 'slides-v1.pdf', url: 'u1', created_at: null, is_current: false },
      ],
      comments: [
        { id: 'k1', author_role: 'organizer', author_label: 'Organizer', body: 'Please send a sharper deck.', created_at: null },
      ],
    },
  ],
}

let calls: { url: string; method: string; body: unknown }[] = []

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function renderPortal() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <MemoryRouter initialEntries={['/portal/tok-123']}>
      <QueryClientProvider client={queryClient}>
        <Routes>
          <Route path="/portal/:token" element={<Portal />} />
        </Routes>
      </QueryClientProvider>
    </MemoryRouter>
  )
}

beforeEach(() => {
  calls = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const u = String(url)
      const method = init.method ?? 'GET'
      calls.push({ url: u, method, body: init.body ? JSON.parse(String(init.body)) : undefined })
      if (u.includes('/public/session/redeem')) {
        return json({ purpose: 'portal', org_id: 'o1', contact_id: 'c1' })
      }
      if (u.endsWith('/comments')) return json({ comment: { id: 'new', author_role: 'speaker' } })
      if (u.includes('/public/portal/me')) return json(ME)
      return json({})
    })
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('Portal content pipeline', () => {
  it('shows the current version, prior versions, organizer feedback, and lets the speaker reply', async () => {
    renderPortal()

    // current version marker on the file chip
    expect(await screen.findByText('slides-v2.pdf')).toBeInTheDocument()
    expect(screen.getByText('v2')).toBeInTheDocument()

    // version history is collapsed until asked for
    expect(screen.queryByText('slides-v1.pdf')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /View 1 previous version/ }))
    expect(await screen.findByText('slides-v1.pdf')).toBeInTheDocument()

    // organizer feedback is visible to the speaker
    expect(screen.getByText('Please send a sharper deck.')).toBeInTheDocument()

    // the speaker can reply
    fireEvent.change(screen.getByPlaceholderText('Reply to the organizer…'), {
      target: { value: 'Fixed it, re-uploaded.' },
    })
    fireEvent.click(screen.getByRole('button', { name: /Reply/ }))

    await waitFor(() => {
      const post = calls.find(
        (c) => c.url.includes('/public/portal/tasks/a1/comments') && c.method === 'POST'
      )
      expect(post).toBeTruthy()
      expect((post!.body as { body: string }).body).toBe('Fixed it, re-uploaded.')
    })
  })

  it('tells the speaker which file types and size the upload accepts', async () => {
    renderPortal()

    // the task deliverable upload: visible hint + a matching accept allowlist
    const hint = await screen.findByTestId('upload-hint')
    expect(hint).toHaveTextContent(/up to 30 MB/)
    expect(hint).toHaveTextContent(/PDF/)
    expect(hint).toHaveTextContent(/PPTX/)

    const input = screen.getByTestId('upload-input')
    expect(input).toHaveAttribute('type', 'file')
    const accept = input.getAttribute('accept') ?? ''
    expect(accept).toContain('.pdf')
    expect(accept).toContain('.pptx')
    expect(accept).toContain('.png')

    // the headshot upload carries its own (image-only) constraints
    const headshotHint = screen.getByTestId('headshot-hint')
    expect(headshotHint).toHaveTextContent(/up to 8 MB/)
    expect(screen.getByTestId('headshot-input').getAttribute('accept') ?? '').toContain('image/png')
  })
})
