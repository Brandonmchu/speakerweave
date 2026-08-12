/**
 * Judge-facing competition page (route: /killmysaas).
 *
 * A scoreboard, not a brochure. The argument runs: here is what the brief
 * asked for, here is the independent evaluation result, here is the parity
 * ledger against the SaaS, here is what goes past it, here are the bonuses,
 * and here is a ten-minute path to check all of it yourself.
 *
 * Ground rhythm follows the site's rule — ink for the argument, paper for the
 * evidence. The two long tables sit in `.light` bands because that is where
 * the product is being shown, and long tables read better on paper.
 *
 * Every number on this page came out of the repository or the eval run; none
 * of them are rounded up. Where a figure is quoted from a document rather than
 * measured here, the document is named next to it.
 */
import {
  ArrowLeftRight,
  Blocks,
  Bot,
  Cloud,
  Code2,
  Gauge,
  KeyRound,
  Network,
  Scale,
  Slack,
  Sparkles,
  Table2,
  Terminal,
  type LucideIcon,
} from 'lucide-react'
import { Link } from 'react-router-dom'

import { DOCS_URL, REPO_URL, SiteShell, vars } from '@/pages/siteShared'

import '../styles/site-competition.css'

const EDGE_URL = 'https://speakerweave-web.brandon-c2f.workers.dev'
const SCHEDULE_PATH = '/e/ai-builders-summit/schedule'
const SPEAKERS_PATH = '/e/ai-builders-summit/speakers'
const CFP_PATH = '/submit/call-for-speakers'
const CALENDAR_FEED = '/public/program/ai-builders-summit/calendar.ics'

/* ── hero facts ────────────────────────────────────────────────────────────
 * API 1,059 (pytest --collect-only) + web 632 (vitest list) + CLI 8 = 1,699. */
const NUMBERS: Array<[string, string]> = [
  ['100%', 'overall score on the final independent eval run, area-weighted'],
  ['7 / 7', 'areas at 100%, including the optional extra-credit area'],
  ['1,699', 'automated tests: 1,059 API · 632 web · 8 CLI'],
  ['5', 'agent surfaces on one tool layer — Ask, Slack, Claude, ChatGPT, sw'],
]

/* ── the evaluation ────────────────────────────────────────────────────────
 * Area weights, rubric-item counts and item weights are the harness's own,
 * from `research/14-eval-gap-analysis.md`. The six required areas sum to 100;
 * Speaker CRM is optional extra credit and sits outside that 100. */
type AreaRow = {
  area: string
  code: string
  weight: string
  items: number
  itemWeight: number
  note?: string
}

const AREAS: AreaRow[] = [
  { area: 'Call for Papers', code: 'CFP', weight: '20', items: 16, itemWeight: 34 },
  { area: 'Abstract Management', code: 'ABS', weight: '20', items: 14, itemWeight: 28 },
  { area: 'Speaker Management', code: 'SPK', weight: '15', items: 16, itemWeight: 33 },
  { area: 'Content Management', code: 'CNT', weight: '15', items: 14, itemWeight: 31 },
  { area: 'AI Agenda', code: 'AIA', weight: '10', items: 8, itemWeight: 18 },
  { area: 'Public Widgets', code: 'EMB', weight: '20', items: 16, itemWeight: 34 },
  {
    area: 'Speaker CRM',
    code: 'CRM',
    weight: '+10',
    items: 12,
    itemWeight: 19,
    note: 'optional · extra credit',
  },
]

const RUN_FACTS: Array<[string, string]> = [
  ['100 / 100', 'overall, area-weighted across the six required areas'],
  ['100%', 'coverage — every judgeable rubric item was reached and graded'],
  ['0', 'regressions against the previous run'],
  ['+10', 'extra credit: Speaker CRM, the optional area, also scored 100%'],
]

/* ── parity ────────────────────────────────────────────────────────────────
 * Rows 1–9 are the brief's nine core requirements, verbatim in intent. Rows
 * 10–12 come from the Sessionboard teardown — things the SaaS sells that the
 * brief never spelled out. */
type ParityRow = {
  asked: string
  ships: string
  where: string
  href?: string
}

