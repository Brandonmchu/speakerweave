/**
 * The published program, as an attendee sees it — the other half of the landing
 * page's product story, sitting under the admin window the same way.
 *
 * Rules, the same three the admin window keeps:
 *   1. Every string is the seeded AI Builders Summit, so this agrees with the
 *      real public pages a visitor reaches from the links beside it.
 *   2. Real DOM, not a screenshot: it stays crisp, and the site's own nav
 *      actually switches views.
 *   3. Nothing here implies a write. The only actions shown (add to calendar,
 *      share) are the ones the real published site offers a stranger.
 *
 * Chrome is deliberately the published site's own — white page inside browser
 * furniture — because that is what the visitor is being shown: not our admin
 * palette, but the thing their attendees will open on a phone in a hallway.
 */
import { useState, type JSX } from 'react'

import '../styles/site-attendee.css'

type ViewKey = 'schedule' | 'speakers' | 'session' | 'branding'

/**
 * Four conferences, one platform. The pill that opens this view makes a claim —
 * that these pages carry the ORGANISER's identity rather than ours — so the demo
 * restyles instead of asserting: each preset writes the same custom properties
 * the real feature writes per event, over the same schedule markup and data.
 *
 * Every face here is already on the page (JetBrains Mono, Instrument Serif,
 * Instrument Sans), so trying on a brand costs no font request.
 */
type Brand = {
  key: string
  name: string
  dot: string
  dark?: boolean
  vars: Record<string, string>
}

const BRANDS: Brand[] = [
  {
    key: 'default',
    name: 'Sandstone',
    dot: '#a85e3e',
    // The canonical look: identical to the tokens the stylesheet already
    // declares, so the other three views stay pixel-for-pixel unchanged.
    vars: {},
  },
  {
    key: 'nightfall',
    name: 'Nightfall',
    dot: '#7c5cff',
    dark: true,
    vars: {
      '--swp-paper': '#14131c',
      '--swp-ink': '#f3f1ff',
      '--swp-ink2': 'rgba(243, 241, 255, 0.72)',
      '--swp-ink3': 'rgba(243, 241, 255, 0.5)',
      '--swp-line': 'rgba(243, 241, 255, 0.14)',
      '--swp-tint': 'rgba(243, 241, 255, 0.08)',
      '--swp-accent': '#7c5cff',
      '--swp-ink-on': '#14131c',
      '--swp-display': "'Instrument Serif', Georgia, serif",
    },
  },
  {
    key: 'meridian',
    name: 'Meridian',
    dot: '#2f6f4e',
    vars: {
      '--swp-paper': '#fbf8f0',
      '--swp-ink': '#16201a',
      '--swp-ink2': '#44564b',
      '--swp-ink3': '#7c8c82',
      '--swp-line': 'rgba(22, 32, 26, 0.13)',
      '--swp-tint': 'rgba(22, 32, 26, 0.06)',
      '--swp-accent': '#2f6f4e',
      '--swp-display': "'Instrument Serif', Georgia, serif",
    },
  },
  {
    key: 'signal',
    name: 'Signal',
    dot: '#c2361f',
    vars: {
      '--swp-paper': '#fff',
      '--swp-ink': '#111',
      '--swp-ink2': '#4a4a4a',
      '--swp-ink3': '#8a8a8a',
      '--swp-line': 'rgba(17, 17, 17, 0.14)',
      '--swp-tint': 'rgba(17, 17, 17, 0.06)',
      '--swp-accent': '#c2361f',
      '--swp-display': "'Instrument Sans Variable', 'Instrument Sans', system-ui, sans-serif",
    },
  },
]

/** A speaker, with the headshot committed under `web/public/speakers/`. */
type Person = { name: string; role: string; org: string; photo: string }

function person(name: string, role: string, org: string): Person {
  return {
    name,
    role,
    org,
    photo: `/speakers/${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.jpg`,
  }
}

