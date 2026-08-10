import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { Home, REPO_URL } from '@/pages/Home'

const calls: string[] = []
let writeText: ReturnType<typeof vi.fn>

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
  writeText = vi.fn().mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText },
    configurable: true,
  })
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
  Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true })
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

  it('presents the open-source posture, stack, and swappable infrastructure', () => {
    renderHome()

    const openSource = screen.getByTestId('open-source-section')
    expect(within(openSource).getByRole('heading', { name: 'Open source' })).toBeInTheDocument()
    expect(openSource).toHaveTextContent('SpeakerWeave is open source')
    expect(openSource).toHaveTextContent('source-available for the community')
    expect(within(openSource).getByRole('link', { name: /source repository/i })).toHaveAttribute(
      'href',
      REPO_URL,
    )

    const stack = screen.getByTestId('stack-section')
    expect(within(stack).getByRole('heading', { name: 'The stack' })).toBeInTheDocument()
    for (const technology of [
      'FastAPI',
      'React + Vite',
      'Supabase (Postgres)',
      'Clerk',
      'Resend',
      'Railway',
    ]) {
      expect(within(stack).getByText(technology)).toBeInTheDocument()
    }
    expect(stack).toHaveTextContent('swap them without touching the domain core')
  })

  it('shows copyable Claude and ChatGPT MCP configurations for this origin', async () => {
    renderHome()

    const aiApps = screen.getByTestId('ai-apps-section')
    expect(within(aiApps).getByRole('heading', { name: 'Use it from your AI' })).toBeInTheDocument()
    expect(within(aiApps).getByRole('heading', { name: 'Add to Claude' })).toBeInTheDocument()
    expect(within(aiApps).getByRole('heading', { name: 'Add to ChatGPT' })).toBeInTheDocument()
    expect(aiApps).toHaveTextContent(`${window.location.origin}/mcp`)
    expect(within(aiApps).getByRole('link', { name: /full MCP tool list/i })).toHaveAttribute(
      'href',
      '/developers',
    )

    fireEvent.click(
      within(aiApps).getByRole('button', { name: 'Copy Add to Claude MCP configuration' }),
    )
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(expect.stringContaining(`${window.location.origin}/mcp`)),
    )
    expect(writeText).toHaveBeenCalledWith(
      expect.stringContaining('Bearer YOUR_API_TOKEN'),
    )

    writeText.mockClear()
    fireEvent.click(
      within(aiApps).getByRole('button', { name: 'Copy Add to ChatGPT MCP configuration' }),
    )
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(expect.stringContaining('"name": "SpeakerWeave"')),
    )
    expect(writeText).toHaveBeenCalledWith(
      expect.stringContaining(`${window.location.origin}/mcp`),
    )
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