const PARITY: ParityRow[] = [
  {
    asked: 'Custom submission forms with conditional logic and category routing',
    ships:
      'Multi-page builder over reusable contact and session fields, with show/hide/require rules on all-or-any matching plus routing rules. The rule engine ships twice — Python and TypeScript — against shared fixtures, so the live preview and the server enforcement cannot drift.',
    where: 'Call for Speakers',
    href: CFP_PATH,
  },
  {
    asked: 'Speaker portal for bios, headshots, slides, and documents',
    ships:
      'Cookie-scoped portal with no client-supplied identity: profile, headshot, socials, logistics fields, assigned tasks with due dates, file requests, immutable versions, approve / needs-changes review, and per-item comment threads.',
    where: 'Speaker portal',
    href: '/speaker-signin',
  },
  {
    asked: 'Automated communications including calendar invites (Gmail, Outlook, iCal)',
    ships:
      'Outbox-backed sending with retries and idempotency, templates with merge tags, audience targeting with a live recipient count, and one log row per recipient. Native calendar invitations, plus a subscribable feed of the whole published program.',
    where: 'Calendar feed',
    href: CALENDAR_FEED,
  },
  {
    asked: 'Evaluation workflows with optional AI-assisted review',
    ships:
      'Multiple rounds with open/close windows, weighted numeric, select and free-text criteria, per-round reviewer pools, track-aware and per-submission assignment, anonymised rounds, abstentions with reasons, a summary dashboard, and CSV export of scores. AI first-pass triage returns a score and a rationale that an organizer can override.',
    where: 'Evaluation',
  },
  {
    asked: 'Drag-and-drop scheduling with conflict detection and multiple view options',
    ships:
      'Multi-day room grid with drag-and-drop and a click-to-place fallback, live conflict detection for speaker double-booking and room overlap — the room rule backed by a Postgres gist exclusion constraint, not just a client check — List / Day / Week / Rooms / Conflicts views, and conflict-free auto-place.',
    where: 'Agenda',
  },
  {
    asked: 'Real-time dashboard for speaker onboarding status',
    ships:
      'Per-speaker by per-task deliverables matrix with due dates, outstanding-only filters, polling refresh, and reminders targeted at exactly the speakers who are behind rather than the whole roster.',
    where: 'Dashboard',
  },
  {
    asked: 'Accelevents integration to prevent manual data re-entry',
    ships:
      'No vendor connector, and no re-entry either: an accepted submission is the session, in one table, with its metadata intact. Everything else leaves through a stable /v1 REST API with organization-scoped tokens, read-only JSON program feeds, iCal, speaker CSV import and export, and Airtable sync.',
    where: 'Developers',
    href: '/developers',
  },
  {
    asked: 'Resource and wiki pages supporting HTML embeds',
    ships:
      'Organizer-authored rich text on speaker portals and on CFP forms, with the server as the authoritative sanitiser — script tags and inline event handlers are stripped before anything renders, and the API suite asserts it.',
    where: 'Portal',
  },
  {
    asked: 'Embeddable speaker gallery and schedule for websites',
    ships:
      'Public schedule and speaker pages, script and iframe snippets generated in Settings with track, accent-colour and compact-layout options, an auto-resizing embed loader, and the same data as read-only JSON feeds.',
    where: 'Public schedule',
    href: SCHEDULE_PATH,
  },
  {
    asked: 'Speaker CRM across events — the teardown’s year-round product',
    ships:
      'Organization-wide people directory with duplicate detection and merge, notes, tags, custom fields, saved segments that are stored as filters rather than frozen lists, cross-event history, and a Kanban sourcing pipeline.',
    where: 'Directory · Pipeline',
  },
  {
    asked: 'Change history with attribution and restore',
    ships:
      'Session title and description edits are recorded as revisions with attribution and can be restored from the submission drawer.',
    where: 'Submissions',
  },
  {
    asked: 'Reporting and export',
    ships:
      'Evaluation summary with per-session aggregates and reviewer-disagreement spread, CSV export of submissions and of review scores, speaker roster CSV in and out, and a ZIP bundle of the current version of every collected file.',
    where: 'Evaluation · Content',
  },
]

/* ── beyond parity ─────────────────────────────────────────────────────── */
type Beyond = {
  icon: LucideIcon
  tone?: string
  title: string
  kicker: string
  body: string
}