const ROSTER: Person[] = [
  person('Ada Okafor', 'VP of Engineering', 'Lumen AI'),
  person('Raj Patel', 'Observability Lead', 'TraceStack'),
  person('Elena Vasquez', 'Founder & CEO', 'FineTune Labs'),
  person('James Park', 'Principal Security Researcher', 'RedTeam AI'),
  person('Priya Raman', 'Staff ML Engineer', 'VectorWorks'),
  person('Yuki Tanaka', 'Research Engineer', 'PixelMind'),
  person('Omar Haddad', 'Staff Developer Advocate', 'ToolChain'),
  person('Grace Lin', 'ML Engineer', 'FineTune Labs'),
]

/** Saturday of the seeded agenda: the program as published. */
const AGENDA: Array<{
  time: string
  title: string
  room: string
  track: string
  speaker: Person
}> = [
  {
    time: '09:00',
    title: 'The Agentic Future Is Boring',
    room: 'Main Stage',
    track: 'Keynote',
    speaker: ROSTER[0],
  },
  {
    time: '10:15',
    title: 'RAG in Production: Lessons From 10B Queries',
    room: 'Main Stage',
    track: 'Engineering',
    speaker: ROSTER[1],
  },
  {
    time: '11:30',
    title: 'Guardrails: Structured Outputs Without the Pain',
    room: 'Workshop A',
    track: 'Engineering',
    speaker: ROSTER[3],
  },
  {
    time: '13:00',
    title: 'Hands-On: Fine-Tuning Open Models',
    room: 'Workshop B',
    track: 'Research',
    speaker: ROSTER[2],
  },
  {
    time: '14:30',
    title: 'Evaluating LLM Agents That Actually Ship',
    room: 'Main Stage',
    track: 'Product',
    speaker: ROSTER[4],
  },
]

/** Track colour follows the track, not the row — two Engineering talks with
 *  different coloured chips reads as a bug in the product being demonstrated. */
const TRACK_TONE: Record<string, string> = {
  Keynote: 'swp-t0',
  Engineering: 'swp-t1',
  Research: 'swp-t2',
  Product: 'swp-t3',
}

const VIEWS: Array<{ key: ViewKey; label: string; path: string }> = [
  { key: 'schedule', label: 'Schedule', path: '/e/ai-builders-summit/schedule' },
  { key: 'speakers', label: 'Speakers', path: '/e/ai-builders-summit/speakers' },
  { key: 'session', label: 'Sessions', path: '/e/ai-builders-summit/s/rag-in-production' },
]

function Face({ who, size }: { who: Person; size: 'sm' | 'lg' }) {
  return (
    <img
      className={`swp-face swp-face-${size}`}
      src={who.photo}
      alt=""
      loading="lazy"
      decoding="async"
    />
  )
}

function ScheduleView() {
  return (
    <>
      <div className="swp-days" role="group" aria-label="Program days">
        <span className="on">Sat, Oct 12</span>
        <span>Sun, Oct 13</span>
        <em>5 sessions · 3 tracks</em>
      </div>
      <ol className="swp-sessions">
        {AGENDA.map((session, index) => (
          <li key={session.title} style={{ ['--i' as string]: index }}>
            <time>{session.time}</time>
            <div>
              <b>{session.title}</b>
              <span className="swp-meta">
                <Face who={session.speaker} size="sm" />
                {session.speaker.name} · {session.room}
              </span>
            </div>
            <em className={`swp-track ${TRACK_TONE[session.track] ?? ''}`}>{session.track}</em>
          </li>
        ))}
      </ol>
    </>
  )
}

function SpeakersView() {
  return (
    <div className="swp-gallery">
      {ROSTER.map((who, index) => (
        <figure key={who.name} style={{ ['--i' as string]: index }}>
          <Face who={who} size="lg" />
          <figcaption>
            <b>{who.name}</b>
            <span>{who.role}</span>
            <em>{who.org}</em>
          </figcaption>
        </figure>
      ))}
    </div>
  )
}

