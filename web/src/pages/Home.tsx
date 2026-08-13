/**
 * Public marketing landing (routes: `/` when unauthenticated, and `/demo`).
 *
 * Built to the landing-page brief: the site inverts the admin app — ink ground
 * with the warm paper appearing only as inserted bands, and those bands are
 * reserved for the three feature demos (review, surfaces, speaker portal). The
 * visual language lives in `styles/site.css`; this file owns structure, copy,
 * real routes, and the live speaker wall.
 *
 * The primary CTA gets organizers into a seeded workspace with a short-lived
 * demo token. Public program links stay real anchors for people, crawlers, and
 * browser agents, while real organizers can still use Clerk at /sign-in.
 */
import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Sparkles, SquareTerminal, type LucideIcon } from 'lucide-react'
import { Link, useNavigate } from 'react-router-dom'

import chatgptLogo from '../assets/logos/chatgpt.svg'
import claudeLogo from '../assets/logos/claude.svg'
import slackLogo from '../assets/logos/slack.svg'
import { setToken } from '@/lib/api'
import { fetchDemoEntry, fetchDemoToken, type DemoPersona } from '@/lib/demoApi'
import { FEATURED_EVENT_SLUG, featuredScheduleUrl } from '@/lib/featuredEvent'
import {
  dedupeProgramSpeakers,
  getProgramSchedule,
  getProgramSpeakers,
  initialsOf,
} from '@/lib/programApi'
import { avatarGradient, stableHash } from '@/ui/avatar'
import { AgentSurfaceDemo, type AgentSurfaceId } from '@/pages/agentDemos'
import { DemoDoors, useDemoEntry } from '@/pages/demoDoors'
import { AppWindow, type ScreenKey } from '@/pages/appWindow'
import { AttendeeWindow, type AttendeeViewKey } from '@/pages/attendeeWindow'
import {
  DOCS_URL,
  EXPLORE,
  ORGANIZER_SIGNUP_URL,
  REPO_URL,
  SiteShell,
  vars,
} from '@/pages/siteShared'

export { DOCS_URL, REPO_URL } from '@/pages/siteShared'

/**
 * The year an organizer already knows, and the answer to each line of it.
 *
 * Paired by index: read across and the second column answers the first. Every
 * line on the right is a shipped surface you can open from this page — nothing
 * here is a roadmap.
 */
const PAINS = [
  'Reviewers score alone, in silos, and never see each other’s reasoning',
  'Committee work escapes into Slack threads, a spreadsheet and three Google Docs',
  'Speakers re-type the same bio into a form, an email and a slide template',
  'Accept, notify and onboard are three tools that do not know about each other',
  'The program lives in a schedule tool your data cannot leave',
  'Somebody rebuilds last year’s chase list by hand, every year',
]

const FIXES = [
  'One shared page per submission: every score, every comment, attributed',
  'The same agent in the app, in Slack, in ChatGPT or Claude, and in your terminal',
  'Speakers keep one portal, with versions, approvals and a single checklist',
  'One decision sends the email, opens the portal and starts the content clock',
  'Public schedule, embeds, iCal, JSON, a REST API and 16 MCP tools — all yours',
  'A cross-event speaker CRM that remembers who was good, and who owes you',
]

/**
 * The lifecycle, in the order a program runs — a left-to-right track rather
 * than a list, because the order is the point. One short line each: this is the
 * map of the year, and the detail lives in the demo further down.
 */
const LIFECYCLE = [
  { title: 'Call for Papers', body: 'One page, no account, drafts that survive.' },
  { title: 'Review', body: 'Committees score blind, without a spreadsheet.' },
  { title: 'Decisions', body: 'Accept, reject and notify in one pass.' },
  { title: 'Speaker Portal', body: 'Speakers onboard themselves.' },
  { title: 'Agenda', body: 'A schedule that catches its own conflicts.' },
  { title: 'Publish', body: 'Site, embeds and calendar feeds follow.' },
  { title: 'Speaker CRM', body: 'Your bench, ready for next year.' },
]

/**
 * The four agentic surfaces, in the order a team meets them. Every one of them
 * dispatches through the same organization-scoped tool layer — that shared
 * layer is the claim this section is making, so the copy keeps pointing at it.
 */
