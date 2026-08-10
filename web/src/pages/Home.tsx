import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import {
  ArrowRight,
  CalendarDays,
  Check,
  ClipboardList,
  Code2,
  Copy,
  ExternalLink,
  MessagesSquare,
  Star,
  Users,
} from 'lucide-react'

import { setToken } from '@/lib/api'
import { fetchDemoToken } from '@/lib/demoApi'
import {
  CFP_FORM_URL,
  DEVELOPERS_URL,
  featuredScheduleUrl,
  featuredSpeakersUrl,
} from '@/lib/featuredEvent'
import { Button } from '@/ui/button'

export const REPO_URL = 'https://github.com/Brandonmchu/speakerweave'

const HIGHLIGHTS = [
  {
    icon: ClipboardList,
    title: 'Review submissions',
    body: 'Triage the CFP inbox — accept, decline, and dig into every proposal.',
  },
  {
    icon: CalendarDays,
    title: 'Build the agenda',
    body: 'Schedule sessions across rooms and tracks, conflicts flagged in real time.',
  },
  {
    icon: Star,
    title: 'Score & onboard speakers',
    body: 'Run the evaluation plan, then walk accepted speakers through their tasks.',
  },
]

/** Crawlable links to the public conference surfaces. Plain in-app routes so a
 *  browser agent reading `href`s can discover every public page. */
const EXPLORE = [
  { icon: CalendarDays, label: 'Schedule', to: featuredScheduleUrl },
  { icon: Users, label: 'Speakers', to: featuredSpeakersUrl },
  { icon: MessagesSquare, label: 'Call for Speakers', to: CFP_FORM_URL },
  { icon: Code2, label: 'Developers / API', to: DEVELOPERS_URL },
]

const STACK = [
  { name: 'FastAPI', role: 'typed API and hosted MCP server' },
  { name: 'React + Vite', role: 'fast, focused web interface' },
  { name: 'Supabase (Postgres)', role: 'durable program data' },
  { name: 'Clerk', role: 'organizer authentication' },
  { name: 'Resend', role: 'transactional speaker email' },
  { name: 'Railway', role: 'application hosting' },
]

function CopyConfigButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false)

  return (
    <button
      type="button"
      aria-label={label}
      className="inline-flex items-center gap-1.5 rounded-md border border-white/15 bg-white/10 px-2.5 py-1.5 text-xs font-medium text-white transition-colors hover:bg-white/15 active:scale-[0.98]"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value)
          setCopied(true)
        } catch {
          // The code block remains selectable when the Clipboard API is unavailable.
        }
      }}
    >
      {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
      {copied ? 'Copied' : 'Copy'}
    </button>
  )
}

/**
 * Public marketing landing (routes: `/` when unauthenticated, and `/demo`).
 *
 * Two jobs:
 *  1. Get an organizer (or an eval agent) into the app in one click. Every
 *     primary CTA fetches a short-lived demo token, stores it via setToken(),
 *     and drops straight into the workspace — no Clerk sign-up required.
 *  2. Expose the public conference pages (schedule, speakers, CFP, API docs) as
 *     real, crawlable <a> links so they're discoverable without a guessed slug.
 *
 * Real organizers can still head to /sign-in for their own Clerk account.
 */
