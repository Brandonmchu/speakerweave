import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { Home } from '@/pages/Home'

const calls: string[] = []

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function renderHome() {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/dashboard" element={<div>Dashboard reached</div>} />
      </Routes>
    </MemoryRouter>
  )
}

beforeEach(() => {
  calls.length = 0
  window.localStorage.clear()
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      calls.push(String(url))
      return json({ token: 'demo.jwt.token' })
    })
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
  window.localStorage.clear()
})

describe('Home landing', () => {
  it('renders the hero and the entry CTAs an agent would look for', () => {
    renderHome()
    expect(
      screen.getByRole('heading', { name: /Run your conference program/i })
    ).toBeInTheDocument()
    // Primary + secondary org-app entrances.
    expect(
      screen.getByRole('button', { name: /Enter the demo workspace/i })
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Get started$/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Organizer dashboard/i })).toBeInTheDocument()
  })

  it('exposes crawlable links to every public page + Clerk sign-in', () => {
    renderHome()
    const href = (name: RegExp) =>
      screen.getAllByRole('link', { name }).map((a) => a.getAttribute('href'))
    expect(href(/Schedule/i)).toContain('/e/ai-builders-summit/schedule')
    expect(href(/Speakers/i)).toContain('/e/ai-builders-summit/speakers')
    expect(href(/Call for Speakers/i)).toContain('/submit/call-for-speakers')
    expect(href(/Developers/i)).toContain('/developers')
    expect(href(/Speaker sign in/i)).toContain('/speaker-signin')
    // Real-org sign-in stays reachable (Clerk).
    expect(href(/Sign in/i)).toContain('/sign-in')
  })

  it('the primary CTA fetches a demo token, stores it, and lands in the app', async () => {
    renderHome()
    fireEvent.click(screen.getByRole('button', { name: /Enter the demo workspace/i }))
    expect(await screen.findByText('Dashboard reached')).toBeInTheDocument()
    expect(calls[0]).toBe('/public/demo-token')
    expect(window.localStorage.getItem('dais.token')).toBe('demo.jwt.token')
  })

  it('the secondary "Get started" CTA also enters the demo', async () => {
    renderHome()
    fireEvent.click(screen.getByRole('button', { name: /^Get started$/i }))
    expect(await screen.findByText('Dashboard reached')).toBeInTheDocument()
    expect(window.localStorage.getItem('dais.token')).toBe('demo.jwt.token')
  })
})
