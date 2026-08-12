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
          {/* The two link-authenticated surfaces the demo doors open. */}
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
      if (String(url).includes('/speakers')) return json(SPEAKERS)
      if (String(url).includes('/schedule')) return json(SCHEDULE)
      // The reviewer and speaker doors get a magic-link path, not a session.
      if (String(url).includes('/demo-entry/reviewer'))
        return json({ persona: 'reviewer', kind: 'path', path: '/review/demo-review-token' })
      if (String(url).includes('/demo-entry/speaker'))
        return json({ persona: 'speaker', kind: 'path', path: '/portal/demo-portal-token' })
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
    // The same entry point opens the page and closes it.
    expect(screen.getAllByRole('button', { name: /Enter the demo workspace/i })).toHaveLength(2)
    expect(
      screen.getByText('No sign-up for the demo. Jump into a fully seeded workspace.')
    ).toBeInTheDocument()
  })

  // Clerk is off in tests, so the hero falls back to the attendee link and the
  // closing CTA leads with the demo. The signup route only exists with Clerk.
  it('offers a way in for someone without an account yet', () => {
    renderHome()

    expect(screen.getByRole('link', { name: /See what attendees will see/i })).toHaveAttribute(
      'href',
      '/e/ai-builders-summit/schedule'
    )
    expect(screen.queryByRole('link', { name: /Create your account/i })).toBeNull()
    // Signing in stays reachable either way, for organizers who already have one.
    expect(screen.getByRole('link', { name: /Sign in with your account/i })).toHaveAttribute(
      'href',
      '/sign-in'
    )
  })

  it('sends a new organizer to Clerk signup when Clerk is configured', async () => {
    vi.resetModules()
    vi.stubEnv('VITE_CLERK_PUBLISHABLE_KEY', 'pk_test_configured')
    const shared = await import('@/pages/siteShared')
    expect(shared.ORGANIZER_SIGNUP_URL).toBe('/sign-up')
    expect(shared.ORGANIZER_SIGNIN_URL).toBe('/sign-in')

    // Self-hosted without Clerk there is no signup flow to link into.
    vi.stubEnv('VITE_CLERK_PUBLISHABLE_KEY', '')
    vi.resetModules()
    const selfHosted = await import('@/pages/siteShared')
    expect(selfHosted.ORGANIZER_SIGNUP_URL).toBeNull()
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

  it('lets a visitor try the published page in other conferences\' brands', () => {
    renderHome()

    const section = screen.getByTestId('attendee-section')
    const pills = [...section.querySelectorAll<HTMLButtonElement>('.bentabs button')]
    expect(pills.map((b) => b.textContent)).toContain('Your brand, not ours')

    // The claim is that these pages carry the organiser's identity, so the pill
    // has to actually restyle the window rather than describe it.
    fireEvent.click(pills[pills.length - 1])
    const swatches = [...section.querySelectorAll<HTMLButtonElement>('.swp-brands button')]
    expect(swatches.map((b) => b.textContent)).toEqual([
      'Sandstone',
      'Nightfall',
      'Meridian',
      'Signal',
    ])

    // It opens on Nightfall rather than on the canonical look: landing on the
    // page the visitor is already reading would make the pill look dead.
    const frame = section.querySelector('.swp-frame') as HTMLElement
    expect(frame.style.getPropertyValue('--swp-paper')).toBe('#14131c')
    expect(frame).toHaveAttribute('data-dark', 'true')
    // Both halves of the inverted chip move together, or a light-ink brand
    // paints white lettering onto a white pill.
    expect(frame.style.getPropertyValue('--swp-ink-on')).toBe('#14131c')

    // Branding is an organiser capability, not a page in the attendee's nav.
    expect(section.textContent).not.toContain('speakerweave.com/e/ai-builders-summit/branding')

    // And every other preset is one click away, ours included.
    fireEvent.click(swatches[0])
    expect(frame.style.getPropertyValue('--swp-paper')).toBe('')

    fireEvent.click(swatches[2])
    expect(frame.style.getPropertyValue('--swp-paper')).toBe('#fbf8f0')
  })

  it('opens the demo as any of its three audiences', async () => {
    renderHome()

    const doors = screen.getByLabelText('Open the demo as')
    expect(
      [...doors.querySelectorAll('b')].map((entry) => entry.textContent)
    ).toEqual(['Organizer', 'Reviewer', 'Speaker'])

    // The reviewer door follows the magic link the API mints rather than
    // storing a session token — that surface authenticates by link.
    fireEvent.click(within(doors).getByRole('button', { name: /Reviewer/ }))
    expect(await screen.findByText('Review reached')).toBeInTheDocument()
    expect(calls).toContain('/public/demo-entry/reviewer')
    expect(window.localStorage.getItem('dais.token')).toBeNull()
  })

  it('opens the speaker portal from its own door', async () => {
    renderHome()

    const doors = screen.getByLabelText('Open the demo as')
    fireEvent.click(within(doors).getByRole('button', { name: /Speaker/ }))
    expect(await screen.findByText('Portal reached')).toBeInTheDocument()
    expect(calls).toContain('/public/demo-entry/speaker')
  })

  it('keeps the exact organizer entry the eval harness pre-auth clicks', () => {
    renderHome()

    // `sbek auth --persona organizer --at /demo --click "Enter the demo
    // workspace"` depends on this literal label being a clickable button.
    // Changing the string silently breaks the harness's organizer pre-auth,
    // which is worth a test of its own.
    const entries = screen.getAllByRole('button', { name: 'Enter the demo workspace →' })
    expect(entries.length).toBeGreaterThan(0)
  })

  it('states the problem before any feature, and cites the independent score', () => {
    renderHome()

    const problem = screen.getByTestId('problem-section')
    expect(
      within(problem).getByRole('heading', { name: 'You have run this conference before.' })
    ).toBeInTheDocument()

    // Read across: every pain has an answer, and the two columns stay paired.
    const pains = problem.querySelectorAll('.pains li')
    const fixes = problem.querySelectorAll('.fixes li')
    expect(pains).toHaveLength(6)
    expect(fixes).toHaveLength(pains.length)
    expect(problem).toHaveTextContent('Reviewers score alone')

    expect(problem).toHaveTextContent('100 / 100')
    expect(problem).toHaveTextContent('96 rubric items')
    expect(within(problem).getByRole('link', { name: /Read the scorecard/i })).toHaveAttribute(
      'href',
      '/killmysaas'
    )
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

  it('closes on the sign-up CTA, with the open-source posture beneath it', () => {
    renderHome()

    // The page ends on the two ways in; what the project is made of lives on
    // its own page rather than in a stack table on the landing page.
    expect(screen.queryByTestId('stack-section')).toBeNull()
    expect(
      screen.getByRole('heading', { name: 'Run your next conference on it.' })
    ).toBeInTheDocument()

    const openSource = screen.getByTestId('open-source-section')
    expect(openSource).toHaveTextContent('MIT licensed')
    expect(within(openSource).getByRole('link', { name: /source repository/i })).toHaveAttribute(
      'href',
      REPO_URL
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
      'Agenda',
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
    fireEvent.click(screen.getAllByRole('button', { name: /Enter the demo workspace/i })[0])
    expect(await screen.findByText('Dashboard reached')).toBeInTheDocument()
    expect(calls).toContain('/public/demo-token')
    expect(window.localStorage.getItem('dais.token')).toBe('demo.jwt.token')
  })
})