const SURFACES: Array<{
  title: string
  /** Compact label for the card row and the tab, when the title is a sentence. */
  short?: string
  kicker: string
  icon?: LucideIcon
  /** Brand marks, when the surface has ones people recognise faster than a glyph. */
  logos?: Array<{ src: string; invert?: boolean }>
  /** Ink tile is the default; `tone` gives a surface its own colour. */
  tone?: string
  /** Which mocked conversation illustrates this surface. */
  demo: AgentSurfaceId
  body: (endpoint: string) => ReactNode
  /** Where to read the setup, when the surface takes any setting up. */
  link?: { href: string; label: string }
}> = [
  {
    title: 'In-app agent',
    kicker: 'Built in',
    icon: Sparkles,
    tone: 'brand',
    demo: 'in-app',
    body: () =>
      'Runs the program, not just the search box: streaming threads, @-mention any submission or speaker as context, clickable entity badges that navigate the app, and approve/deny gates before anything sensitive happens.',
  },
  {
    title: 'Work in ChatGPT & Claude using our MCP server',
    // The two marks say "your client" faster than the word connector does.
    short: 'ChatGPT / Claude / MCP',
    kicker: 'Any client',
    logos: [{ src: chatgptLogo, invert: true }, { src: claudeLogo }],
    tone: 'mcp',
    demo: 'mcp',
    body: (endpoint) => (
      <>
        Add <code>{endpoint}</code> to Claude or ChatGPT as a connector — OAuth, no custom headers.
        Connectors run the other way too, bringing your own MCP servers into the agent.
      </>
    ),
    link: { href: `${DOCS_URL}/ai/mcp`, label: 'Set it up in ChatGPT or Claude' },
  },
  {
    title: 'Slack',
    kicker: 'Team surface',
    logos: [{ src: slackLogo }],
    demo: 'slack',
    body: () =>
      'Mention or DM the same agent that powers in-app Ask — the same built-in and connected MCP tools, with Approve/Deny buttons in Slack and shared Ask thread history.',
  },
  {
    title: 'CLI',
    kicker: 'Terminal',
    icon: SquareTerminal,
    tone: 'cli',
    demo: 'cli',
    body: () => (
      <>
        <code>pipx install</code>, authenticate with an API token, then <code>sw ask</code> — the
        same brain from any shell, script, or coding agent you already run, Codex and Claude Code
        included.
      </>
    ),
    link: { href: `${DOCS_URL}/ai/cli`, label: 'Read the CLI reference' },
  },
]

type Surface = (typeof SURFACES)[number]

/**
 * A surface's mark: brand logos when it has them, a glyph when it doesn't.
 * Two logos are separated by a slash, the same way the label reads.
 */
function SurfaceMark({ icon: Icon, logos, tone }: Pick<Surface, 'icon' | 'logos' | 'tone'>) {
  const classes = ['ico', logos && logos.length > 1 ? 'duo' : '', tone ?? ''].filter(Boolean)

  return (
    <span className={classes.join(' ')} aria-hidden="true">
      {logos
        ? logos.map(({ src, invert }, mark) => (
            <Fragment key={src}>
              {mark > 0 && <b>/</b>}
              <img src={src} alt="" className={invert ? 'inv' : undefined} />
            </Fragment>
          ))
        : Icon
          ? <Icon strokeWidth={1.75} />
          : null}
    </span>
  )
}

/**
 * The agentic section: one tab per surface, one demo on stage.
 *
 * Four stacked bands made a visitor scroll past three surfaces to reach the one
 * they cared about, so the surfaces share a stage instead. It advances on its
 * own — the demos are the argument, and most people will not click — but only
 * while the stage is actually on screen, it stops for good the moment someone
 * picks a tab themselves, and reduced motion never advances at all. The panel is
 * keyed by surface so switching remounts the demo and replays its sequence.
 */
const SURFACE_DWELL_MS = 9000

