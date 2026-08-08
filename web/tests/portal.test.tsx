import { render, screen } from '@testing-library/react'
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
  portal: {
    name: 'Speakers',
    welcome_html: '<p>Welcome speakers!</p>',
    accent_color: '#4962E2',
    logo_url: null,
  },
  sessions: [
    {
      id: 's1',
      title: 'Intro to Analytical Engines',
      status: 'accepted',
      friendly_id: 'SESS-1',
      starts_at: null,
      ends_at: null,
      role: 'speaker',
      is_primary: true,
    },
  ],
  tasks: [
    {
      assignment_id: 'a1',
      status: 'todo',
      completed_at: null,
      task: {
        id: 't1',
        name: 'Confirm your bio',
        description: 'Double-check the bio we show on the program.',
        kind: 'todo',
        link_url: null,
        due_at: null,
        required: true,
      },
      file: null,
    },
  ],
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
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const u = String(url)
      if (u.includes('/public/session/redeem')) {
        return json({ purpose: 'portal', org_id: 'o1', contact_id: 'c1' })
      }
      if (u.includes('/public/portal/me')) {
        return json(ME)
      }
      return json({})
    })
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('Portal page', () => {
  it('redeems the token and renders the speaker portal', async () => {
    renderPortal()

    // header: event name + personalized greeting + welcome_html
    expect(await screen.findByText('AI Builders Summit')).toBeInTheDocument()
    expect(await screen.findByRole('heading', { name: /Welcome, Ada Lovelace/ })).toBeInTheDocument()
    expect(await screen.findByText('Welcome speakers!')).toBeInTheDocument()

    // sections
    expect(screen.getByText('Your profile')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Save profile/ })).toBeInTheDocument()

    // session + its status
    expect(screen.getByText('Intro to Analytical Engines')).toBeInTheDocument()
    expect(screen.getByText('Accepted')).toBeInTheDocument()

    // task checklist: name, required marker, complete action
    expect(screen.getByText('Confirm your bio')).toBeInTheDocument()
    expect(screen.getByText('Required')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Mark complete/ })).toBeInTheDocument()
  })

  it('shows an expired-link notice when the session is gone', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (String(url).includes('/public/session/redeem')) {
          return json({ detail: 'expired' }, 400)
        }
        return json({ detail: 'Your portal session is invalid or has expired.' }, 401)
      })
    )
    renderPortal()
    expect(await screen.findByText(/sign-in link has expired/i)).toBeInTheDocument()
  })
})
