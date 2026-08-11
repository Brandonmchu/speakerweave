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
    await waitFor(() => expect(container.querySelectorAll('.tile img')).toHaveLength(6))
    expect(container.querySelectorAll('.tile')).toHaveLength(12)

    const photo = container.querySelector<HTMLImageElement>('.tile img')
    expect(photo?.getAttribute('src')).toBe('/speakers/priya-raman.jpg')

    // The speaker with no headshot gets initials on a gradient, not a broken image.
    const initials = [...container.querySelectorAll('.tile span')].map((el) => el.textContent)
    expect(initials).toContain('WZ')
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
