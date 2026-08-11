import { useState } from 'react'
import { preload } from 'react-dom'
import { Link, useNavigate } from 'react-router-dom'
import {
  ArrowRight,
  Bot,
  BrainCircuit,
  CalendarDays,
  Check,
  ChevronDown,
  ClipboardCheck,
  Code2,
  ContactRound,
  Copy,
  ExternalLink,
  FileText,
  Globe2,
  MessagesSquare,
  Send,
  SquareTerminal,
  UserRoundCheck,
  Users,
  Workflow,
} from 'lucide-react'

import agendaScreenshot from '../assets/agenda.jpg'
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
export const DOCS_URL = 'https://speaker-weave.mintlify.site'
const LICENSE_URL = `${REPO_URL}/blob/main/LICENSE`

const CAPABILITIES = [
  {
    icon: FileText,
    title: 'Call for Papers',
    body: 'Smart forms with conditional logic for every submission path.',
    span: 'lg:col-span-3',
  },
  {
    icon: ClipboardCheck,
    title: 'Review',
    body: 'Committees, blind rounds, scorecards, and practical AI triage.',
    span: 'lg:col-span-3',
  },
  {
    icon: Send,
    title: 'Decisions',
    body: 'One click sends emails and kicks off speaker onboarding.',
    span: 'lg:col-span-3',
  },
  {
    icon: UserRoundCheck,
    title: 'Speaker Portal',
    body: 'Bios, headshots, versioned content, and approvals in one place.',
    span: 'lg:col-span-3',
  },
  {
    icon: CalendarDays,
    title: 'Agenda Builder',
    body: 'Drag-and-drop planning, live conflict checks, and auto-place.',
    span: 'lg:col-span-4',
  },
  {
    icon: Globe2,
    title: 'Publish',
    body: 'Public schedule, speaker gallery, embeds, and iCal feeds.',
    span: 'lg:col-span-4',
  },
  {
    icon: ContactRound,
    title: 'Speaker CRM',
    body: 'A cross-event directory with sourcing pipeline and segments.',
    span: 'lg:col-span-4',
  },
]

/** Crawlable links to the public conference surfaces. Plain in-app routes so a
 *  browser agent reading `href`s can discover every public page. */
const EXPLORE = [
  { icon: CalendarDays, label: 'Schedule', to: featuredScheduleUrl },
  { icon: Users, label: 'Speakers', to: featuredSpeakersUrl },
  { icon: MessagesSquare, label: 'Call for Speakers', to: CFP_FORM_URL },
  { icon: Code2, label: 'Developers', to: DEVELOPERS_URL },
]

const STACK = [
  { name: 'FastAPI', role: 'Typed API + hosted MCP' },
  { name: 'React + Vite', role: 'Fast web interface' },
  { name: 'Supabase (Postgres)', role: 'Program data' },
  { name: 'Clerk', role: 'Organizer auth' },
  { name: 'Resend', role: 'Transactional email' },
  { name: 'Railway', role: 'Application hosting' },
]

function CopyConfigButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false)

  return (
    <button
      type="button"
      aria-label={label}
      className="inline-flex items-center gap-1.5 rounded-md border border-background/20 bg-background/10 px-2.5 py-1.5 text-xs font-medium text-background transition-[background-color,transform] hover:bg-background/15 active:scale-[0.98]"
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
 * The primary CTA gets organizers into a seeded workspace with a short-lived
 * demo token. Public program links remain real anchors for people, crawlers,
 * and browser agents, while real organizers can still use Clerk at /sign-in.
 */
export function Home() {
  // Conditional resource hint: unlike a static index.html preload, this only
  // competes for bandwidth on routes that actually render the landing page.
  preload(agendaScreenshot, { as: 'image', fetchPriority: 'high' })

  const navigate = useNavigate()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const mcpEndpoint = `${window.location.origin}/mcp`
  const mcpClients = [
    {
      title: 'Claude (MCP)',
      summary: 'Connect Claude',
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
      title: 'ChatGPT (MCP)',
      summary: 'Connect ChatGPT',
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

  const aiSurfaces = [
    {
      icon: BrainCircuit,
      title: 'In-app chat agent',
      body: 'Streaming chat with threads, @-mention any submission or speaker as context, clickable entity badges, and approve/deny gates on anything sensitive.',
      eyebrow: 'Built in',
    },
    {
      icon: MessagesSquare,
      title: 'Slack bot',
      body: 'Bring the same program context and tools into the channel where the team works.',
      eyebrow: 'Team surface',
    },
    {
      icon: SquareTerminal,
      title: 'sw CLI',
      body: 'pipx install, authenticate with an API token, then sw ask — the same brain from any shell or script.',
      eyebrow: 'Terminal',
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
    <div className="min-h-screen overflow-hidden bg-background text-foreground">
      <a
        href="#main-content"
        className="fixed left-4 top-3 z-50 -translate-y-20 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground shadow-raised transition-transform focus:translate-y-0"
      >
        Skip to content
      </a>

      <header className="relative z-20 border-b border-border/80 bg-background/90 backdrop-blur-md">
        <div className="mx-auto flex h-16 max-w-7xl items-center gap-4 px-5 sm:px-8">
          <Link to="/" className="flex items-center gap-2.5" aria-label="SpeakerWeave home">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-sm font-semibold text-primary-foreground shadow-soft">
              S
            </span>
            <span className="text-lg font-semibold tracking-tight text-foreground">SpeakerWeave</span>
          </Link>

          <nav aria-label="Public program" className="ml-auto hidden items-center gap-1 md:flex">
            {EXPLORE.map(({ label, to }) => (
              <Link
                key={label}
                to={to}
                className="rounded-md px-3 py-1.5 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                {label}
              </Link>
            ))}
            <a
              href={DOCS_URL}
              className="rounded-md px-3 py-1.5 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              Docs
            </a>
          </nav>

          <Link
            to="/speaker-signin"
            className="ml-auto rounded-md px-3 py-1.5 text-sm font-medium text-primary transition-colors hover:bg-primary-subtle hover:text-primary-strong md:ml-2"
          >
            Speaker sign in
          </Link>
        </div>
      </header>

      <main id="main-content">
        <section className="relative">
          <div
            aria-hidden="true"
            className="pointer-events-none absolute -left-1/4 -top-1/3 h-[48rem] w-[58rem] rounded-full bg-[radial-gradient(ellipse_at_center,hsl(var(--primary)/0.20),transparent_66%)] blur-3xl"
          />
          <div className="relative mx-auto grid max-w-7xl gap-12 px-5 pb-16 pt-14 sm:px-8 sm:pb-20 sm:pt-20 lg:grid-cols-[0.82fr_1.18fr] lg:items-center lg:gap-14 lg:pb-24 lg:pt-24">
            <div className="max-w-2xl">
              <p className="inline-flex items-center gap-2 rounded-full border border-primary/20 bg-primary-subtle px-3 py-1 text-xs font-semibold text-primary-strong">
                <span className="h-1.5 w-1.5 rounded-full bg-primary" />
                Open-source conference operations
              </p>
              <h1 className="mt-6 text-balance text-4xl font-semibold leading-[1.04] tracking-[-0.045em] text-foreground sm:text-5xl lg:text-[3.55rem]">
                Run your conference program, end to end.
              </h1>
              <p className="mt-6 max-w-[62ch] text-pretty text-base leading-7 text-muted-foreground sm:text-lg sm:leading-8">
                From call for papers to a published, staffed, scheduled agenda - submissions,
                reviews, speaker onboarding, content, and scheduling in one open-source workspace.
              </p>

              <div className="mt-8 flex flex-col items-start gap-4 sm:flex-row sm:items-center">
                <Button
                  size="lg"
                  onClick={enterDemo}
                  disabled={loading}
                  className="h-12 px-6 shadow-[0_10px_28px_-10px_hsl(var(--primary)/0.65)]"
                >
                  {loading ? 'Starting the demo…' : 'Enter the demo workspace'}
                  {!loading && <ArrowRight className="h-4 w-4" />}
                </Button>
                <Link
                  to={featuredScheduleUrl}
                  className="group inline-flex items-center gap-1.5 text-sm font-medium text-foreground transition-colors hover:text-primary"
                >
                  View the public program
                  <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
                </Link>
              </div>
              <p className="mt-3 text-xs text-muted-foreground">
                No sign-up. Jump into a fully seeded workspace.
              </p>
              {error && <p className="mt-2 text-sm text-destructive">{error}</p>}
            </div>

            <figure className="relative lg:translate-x-3">
              <div
                aria-hidden="true"
                className="absolute -inset-4 rounded-[2rem] bg-primary/10 blur-2xl"
              />
              <div className="relative overflow-hidden rounded-[1.15rem] border border-border/90 bg-card p-1.5 shadow-lifted lg:[transform:perspective(1200px)_rotateY(-1.5deg)_rotateX(0.5deg)]">
                <div className="overflow-hidden rounded-xl border border-border bg-card">
                  <div className="flex h-10 items-center gap-3 border-b border-border bg-muted/70 px-3">
                    <div className="flex gap-1.5" aria-hidden="true">
                      <span className="h-2.5 w-2.5 rounded-full bg-destructive/75" />
                      <span className="h-2.5 w-2.5 rounded-full bg-warning/80" />
                      <span className="h-2.5 w-2.5 rounded-full bg-success/75" />
                    </div>
                    <div className="mx-auto flex h-6 w-[55%] items-center justify-center rounded-md border border-border bg-background/80 px-3 font-mono text-[10px] text-muted-foreground shadow-soft">
                      speakerweave.com
                    </div>
                    <div className="w-12" aria-hidden="true" />
                  </div>
                  <img
                    src={agendaScreenshot}
                    alt="SpeakerWeave agenda builder showing a multi-track conference schedule"
                    className="block h-auto w-full bg-card"
                    loading="eager"
                    decoding="async"
                    fetchPriority="high"
                  />
                </div>
              </div>
              <figcaption className="sr-only">
                The SpeakerWeave drag-and-drop agenda builder.
              </figcaption>
            </figure>
          </div>
        </section>

        <section aria-label="Project credibility" className="border-y border-border bg-card/55">
          <ul className="mx-auto grid max-w-7xl divide-y divide-border px-5 sm:grid-cols-2 sm:divide-x sm:divide-y-0 sm:px-8 lg:grid-cols-4">
            <li className="py-4 text-sm font-medium text-foreground sm:pr-6">
              <a
                href={REPO_URL}
                className="inline-flex items-center gap-1.5 transition-colors hover:text-primary"
              >
                Open source - MIT
                <ExternalLink className="h-3.5 w-3.5" />
              </a>
            </li>
            <li className="py-4 text-sm text-muted-foreground sm:px-6">
              <span className="font-medium tabular-nums text-foreground">982 backend</span> +{' '}
              <span className="font-medium tabular-nums text-foreground">603 frontend</span> tests
            </li>
            <li className="py-4 text-sm text-muted-foreground sm:px-6">
              Built end-to-end by AI coding agents
            </li>
            <li className="py-4 text-sm text-muted-foreground sm:pl-6">
              REST API + MCP + webhooks-ready
            </li>
          </ul>
        </section>

        <section className="mx-auto max-w-7xl px-5 pb-10 pt-20 sm:px-8 sm:pt-28">
          <div className="max-w-2xl">
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-primary">
              The whole program lifecycle
            </p>
            <h2 className="mt-3 text-balance text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">
              From first proposal to final room assignment.
            </h2>
            <p className="mt-4 max-w-[62ch] text-pretty text-base leading-7 text-muted-foreground">
              One operating system for program teams, review committees, speakers, and attendees.
            </p>
          </div>

          <div className="mt-10 grid gap-3 sm:grid-cols-2 lg:grid-cols-12">
            {CAPABILITIES.map(({ icon: Icon, title, body, span }) => (
              <article
                key={title}
                className={`group rounded-xl border border-border bg-card p-5 transition-[border-color,box-shadow,transform] duration-200 hover:-translate-y-0.5 hover:border-primary/35 hover:shadow-raised ${span}`}
              >
                <div className="flex items-center gap-3">
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary-subtle text-primary">
                    <Icon className="h-[18px] w-[18px]" strokeWidth={1.8} />
                  </span>
                  <h3 className="text-sm font-semibold text-foreground">{title}</h3>
                </div>
                <p className="mt-3 text-sm leading-6 text-muted-foreground">{body}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="mx-auto max-w-7xl px-5 pb-20 pt-12 sm:px-8 sm:pb-28">
          <div className="flex flex-col gap-5 border-y border-border py-7 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                Live public example
              </p>
              <h2 className="mt-2 text-xl font-semibold tracking-tight text-foreground">
                Explore the AI Builders Summit
              </h2>
            </div>
            <nav
              aria-label="Explore the AI Builders Summit"
              className="grid gap-2 sm:grid-cols-2 lg:flex"
            >
              {EXPLORE.map(({ icon: Icon, label, to }) => (
                <Link
                  key={label}
                  to={to}
                  className="group inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium text-foreground transition-colors hover:bg-accent hover:text-primary"
                >
                  <Icon className="h-4 w-4 text-muted-foreground transition-colors group-hover:text-primary" />
                  {label}
                  <ArrowRight className="h-3.5 w-3.5 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
                </Link>
              ))}
            </nav>
          </div>
        </section>

        <section data-testid="ai-apps-section" className="relative border-y border-border bg-card">
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-0 top-0 h-80 bg-[radial-gradient(ellipse_at_top,hsl(var(--primary)/0.14),transparent_68%)]"
          />
          <div className="relative mx-auto max-w-7xl px-5 py-20 sm:px-8 sm:py-28">
            <div className="mx-auto max-w-3xl text-center">
              <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-xl border border-primary/20 bg-primary-subtle text-primary shadow-soft">
                <Workflow className="h-5 w-5" strokeWidth={1.8} />
              </div>
              <p className="mt-5 text-xs font-semibold uppercase tracking-[0.18em] text-primary">
                One brain, five surfaces
              </p>
              <h2 className="mt-3 text-balance text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">
                Your program context travels with you.
              </h2>
              <p className="mx-auto mt-4 max-w-[68ch] text-pretty text-base leading-7 text-muted-foreground">
                The in-app chat agent, Slack bot, CLI, Claude, and ChatGPT all dispatch through the
                same organization-scoped tool layer — and MCP connectors (Every is the first preset)
                bring your business tools into the agent. Permissions and program data stay
                consistent, whichever surface your team chooses.
              </p>
            </div>

            <div className="mt-12 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              {aiSurfaces.map(({ icon: Icon, title, body, eyebrow }) => (
                <article key={title} className="rounded-xl border border-border bg-background p-5">
                  <div className="flex items-start justify-between gap-4">
                    <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary-subtle text-primary">
                      <Icon className="h-[18px] w-[18px]" strokeWidth={1.8} />
                    </span>
                    <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                      {eyebrow}
                    </span>
                  </div>
                  <h3 className="mt-6 text-base font-semibold text-foreground">{title}</h3>
                  <p className="mt-2 text-sm leading-6 text-muted-foreground">{body}</p>
                </article>
              ))}

              {mcpClients.map(({ title, summary, steps, config }) => {
                const Icon = title.startsWith('Claude') ? Bot : BrainCircuit
                return (
                  <article
                    key={title}
                    className="flex flex-col rounded-xl border border-border bg-background p-5"
                  >
                    <div className="flex items-start justify-between gap-4">
                      <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary-subtle text-primary">
                        <Icon className="h-[18px] w-[18px]" strokeWidth={1.8} />
                      </span>
                      <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                        MCP client
                      </span>
                    </div>
                    <h3 className="mt-6 text-base font-semibold text-foreground">{title}</h3>
                    <p className="mt-2 text-sm leading-6 text-muted-foreground">
                      Connect to <span className="font-mono text-xs text-foreground">{mcpEndpoint}</span>{' '}
                      and use SpeakerWeave from this client.
                    </p>

                    <details className="group mt-5 border-t border-border pt-4">
                      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 text-sm font-medium text-primary marker:hidden">
                        {summary}
                        <ChevronDown className="h-4 w-4 transition-transform group-open:rotate-180" />
                      </summary>
                      <div className="mt-4">
                        <ol className="space-y-2 text-sm leading-5 text-muted-foreground">
                          {steps.map((step, index) => (
                            <li key={step} className="flex gap-2.5">
                              <span className="font-mono text-xs font-semibold text-primary">
                                {index + 1}.
                              </span>
                              <span>{step}</span>
                            </li>
                          ))}
                        </ol>
                        <div className="relative mt-4 overflow-hidden rounded-lg bg-foreground">
                          <div className="flex items-center justify-between border-b border-background/15 px-3 py-2">
                            <span className="font-mono text-[10px] uppercase tracking-wider text-background/60">
                              Power-user MCP config
                            </span>
                            <CopyConfigButton
                              value={config}
                              label={`Copy ${title.replace(' (MCP)', '')} MCP configuration`}
                            />
                          </div>
                          <pre className="overflow-x-auto p-3 font-mono text-[11px] leading-relaxed text-background/80">
                            <code>{config}</code>
                          </pre>
                        </div>
                      </div>
                    </details>
                  </article>
                )
              })}
            </div>

            <div className="mt-8 text-center">
              <Link
                to="/developers"
                className="group inline-flex items-center gap-1.5 text-sm font-medium text-primary underline underline-offset-4 transition-colors hover:text-primary-strong"
              >
                See the full MCP tool list
                <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
              </Link>
            </div>
          </div>
        </section>

        <div className="mx-auto grid max-w-7xl gap-6 px-5 py-20 sm:px-8 sm:py-28 lg:grid-cols-[0.9fr_1.1fr]">
          <section
            data-testid="open-source-section"
            className="rounded-2xl border border-border bg-card p-7 shadow-soft sm:p-9"
          >
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-primary">
              Community built
            </p>
            <h2 className="mt-3 text-3xl font-semibold tracking-tight text-foreground">
              Open source
            </h2>
            <p className="mt-5 text-base leading-7 text-foreground">
              SpeakerWeave is open source, so organizers and builders can inspect it, extend it,
              and help shape what comes next.
            </p>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">
              MIT licensed from end to end. Fork it, self-host it, or contribute upstream.
            </p>
            <a
              href={REPO_URL}
              aria-label="SpeakerWeave source repository"
              className="mt-6 inline-flex items-center gap-1.5 text-sm font-medium text-primary underline underline-offset-4 transition-colors hover:text-primary-strong"
            >
              View the repository
              <ExternalLink className="h-4 w-4" />
            </a>
          </section>

          <section
            data-testid="stack-section"
            className="rounded-2xl border border-border bg-card p-7 shadow-soft sm:p-9"
          >
            <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.16em] text-primary">
                  Bring your own
                </p>
                <h2 className="mt-3 text-3xl font-semibold tracking-tight text-foreground">
                  The stack
                </h2>
              </div>
              <p className="max-w-xs text-sm leading-6 text-muted-foreground">
                Clear interfaces make the infrastructure swappable.
              </p>
            </div>

            <dl className="mt-6 grid overflow-hidden rounded-xl border border-border sm:grid-cols-2">
              {STACK.map(({ name, role }, index) => (
                <div
                  key={name}
                  className={`bg-background px-4 py-3.5 ${index > 0 ? 'border-t border-border' : ''} ${index === 1 ? 'sm:border-t-0' : ''} ${index % 2 === 1 ? 'sm:border-l sm:border-border' : ''}`}
                >
                  <dt className="text-sm font-semibold text-foreground">{name}</dt>
                  <dd className="mt-0.5 text-xs text-muted-foreground">{role}</dd>
                </div>
              ))}
            </dl>
            <p className="mt-4 text-sm leading-6 text-muted-foreground">
              Swap auth, email, hosting, or data providers without touching the domain core.
            </p>
          </section>
        </div>

        <section className="mx-auto max-w-7xl px-5 pb-20 sm:px-8 sm:pb-28">
          <div className="relative overflow-hidden rounded-2xl border border-primary/20 bg-primary-subtle px-6 py-10 text-center sm:px-10 sm:py-12">
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_right,hsl(var(--primary)/0.16),transparent_45%)]"
            />
            <div className="relative">
              <h2 className="text-2xl font-semibold tracking-tight text-foreground">
                Running your own conference?
              </h2>
              <p className="mx-auto mt-3 max-w-lg text-sm leading-6 text-muted-foreground">
                Organizers with an account can sign in to manage their events, review teams, and
                speaker program.
              </p>
              <Button asChild variant="secondary" size="lg" className="mt-6">
                <Link to="/sign-in">
                  Sign in with your account
                  <ArrowRight className="h-4 w-4" />
                </Link>
              </Button>
            </div>
          </div>
        </section>
      </main>

      <footer className="border-t border-border bg-card/60">
        <div className="mx-auto flex max-w-7xl flex-col gap-6 px-5 py-8 sm:px-8 md:flex-row md:items-center">
          <div className="flex items-center gap-2.5">
            <span className="flex h-7 w-7 items-center justify-center rounded-md bg-primary text-xs font-semibold text-primary-foreground">S</span>
            <span className="text-sm font-semibold text-foreground">SpeakerWeave</span>
          </div>
          <nav
            aria-label="Footer"
            className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm text-muted-foreground md:ml-auto"
          >
            {EXPLORE.map(({ label, to }) => (
              <Link key={label} to={to} className="transition-colors hover:text-foreground">
                {label}
              </Link>
            ))}
            <Link to="/speaker-signin" className="transition-colors hover:text-foreground">
              Speaker sign in
            </Link>
            <a href={LICENSE_URL} className="transition-colors hover:text-foreground">
              License
            </a>
            <a href={DOCS_URL} className="transition-colors hover:text-foreground">
              Docs
            </a>
            <a href={REPO_URL} className="transition-colors hover:text-foreground">
              GitHub
            </a>
          </nav>
        </div>
      </footer>
    </div>
  )
}