function AgentSurfaces({ endpoint }: { endpoint: string }) {
  const [index, setIndex] = useState(0)
  const [auto, setAuto] = useState(true)
  const [onScreen, setOnScreen] = useState(false)
  const [reduced, setReduced] = useState(false)
  const stage = useRef<HTMLDivElement | null>(null)
  const cycling = auto && onScreen && !reduced

  useEffect(() => {
    setReduced(
      typeof window.matchMedia === 'function' &&
        window.matchMedia('(prefers-reduced-motion: reduce)').matches
    )

    const node = stage.current
    if (!node || typeof IntersectionObserver === 'undefined') {
      setOnScreen(true)
      return
    }
    const observer = new IntersectionObserver(
      (entries) => setOnScreen(entries.some((entry) => entry.isIntersecting)),
      { threshold: 0.25 }
    )
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (!cycling) return
    const timer = window.setTimeout(
      () => setIndex((current) => (current + 1) % SURFACES.length),
      SURFACE_DWELL_MS
    )
    return () => window.clearTimeout(timer)
  }, [cycling, index])

  /** Picking a surface — by click or by keyboard — ends the carousel. */
  function choose(next: number) {
    setAuto(false)
    setIndex((next + SURFACES.length) % SURFACES.length)
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0
    if (!step) return
    event.preventDefault()
    choose(index + step)
    const tabs = event.currentTarget.querySelectorAll('button')
    tabs[(index + step + SURFACES.length) % SURFACES.length]?.focus()
  }

  const active = SURFACES[index]

  return (
    <>
      <div
        className="surftabs rv"
        role="tablist"
        aria-label="Agent surfaces"
        onKeyDown={onKeyDown}
        style={vars({ '--d': '.05s' })}
      >
        {SURFACES.map(({ title, short, kicker, icon, logos, tone, demo }, tab) => (
          <button
            key={title}
            type="button"
            role="tab"
            id={`surftab-${demo}`}
            aria-selected={tab === index}
            aria-controls={`surfpanel-${demo}`}
            tabIndex={tab === index ? 0 : -1}
            onClick={() => choose(tab)}
          >
            <SurfaceMark icon={icon} logos={logos} tone={tone} />
            <span>
              <b>{short ?? title}</b>
              <em>{kicker}</em>
            </span>
            {cycling && tab === index && <i className="surftick" />}
          </button>
        ))}
      </div>

      <div className="surfstage rv" ref={stage} style={vars({ '--d': '.1s' })}>
        <div
          key={active.demo}
          className="split surfpanel"
          role="tabpanel"
          id={`surfpanel-${active.demo}`}
          aria-labelledby={`surftab-${active.demo}`}
        >
          <div className="surfcopy">
            <div className="srow">
              <SurfaceMark icon={active.icon} logos={active.logos} tone={active.tone} />
              <h3>{active.title}</h3>
              <em>{active.kicker}</em>
              <p>{active.body(endpoint)}</p>
              {active.link && (
                <a className="slink" href={active.link.href} target="_blank" rel="noreferrer">
                  {active.link.label} →
                </a>
              )}
            </div>
          </div>
          <div className="surfdemo demo">
            <AgentSurfaceDemo surface={active.demo} />
          </div>
        </div>
      </div>
    </>
  )
}

/**
 * The workspace, named by what the visitor gets rather than by what the screen
 * is called. Each tab drives the real interface below it, so the claim and the
 * proof are never more than one click apart — which is why the page no longer
 * needs a band per feature explaining the same four things in prose.
 */
const BENEFITS: Array<{ label: string; body: string; screen: ScreenKey }> = [
  {
    label: 'Read every proposal once',
    body: 'Submissions land in one queue with reviewer scores attached, so the committee argues about talks instead of about spreadsheets.',
    screen: 'submissions',
  },
  {
    label: 'Build a schedule that holds',
    body: 'Auto-place fills the grid from accepted talks, and every move is checked live against speaker availability and room capacity — a double-booking surfaces before the program does.',
    screen: 'agenda',
  },
  {
    label: 'Stop chasing speakers',
    body: 'Everyone confirmed shows up here with what they still owe. Reminders name only the missing piece, so nobody gets a nag about something they already sent.',
    screen: 'speakers',
  },
  {
    label: 'Know what is still missing',
    body: 'Bios, headshots and slides in one matrix, every revision kept, so you can see at a glance what would hold up publishing tomorrow.',
    screen: 'content',
  },
]

/**
 * The admin tour: benefit tabs over the real interface.
 *
 * The tabs and the app's own rail drive the same state, so clicking either one
 * keeps the other honest — the visitor can browse by what they want or by where
 * it lives, and never sees the two disagree.
 */