function SessionView() {
  const session = AGENDA[1]

  return (
    <article className="swp-detail">
      <p className="swp-crumb">Saturday · 10:15 – 11:00 · {session.room}</p>
      <h3>{session.title}</h3>
      <p className="swp-abstract">
        Two years of serving retrieval at scale, and the four things that actually moved quality:
        chunking you can explain, evals that run on every deploy, a cache that knows when it is
        wrong, and boring infrastructure.
      </p>
      <div className="swp-byline">
        <Face who={session.speaker} size="lg" />
        <div>
          <b>{session.speaker.name}</b>
          <span>
            {session.speaker.role} · {session.speaker.org}
          </span>
        </div>
      </div>
      <div className="swp-acts">
        <span className="swp-act swp-act-p">Add to calendar</span>
        <span className="swp-act">Share</span>
        <span className="swp-act">Add to my schedule</span>
      </div>
    </article>
  )
}

/** The same published schedule, wearing a brand the visitor picks. */
function BrandingView({
  brand,
  onBrand,
}: {
  brand: Brand
  onBrand: (next: Brand) => void
}) {
  return (
    <>
      <div className="swp-brands" role="group" aria-label="Try a conference brand">
        {BRANDS.map((entry) => (
          <button
            key={entry.key}
            type="button"
            aria-pressed={entry.key === brand.key}
            onClick={() => onBrand(entry)}
          >
            <i style={{ background: entry.dot }} aria-hidden="true" />
            {entry.name}
          </button>
        ))}
      </div>
      <ScheduleView />
    </>
  )
}

/**
 * The published site, in browser furniture. Uncontrolled by default; the
 * landing page hands it a view so its own tabs and this nav stay in step.
 */
export function AttendeeWindow({
  view: controlled,
  onViewChange,
}: {
  view?: ViewKey
  onViewChange?: (next: ViewKey) => void
} = {}): JSX.Element {
  const [own, setOwn] = useState<ViewKey>('schedule')
  const [brand, setBrand] = useState<Brand>(BRANDS[0])
  const view = controlled ?? own
  // Branding is an organiser capability, not a page in the attendee's nav, so
  // it borrows the schedule's tab and address — it IS the schedule, restyled.
  const navKey = view === 'branding' ? 'schedule' : view
  const path = VIEWS.find((entry) => entry.key === navKey)?.path ?? VIEWS[0].path
  const skin = view === 'branding' ? brand : BRANDS[0]

  const select = (next: ViewKey) => {
    setOwn(next)
    onViewChange?.(next)
  }

  return (
    <div
      className="swp-frame"
      role="group"
      aria-label="Published program site"
      data-dark={skin.dark ? 'true' : undefined}
      style={skin.vars}
    >
      <div className="swp-bar" aria-hidden="true">
        <i className="swp-dots" />
        <span className="swp-url">
          speakerweave.com<b>{path}</b>
        </span>
      </div>

      <div className="swp-site">
        <header className="swp-head">
          <div>
            <b>AI Builders Summit</b>
            <span>Oct 12–13, 2026 · San Francisco</span>
          </div>
          <nav aria-label="Program">
            {VIEWS.map((entry) => (
              <button
                key={entry.key}
                type="button"
                aria-current={entry.key === navKey ? 'page' : undefined}
                onClick={() => select(entry.key)}
              >
                {entry.label}
              </button>
            ))}
            <span className="swp-reg">Register</span>
          </nav>
        </header>

        <div className="swp-page" key={view}>
          {view === 'schedule' ? <ScheduleView /> : null}
          {view === 'speakers' ? <SpeakersView /> : null}
          {view === 'session' ? <SessionView /> : null}
          {view === 'branding' ? <BrandingView brand={brand} onBrand={setBrand} /> : null}
        </div>
      </div>
    </div>
  )
}

export type { ViewKey as AttendeeViewKey }
