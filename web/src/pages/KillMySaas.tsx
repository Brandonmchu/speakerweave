/**
 * Judge-facing competition page (route: /killmysaas).
 *
 * The submission on one page, in the public site's language: ink ground, serif
 * headings, mono for anything the system counted. No demo cards here — the
 * whole page is an argument, and the product itself is one click away.
 */
import { Link } from 'react-router-dom'

import { DOCS_URL, REPO_URL, SiteShell, vars } from '@/pages/siteShared'

const EDGE_URL = 'https://speakerweave-web.brandon-c2f.workers.dev'

const NUMBERS: Array<[string, string]> = [
  ['96/96', 'published rubric items verified end to end, all 7 areas'],
  ['1,024 + 622', 'API and web tests, all green'],
  ['−52%', 'critical-path JS from the performance pass (180 kB gzip)'],
  ['5 surfaces', 'in-app agent, Slack, Claude, ChatGPT, CLI — one tool layer'],
]

const JUDGE_PATH: Array<[string, string, string | null]> = [
  ['Enter the demo', 'One click, no sign-up — a fully seeded conference workspace.', '/demo'],
  [
    'Review and decide',
    'Open Submissions, read scores, accept a talk — the decision email and onboarding kick off automatically.',
    null,
  ],
  [
    'Build the agenda',
    'Drag sessions into rooms, watch conflicts flag live, auto-place the rest, publish.',
    null,
  ],
  [
    'See the public program',
    'Schedule, speaker gallery, embeds, and iCal — updated live.',
    '/e/ai-builders-summit/schedule',
  ],
  [
    'Ask the agent',
    'Click Ask, @-mention a speaker, ask what’s outstanding — approve an action when it asks.',
    null,
  ],
]

const PARITY = [
  'Custom submission forms with conditional logic and routing',
  'Anonymized, weighted, multi-round review with committees',
  'Decision emails and one-click speaker onboarding',
  'Speaker portals: bios, headshots, versioned content, approvals',
  'Drag-and-drop agenda with live conflict detection and auto-place',
  'Public schedule and speaker pages, embeds, JSON and iCal feeds',
  'Cross-event speaker CRM: dedupe, merge, segments, pipeline',
]

const BEYOND = [
  {
    title: 'In-app chat agent',
    kicker: 'Built in',
    body: 'Streaming threads, @-mention any submission or speaker as context, clickable entity badges that navigate the app, and inline Approve/Deny gates before any sensitive action.',
  },
  {
    title: 'Hosted MCP server + OAuth 2.1',
    kicker: 'Any client',
    body: 'Remote Streamable HTTP at /mcp with discovery, dynamic client registration, and PKCE — add it to claude.ai or ChatGPT as a connector with just the URL.',
  },
  {
    title: 'MCP connectors framework',
    kicker: 'Inbound tools',
    body: 'The agent consumes external MCP servers too: Every ships as a preset, and any custom server joins via OAuth or bearer token, with external mutations behind the same approval gate.',
  },
  {
    title: 'Slack agent bot',
    kicker: 'Team surface',
    body: 'The in-app agent in Slack: same organization-scoped tools and MCP connectors, native Approve/Deny buttons for sensitive actions, and shared Ask thread history.',
  },
  {
    title: 'sw CLI',
    kicker: 'Terminal',
    body: 'pipx install, authenticate with an API token, and run conference operations — or `sw ask` the same agent — from any shell or script.',
  },
  {
    title: 'REST API + published docs',
    kicker: 'Integration',
    body: 'A stable /v1 surface with org-scoped tokens, an interactive OpenAPI explorer, and a hosted documentation site generated from the real spec.',
  },
  {
    title: 'Airtable sync',
    kicker: 'Persistence',
    body: 'Per-organization credentials, auto-created Speakers and Submissions tables, keyed upserts, one-click sync.',
  },
  {
    title: 'AI triage with human overrides',
    kicker: 'Review',
    body: 'First-pass ranking of submissions with rationale, deliberate abstentions, and organizer overrides that persist.',
  },
]