const BEYOND: Beyond[] = [
  {
    icon: Bot,
    tone: 'brand',
    title: 'In-app agent with approval gates',
    kicker: 'Ask',
    body: 'Streaming threads on every organizer page. @-mention any submission, speaker or session as context; entity badges route back into the app; and anything sensitive — email, decision, publish, delete — stops at an inline Approve / Deny gate before it runs.',
  },
  {
    icon: Network,
    tone: 'mcp',
    title: 'Hosted MCP server with OAuth 2.1',
    kicker: '14 tools',
    body: 'Remote Streamable HTTP at /mcp with 14 tools and 3 resources. Protected-resource discovery, dynamic client registration and authorization code with PKCE, so claude.ai or a ChatGPT connector needs the URL and nothing else. Header-capable clients can use a bearer token instead.',
  },
  {
    icon: Blocks,
    title: 'MCP connectors, inbound',
    kicker: 'External tools',
    body: 'The agent consumes external MCP servers as well as exposing one. Every ships as a preset; any other server joins over OAuth or a bearer token; and external mutations pass through the same approval gate as internal ones.',
  },
  {
    icon: Slack,
    title: 'Slack agent',
    kicker: 'Team surface',
    body: 'Registered as a Slack Agent, not a webhook toy: signed Events and Interactivity on one URL, the same organization-scoped tools and connectors, native Approve and Deny buttons, and Slack threads mapped into Ask history so both surfaces share one conversation.',
  },
  {
    icon: Terminal,
    tone: 'cli',
    title: 'sw command-line client',
    kicker: 'Terminal',
    body: 'A separate Python package with its own test gate. pipx install, sw auth login with an organization token, then decisions, speaker CSV import, scheduling, content reminders, triage — or sw ask, which is the same agent from a shell script.',
  },
  {
    icon: Code2,
    title: 'REST API and hosted documentation',
    kicker: '25 endpoints',
    body: 'A stable /v1 surface with organization-scoped tokens stored only as SHA-256 hashes, an in-app reference with copyable curl, the generated OpenAPI explorer on the API service, and a hosted documentation site. The brief pointed at Sessionboard’s own docs site; this is the same thing, open.',
  },
  {
    icon: Table2,
    title: 'Airtable sync',
    kicker: 'Persistence',
    body: 'Per-organization credentials held server-side and masked, Speakers and Submissions tables created on demand, and keyed upserts — speakers by email, submissions by friendly ID — so a sync can run twice without duplicating a row.',
  },
  {
    icon: Sparkles,
    title: 'AI triage with human overrides',
    kicker: 'Review',
    body: 'A first pass over the submission pool that returns a score and a written rationale, ranks the field, and falls back to reviewer-score heuristics with no provider key. Organizer overrides persist and win.',
  },
  {
    icon: ArrowLeftRight,
    title: 'Provider-neutral by construction',
    kicker: 'No lock-in',
    body: 'One agent runtime behind one service boundary, running on the OpenAI Agents SDK or on Claude by environment variable, with the same tools, event protocol and permission gate. Database, auth, email, hosting and AI are each a documented swap point with its invariants written down in AGENTS.md.',
  },
  {
    icon: Scale,
    title: 'MIT licence, and a repo built to be forked',
    kicker: 'Open source',
    body: '19 ordered, re-runnable migrations, a deterministic demo seed, four named quality gates, and an AGENTS.md that hands the next coding agent the map, the invariants and a starter prompt for standing it up on someone else’s stack.',
  },
]

/* ── bonuses ───────────────────────────────────────────────────────────── */
type Bonus = {
  icon: LucideIcon
  title: string
  body: string
  linkLabel?: string
  href?: string
  to?: string
}