export function Home() {
  const navigate = useNavigate()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const mcpEndpoint = `${window.location.origin}/mcp`
  const aiApps = [
    {
      title: 'Add to Claude',
      steps: [
        `In claude.ai or Claude for Work, add a custom connector with URL ${mcpEndpoint}.`,
        'Authorize when prompted with an API token from Settings.',
        'For clients that support custom headers, use the power-user JSON below.',
      ],
      config: JSON.stringify(
        {
          mcpServers: {
            speakerweave: {
              type: 'http',
              url: mcpEndpoint,
              headers: { Authorization: 'Bearer YOUR_API_TOKEN' },
            },
          },
        },
        null,
        2,
      ),
    },
    {
      title: 'Add to ChatGPT',
      steps: [
        `In ChatGPT, add a custom connector with URL ${mcpEndpoint}.`,
        'Authorize when prompted with an API token from Settings.',
        'For clients that support custom headers, use the power-user JSON below.',
      ],
      config: JSON.stringify(
        {
          name: 'SpeakerWeave',
          url: mcpEndpoint,
          headers: { Authorization: 'Bearer YOUR_API_TOKEN' },
        },
        null,
        2,
      ),
    },
  ]

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

  return (
    <div className="min-h-screen bg-background">
      {/* ── top nav ──────────────────────────────────────────────────────── */}
      <header className="border-b border-border">
        <div className="mx-auto flex h-14 max-w-5xl items-center gap-4 px-4 sm:px-6">
          <Link to="/" className="flex items-center gap-2" aria-label="dais home">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-sm font-semibold text-primary-foreground">
              d
            </div>
            <span className="text-lg font-semibold tracking-tight text-foreground">dais</span>
          </Link>

          <nav className="ml-auto hidden items-center gap-1 sm:flex">
            <Link
              to={featuredScheduleUrl}
              className="rounded-md px-3 py-1.5 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              Schedule
            </Link>
            <Link
              to={featuredSpeakersUrl}
              className="rounded-md px-3 py-1.5 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              Speakers
            </Link>
            <Link
              to={CFP_FORM_URL}
              className="rounded-md px-3 py-1.5 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              Call for Speakers
            </Link>
            <Link
              to={DEVELOPERS_URL}
              className="rounded-md px-3 py-1.5 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              Developers
            </Link>
          </nav>

          <Link
            to="/speaker-signin"
            className="ml-auto rounded-md px-3 py-1.5 text-sm font-medium text-primary transition-colors hover:bg-primary-subtle sm:ml-2"
          >
            Speaker sign in
          </Link>
        </div>
      </header>

      {/* ── hero ─────────────────────────────────────────────────────────── */}
      <main className="mx-auto max-w-5xl px-4 pb-20 sm:px-6">
        <section className="flex flex-col items-center pt-16 text-center sm:pt-24">
          <span className="inline-flex items-center rounded-full border border-border bg-card px-3 py-1 text-xs font-medium text-muted-foreground">
            Open-source conference speaker management
          </span>

          <h1 className="mt-6 max-w-2xl text-4xl font-semibold tracking-tight text-foreground sm:text-5xl">
            Run your conference program, end to end
          </h1>
          <p className="mt-4 max-w-xl text-base text-muted-foreground sm:text-lg">
            From call for papers to a scheduled, onboarded program — dais handles submissions,
            reviews, the agenda, and speaker comms in one workspace.
          </p>

          <div className="mt-8 flex flex-col items-center gap-3 sm:flex-row">
            <Button size="lg" onClick={enterDemo} disabled={loading}>
              {loading ? 'Starting the demo…' : 'Enter the demo workspace'}
              {!loading && <ArrowRight className="h-4 w-4" />}
            </Button>
            <div className="flex items-center gap-3">
              <Button size="lg" variant="secondary" onClick={enterDemo} disabled={loading}>
                Get started
              </Button>
              <button
                type="button"
                onClick={enterDemo}
                disabled={loading}
                className="text-sm font-medium text-primary underline underline-offset-4 hover:text-primary-strong disabled:opacity-50"
              >
                Organizer dashboard
              </button>
            </div>
          </div>
          <p className="mt-3 text-xs text-muted-foreground">
            No sign-up — jump into a fully seeded workspace.
          </p>
          {error && <p className="mt-2 text-sm text-destructive">{error}</p>}
        </section>

        {/* ── what you can do ────────────────────────────────────────────── */}
        <section className="mt-16 grid gap-4 sm:grid-cols-3">
          {HIGHLIGHTS.map(({ icon: Icon, title, body }) => (
            <div
              key={title}
              className="rounded-xl border border-border bg-card p-5 text-left shadow-soft"
            >
              <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary-subtle text-primary">
                <Icon className="h-[18px] w-[18px]" />
              </div>
              <h2 className="mt-3 text-sm font-semibold text-foreground">{title}</h2>
              <p className="mt-1 text-sm text-muted-foreground">{body}</p>
            </div>
          ))}
        </section>

        {/* ── public program links (crawlable) ───────────────────────────── */}
        <section className="mt-16">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            Explore the AI Builders Summit
          </h2>
          <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {EXPLORE.map(({ icon: Icon, label, to }) => (
              <Link
                key={label}
                to={to}
                className="group flex items-center gap-3 rounded-xl border border-border bg-card p-4 shadow-soft transition-shadow hover:shadow-raised"
              >
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary-subtle text-primary">
                  <Icon className="h-[18px] w-[18px]" />
                </div>
                <span className="text-sm font-medium text-foreground">{label}</span>
                <ArrowRight className="ml-auto h-4 w-4 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
              </Link>
            ))}
          </div>
        </section>

        {/* ── open source ───────────────────────────────────────────────── */}
        <section
          data-testid="open-source-section"
          className="mt-20 grid gap-6 border-y border-border py-10 sm:grid-cols-[1fr_1.45fr] sm:items-start"
        >
          <div>
            <p className="text-xs font-semibold uppercase tracking-wider text-primary">
              Community built
            </p>
            <h2 className="mt-2 text-2xl font-semibold tracking-tight text-foreground">
              Open source
            </h2>
          </div>
          <div>
            <p className="text-base leading-relaxed text-foreground">
              SpeakerWeave is open source, so organizers and builders can inspect it, extend it,
              and help shape what comes next.
            </p>
            <p className="mt-2 text-sm text-muted-foreground">
              License posture: source-available for the community.
            </p>
            <a
              href={REPO_URL}
              aria-label="SpeakerWeave source repository"
              className="mt-4 inline-flex items-center gap-1.5 text-sm font-medium text-primary underline underline-offset-4 transition-colors hover:text-primary-strong"
            >
              View the repository
              <ExternalLink className="h-4 w-4" />
            </a>
          </div>
        </section>

        {/* ── stack ─────────────────────────────────────────────────────── */}
        <section data-testid="stack-section" className="mt-20">
          <div className="grid gap-4 sm:grid-cols-[1fr_2fr] sm:items-end">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wider text-primary">
                Architecture
              </p>
              <h2 className="mt-2 text-2xl font-semibold tracking-tight text-foreground">
                The stack
              </h2>
            </div>
            <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">
              A compact, production-ready foundation with explicit boundaries between the product
              and its infrastructure.
            </p>
          </div>

          <dl className="mt-6 grid border-y border-border sm:grid-cols-2">
            {STACK.map(({ name, role }, index) => (
              <div
                key={name}
                className={`grid grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)] gap-3 border-border px-1 py-3.5 sm:py-4 ${
                  index > 0 ? 'border-t' : ''
                } ${index === 1 ? 'sm:border-t-0' : ''} ${
                  index % 2 === 1 ? 'sm:border-l sm:pl-5' : 'sm:pr-5'
                }`}
              >
                <dt className="text-sm font-semibold text-foreground">{name}</dt>
                <dd className="text-sm text-muted-foreground">{role}</dd>
              </div>
            ))}
          </dl>

          <div className="mt-5 rounded-lg bg-muted px-4 py-3 text-sm leading-relaxed text-muted-foreground">
            <span className="font-semibold text-foreground">Bring your own.</span> Auth (Clerk),
            email (Resend), and hosting meet the app at clear interfaces—swap them without touching
            the domain core.
          </div>
        </section>

        {/* ── MCP clients ───────────────────────────────────────────────── */}
        <section data-testid="ai-apps-section" className="mt-20">
          <div className="grid gap-4 sm:grid-cols-[1fr_2fr] sm:items-end">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wider text-primary">AI apps</p>
              <h2 className="mt-2 text-2xl font-semibold tracking-tight text-foreground">
                Use it from your AI
              </h2>
            </div>
            <div className="max-w-2xl space-y-2 text-sm leading-relaxed text-muted-foreground">
              <p>
                SpeakerWeave ships a hosted MCP server at{' '}
                <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">
                  {mcpEndpoint}
                </code>
                . Claude and ChatGPT use the same endpoint.
              </p>
              <p>
                Ask SpeakerWeave in the organizer app, the Slack bot, and MCP all share the same
                organization-scoped tool layer.
              </p>
            </div>
          </div>

          <div className="mt-6 grid gap-4 md:grid-cols-2">
            {aiApps.map(({ title, steps, config }) => (
              <article key={title} className="rounded-xl border border-border bg-card p-5 shadow-soft">
                <h3 className="text-base font-semibold text-foreground">{title}</h3>
                <ol className="mt-3 space-y-1.5 text-sm text-muted-foreground">
                  {steps.map((step, index) => (
                    <li key={step} className="flex gap-2.5">
                      <span className="font-mono text-xs font-semibold text-primary">{index + 1}.</span>
                      <span>{step}</span>
                    </li>
                  ))}
                </ol>
                <div className="relative mt-5 overflow-hidden rounded-lg bg-foreground">
                  <div className="flex items-center justify-between border-b border-white/10 px-3 py-2">
                    <span className="font-mono text-[11px] uppercase tracking-wider text-white/60">
                      Power-user MCP config
                    </span>
                    <CopyConfigButton value={config} label={`Copy ${title} MCP configuration`} />
                  </div>
                  <pre className="overflow-x-auto p-4 font-mono text-xs leading-relaxed text-primary-subtle">
                    <code>{config}</code>
                  </pre>
                </div>
              </article>
            ))}
          </div>

          <Link
            to="/developers"
            className="mt-5 inline-flex items-center gap-1.5 text-sm font-medium text-primary underline underline-offset-4 transition-colors hover:text-primary-strong"
          >
            See the full MCP tool list
            <ArrowRight className="h-4 w-4" />
          </Link>
        </section>

        {/* ── real-account sign in ───────────────────────────────────────── */}
        <section className="mt-16 rounded-xl border border-border bg-card p-6 text-center shadow-soft">
          <h2 className="text-base font-semibold text-foreground">
            Running your own conference?
          </h2>
          <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
            Organizers with an account can sign in to manage their own event.
          </p>
          <Link
            to="/sign-in"
            className="mt-4 inline-flex items-center gap-1.5 text-sm font-medium text-primary underline underline-offset-4 hover:text-primary-strong"
          >
            Sign in with your account
            <ArrowRight className="h-4 w-4" />
          </Link>
        </section>
      </main>
    </div>
  )
}