const INTEROP = [
  {
    title: 'OpenAI ⇄ Anthropic',
    body: 'The chat agent is provider-neutral: one env switch selects the OpenAI Agents SDK (gpt-5.6 at high reasoning) or Claude. Same tools, same streaming protocol, same UI. No key at all → the entire feature stays dormant.',
  },
  {
    title: 'Railway ⇄ Cloudflare',
    body: 'Both web tiers ship in the repo and run live: the nginx reference on Railway, and a Cloudflare Worker serving the same SPA from the edge with identical proxy and SSE behavior.',
  },
  {
    title: 'Bring-your-own everything',
    body: 'Database (PostgREST/Supabase), auth (Clerk or token issuer), email (Resend behind one boundary), hosting, and AI are all documented swap points with their invariants spelled out in AGENTS.md.',
  },
  {
    title: 'Built to be adopted by agents',
    body: 'AGENTS.md gives a coding agent the repo map, security invariants, and the four quality gates — plus a starter prompt for wiring SpeakerWeave into an organization’s own stack.',
  },
]

const STACK: Array<[string, string]> = [
  ['FastAPI + Python', 'API, MCP server, OAuth, outbox worker'],
  ['React 19 + Vite + Tailwind', 'SPA with route-level code splitting'],
  ['Supabase Postgres', 'Org-scoped data, RLS backstop, Storage'],
  ['Clerk', 'Organizer auth (dev-token flow without it)'],
  ['Resend', 'Transactional email + calendar invites'],
  ['Railway + Cloudflare', 'Reference hosting + live edge deployment'],
  ['OpenAI + Anthropic', 'Chat agent (either), AI triage'],
  ['Airtable', 'Team-facing sync'],
]