const BONUSES: Bonus[] = [
  {
    icon: Cloud,
    title: 'Cloudflare deployment',
    body: 'The web tier ships as a Cloudflare Worker as well as an nginx image: static assets from the edge with Brotli and SPA fallback, and the identical /api, /public, /mcp and OAuth proxy contract, SSE chat streaming included. wrangler.jsonc and worker/index.js are in the repo; npm run build && npx wrangler deploy is the whole deployment.',
    linkLabel: 'Live at the edge',
    href: EDGE_URL,
  },
  {
    icon: Table2,
    title: 'Airtable persistence',
    body: 'Configured per organization in Settings → Integrations with a masked, server-side token. SpeakerWeave creates the Speakers and Submissions tables if the token carries schema scope, then upserts speakers by email and submissions by friendly ID. Environment credentials are a fallback for the demo org only.',
  },
  {
    icon: Gauge,
    title: 'Speed',
    body: '24 route modules load lazily behind structural skeletons; the agent runtime and its Markdown stack are separate chunks that never appear in the entry HTML and stay absent while the feature is off; every build gzips its own assets; and the Cloudflare edge adds Brotli on top. The repo’s audit, PERF_FINDINGS.md, records the critical-path chain falling from 375 kB to 180 kB gzip in that pass.',
    linkLabel: 'PERF_FINDINGS.md',
    href: `${REPO_URL}/blob/main/PERF_FINDINGS.md`,
  },
  {
    icon: KeyRound,
    title: 'API',
    body: '25 documented /v1 endpoints over events, submissions, speakers, schedules, taxonomies, content status and evaluation summaries, authenticated by organization-scoped tokens shown once and stored hashed. Cross-organization reads return 404, not 403. Plus the generated OpenAPI explorer, hosted docs, and the MCP server for agent clients.',
    linkLabel: 'API reference',
    to: '/developers',
  },
]

/* ── the ten-minute path ───────────────────────────────────────────────── */
const JUDGE_PATH: Array<{ title: string; body: string; to?: string; tag: string }> = [
  {
    title: 'Enter the demo workspace',
    body: 'One click, no sign-up, no email code. A fully seeded conference — AI Builders Summit 2026 — with submissions, reviews, speakers, tasks and a partly built agenda already in it.',
    to: '/demo',
    tag: 'open',
  },
  {
    title: 'Submit a talk as a stranger',
    body: 'The public call for papers: anonymous, deadline shown, conditional questions that appear as you answer, server-side validation, and a manage link back to your own submission afterwards.',
    to: CFP_PATH,
    tag: 'open',
  },
  {
    title: 'Review it and decide',
    body: 'Submissions → open a proposal → reviewer scores, comments and the AI triage rationale in one panel. Accept it: the decision email is queued, sent and logged per recipient, and the talk becomes a schedulable session with no re-entry.',
    tag: 'in app',
  },
  {
    title: 'Break the agenda on purpose',
    body: 'Agenda → drag a session onto a slot a speaker is already in. The ghost turns red before you drop it, the banner names both sessions, and the Conflicts tab counts up. Move it back and the warning clears without a reload. Then Auto-place the rest.',
    tag: 'in app',
  },
  {
    title: 'Read the published program',
    body: 'The public schedule and speaker gallery, signed out, updating from the same rows the organizer just edited. Embed snippets, JSON feeds and the iCal feed come off the same surface.',
    to: SCHEDULE_PATH,
    tag: 'open',
  },
  {
    title: 'Ask the agent to do something it should not',
    body: 'Open Ask, @-mention a submission, and tell it to email the speaker. It stops and asks — Approve or Deny — before anything leaves the building. The same gate applies in Slack and over MCP.',
    tag: 'in app',
  },
  {
    title: 'Call it as software',
    body: 'The developer reference: 25 REST endpoints with copyable curl, the token model, and the hosted MCP server with the exact JSON to paste into a client.',
    to: '/developers',
    tag: 'open',
  },
]

const LINKS: Array<[string, string]> = [
  ['Live demo', 'https://speakerweave.com/demo'],
  ['Source (MIT)', REPO_URL],
  ['Documentation', DOCS_URL],
  ['API reference', 'https://speakerweave.com/developers'],
  ['Cloudflare edge deployment', EDGE_URL],
  ['Public schedule', `https://speakerweave.com${SCHEDULE_PATH}`],
]

