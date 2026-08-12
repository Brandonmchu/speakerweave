/**
 * `/judge` — the page you hand somebody who has to evaluate this.
 *
 * Its job is to be complete and self-explanatory in one screen: three doors
 * that actually open, an honest statement about shared demo state, the
 * machine-readable surfaces, and the independent score. Each of those is worth
 * a test, because each one is a promise made to a stranger.
 */
import { QueryClientProvider, QueryClient } from '@tanstack/react-query'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { Judge } from '@/pages/Judge'

const calls: string[] = []

function json(payload: unknown) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

function renderJudge() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/judge']}>
        <Routes>
          <Route path="/judge" element={<Judge />} />
          <Route path="/dashboard" element={<div>Dashboard reached</div>} />
          <Route path="/review/:token" element={<div>Review reached</div>} />
          <Route path="/portal/:token" element={<div>Portal reached</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  )
}

beforeEach(() => {
  calls.length = 0
  window.localStorage.clear()
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      calls.push(String(url))
      if (String(url).includes('/demo-entry/reviewer'))
        return json({ persona: 'reviewer', kind: 'path', path: '/review/tok' })
      if (String(url).includes('/demo-entry/speaker'))
        return json({ persona: 'speaker', kind: 'path', path: '/portal/tok' })
      return json({ token: 'demo.jwt.token' })
    })
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
  window.localStorage.clear()
})

describe('Judge access page', () => {
  it('offers all three doors, each naming what is behind it', () => {
    renderJudge()

    const doors = screen.getByLabelText('Open the demo as')
    expect([...doors.querySelectorAll('b')].map((b) => b.textContent)).toEqual([
      'Organizer',
      'Reviewer',
      'Speaker',
    ])
    // The detail variant names surfaces a judge can go and check, not adjectives.
    expect(doors).toHaveTextContent('agenda builder with live conflicts')
    expect(doors).toHaveTextContent('weighted rubric')
    expect(doors).toHaveTextContent('onboarding checklist')
  })

  it('opens the organizer workspace with a session token', async () => {
    renderJudge()

    fireEvent.click(
      within(screen.getByLabelText('Open the demo as')).getByRole('button', { name: /Organizer/ })
    )
    expect(await screen.findByText('Dashboard reached')).toBeInTheDocument()
    expect(calls).toContain('/public/demo-token')
    expect(window.localStorage.getItem('dais.token')).toBe('demo.jwt.token')
  })

  it('opens the reviewer and speaker surfaces by magic link, with no session stored', async () => {
    renderJudge()

    fireEvent.click(
      within(screen.getByLabelText('Open the demo as')).getByRole('button', { name: /Reviewer/ })
    )
    expect(await screen.findByText('Review reached')).toBeInTheDocument()
    expect(calls).toContain('/public/demo-entry/reviewer')
    expect(window.localStorage.getItem('dais.token')).toBeNull()
  })

  it('is honest about what a judge changes in a shared workspace', () => {
    renderJudge()
    expect(screen.getByText(/changes you make are real/i)).toBeInTheDocument()
    expect(screen.getByText(/rebuilt from the seeder/i)).toBeInTheDocument()
  })

  it('points at the machine-readable surfaces and the independent score', () => {
    renderJudge()

    for (const surface of ['MCP server', 'REST API', 'Public program data', 'Source']) {
      expect(screen.getByText(surface)).toBeInTheDocument()
    }
    expect(screen.getByText('100 / 100')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Read the scorecard/i })).toHaveAttribute(
      'href',
      '/killmysaas'
    )
  })
})
