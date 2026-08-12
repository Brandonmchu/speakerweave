import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { DOCS_URL, Home, REPO_URL } from '@/pages/Home'

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
      screen.getByRole('heading', { name: 'Every speaker, from submission to stage.' })
    ).toBeInTheDocument()
    expect(screen.getByText(/SpeakerWeave runs your whole conference/)).toBeInTheDocument()
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

    // Every captioned tile names the speaker and carries a status, so the wall
    // reads as a roster rather than stock photography. The status dot is an
    // inline `::before` on the label — never a sibling element, which is what
    // used to collapse onto the first glyph in WebKit.
    for (const cap of container.querySelectorAll('.tile .cap')) {
      expect(cap.querySelector('b')?.textContent).toMatch(/Priya Raman|Wei Zhang/)
      const status = cap.querySelector('em')
      expect(status?.className).toMatch(/\bdotted\b/)
      expect(status?.className).toMatch(/\bd-[a-z]+\b/)
      expect(status?.querySelector('.dot')).toBeNull()
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

  it('gives every agentic surface a mark on its tab', () => {
    const { container } = renderHome()

    const agentic = screen.getByTestId('ai-apps-section')
    // Two glyphs plus real brand marks, which ship as <img>: Slack's, and the
    // ChatGPT + Claude pair on the connector tab.
    expect(agentic.querySelectorAll('.surftabs .ico svg, .surftabs .ico img')).toHaveLength(5)
    expect(agentic.querySelectorAll('.surftabs .ico img')).toHaveLength(3)
    // ChatGPT's mark ships black, so it is flipped for the ink ground.
    expect(agentic.querySelectorAll('.surftabs .ico img.inv')).toHaveLength(1)
    expect(container.querySelectorAll('.tile.artifact')).toHaveLength(1)
  })

  it('shows the real admin UI, and lets you click through its rail', () => {
    renderHome()

    const section = screen.getByTestId('app-window-section')
    // The desktop rail; the component also renders a mobile strip of the same
    // four screens, which is why this is scoped rather than queried by role.
    const rail = [...section.querySelectorAll<HTMLButtonElement>('.swa-rail button')]
    expect(rail.map((b) => b.textContent?.replace(/\d+$/, ''))).toEqual([
      'Submissions',
      'Agenda',
      'Speakers',
      'Content',
    ])

    // Submissions is the landing screen, and it carries real seeded rows.
    expect(section).toHaveTextContent('SESS-114')
    expect(rail[0]).toHaveAttribute('aria-current', 'page')

    // The rail genuinely switches screens rather than decorating one.
    fireEvent.click(rail[1])
    expect(rail[1]).toHaveAttribute('aria-current', 'page')
    expect(rail[0]).not.toHaveAttribute('aria-current')
    expect(section).toHaveTextContent(/Unscheduled|Main Stage/)
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
    expect(href(/Open source/i)).toContain('/open-source')
    expect(href(/Kill My SaaS/i)).toContain('/killmysaas')
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

  it('puts every agentic surface on one stage, a tab at a time', () => {
    renderHome()

    const agentic = screen.getByTestId('ai-apps-section')
    expect(
      within(agentic).getByRole('heading', { name: 'Built for the Agentic Future' })
    ).toBeInTheDocument()
    expect(agentic).toHaveTextContent('organization-scoped tool layer')

    // Every surface has a tab; the in-app agent opens on stage. Labels are read
    // off the label element, since the mark beside it carries a slash of its own.
    const tabs = within(agentic).getAllByRole('tab')
    expect(tabs.map((tab) => tab.querySelector('span:not([aria-hidden]) b')?.textContent)).toEqual([
      'In-app agent',
      'ChatGPT / Claude / MCP',
      'Slack',
      'CLI',
    ])
    expect(tabs[0]).toHaveAttribute('aria-selected', 'true')
    expect(
      within(agentic).getByRole('heading', { name: 'In-app agent' })
    ).toBeInTheDocument()

    // Each tab swaps the panel for its own claim and its own demo.
    fireEvent.click(tabs[1])
    expect(tabs[1]).toHaveAttribute('aria-selected', 'true')
    expect(tabs[0]).toHaveAttribute('aria-selected', 'false')
    expect(
      within(agentic).getByRole('heading', {
        name: 'Work in ChatGPT & Claude using our MCP server',
      })
    ).toBeInTheDocument()
    expect(agentic).toHaveTextContent(`${window.location.origin}/mcp`)
    expect(agentic).toHaveTextContent('Claude or ChatGPT')
    // The connector is the one surface with setup, so it points at the docs.
    expect(
      within(agentic).getByRole('link', { name: /Set it up in ChatGPT or Claude/i })
    ).toHaveAttribute('href', `${DOCS_URL}/ai/mcp`)

    fireEvent.click(tabs[3])
    expect(within(agentic).getByRole('heading', { name: 'CLI' })).toBeInTheDocument()
    expect(agentic).toHaveTextContent('Codex and Claude Code')

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
