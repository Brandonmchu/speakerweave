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
import { useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Plug, Sparkles, SquareTerminal, type LucideIcon } from 'lucide-react'
import { Link, useNavigate } from 'react-router-dom'

import slackLogo from '../assets/logos/slack.svg'
import { setToken } from '@/lib/api'
import { fetchDemoToken } from '@/lib/demoApi'
import { FEATURED_EVENT_SLUG, featuredScheduleUrl } from '@/lib/featuredEvent'
import {
  dedupeProgramSpeakers,
  getProgramSchedule,
  getProgramSpeakers,
  initialsOf,
} from '@/lib/programApi'
import { avatarGradient, stableHash } from '@/ui/avatar'
import { EXPLORE, REPO_URL, SiteShell, vars } from '@/pages/siteShared'

export { DOCS_URL, REPO_URL } from '@/pages/siteShared'

/** The lifecycle, in the order a program runs. */
const LIFECYCLE = [
  {
    title: 'Call for Papers',
    body: 'Smart forms with conditional logic for every submission path.',
    kicker: 'Forms',
  },
  {
    title: 'Review',
    body: 'Committees, blind rounds, scorecards, and practical AI triage.',
    kicker: 'Scoring',
  },
  {
    title: 'Decisions',
    body: 'One click sends emails and kicks off speaker onboarding.',
    kicker: 'Automation',
  },
  {
    title: 'Speaker Portal',
    body: 'Bios, headshots, versioned content, and approvals in one place.',
    kicker: 'Onboarding',
  },
  {
    title: 'Agenda Builder',
    body: 'Drag-and-drop planning, live conflict checks, and auto-place.',
    kicker: 'Scheduling',
  },
  {
    title: 'Publish',
    body: 'Public schedule, speaker gallery, embeds, and iCal feeds.',
    kicker: 'Public site',
  },
  {
    title: 'Speaker CRM',
    body: 'A cross-event directory with sourcing pipeline and segments.',
    kicker: 'Sourcing',
  },
]

/**
 * The four agentic surfaces, in the order a team meets them. Every one of them
 * dispatches through the same organization-scoped tool layer — that shared
 * layer is the claim this section is making, so the copy keeps pointing at it.
 */
const SURFACES: Array<{
  title: string
  kicker: string
  icon?: LucideIcon
  /** Brand mark, when the surface has one people recognise faster than a glyph. */
  logo?: string
  /** Ink tile is the default; `tone` gives a surface its own colour. */
  tone?: string
  body: (endpoint: string) => ReactNode
}> = [
  {
    title: 'In-app agent',
    kicker: 'Built in',
    icon: Sparkles,
    tone: 'brand',
    body: () =>
      'Runs the program, not just the search box: streaming threads, @-mention any submission or speaker as context, clickable entity badges that navigate the app, and approve/deny gates before anything sensitive happens.',
  },
  {
    title: 'MCP server + connectors',
    kicker: 'Any client',
    icon: Plug,
    tone: 'mcp',
    body: (endpoint) => (
      <>
        Add <code>{endpoint}</code> to Claude or ChatGPT as a connector — OAuth, no custom headers.
        Connectors run the other way too, bringing your own MCP servers into the agent.
      </>
    ),
  },
  {
    title: 'Slack',
    kicker: 'Team surface',
    logo: slackLogo,
    body: () =>
      'Mention or DM the same agent that powers in-app Ask — the same built-in and connected MCP tools, with Approve/Deny buttons in Slack and shared Ask thread history.',
  },
  {
    title: 'sw CLI',
    kicker: 'Terminal',
    icon: SquareTerminal,
    tone: 'cli',
    body: () => (
      <>
        <code>pipx install</code>, authenticate with an API token, then <code>sw ask</code> — the
        same brain from any shell, script, or coding agent you already run, Codex and Claude Code
        included.
      </>
    ),
  },
]

const STACK = [
  { name: 'FastAPI', role: 'Typed API + hosted MCP' },
  { name: 'React + Vite', role: 'Fast web interface' },
  { name: 'Supabase (Postgres)', role: 'Program data' },
  { name: 'Clerk', role: 'Organizer auth' },
  { name: 'Resend', role: 'Transactional email' },
  { name: 'Railway', role: 'Application hosting' },
]

/** Round 2 of the seeded demo workspace — the numbers the demo really shows. */
const REVIEW_ROUNDS = [
  { committee: 'Committee A', width: '72%', score: '3.6' },
  { committee: 'Committee B', width: '62%', score: '3.1' },
  { committee: 'Committee C', width: '80%', score: '4.0' },
  { committee: 'Committee D', width: '56%', score: '2.8' },
]

