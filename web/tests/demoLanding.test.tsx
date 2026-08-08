import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { DemoLanding } from '@/pages/DemoLanding'

const calls: string[] = []

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function renderLanding() {
  return render(
    <MemoryRouter initialEntries={['/demo']}>
      <Routes>
        <Route path="/demo" element={<DemoLanding />} />
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

describe('DemoLanding page', () => {
  it('renders the hero pitch and the primary demo button', () => {
    renderLanding()
    expect(screen.getByText('Open-source conference speaker management', { exact: false })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Enter the demo workspace/i })).toBeInTheDocument()
    // The three "what to explore" cards.
    expect(screen.getByText('Review submissions')).toBeInTheDocument()
    expect(screen.getByText('Build the agenda')).toBeInTheDocument()
    expect(screen.getByText('Score & onboard speakers')).toBeInTheDocument()
  })

  it('fetches /public/demo-token, stores it, and lands in the app', async () => {
    renderLanding()
    fireEvent.click(screen.getByRole('button', { name: /Enter the demo workspace/i }))

    // Navigated to /dashboard once the token was fetched + stored.
    expect(await screen.findByText('Dashboard reached')).toBeInTheDocument()
    expect(calls[0]).toBe('/public/demo-token')
    expect(window.localStorage.getItem('dais.token')).toBe('demo.jwt.token')
  })
})