function AdminTour({ onEnter, loading }: { onEnter: () => void; loading: boolean }) {
  const [screen, setScreen] = useState<ScreenKey>('submissions')
  const active = BENEFITS.find((benefit) => benefit.screen === screen) ?? BENEFITS[0]

  return (
    <>
      <div className="bentabs rv" role="tablist" aria-label="What the workspace does">
        {BENEFITS.map((benefit) => (
          <button
            key={benefit.screen}
            type="button"
            role="tab"
            aria-selected={benefit.screen === screen}
            onClick={() => setScreen(benefit.screen)}
          >
            {benefit.label}
          </button>
        ))}
      </div>
      <p className="benline rv" key={active.screen}>
        {active.body}
      </p>

      <div className="appframe rv" style={vars({ '--d': '.1s' })}>
        <AppWindow screen={screen} onScreenChange={setScreen} />
      </div>
      <div className="rv" style={{ marginTop: 26 }}>
        <button type="button" className="arrowlink" onClick={onEnter} disabled={loading}>
          Open the real thing →
        </button>
      </div>
    </>
  )
}

/** What the published side is worth, view by view. */
const PUBLIC_BENEFITS: Array<{ label: string; body: string; view: AttendeeViewKey }> = [
  {
    label: 'A schedule that is never stale',
    body: 'Move a session at 9am and the public schedule, the embeds on your own site, and every subscribed calendar have it by 9:01.',
    view: 'schedule',
  },
  {
    label: 'Speakers who look the part',
    body: 'Bios and headshots come straight from what each speaker approved in their portal — no copy-paste, no out-of-date photo from three years ago.',
    view: 'speakers',
  },
  {
    label: 'A page worth sharing',
    body: 'Every session gets its own address, with the abstract, the speaker, and one tap to put it in a calendar — which is what actually fills the room.',
    view: 'session',
  },
  {
    label: 'Your brand, not ours',
    body: 'Colours, type and layout are set per conference, so attendees see your event rather than our template. Run three conferences and each one keeps its own look — try one below.',
    view: 'branding',
  },
]

/** The attendee tour: same shape as the admin one, other side of the data. */
function AttendeeTour() {
  const [view, setView] = useState<AttendeeViewKey>('schedule')
  const active = PUBLIC_BENEFITS.find((benefit) => benefit.view === view) ?? PUBLIC_BENEFITS[0]

  return (
    <>
      <div className="bentabs rv" role="tablist" aria-label="What attendees get">
        {PUBLIC_BENEFITS.map((benefit) => (
          <button
            key={benefit.view}
            type="button"
            role="tab"
            aria-selected={benefit.view === view}
            onClick={() => setView(benefit.view)}
          >
            {benefit.label}
          </button>
        ))}
      </div>
      <p className="benline rv" key={active.view}>
        {active.body}
      </p>

      <div className="appframe rv" style={vars({ '--d': '.1s' })}>
        <AttendeeWindow view={view} onViewChange={setView} />
      </div>
    </>
  )
}

/** Twelve tiles, three drifting columns. */
const WALL_SIZE = 12

/**
 * Where a speaker sits in the program. Faces alone read as stock photography;
 * the status is what makes the wall legible as a roster inside a product.
 * Assigned by stable hash so a given speaker keeps the same one, and drawn from
 * states the demo workspace actually models.
 */
const WALL_STATES: Array<{ label: string; dot: string }> = [
  { label: 'Onboarded', dot: 'd-acc' },
  { label: 'Confirmed', dot: 'd-acc' },
  { label: 'Content due', dot: 'd-pend' },
  { label: 'Bio approved', dot: 'd-acc' },
  { label: 'In review', dot: 'd-q' },
  { label: 'Slides due', dot: 'd-warn' },
]

/** The one non-face tile: which slot the live program summary occupies. */
const SUMMARY_SLOT = 5

/**
 * The hero wall is the featured event's real speaker roster: headshots where
 * the speaker has uploaded one, and the app's gradient-plus-initials tile
 * everywhere else — the same fallback the public speaker gallery uses, so a
 * partially-filled wall is a legitimate live state rather than a broken one.
 *
 * Before the roster resolves the tiles render as bare gradients, keyed off
 * their slot so nothing reshuffles when the names land.
 */