/** Saturday of the seeded agenda: [time, Main Hall, Track A, Workshop]. */
const AGENDA_ROWS: Array<[string, ...Array<{ title: string; tone: string } | null>]> = [
  ['09:00', { title: 'Opening keynote', tone: 'g1' }, null, null],
  ['10:15', null, { title: 'RAG in Production', tone: 'g3' }, { title: 'Fine-tuning lab', tone: 'g4' }],
  ['11:30', { title: 'Guardrails', tone: 'g6' }, { title: 'Observability', tone: 'g2' }, null],
  ['13:00', null, { title: 'Multimodal RAG', tone: 'g5' }, { title: 'Tool-using agents', tone: 'g8' }],
]

const SCHEDULE_PREVIEW = [
  ['09:00', 'Opening keynote: The Agentic Future Is Boring', 'Main Hall'],
  ['10:15', 'RAG in Production: Lessons From 10B Queries', 'Track A'],
  ['11:30', 'Guardrails: Structured Outputs Without the Pain', 'Track B'],
  ['13:00', 'Hands-On: Fine-Tuning Open Models', 'Workshop'],
  ['14:30', 'Evaluating LLM Agents That Actually Ship', 'Track A'],
]

const PORTAL_TASKS: Array<[string, string, boolean]> = [
  ['Accept your invitation', 'Aug 2', true],
  ['Bio · v3 approved', 'Aug 9', true],
  ['Headshot uploaded', 'Aug 14', true],
  ['Talk description', 'Aug 18', true],
  ['Slides', 'due Aug 27', false],
  ['Travel details', 'due Sep 4', false],
]

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
  const navigate = useNavigate()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const mcpEndpoint = `${window.location.origin}/mcp`

  async function enterDemo() {
    if (loading) return
    setError(null)
    setLoading(true)
    try {
      const token = await fetchDemoToken()
      setToken(token)
      navigate('/dashboard', { replace: true })
    } catch {
      setError("Couldn't start the demo. Give it a moment and try again.")
      setLoading(false)
    }
  }

  /** The three feature demos have no public counterpart to link to — the real
   *  surface is the seeded workspace, so each one opens it. */
  const demoLink = (label: string) => (
    <button type="button" className="arrowlink" onClick={enterDemo} disabled={loading}>
      {label} →
    </button>
  )

  return (
    <SiteShell>
      {/* ── hero ─────────────────────────────────────────────────────────── */}
      <section className="wrap hero">
        <div className="rv in">
          <span className="badge">
            <i />
            Open-source conference operations
          </span>
          <h1 className="h1 serif">Every speaker, from submission to stage.</h1>
          <p className="lede">
            From call for papers to a published, staffed, scheduled agenda — submissions, reviews,
            speaker onboarding, content, and scheduling in one open-source workspace.
          </p>
          <div className="ctas">
            <button type="button" className="btn p" onClick={enterDemo} disabled={loading}>
              {loading ? 'Starting the demo…' : 'Enter the demo workspace →'}
            </button>
            <Link to={featuredScheduleUrl} className="btn t">
              View the public program →
            </Link>
          </div>
          <p className="note">No sign-up. Jump into a fully seeded workspace.</p>
          {error && <p className="err">{error}</p>}
        </div>
        <SpeakerWall />
      </section>

      {/* ── facts ────────────────────────────────────────────────────────── */}
      <section className="wrap factsect" aria-label="Project credibility">
        <div className="rule" />
        <ul className="facts rv" style={vars({ '--d': '.1s' })}>
          <li>
            <a href={REPO_URL}>
              Open source · <b>MIT</b>
            </a>
          </li>
          <li>
            <b>982</b> backend + <b>603</b> frontend tests
          </li>
          <li>Built end-to-end by AI coding agents</li>
          <li>REST API + MCP + webhooks-ready</li>
        </ul>
      </section>

      {/* ── agentic ──────────────────────────────────────────────────────── */}
      <section className="light" data-testid="ai-apps-section">
        <div className="wrap">
          <div className="rv">
            <p className="eyebrow">One brain, every surface</p>
            <h2 className="h2 serif">Built for the future, and fully agentic.</h2>
            <p className="lede" style={{ maxWidth: '66ch' }}>
              Every surface dispatches through the same organization-scoped tool layer, so the agent
              can run the program wherever you already work — in the app, in your MCP client, in the
              channel, or in a terminal. Permissions and program data stay consistent, and anything
              sensitive stops at an approval gate first.
            </p>
          </div>

          <div className="split top" style={{ marginTop: 44 }}>
            <div className="term rv demo">
              <div>
                <span className="p">$</span>{' '}
                <span className="cmd">sw ask &quot;who still owes content before Aug 27?&quot;</span>
                <span className="cur" />
              </div>
              <div className="out">→ 6 speakers outstanding · 4 missing headshot only</div>
              <div className="p">→ raj.patel · marco.bianchi · aisha.bello · omar.haddad</div>
              <div className="p">
                → run <span className="lit">sw remind --deadline 2026-08-27</span> to queue emails
              </div>
            </div>

            <div className="rv" style={vars({ '--d': '.15s' })}>
              {SURFACES.map(({ title, kicker, icon: Icon, logo, tone, body }) => (
                <div key={title} className="srow">
                  <span className={`ico${tone ? ` ${tone}` : ''}`} aria-hidden="true">
                    {logo ? <img src={logo} alt="" /> : Icon ? <Icon strokeWidth={1.75} /> : null}
                  </span>
                  <h3>{title}</h3>
                  <em>{kicker}</em>
                  <p>{body(mcpEndpoint)}</p>
                </div>
              ))}
              <div style={{ marginTop: 26 }}>
                <Link to="/developers" className="arrowlink">
                  See the full MCP tool list →
                </Link>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ── lifecycle ────────────────────────────────────────────────────── */}
      <section className="wrap sect">
        <div className="rv">
          <p className="eyebrow">The whole program lifecycle</p>
          <h2 className="h2 serif">From first proposal to final room assignment.</h2>
          <p className="lede">
            One operating system for program teams, review committees, speakers, and attendees.
          </p>
        </div>
        <div className="numtop" style={{ marginTop: 36 }}>
          {LIFECYCLE.map(({ title, body, kicker }, index) => (
            <div
              key={title}
              className="num rv"
              style={vars({ '--d': `${index * 0.06}s` })}
            >
              <em aria-hidden="true">{String(index + 1).padStart(2, '0')}</em>
              <div>
                <h3>{title}</h3>
                <p>{body}</p>
              </div>
              <span>{kicker}</span>
            </div>
          ))}
        </div>
      </section>

      {/* ── review demo ──────────────────────────────────────────────────── */}
      <section className="light">
        <div className="wrap split">
          <div className="rv">
            <p className="eyebrow">Review</p>
            <h2 className="h2 serif">
              Blind rounds, real scorecards, and triage that saves the committee a weekend.
            </h2>
            <p className="lede">
              Committees score against your criteria without seeing each other&rsquo;s marks.
              Averages settle as reviews land, and AI triage flags the obvious duplicates and
              off-topic submissions before a human spends time on them.
            </p>
            <div style={{ marginTop: 26 }}>{demoLink('See how review works')}</div>
          </div>

          <div className="card lite rv demo" style={vars({ '--d': '.15s' })}>
            <div className="chead">
              SESS-114 · Designing Trustworthy AI<span className="end">Round 2</span>
            </div>
            {REVIEW_ROUNDS.map(({ committee, width, score }, index) => (
              <div key={committee} className="rev">
                <b>{committee}</b>
                <span className="track" style={vars({ '--d': `${index * 0.15}s` })}>
                  <i style={vars({ '--w': width })} />
                </span>
                <span className="score">{score}</span>
              </div>
            ))}
            <div className="avgrow">
              <div className="avg">3.38</div>
              <div className="avglab">
                weighted average
                <br />4 of 4 reviews in
              </div>
              <div className="flip">
                <span className="a dotted d-pend">Pending review</span>
                <span className="b dotted d-q">Moved to accept queue</span>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ── agenda demo ──────────────────────────────────────────────────── */}
      <section className="wrap sect">
        <div className="split">
          <div className="card rv demo">
            <div className="chead">
              Agenda builder · Saturday<span className="end">auto-place</span>
            </div>
            <div className="board">
              <div />
              <div className="bh">Main Hall</div>
              <div className="bh">Track A</div>
              <div className="bh">Workshop</div>
              {AGENDA_ROWS.map(([time, ...cells], row) => (
                <Row
                  key={time}
                  time={time}
                  cells={cells}
                  firstTile={AGENDA_ROWS.slice(0, row).reduce(
                    (count, [, ...prior]) => count + prior.filter(Boolean).length,
                    0
                  )}
                />
              ))}
            </div>
            <div className="conflict dotted d-warn">
              Wei Zhang was double-booked at 11:30 — moved to Track A
            </div>
          </div>

          <div className="rv" style={vars({ '--d': '.15s' })}>
            <p className="eyebrow">Agenda builder</p>
            <h2 className="h2 serif">Drag a session anywhere. It tells you what breaks.</h2>
            <p className="lede">
              Auto-place fills rooms and slots from accepted sessions, and every move is checked
              live against speaker availability, room capacity, and track spread. Publish when
              it&rsquo;s right — the public schedule, embeds, and iCal feeds all follow.
            </p>
            <div style={{ marginTop: 26 }}>{demoLink('Open the demo agenda')}</div>
          </div>
        </div>
      </section>

      {/* ── live public example ──────────────────────────────────────────── */}
      <section className="wrap sect">
        <div className="rv">
          <p className="eyebrow">Live public example</p>
          <h2 className="h2 serif">Explore the AI Builders Summit.</h2>
          <p className="lede">
            Every event publishes a schedule, a speaker gallery, embeds, and iCal feeds from the
            same program data — no second CMS to keep in sync.
          </p>
        </div>

        <div className="sched rv" style={vars({ '--d': '.1s' })}>
          <div className="now" aria-hidden="true" />
          {SCHEDULE_PREVIEW.map(([time, title, room]) => (
            <div key={title} className="sess">
              <time>{time}</time>
              <b>{title}</b>
              <span>{room}</span>
            </div>
          ))}
        </div>

        <nav className="proglinks rv" aria-label="Explore the AI Builders Summit">
          {EXPLORE.map(({ label, to }) => (
            <Link key={label} to={to}>
              {label} →
            </Link>
          ))}
        </nav>
      </section>

      {/* ── speaker portal demo ──────────────────────────────────────────── */}
      <section className="light">
        <div className="wrap split">
          <div className="card lite rv demo">
            <div className="chead">
              Speaker portal · Priya Raman<span className="end">4 of 6 complete</span>
            </div>
            {PORTAL_TASKS.map(([task, when, done], index) => (
              <div key={task} className="chk">
                <i
                  className={done ? 'on' : ''}
                  style={vars({ '--d': `${index * 0.12}s` })}
                  aria-hidden="true"
                >
                  {done ? '✓' : ''}
                </i>
                <b>{task}</b>
                <span>{when}</span>
              </div>
            ))}
            <div className="meter">
              <i />
            </div>
          </div>

          <div className="rv" style={vars({ '--d': '.15s' })}>
            <p className="eyebrow">Speaker portal</p>
            <h2 className="h2 serif">Speakers see one checklist. You see all eleven.</h2>
            <p className="lede">
              Bios, headshots, versioned content, and approvals live in one place, with every
              revision kept. Chase what&rsquo;s missing from the content matrix, or let scheduled
              reminders do it — each email naming only what that person still owes.
            </p>
            <div style={{ marginTop: 26 }}>{demoLink('See the speaker experience')}</div>
          </div>
        </div>
      </section>

      {/* ── open source + stack ──────────────────────────────────────────── */}
      <section className="wrap sect">
        <div className="split top">
          <div className="rv" data-testid="open-source-section">
            <p className="eyebrow">Community built</p>
            <h2 className="h2 serif sm">Open source</h2>
            <p className="lede" style={{ fontSize: 15 }}>
              SpeakerWeave is open source, so organizers and builders can inspect it, extend it, and
              help shape what comes next. MIT licensed from end to end. Fork it, self-host it, or
              contribute upstream.
            </p>
            <div style={{ marginTop: 22 }}>
              <a href={REPO_URL} aria-label="SpeakerWeave source repository" className="arrowlink">
                View the repository →
              </a>
            </div>
          </div>

          <div
            className="rv"
            data-testid="stack-section"
            style={vars({ '--d': '.1s' })}
          >
            <p className="eyebrow">Bring your own</p>
            <h2 className="h2 serif sm">The stack</h2>
            <dl className="stack">
              {STACK.map(({ name, role }) => (
                <div key={name} className="strow">
                  <dt>{name}</dt>
                  <dd>{role}</dd>
                </div>
              ))}
            </dl>
            <p className="note">
              Swap auth, email, hosting, or data providers without touching the domain core.
            </p>
          </div>
        </div>
      </section>

      {/* ── closing CTA ──────────────────────────────────────────────────── */}
      <section className="wrap" style={{ paddingBottom: 96 }}>
        <div className="cta rv">
          <div className="glow" aria-hidden="true" />
          <h2 className="serif">Running your own conference?</h2>
          <p>
            Organizers with an account can sign in to manage their events, review teams, and speaker
            program.
          </p>
          <div className="ctas">
            <Link to="/sign-in" className="btn d">
              Sign in with your account →
            </Link>
          </div>
        </div>
      </section>
    </SiteShell>
  )
}

/**
 * One time row of the agenda demo: the label, then a tile or an empty slot.
 * Tiles fly in on a 0.1s ladder counted over tiles, not cells, so the slots
 * don't leave gaps in the rhythm.
 */
function Row({
  time,
  cells,
  firstTile,
}: {
  time: string
  cells: Array<{ title: string; tone: string } | null>
  firstTile: number
}) {
  let tile = firstTile
  return (
    <>
      <div className="time">{time}</div>
      {cells.map((cell, column) => {
        if (!cell) return <div key={column} className="slot" />
        tile += 1
        return (
          <div
            key={column}
            className={`stile ${cell.tone}`}
            style={vars({ '--d': `${(tile * 0.2 - 0.1).toFixed(1)}s` })}
          >
            {cell.title}
          </div>
        )
      })}
    </>
  )
}
