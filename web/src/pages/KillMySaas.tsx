import { Link } from 'react-router-dom'
import {
  ArrowRight,
  BrainCircuit,
  Check,
  Cloud,
  Code2,
  Gauge,
  MessagesSquare,
  Plug,
  SquareTerminal,
  Table2,
  Workflow,
} from 'lucide-react'

import { DOCS_URL, REPO_URL } from '@/pages/Home'
import { BrandMark } from '@/ui/brand'

const EDGE_URL = 'https://speakerweave-web.brandon-c2f.workers.dev'

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
    icon: BrainCircuit,
    title: 'In-app chat agent',
    body: 'Streaming threads, @-mention any submission or speaker as context, clickable entity badges that navigate the app, and inline Approve/Deny gates before any sensitive action.',
  },
  {
    icon: Workflow,
    title: 'Hosted MCP server + OAuth 2.1',
    body: 'Remote Streamable HTTP at /mcp with discovery, dynamic client registration, and PKCE — add it to claude.ai or ChatGPT as a connector with just the URL.',
  },
  {
    icon: Plug,
    title: 'MCP connectors framework',
    body: 'The agent consumes external MCP servers too: Every ships as a preset, and any custom server joins via OAuth or bearer token, with external mutations behind the same approval gate.',
  },
  {
    icon: MessagesSquare,
    title: 'Slack agent bot',
    body: 'Signed mentions and DMs answered with live workspace data — the same organization-scoped tool layer as every other surface.',
  },
  {
    icon: SquareTerminal,
    title: 'sw CLI',
    body: 'pipx install, authenticate with an API token, and run conference operations — or `sw ask` the same agent — from any shell or script.',
  },
  {
    icon: Code2,
    title: 'REST API + published docs',
    body: 'A stable /v1 surface with org-scoped tokens, an interactive OpenAPI explorer, and a hosted documentation site generated from the real spec.',
  },
  {
    icon: Table2,
    title: 'Airtable sync',
    body: 'Per-organization credentials, auto-created Speakers and Submissions tables, keyed upserts, one-click sync.',
  },
  {
    icon: Gauge,
    title: 'AI triage with human overrides',
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

const STACK = [
  ['FastAPI + Python', 'API, MCP server, OAuth, outbox worker'],
  ['React 19 + Vite + Tailwind', 'SPA with route-level code splitting'],
  ['Supabase Postgres', 'Org-scoped data, RLS backstop, Storage'],
  ['Clerk', 'Organizer auth (dev-token flow without it)'],
  ['Resend', 'Transactional email + calendar invites'],
  ['Railway + Cloudflare', 'Reference hosting + live edge deployment'],
  ['OpenAI + Anthropic', 'Chat agent (either), AI triage'],
  ['Airtable', 'Team-facing sync'],
]

const NUMBERS = [
  ['96/96', 'published rubric items verified end to end, all 7 areas'],
  ['1,024 + 622', 'API and web tests, all green'],
  ['−52%', 'critical-path JS from the performance pass (180 kB gzip)'],
  ['5 surfaces', 'in-app agent, Slack, Claude, ChatGPT, CLI — one tool layer'],
]

const JUDGE_PATH = [
  ['Enter the demo', 'One click, no sign-up — a fully seeded conference workspace.', '/demo'],
  ['Review and decide', 'Open Submissions, read scores, accept a talk — the decision email and onboarding kick off automatically.', null],
  ['Build the agenda', 'Drag sessions into rooms, watch conflicts flag live, auto-place the rest, publish.', null],
  ['See the public program', 'Schedule, speaker gallery, embeds, and iCal — updated live.', '/e/ai-builders-summit/schedule'],
  ['Ask the agent', 'Click Ask, @-mention a speaker, ask what’s outstanding — approve an action when it asks.', null],
]

export function KillMySaas() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b border-border/80 bg-background/90">
        <div className="mx-auto flex h-16 max-w-6xl items-center gap-3 px-5 sm:px-8">
          <Link to="/" className="flex items-center gap-2.5" aria-label="SpeakerWeave home">
            <BrandMark className="h-8 w-8" />
            <span className="text-lg font-semibold tracking-tight text-foreground">speakerweave</span>
          </Link>
          <span className="ml-2 rounded-full border border-primary/25 bg-primary-subtle px-2.5 py-0.5 text-xs font-semibold text-primary">
            Kill My SaaS 1
          </span>
          <nav className="ml-auto flex items-center gap-1">
            <a
              href={REPO_URL}
              className="rounded-md px-3 py-1.5 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              GitHub
            </a>
            <a
              href={DOCS_URL}
              className="rounded-md px-3 py-1.5 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              Docs
            </a>
          </nav>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-5 py-14 sm:px-8">
        {/* Hero */}
        <section className="max-w-3xl">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-primary">
            The submission, on one page
          </p>
          <h1 className="mt-3 text-balance text-4xl font-semibold tracking-tight sm:text-5xl">
            A complete, open-source Sessionboard — then some.
          </h1>
          <p className="mt-5 text-pretty text-lg leading-8 text-muted-foreground">
            SpeakerWeave covers the full program lifecycle Sessionboard sells — CFP to published
            schedule — and keeps going: a built-in AI agent with approval gates, a hosted MCP
            server, a Slack bot, a CLI, a public API with hosted docs, and a provider-neutral
            architecture that runs on your keys and your infrastructure. Built end to end by AI
            coding agents. MIT licensed.
          </p>
          <div className="mt-7 flex flex-wrap items-center gap-3">
            <Link
              to="/demo"
              className="inline-flex items-center gap-2 rounded-md bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground shadow-raised transition-colors hover:bg-primary-strong"
            >
              Enter the demo workspace <ArrowRight className="h-4 w-4" />
            </Link>
            <a
              href={REPO_URL}
              className="inline-flex items-center gap-2 rounded-md border border-input bg-card px-5 py-2.5 text-sm font-semibold text-foreground transition-colors hover:bg-accent"
            >
              Read the source
            </a>
          </div>
        </section>

        {/* Numbers */}
        <section className="mt-14 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {NUMBERS.map(([n, label]) => (
            <div key={label} className="rounded-xl border border-border bg-card p-5">
              <p className="text-2xl font-semibold tracking-tight text-foreground">{n}</p>
              <p className="mt-1 text-sm leading-6 text-muted-foreground">{label}</p>
            </div>
          ))}
        </section>

        {/* Judge path */}
        <section className="mt-16">
          <h2 className="text-2xl font-semibold tracking-tight">Judge it in ten minutes</h2>
          <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
            No credentials anywhere — organizer, speaker, and reviewer roles are all reachable from
            the product itself.
          </p>
          <ol className="mt-6 grid gap-3">
            {JUDGE_PATH.map(([title, body, href], i) => (
              <li key={title} className="flex gap-4 rounded-xl border border-border bg-card p-4">
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary-subtle text-sm font-semibold text-primary">
                  {i + 1}
                </span>
                <div>
                  <p className="font-medium text-foreground">
                    {href ? (
                      <Link to={href} className="text-primary underline-offset-4 hover:underline">
                        {title}
                      </Link>
                    ) : (
                      title
                    )}
                  </p>
                  <p className="mt-0.5 text-sm leading-6 text-muted-foreground">{body}</p>
                </div>
              </li>
            ))}
          </ol>
        </section>

        {/* Parity + beyond */}
        <section className="mt-16 grid gap-8 lg:grid-cols-[1fr_1.6fr]">
          <div>
            <h2 className="text-2xl font-semibold tracking-tight">Everything Sessionboard does</h2>
            <ul className="mt-5 space-y-2.5">
              {PARITY.map((item) => (
                <li key={item} className="flex items-start gap-2.5 text-sm leading-6 text-muted-foreground">
                  <Check className="mt-1 h-4 w-4 shrink-0 text-success" />
                  {item}
                </li>
              ))}
            </ul>
          </div>
          <div>
            <h2 className="text-2xl font-semibold tracking-tight">And what it adds</h2>
            <div className="mt-5 grid gap-3 sm:grid-cols-2">
              {BEYOND.map(({ icon: Icon, title, body }) => (
                <article key={title} className="rounded-xl border border-border bg-card p-4">
                  <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary-subtle text-primary">
                    <Icon className="h-4 w-4" />
                  </span>
                  <h3 className="mt-3 text-sm font-semibold text-foreground">{title}</h3>
                  <p className="mt-1 text-[13px] leading-5 text-muted-foreground">{body}</p>
                </article>
              ))}
            </div>
          </div>
        </section>

        {/* Interoperability */}
        <section className="mt-16">
          <h2 className="text-2xl font-semibold tracking-tight">Interoperable by construction</h2>
          <div className="mt-5 grid gap-3 md:grid-cols-2">
            {INTEROP.map(({ title, body }) => (
              <article key={title} className="rounded-xl border border-border bg-card p-5">
                <h3 className="font-semibold text-foreground">{title}</h3>
                <p className="mt-1.5 text-sm leading-6 text-muted-foreground">{body}</p>
              </article>
            ))}
          </div>
        </section>

        {/* Stack + bonus */}
        <section className="mt-16 grid gap-8 md:grid-cols-2">
          <div>
            <h2 className="text-2xl font-semibold tracking-tight">Tech stack</h2>
            <dl className="mt-5 space-y-2.5">
              {STACK.map(([name, role]) => (
                <div key={name} className="flex items-baseline justify-between gap-4 border-b border-border/60 pb-2.5">
                  <dt className="text-sm font-medium text-foreground">{name}</dt>
                  <dd className="text-right text-sm text-muted-foreground">{role}</dd>
                </div>
              ))}
            </dl>
          </div>
          <div>
            <h2 className="text-2xl font-semibold tracking-tight">Competition bonuses</h2>
            <ul className="mt-5 space-y-3">
              <li className="flex items-start gap-3 text-sm leading-6">
                <Code2 className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                <span>
                  <strong>API</strong> — full /v1 REST + tokens, OpenAPI explorer, and{' '}
                  <a href={DOCS_URL} className="text-primary underline-offset-4 hover:underline">
                    hosted docs
                  </a>
                  ; plus a hosted MCP server Sessionboard doesn&rsquo;t have.
                </span>
              </li>
              <li className="flex items-start gap-3 text-sm leading-6">
                <Table2 className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                <span>
                  <strong>Airtable persistence</strong> — live per-org sync of speakers and
                  submissions into your base.
                </span>
              </li>
              <li className="flex items-start gap-3 text-sm leading-6">
                <Cloud className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                <span>
                  <strong>Cloudflare</strong> — the web tier runs live on{' '}
                  <a href={EDGE_URL} className="text-primary underline-offset-4 hover:underline">
                    Workers at the edge
                  </a>{' '}
                  from a one-command deploy in the repo.
                </span>
              </li>
              <li className="flex items-start gap-3 text-sm leading-6">
                <Gauge className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                <span>
                  <strong>Speed</strong> — 180 kB gzip critical path (−52% in one audited pass),
                  precompressed assets, edge Brotli, skeleton-first rendering.
                </span>
              </li>
              <li className="flex items-start gap-3 text-sm leading-6">
                <BrainCircuit className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                <span>
                  <strong>Built by coding agents</strong> — Claude orchestrating, Codex
                  implementing, with every gate green on every commit; the repo is tuned for the
                  next agent via AGENTS.md.
                </span>
              </li>
            </ul>
          </div>
        </section>

        {/* Links */}
        <section className="mt-16 rounded-2xl border border-border bg-card p-6">
          <h2 className="text-lg font-semibold tracking-tight">Everything, one click away</h2>
          <div className="mt-4 grid gap-2 text-sm sm:grid-cols-2 lg:grid-cols-3">
            {[
              ['Live demo', 'https://speakerweave.com/demo'],
              ['Source (MIT)', REPO_URL],
              ['Documentation', DOCS_URL],
              ['Edge deployment', EDGE_URL],
              ['Public schedule', 'https://speakerweave.com/e/ai-builders-summit/schedule'],
              ['API reference', 'https://speakerweave.com/developers'],
            ].map(([label, href]) => (
              <a
                key={label}
                href={href}
                className="flex items-center justify-between gap-2 rounded-lg border border-border/70 px-3.5 py-2.5 text-foreground transition-colors hover:bg-accent"
              >
                <span className="font-medium">{label}</span>
                <ArrowRight className="h-3.5 w-3.5 text-muted-foreground" />
              </a>
            ))}
          </div>
        </section>
      </main>

      <footer className="border-t border-border bg-card/60">
        <div className="mx-auto flex max-w-6xl items-center gap-2.5 px-5 py-6 text-sm text-muted-foreground sm:px-8">
          <BrandMark className="h-6 w-6" />
          Built for swyx&rsquo;s Kill My SaaS 1 · August 2026
        </div>
      </footer>
    </div>
  )
}
