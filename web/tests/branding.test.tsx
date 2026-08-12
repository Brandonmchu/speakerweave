import { render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  DEFAULT_BRANDING,
  brandingStyle,
  sanitizeBranding,
  type BrandingConfig,
  type ScheduleLayout,
  type SpeakerLayout,
} from '@/lib/branding'
import { PublicSchedule } from '@/pages/PublicSchedule'
import { PublicSpeakers } from '@/pages/PublicSpeakers'
import { ProgramShell, programAccentStyle } from '@/pages/publicProgramShared'

const BRANDING: BrandingConfig = {
  ...DEFAULT_BRANDING,
  accent: 'ffcc00',
  background: 'fefae0',
  surface: 'ffffff',
  ink: '1c1a17',
  logo_url: 'https://assets.example.test/summit-logo.png',
}

const SESSION = {
  id: 'session-1',
  friendly_id: 'SW-1',
  title: 'Opening Keynote',
  description: '<p>A practical opening session.</p>',
  starts_at: '2026-10-12T16:00:00+00:00',
  ends_at: '2026-10-12T16:45:00+00:00',
  room: 'Main Hall',
  track: { name: 'Engineering', color: '#123456' },
  format: 'Keynote',
  speakers: [{ name: 'Alice Alpha', title: 'CTO', company: 'Alpha', photo_url: null }],
}

const SPEAKER = {
  id: 'speaker-1',
  name: 'Alice Alpha',
  title: 'CTO',
  company: 'Alpha',
  photo_url: null,
  bio: 'Alice builds reliable systems.',
  linkedin_url: null,
  twitter_url: null,
  sessions: [],
}

function response(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json' },
  })
}

function renderRoute(path: string, route: string, element: React.ReactNode) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <MemoryRouter initialEntries={[path]}>
      <QueryClientProvider client={queryClient}>
        <Routes>
          <Route path={route} element={element} />
        </Routes>
      </QueryClientProvider>
    </MemoryRouter>
  )
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  window.localStorage.clear()
})

describe('branding tokens', () => {
  it('sanitizes each field independently and drops junk', () => {
    expect(
      sanitizeBranding({
        accent: '#ABCDEF',
        background: 'not-a-color',
        heading_font: 'comic-sans',
        body_font: 'inter',
        radius: 'pill',
        schedule_layout: 'timeline',
        speaker_layout: 'list',
        density: 'tiny',
        header_style: 'billboard',
        show_powered_by: 'yes',
        unknown: 'discard me',
      })
    ).toEqual({
      ...DEFAULT_BRANDING,
      accent: 'abcdef',
      body_font: 'inter',
      speaker_layout: 'list',
    })
  })

  it('emits scoped custom properties and readable foregrounds', () => {
    const style = brandingStyle({ ...BRANDING, radius: 'large' }) as Record<string, string>

    expect(style['--dais-accent']).toBe('#ffcc00')
    expect(style['--primary']).toBe('48 100% 50%')
    expect(style['--primary-foreground']).toBe('36 10% 10%')
    expect(style['--background']).toBe('52 94% 94%')
    expect(style['--card']).toBe('0 0% 100%')
    expect(style['--foreground']).toBe('36 10% 10%')
    expect(style['--radius']).toBe('1rem')
    expect(style['--brand-body-font']).toContain('Instrument Sans')
  })

  it('re-derives the neutral tokens from the ink that actually won', () => {
    // A dark canvas flips --foreground to white. The neutrals in theme.css are
    // the DEFAULT ink at low alpha — dark grey text and near-black hairlines —
    // so leaving them would make `text-muted-foreground` (the most-used class
    // on these pages) and `border-border` invisible against it.
    const dark = brandingStyle({ ...BRANDING, background: '111111', ink: null }) as Record<
      string,
      string
    >

    expect(dark['--foreground']).toBe('0 0% 100%')
    expect(dark['--muted-foreground']).toBe('0 0% 100% / 0.68')
    expect(dark['--border']).toBe('0 0% 100% / 0.14')

    // The inverted chip must move as a PAIR. Pinning only the block is how a
    // dark canvas ends up with a white pill carrying white text.
    expect(dark['--status-solid']).toBe('0 0% 100%')
    expect(dark['--status-solid-foreground']).toBe('36 10% 10%')

    // An unbranded event keeps the hand-tuned palette untouched.
    const plain = brandingStyle({ ...BRANDING, background: null, surface: null, ink: null })
    expect(plain).not.toHaveProperty('--muted-foreground')
    expect(plain).not.toHaveProperty('--border')
    expect(plain).not.toHaveProperty('--status-solid')
  })

  it('keeps the embed accent override above stored branding', () => {
    const style = programAccentStyle('12EF34', { ...BRANDING, accent: '001122' }) as Record<
      string,
      string
    >

    expect(style['--dais-accent']).toBe('#12ef34')
    expect(style['--primary']).toBe('129 87% 50%')
  })

  it('renders a branded program header with the event logo', () => {
    render(
      <MemoryRouter>
        <ProgramShell
          slug="summit"
          eventName="AI Builders Summit"
          active="schedule"
          branding={BRANDING}
        >
          <p>Program</p>
        </ProgramShell>
      </MemoryRouter>
    )

    expect(screen.getByRole('img', { name: 'AI Builders Summit' })).toHaveAttribute(
      'src',
      BRANDING.logo_url
    )
    expect(screen.getByTestId('public-program-page')).toHaveStyle('--dais-accent: #ffcc00')
  })
})

describe('branded public layouts', () => {
  it.each<ScheduleLayout>(['list', 'tracks', 'grid'])(
    'renders the %s schedule layout from event branding',
    async (scheduleLayout) => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () =>
          response({
            event: {
              name: 'AI Builders Summit',
              timezone: 'UTC',
              location: 'Toronto',
              branding: { ...BRANDING, schedule_layout: scheduleLayout },
            },
            days: [{ date: '2026-10-12', sessions: [SESSION] }],
          })
        )
      )

      renderRoute('/e/summit/schedule', '/e/:slug/schedule', <PublicSchedule />)

      expect(await screen.findByTestId(`schedule-layout-${scheduleLayout}`)).toBeInTheDocument()
      expect(screen.getByRole('img', { name: 'AI Builders Summit' })).toBeInTheDocument()
      expect(screen.getByTestId('public-program-page')).toHaveStyle('--dais-accent: #ffcc00')
    }
  )

  it.each<SpeakerLayout>(['grid', 'list'])(
    'renders the %s speaker layout from event branding',
    async (speakerLayout) => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () =>
          response({
            event: {
              name: 'AI Builders Summit',
              timezone: 'UTC',
              branding: { ...BRANDING, speaker_layout: speakerLayout },
            },
            speakers: [SPEAKER],
          })
        )
      )

      renderRoute('/e/summit/speakers', '/e/:slug/speakers', <PublicSpeakers />)

      const testId = speakerLayout === 'grid' ? 'speaker-gallery-grid' : 'speaker-directory-list'
      expect(await screen.findByTestId(testId)).toBeInTheDocument()
      expect(screen.getByRole('img', { name: 'AI Builders Summit' })).toBeInTheDocument()
      expect(screen.getByTestId('public-program-page')).toHaveStyle('--dais-accent: #ffcc00')
    }
  )
})