function SpeakerWall() {
  const query = useQuery({
    queryKey: ['program-speakers', FEATURED_EVENT_SLUG],
    queryFn: () => getProgramSpeakers(FEATURED_EVENT_SLUG),
    staleTime: 5 * 60_000,
    retry: false,
  })
  const scheduleQuery = useQuery({
    queryKey: ['program-schedule', FEATURED_EVENT_SLUG],
    queryFn: () => getProgramSchedule(FEATURED_EVENT_SLUG),
    staleTime: 5 * 60_000,
    retry: false,
  })

  const roster = dedupeProgramSpeakers(query.data?.speakers ?? [])

  // The summary slot is fixed, so the wall doesn't reshuffle when data lands.
  let speakerIndex = -1
  const tiles = Array.from({ length: WALL_SIZE }, (_, index) => {
    if (index === SUMMARY_SLOT) return { key: `${index}`, summary: true as const }

    speakerIndex += 1
    const speaker = roster.length ? roster[speakerIndex % roster.length] : null
    const seed = speaker ? speaker.id || speaker.name : `slot-${index}`
    const [start, end] = avatarGradient(`${seed}${roster.length ? '' : index}`)
    return {
      key: `${index}`,
      summary: false as const,
      name: speaker?.name ?? null,
      photo: speaker?.photo_url ?? null,
      state: speaker ? WALL_STATES[stableHash(seed) % WALL_STATES.length] : null,
      gradient: `linear-gradient(145deg, ${start}, ${end})`,
    }
  })

  // Everything on the summary tile is the featured event's own public program.
  const days = scheduleQuery.data?.days ?? []
  const sessionCount = days.reduce((total, day) => total + day.sessions.length, 0)
  const trackCount = new Set(
    days.flatMap((day) => day.sessions.map((s) => s.track?.name).filter(Boolean))
  ).size
  const eventName = scheduleQuery.data?.event?.name ?? query.data?.event?.name ?? null

  return (
    <div className="cols" aria-hidden="true">
      {[0, 1, 2].map((column) => (
        <div key={column} className={`col s${column + 1}`}>
          {tiles.slice(column * 4, column * 4 + 4).map((tile) =>
            tile.summary ? (
              <div key={tile.key} className="tile artifact" data-testid="wall-summary">
                <div>
                  <div className="k">Live program</div>
                  <div className="t">{eventName ?? 'AI Builders Summit'}</div>
                  <div className="sub">
                    {days.length ? `${days.length} days · ` : ''}Published live
                  </div>
                </div>
                <div className="stats">
                  <div>
                    <b>{roster.length || '—'}</b> speakers confirmed
                  </div>
                  <div>
                    <b>{sessionCount || '—'}</b> sessions scheduled
                  </div>
                  <div>
                    <b>{trackCount || '—'}</b> tracks live
                  </div>
                </div>
              </div>
            ) : (
              <div key={tile.key} className="tile" style={{ backgroundImage: tile.gradient }}>
                {tile.photo ? (
                  <img src={tile.photo} alt="" loading="lazy" decoding="async" />
                ) : tile.name ? (
                  <span className="initials">{initialsOf(tile.name)}</span>
                ) : null}
                {tile.name && (
                  <span className="cap">
                    <b>{tile.name}</b>
                    {tile.state && (
                      <em className={`dotted ${tile.state.dot}`}>{tile.state.label}</em>
                    )}
                  </span>
                )}
              </div>
            )
          )}
        </div>
      ))}
    </div>
  )
}

