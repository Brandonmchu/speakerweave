import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { Home, REPO_URL } from '@/pages/Home'

const calls: string[] = []

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

/** The hero wall reads the featured event's public roster. */
const SPEAKERS = {
  event: { name: 'AI Builders Summit' },
  speakers: [
    {
      id: 'c1',
      name: 'Priya Raman',
      title: 'Staff ML Engineer',
      company: 'VectorWorks',
      photo_url: '/speakers/priya-raman.jpg',
      bio: null,
      linkedin_url: null,
      twitter_url: null,
      sessions: [],
    },
    {
      id: 'c2',
      name: 'Wei Zhang',
      title: 'Senior Engineer',
      company: 'StructOut',
      photo_url: null,
      bio: null,
      linkedin_url: null,
      twitter_url: null,
      sessions: [],
    },
  ],
}

/** The summary tile counts sessions and tracks off the public schedule. */
const SCHEDULE = {
  event: { name: 'AI Builders Summit 2026', timezone: 'America/Los_Angeles' },
  days: [
    {
      date: '2026-10-12',
      sessions: [{ id: 's1', title: 'Opening keynote', track: { id: 't1', name: 'Engineering' } }],
    },
    { date: '2026-10-13', sessions: [] },
  ],
}

function renderHome() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/dashboard" element={<div>Dashboard reached</div>} />
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
      if (String(url).includes('/speakers')) return json(SPEAKERS)
      if (String(url).includes('/schedule')) return json(SCHEDULE)
      return json({ token: 'demo.jwt.token' })
    })
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
  window.localStorage.clear()
})

describe('Home landing', () => {
  it('renders the hero and its primary demo entry point', () => {
    renderHome()
    expect(
      screen.getByRole('heading', { name: 'Run your conference program, end to end.' })
    ).toBeInTheDocument()
    expect(
      screen.getByText(/From call for papers to a published, staffed, scheduled agenda/)
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Enter the demo workspace/i })).toBeInTheDocument()
    expect(screen.getByText('No sign-up. Jump into a fully seeded workspace.')).toBeInTheDocument()
  })

  it('fills the hero wall from the featured event roster, with the gradient fallback', async () => {
    const { container } = renderHome()

    // Twelve tiles regardless of roster size — short rosters cycle.
    await waitFor(() => expect(container.querySelectorAll('.tile img').length).toBeGreaterThan(0))
    expect(container.querySelectorAll('.tile')).toHaveLength(12)

    const photo = container.querySelector<HTMLImageElement>('.tile img')
    expect(photo?.getAttribute('src')).toBe('/speakers/priya-raman.jpg')

    // The speaker with no headshot gets initials on a gradient, not a broken image.
    const initials = [...container.querySelectorAll('.tile .initials')].map((el) => el.textContent)
    expect(initials).toContain('WZ')
  })

  it('captions wall faces with who they are and where they are in the program', async () => {
    const { container } = renderHome()

    await waitFor(() => expect(container.querySelectorAll('.tile .cap').length).toBeGreaterThan(0))

    // Every captioned tile names the speaker and carries a status dot, so the
    // wall reads as a roster rather than stock photography.
    for (const cap of container.querySelectorAll('.tile .cap')) {
      expect(cap.querySelector('b')?.textContent).toMatch(/Priya Raman|Wei Zhang/)
      expect(cap.querySelector('em .dot')).toBeTruthy()
    }
  })

  it('summarises the live program on one tile, from real public data', async () => {
    renderHome()

    const summary = await screen.findByTestId('wall-summary')
    // Event name, speaker count and session count all come off the public
    // program endpoints rather than being written into the page.
    await waitFor(() => expect(summary).toHaveTextContent('AI Builders Summit 2026'))
    expect(summary).toHaveTextContent('2 speakers confirmed')
    expect(summary).toHaveTextContent('1 sessions scheduled')
    expect(summary).toHaveTextContent('1 tracks live')
  })

  it('gives every agentic surface a mark', () => {
    const { container } = renderHome()

    const agentic = screen.getByTestId('ai-apps-section')
    expect(agentic.querySelectorAll('.srow .ico svg')).toHaveLength(4)
    expect(container.querySelectorAll('.tile.artifact')).toHaveLength(1)
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
    expect(href(/Sign in with your account/i)).toContain('/sign-in')
  })

  it('presents the open-source posture, stack, and swappable infrastructure', () => {
    renderHome()

    const openSource = screen.getByTestId('open-source-section')
    expect(within(openSource).getByRole('heading', { name: 'Open source' })).toBeInTheDocument()
    expect(openSource).toHaveTextContent('SpeakerWeave is open source')
    expect(openSource).toHaveTextContent('MIT licensed from end to end')
    expect(within(openSource).getByRole('link', { name: /source repository/i })).toHaveAttribute(
      'href',
      REPO_URL
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
      'Swap auth, email, hosting, or data providers without touching the domain core'
    )
    const facts = screen.getByRole('region', { name: 'Project credibility' })
    expect(within(facts).getByText(/982/).closest('li')).toHaveTextContent(
      '982 backend + 603 frontend tests'
    )
    expect(within(facts).getByRole('link')).toHaveAttribute('href', REPO_URL)
    expect(within(facts).getByText('Built end-to-end by AI coding agents')).toBeInTheDocument()
    expect(within(facts).getByText('REST API + MCP + webhooks-ready')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'License' })).toHaveAttribute(
      'href',
      `${REPO_URL}/blob/main/LICENSE`
    )
    expect(screen.getByRole('link', { name: 'GitHub' })).toHaveAttribute('href', REPO_URL)
  })

  it('walks the whole program lifecycle, in order', () => {
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

  it('leads with the agentic surfaces and the MCP endpoint for this origin', () => {
    renderHome()

    const agentic = screen.getByTestId('ai-apps-section')
    expect(
      within(agentic).getByRole('heading', { name: 'Built for the future, and fully agentic.' })
    ).toBeInTheDocument()
    for (const surface of ['In-app agent', 'MCP server + connectors', 'Slack', 'sw CLI']) {
      expect(within(agentic).getByRole('heading', { name: surface })).toBeInTheDocument()
    }
    expect(agentic).toHaveTextContent(`${window.location.origin}/mcp`)
    expect(agentic).toHaveTextContent('Claude or ChatGPT')
    expect(agentic).toHaveTextContent('Codex and Claude Code')
    expect(agentic).toHaveTextContent('organization-scoped tool layer')
    expect(within(agentic).getByRole('link', { name: /full MCP tool list/i })).toHaveAttribute(
      'href',
      '/developers'
    )
  })

  it('the primary CTA fetches a demo token, stores it, and lands in the app', async () => {
    renderHome()
    fireEvent.click(screen.getByRole('button', { name: /Enter the demo workspace/i }))
    expect(await screen.findByText('Dashboard reached')).toBeInTheDocument()
    expect(calls).toContain('/public/demo-token')
    expect(window.localStorage.getItem('dais.token')).toBe('demo.jwt.token')
  })
})