export function KillMySaas() {
  return (
    <SiteShell badge="Kill My SaaS 1">
      {/* ── hero ─────────────────────────────────────────────────────────── */}
      <section className="wrap hero" style={{ display: 'block', paddingTop: 34 }}>
        <div className="rv in">
          <p className="eyebrow">The submission, on one page</p>
          <h1 className="h1 serif" style={{ maxWidth: '20ch' }}>
            A complete, open-source Sessionboard — then some.
          </h1>
          <p className="lede" style={{ maxWidth: '72ch' }}>
            SpeakerWeave covers the full program lifecycle Sessionboard sells — CFP to published
            schedule — and keeps going: a built-in AI agent with approval gates, a hosted MCP
            server, a Slack bot, a CLI, a public API with hosted docs, and a provider-neutral
            architecture that runs on your keys and your infrastructure. Built end to end by AI
            coding agents. MIT licensed.
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

      {/* ── judge path ───────────────────────────────────────────────────── */}
      <section className="wrap sect">
        <div className="rv">
          <p className="eyebrow">Ten minutes</p>
          <h2 className="h2 serif">Judge it without a single credential.</h2>
          <p className="lede">
            Organizer, speaker, and reviewer roles are all reachable from the product itself.
          </p>
        </div>
        <div className="numtop" style={{ marginTop: 36 }}>
          {JUDGE_PATH.map(([title, body, href], index) => (
            <div key={title} className="num rv" style={vars({ '--d': `${index * 0.06}s` })}>
              <em aria-hidden="true">{String(index + 1).padStart(2, '0')}</em>
              <div>
                <h3>{href ? <Link to={href}>{title}</Link> : title}</h3>
                <p>{body}</p>
              </div>
              <span>{href ? 'open' : 'in app'}</span>
            </div>
          ))}
        </div>
      </section>

      {/* ── parity ───────────────────────────────────────────────────────── */}
      <section className="light">
        <div className="wrap split top">
          <div className="rv">
            <p className="eyebrow">Parity</p>
            <h2 className="h2 serif">Everything Sessionboard does.</h2>
            <ul className="checklist">
              {PARITY.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </div>
          <div className="rv" style={vars({ '--d': '.1s' })}>
            <p className="eyebrow">Beyond</p>
            <h2 className="h2 serif">And what it adds.</h2>
            <div style={{ marginTop: 8 }}>
              {BEYOND.map(({ title, kicker, body }) => (
                <div key={title} className="srow">
                  <h3>{title}</h3>
                  <p>{body}</p>
                  <em>{kicker}</em>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* ── interoperability ─────────────────────────────────────────────── */}
      <section className="wrap sect">
        <div className="rv">
          <p className="eyebrow">No lock-in</p>
          <h2 className="h2 serif">Interoperable by construction.</h2>
        </div>
        <div className="grid2 prose rv" style={vars({ '--d': '.1s' })}>
          {INTEROP.map(({ title, body }) => (
            <div key={title}>
              <h3>{title}</h3>
              <p>{body}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ── stack + bonuses ──────────────────────────────────────────────── */}
      <section className="wrap sect" style={{ paddingTop: 0 }}>
        <div className="split top">
          <div className="rv">
            <p className="eyebrow">Under the hood</p>
            <h2 className="h2 serif sm">Tech stack</h2>
            <dl className="stack">
              {STACK.map(([name, role]) => (
                <div key={name} className="strow">
                  <dt>{name}</dt>
                  <dd>{role}</dd>
                </div>
              ))}
            </dl>
          </div>

          <div className="rv" style={vars({ '--d': '.1s' })}>
            <p className="eyebrow">Rubric</p>
            <h2 className="h2 serif sm">Competition bonuses</h2>
            <ul className="checklist">
              <li>
                <span>
                  <strong>API</strong> — full /v1 REST + tokens, OpenAPI explorer, and{' '}
                  <a href={DOCS_URL}>hosted docs</a>; plus a hosted MCP server Sessionboard
                  doesn&rsquo;t have.
                </span>
              </li>
              <li>
                <span>
                  <strong>Airtable persistence</strong> — live per-org sync of speakers and
                  submissions into your base.
                </span>
              </li>
              <li>
                <span>
                  <strong>Cloudflare</strong> — the web tier runs live on{' '}
                  <a href={EDGE_URL}>Workers at the edge</a> from a one-command deploy in the repo.
                </span>
              </li>
              <li>
                <span>
                  <strong>Speed</strong> — 180 kB gzip critical path (−52% in one audited pass),
                  precompressed assets, edge Brotli, skeleton-first rendering.
                </span>
              </li>
              <li>
                <span>
                  <strong>Built by coding agents</strong> — Claude orchestrating, Codex
                  implementing, with every gate green on every commit; the repo is tuned for the
                  next agent via AGENTS.md.
                </span>
              </li>
            </ul>
          </div>
        </div>
      </section>

      {/* ── links ────────────────────────────────────────────────────────── */}
      <section className="wrap" style={{ paddingBottom: 96 }}>
        <div className="rv">
          <p className="eyebrow">Everything, one click away</p>
          <div className="linkgrid">
            {[
              ['Live demo', 'https://speakerweave.com/demo'],
              ['Source (MIT)', REPO_URL],
              ['Documentation', DOCS_URL],
              ['Edge deployment', EDGE_URL],
              ['Public schedule', 'https://speakerweave.com/e/ai-builders-summit/schedule'],
              ['API reference', 'https://speakerweave.com/developers'],
            ].map(([label, href]) => (
              <a key={label} href={href}>
                <span>{label}</span>
                <span aria-hidden="true">→</span>
              </a>
            ))}
          </div>
          <p className="note" style={{ marginTop: 26 }}>
            Built for swyx&rsquo;s Kill My SaaS 1 · August 2026
          </p>
        </div>
      </section>
    </SiteShell>
  )
}