export function KillMySaas() {
  return (
    <SiteShell badge="Kill My SaaS 1">
      {/* ── hero ───────────────────────────────────────────────────────── */}
      <section className="wrap hero" style={{ display: 'block', paddingTop: 34 }}>
        <div className="rv in">
          <p className="eyebrow">The submission · SpeakerWeave</p>
          <h1 className="h1 serif" style={{ maxWidth: '19ch' }}>
            100% on the independent evaluation. All seven areas.
          </h1>
          <p className="lede" style={{ maxWidth: '74ch' }}>
            The brief: clone Sessionboard — the $40,000-a-year conference platform swyx&rsquo;s team
            was quoted for — in a weekend, open source and deployed, then let the AI Engineer
            team&rsquo;s own evaluation harness grade it. SpeakerWeave is that clone. It answers all
            nine core requirements, took every bonus on the list, and adds an agent layer, a public
            API and a hosted MCP server the SaaS does not have.
          </p>
          <div className="ctas">
            <Link to="/demo" className="btn p">
              Enter the demo workspace →
            </Link>
            <a href={REPO_URL} className="btn t">
              Read the source →
            </a>
          </div>

          <div className="statline">
            {NUMBERS.map(([value, label]) => (
              <div key={label}>
                <b>{value}</b>
                <span>{label}</span>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── the evaluation ─────────────────────────────────────────────── */}
      <section className="light">
        <div className="wrap">
          <div className="rv">
            <p className="eyebrow">The evaluation</p>
            <h2 className="h2 serif">Every area scored 100.</h2>
            <p className="lede">
              The harness drives a headless browser agent through 20 scenarios against the deployed
              app, then hands a separate judge the rubric, the transcript and the screenshots. The
              judge has to cite evidence for every verdict — it is told outright that a form
              existing is not proof submission works.
            </p>
          </div>

          <div className="tablewrap rv" style={vars({ '--d': '.06s' })}>
            <table className="doctable">
              <thead>
                <tr>
                  <th>Area</th>
                  <th>Code</th>
                  <th className="n">Area weight</th>
                  <th className="n">Rubric items</th>
                  <th className="n">Item weight</th>
                  <th>Score</th>
                </tr>
              </thead>
              <tbody>
                {AREAS.map((row) => (
                  <tr key={row.code}>
                    <td className="area">
                      {row.area}
                      {row.note && <em>{row.note}</em>}
                    </td>
                    <td>
                      <code>{row.code}</code>
                    </td>
                    <td className="n">{row.weight}</td>
                    <td className="n">{row.items}</td>
                    <td className="n">{row.itemWeight}</td>
                    <td className="score dotted d-acc">100%</td>
                  </tr>
                ))}
                <tr className="sum">
                  <td className="area">Overall</td>
                  <td />
                  <td className="n">100</td>
                  <td className="n">96</td>
                  <td className="n">197</td>
                  <td className="score dotted d-acc">100%</td>
                </tr>
              </tbody>
            </table>
          </div>

          <div className="statline rv" style={vars({ '--d': '.1s' })}>
            {RUN_FACTS.map(([value, label]) => (
              <div key={label}>
                <b>{value}</b>
                <span>{label}</span>
              </div>
            ))}
          </div>

          <div className="callout rv" style={vars({ '--d': '.14s' })}>
            <b>How the harness scores.</b>
            <p className="btext">
              Each rubric item is graded pass (1.0), partial (0.5) or fail (0); items the judge
              genuinely cannot judge are excluded from the denominator rather than forgiven. An area
              score is earned weight divided by judgeable weight. The overall score is the
              area-weighted mean of the six required areas, whose weights sum to 100. If less than
              60% of the area-weighted rubric weight is reached, the score is withheld entirely
              instead of reported low — which is why 100% coverage sits on the board next to the
              100% score.
            </p>
          </div>

          <p className="note">
            96 rubric items across 20 scenarios and 197 weighted points. Speaker CRM is the
            optional extra-credit area: its weight sits outside the required 100 and cannot dilute
            it, and it scored 100 as well.
          </p>
        </div>
      </section>

      {/* ── parity ─────────────────────────────────────────────────────── */}
      <section className="light seam">
        <div className="wrap">
          <div className="rv">
            <p className="eyebrow">Parity</p>
            <h2 className="h2 serif">Everything the SaaS was quoted for.</h2>
            <p className="lede">
              The first nine rows are the brief&rsquo;s core requirements. The last three come from
              the Sessionboard teardown — things the product sells that the brief never spelled out.
              Every row is open in the demo right now.
            </p>
          </div>

          <div className="tablewrap rv" style={vars({ '--d': '.06s' })}>
            <table className="doctable">
              <thead>
                <tr>
                  <th>What the brief and the SaaS specify</th>
                  <th>What SpeakerWeave ships</th>
                  <th>Where</th>
                </tr>
              </thead>
              <tbody>
                {PARITY.map((row) => (
                  <tr key={row.asked}>
                    <td className="said">{row.asked}</td>
                    <td>{row.ships}</td>
                    <td className="where">
                      {row.href ? (
                        row.href.startsWith('/public') ? (
                          <a href={row.href}>{row.where}</a>
                        ) : (
                          <Link to={row.href}>{row.where}</Link>
                        )
                      ) : (
                        row.where
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <p className="note">
            Rows without a public link live behind the demo workspace, which opens in one click at{' '}
            <Link to="/demo">/demo</Link> — no account, no email code.
          </p>
        </div>
      </section>

      {/* ── beyond ─────────────────────────────────────────────────────── */}
      <section className="wrap sect">
        <div className="rv">
          <p className="eyebrow">Beyond it</p>
          <h2 className="h2 serif">Ten things the SaaS does not do.</h2>
          <p className="lede">
            Parity was the requirement. These are the reasons to keep running it after the
            competition ends.
          </p>
        </div>
        <div style={{ marginTop: 30 }}>
          {BEYOND.map(({ icon: Icon, tone, title, kicker, body }, index) => (
            <div
              key={title}
              className="srow rv"
              style={vars({ '--d': `${Math.min(index, 5) * 0.05}s` })}
            >
              <span className={`ico${tone ? ` ${tone}` : ''}`} aria-hidden="true">
                <Icon strokeWidth={1.75} />
              </span>
              <h3>{title}</h3>
              <em>{kicker}</em>
              <p>{body}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ── bonuses ────────────────────────────────────────────────────── */}
      <section className="light">
        <div className="wrap">
          <div className="rv">
            <p className="eyebrow">Bonuses</p>
            <h2 className="h2 serif">All four, built rather than claimed.</h2>
            <p className="lede">
              The brief lists its technical preferences as bonuses, not requirements. Each one below
              is running in the deployment you can open from this page.
            </p>
          </div>
          <div style={{ marginTop: 30 }}>
            {BONUSES.map(({ icon: Icon, title, body, linkLabel, href, to }, index) => (
              <div key={title} className="srow rv" style={vars({ '--d': `${index * 0.06}s` })}>
                <span className="ico" aria-hidden="true">
                  <Icon strokeWidth={1.75} />
                </span>
                <h3>{title}</h3>
                <em className="dotted d-acc">shipped</em>
                <p>
                  {body}
                  {linkLabel && (href || to) && (
                    <>
                      {' '}
                      {to ? <Link to={to}>{linkLabel} →</Link> : <a href={href}>{linkLabel} →</a>}
                    </>
                  )}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── verify ─────────────────────────────────────────────────────── */}
      <section className="wrap sect">
        <div className="rv">
          <p className="eyebrow">Ten minutes</p>
          <h2 className="h2 serif">Check it yourself, without a credential.</h2>
          <p className="lede">
            Organizer, speaker, reviewer and submitter are all reachable from the product. Nothing
            below needs a password, an invitation or an email code.
          </p>
        </div>
        <div className="numtop" style={{ marginTop: 34 }}>
          {JUDGE_PATH.map(({ title, body, to, tag }, index) => (
            <div key={title} className="num rv" style={vars({ '--d': `${index * 0.05}s` })}>
              <em aria-hidden="true">{String(index + 1).padStart(2, '0')}</em>
              <div>
                <h3>{to ? <Link to={to}>{title}</Link> : title}</h3>
                <p>{body}</p>
              </div>
              <span>{tag}</span>
            </div>
          ))}
        </div>
        <p className="note">
          Also public without an account: the speaker gallery at{' '}
          <Link to={SPEAKERS_PATH}>{SPEAKERS_PATH}</Link> and the speaker sign-in at{' '}
          <Link to="/speaker-signin">/speaker-signin</Link>.
        </p>
      </section>

      {/* ── links ──────────────────────────────────────────────────────── */}
      <section className="wrap" style={{ paddingBottom: 96 }}>
        <div className="rv">
          <p className="eyebrow">Everything, one click away</p>
          <div className="linkgrid">
            {LINKS.map(([label, href]) => (
              <a key={label} href={href}>
                <span>{label}</span>
                <span aria-hidden="true">→</span>
              </a>
            ))}
          </div>
          <p className="note" style={{ marginTop: 26 }}>
            Built for swyx&rsquo;s Kill My SaaS 1 · August 2026 · MIT licensed · human product
            direction with AI agents implementing, reviewing and testing
          </p>
        </div>
      </section>
    </SiteShell>
  )
}
