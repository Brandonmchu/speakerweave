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
  it('renders the new hero and its primary demo entry point', () => {
    renderHome()
    expect(
      screen.getByRole('heading', { name: 'Run your conference program, end to end.' })
    ).toBeInTheDocument()
    expect(screen.getByText(/From call for papers to a published, staffed, scheduled agenda/)).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: /Enter the demo workspace/i })
    ).toBeInTheDocument()
    expect(
      screen.getByRole('img', { name: /agenda builder showing a multi-track conference schedule/i }),
    ).toBeInTheDocument()
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
    expect(openSource).toHaveTextContent('MIT licensed from end to end')
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
    expect(stack).toHaveTextContent(
      'Swap auth, email, hosting, or data providers without touching the domain core',
    )
    expect(screen.getByText('Open source - MIT')).toHaveAttribute('href', REPO_URL)
    expect(screen.getByText(/982 backend/).closest('li')).toHaveTextContent(
      '982 backend + 603 frontend tests',
    )
    expect(screen.getByText('Built end-to-end by AI coding agents')).toBeInTheDocument()
    expect(screen.getByText('REST API + MCP + webhooks-ready')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'License' })).toHaveAttribute(
      'href',
      `${REPO_URL}/blob/main/LICENSE`,
    )
    expect(screen.getByRole('link', { name: 'GitHub' })).toHaveAttribute('href', REPO_URL)
  })

  it('presents all seven conference-program capabilities', () => {
    renderHome()

    for (const capability of [
      'Call for Papers',
      'Review',
      'Decisions',
      'Speaker Portal',
      'Agenda Builder',
      'Publish',
      'Speaker CRM',
    ]) {
      expect(screen.getByRole('heading', { name: capability })).toBeInTheDocument()
    }
  })

  it('shows five AI surfaces and copyable MCP configurations for this origin', async () => {
    renderHome()

    const aiApps = screen.getByTestId('ai-apps-section')
    expect(aiApps).toHaveTextContent('One brain, five surfaces')
    expect(
      within(aiApps).getByRole('heading', { name: 'Your program context travels with you.' }),
    ).toBeInTheDocument()
    for (const surface of [
      'In-app chat agent',
      'Slack bot',
      'sw CLI',
      'Claude (MCP)',
      'ChatGPT (MCP)',
    ]) {
      expect(within(aiApps).getByRole('heading', { name: surface })).toBeInTheDocument()
    }
    expect(aiApps).toHaveTextContent(`${window.location.origin}/mcp`)
    expect(aiApps).toHaveTextContent('claude.ai or Claude for Work')
    expect(aiApps).toHaveTextContent('Authorize when prompted with an API token from Settings')
    expect(aiApps).toHaveTextContent('Power-user MCP config')
    expect(aiApps).toHaveTextContent(
      'The in-app chat agent, Slack bot, CLI, Claude, and ChatGPT all dispatch through the',
    )
    expect(within(aiApps).getByRole('link', { name: /full MCP tool list/i })).toHaveAttribute(
      'href',
      '/developers',
    )

    fireEvent.click(within(aiApps).getByText('Connect Claude'))
    fireEvent.click(within(aiApps).getByRole('button', { name: 'Copy Claude MCP configuration' }))
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(expect.stringContaining(`${window.location.origin}/mcp`)),
    )
    expect(writeText).toHaveBeenCalledWith(
      expect.stringContaining('Bearer YOUR_API_TOKEN'),
    )

    writeText.mockClear()
    fireEvent.click(within(aiApps).getByText('Connect ChatGPT'))
    fireEvent.click(within(aiApps).getByRole('button', { name: 'Copy ChatGPT MCP configuration' }))
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

})