export function Home() {
  const { loading, error, enterDemo, enterAs } = useDemoEntry()
  const mcpEndpoint = `${window.location.origin}/mcp`

  return (
    <SiteShell>
      {/* ── hero ─────────────────────────────────────────────────────────── */}
      <section className="wrap hero">
        <div className="rv in">
          {/* Both badges are claims about the project rather than the product,
              and they belong together — the competition entry left the nav for
              this row, where it reads as context instead of as a route. */}
          <div className="badges">
            <Link to="/open-source" className="badge">
              <i />
              Open source
            </Link>
            <Link to="/killmysaas" className="badge flag">
              Kill My SaaS competition
            </Link>
          </div>
          <h1 className="h1 serif">Every speaker, from submission to stage.</h1>
          <p className="lede">
            SpeakerWeave runs your whole conference — submissions, reviews, speakers, and the
            schedule they&rsquo;ll stand on.
          </p>
          {/* The demo leads because it costs nothing, but the page has to offer
              the other thing an organizer came for: a way to start their own. */}
          <div className="ctas">
            <button type="button" className="btn p" onClick={enterDemo} disabled={loading}>
              {loading ? 'Starting the demo…' : 'Enter the demo workspace →'}
            </button>
            <Link to={ORGANIZER_SIGNUP_URL ?? featuredScheduleUrl} className="btn t">
              {ORGANIZER_SIGNUP_URL ? 'Create your account →' : 'See what attendees will see →'}
            </Link>
          </div>
          <p className="note">No sign-up for the demo. Jump into a fully seeded workspace.</p>
          {error && <p className="err">{error}</p>}

          {/* Three products live in here and only one of them had a door. A
              reviewer's scorecard and a speaker's portal are entered by emailed
              link, so nobody could see them without being invited — these ask
              the API for the same link an organizer would have sent. */}
          <DemoDoors enterAs={enterAs} loading={loading} />
        </div>
        <SpeakerWall />
      </section>

      {/* The hero and the section under it share a ground again, so the page
          needs its own seam — a hairline that fades out at both ends. */}
      <div className="wrap">
        <hr className="hairline rv" />
      </div>

      {/* ── agentic ──────────────────────────────────────────────────────── */}
      {/* The surface tabs below say "wherever you already work" better than a
          card row under the hero did, so this section carries that claim alone.
          Centred and set in mono: the section is about machines doing the work,
          and the serif headline upstairs should stay the page's only voice. */}
      <section className="wrap sect" data-testid="ai-apps-section">
        <div className="rv aghead">
          <p className="eyebrow">One brain, every surface</p>
          <h2 className="h2 mono">
            Built for the Agentic Future
            <i aria-hidden="true" />
          </h2>
          <p className="lede">
            One organization-scoped tool layer behind every surface — same permissions, same program
            data, same approval gate before anything sensitive.
          </p>
        </div>

        <AgentSurfaces endpoint={mcpEndpoint} />

        <div style={{ marginTop: 30 }} className="rv">
          <Link to="/developers" className="arrowlink">
            See the full MCP tool list →
          </Link>
        </div>
      </section>

      {/* ── lifecycle ────────────────────────────────────────────────────── */}
      {/* A year of program work reads as a track, not a list: the line draws
          itself left to right and the stops land on it in order, which is the
          one thing a stack of cards could never say. */}
      <section className="light hasbleed">
        {/* The room before the doors open, which is where a call for papers
            starts. Blurred to atmosphere and masked to nothing at both edges:
            it is texture behind the track, never a photograph of an event we
            are claiming to have run. */}
        <img className="bleed" src="/venue/venue-04.jpg" alt="" aria-hidden="true" loading="lazy" decoding="async" />
        <div className="wrap">
          <div className="rv" style={{ maxWidth: '54ch' }}>
            <p className="eyebrow">The whole program lifecycle</p>
            <h2 className="h2 serif">From first proposal to full room.</h2>
            <p className="lede">
              One system carries the year — so nothing is retyped, and nothing falls between two
              tools.
            </p>
          </div>
          <ol className="flow rv" style={vars({ '--d': '.1s' })}>
            {LIFECYCLE.map(({ title, body }, index) => (
              <li key={title} style={vars({ '--d': `${0.25 + index * 0.09}s` })}>
                <i aria-hidden="true" />
                <em aria-hidden="true">{String(index + 1).padStart(2, '0')}</em>
                <h3>{title}</h3>
                <p>{body}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      {/* ── the app itself ───────────────────────────────────────────────── */}
      {/* The lifecycle above says what the product does; this is the product
          doing it. Real DOM rather than a screenshot, so it stays crisp and the
          screens actually switch — driven either from the tabs, which name what
          the visitor gets, or from the app's own rail. */}
      <section className="wrap sect" data-testid="app-window-section">
        <div className="rv" style={{ maxWidth: '58ch' }}>
          <p className="eyebrow">Inside the workspace</p>
          <h2 className="h2 serif">Run the whole program without leaving one tab.</h2>
          <p className="lede">
            This is the real interface, seeded with the AI Builders Summit. Pick what you want to
            see — or click straight into it.
          </p>
        </div>

        <AdminTour onEnter={enterDemo} loading={loading} />
      </section>

      {/* ── what attendees see ───────────────────────────────────────────── */}
      {/* The section above is the workspace; this is the other half of the same
          program data — what everybody who is not an organizer actually looks
          at. Same seeded event, published. */}
      <section className="light" data-testid="attendee-section">
        <div className="wrap">
          <div className="rv" style={{ maxWidth: '58ch' }}>
            <p className="eyebrow">What your attendees see</p>
            <h2 className="h2 serif">Your attendees get a program site you never have to build.</h2>
            <p className="lede">
              Publish once and the schedule, the speaker gallery and every calendar feed update
              themselves — from the same data you just reviewed.
            </p>
          </div>

          <AttendeeTour />

          <div className="rv proglinks" style={{ marginTop: 26 }}>
            {EXPLORE.map(({ label, to }) => (
              <Link key={label} to={to}>
                {label} →
              </Link>
            ))}
          </div>
        </div>
      </section>

      {/* ── the problem ──────────────────────────────────────────────────── */}
      {/* Last, not first: the demos have already shown what this does, so the
          two columns land as recognition rather than as a pitch — the year an
          organizer already had, and beside each line the thing that replaces
          it. The verdict underneath is the one claim that is not ours. */}
      <section className="wrap sect" data-testid="problem-section">
        <div className="rv" style={{ maxWidth: '54ch' }}>
          <p className="eyebrow">Why this exists</p>
          <h2 className="h2 serif">You have run this conference before.</h2>
        </div>
        <div className="ledger rv" style={vars({ '--d': '.08s' })}>
          <div>
            <p className="eyebrow">What the year usually costs</p>
            <ul className="pains">
              {PAINS.map((pain) => (
                <li key={pain}>{pain}</li>
              ))}
            </ul>
          </div>
          <div>
            <p className="eyebrow">What this does instead</p>
            <ul className="fixes">
              {FIXES.map((fix) => (
                <li key={fix}>{fix}</li>
              ))}
            </ul>
          </div>
        </div>

        {/* The claim above is ours; this is somebody else's. */}
        <div className="proof rv" style={vars({ '--d': '.12s' })}>
          <b>100 / 100</b>
          <p>
            on the independent Other Conference/CFP Software evaluation — all seven areas, 96 rubric items, 197
            weighted points, graded by a browser agent with no help from us.
          </p>
          <Link to="/killmysaas" className="arrowlink">
            Read the scorecard →
          </Link>
        </div>
      </section>

      {/* ── closing CTA ──────────────────────────────────────────────────── */}
      {/* The page ends on the one thing left to do. What the project is made of
          belongs to people who are already interested — it lives on the
          open-source page and in the docs, a click away from here. */}
      <section className="wrap sect">
        <div className="cta rv">
          <div className="glow" aria-hidden="true" />
          {/* The full room, under the card that asks you to go and fill one. */}
          <img
            className="ctableed"
            src="/venue/venue-01.jpg"
            alt=""
            aria-hidden="true"
            loading="lazy"
            decoding="async"
          />
          <h2 className="serif">Run your next conference on it.</h2>
          <p>
            Create your workspace and set up your first event, or look around the seeded one first.
            No credit card, and it&rsquo;s open source either way.
          </p>
          {/* Last word on the page, so the account comes first here — the demo
              is the way in for anyone not ready to make one. */}
          <div className="ctas">
            {ORGANIZER_SIGNUP_URL && (
              <Link to={ORGANIZER_SIGNUP_URL} className="btn p">
                Create your account →
              </Link>
            )}
            <button
              type="button"
              className={ORGANIZER_SIGNUP_URL ? 'btn d' : 'btn p'}
              onClick={enterDemo}
              disabled={loading}
            >
              {loading ? 'Starting the demo…' : 'Enter the demo workspace →'}
            </button>
          </div>
          <p className="note">
            Already have an account? <Link to="/sign-in">Sign in with your account</Link>.
          </p>
          <p className="note" data-testid="open-source-section">
            <Link to="/open-source">Open source</Link> and MIT licensed —{' '}
            <a href={REPO_URL} aria-label="SpeakerWeave source repository">
              view the repository
            </a>
            .
          </p>
        </div>
      </section>
    </SiteShell>
  )
}

