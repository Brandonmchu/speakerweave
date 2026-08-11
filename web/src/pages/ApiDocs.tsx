import { ArrowLeft, Bot, KeyRound, Sparkles, Terminal } from 'lucide-react'
import { BrandMark } from '@/ui/brand'
import { Link } from 'react-router-dom'

import {
  API_BASE_PATH,
  AUTH_EXAMPLE,
  AUTH_HEADER,
  CURL_EXAMPLES,
  MCP_TOOLS,
  REST_ENDPOINTS,
  type HttpMethod,
} from '@/lib/apiDocsContent'
import { cn } from '@/lib/utils'
import { CopyButton } from '@/ui/copy-button'

/** Public REST and hosted MCP reference (route: /developers). */
export function ApiDocs() {
  const mcpEndpoint = `${window.location.origin}/mcp`
  const mcpConfig = JSON.stringify(
    {
      mcpServers: {
        speakerweave: {
          type: 'http',
          url: mcpEndpoint,
          headers: { Authorization: 'Bearer dais_your_api_token' },
        },
      },
    },
    null,
    2,
  )

  return (
    <div className="min-h-screen bg-background text-foreground">
      <TopBar />
      <div className="mx-auto grid max-w-6xl gap-10 px-4 py-10 md:grid-cols-[220px_1fr] md:px-8">
        <SideNav />
        <main className="min-w-0 space-y-12">
          <Hero />
          <BaseUrl />
          <Authentication />
          <Conventions />
          <EndpointReference />
          <Examples />
          <McpServer endpoint={mcpEndpoint} config={mcpConfig} />
          <Footer />
        </main>
      </div>
    </div>
  )
}

function TopBar() {
  return (
    <header className="sticky top-0 z-10 border-b border-border bg-card/80 backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3 md:px-8">
        <div className="flex items-center gap-2">
          <BrandMark className="h-8 w-8" />
          <span className="text-lg font-semibold tracking-tight text-foreground">speakerweave</span>
          <span className="ml-1 rounded-full bg-primary-subtle px-2 py-0.5 text-xs font-medium text-primary">
            API reference
          </span>
        </div>
        <Link
          to="/"
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-primary"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to app
        </Link>
      </div>
    </header>
  )
}

const NAV_ITEMS = [
  { id: 'base-url', label: 'Base URL' },
  { id: 'authentication', label: 'Authentication' },
  { id: 'conventions', label: 'Conventions' },
  { id: 'endpoints', label: 'REST endpoints' },
  { id: 'examples', label: 'curl examples' },
  { id: 'mcp-server', label: 'MCP server' },
  { id: 'mcp-tools', label: 'MCP tools' },
]

function SideNav() {
  return (
    <nav className="hidden md:block">
      <div className="sticky top-20 space-y-1 text-sm">
        {NAV_ITEMS.map((item) => (
          <a
            key={item.id}
            href={`#${item.id}`}
            className="block rounded-md px-2 py-1.5 text-muted-foreground transition-colors hover:bg-hover hover:text-primary"
          >
            {item.label}
          </a>
        ))}
      </div>
    </nav>
  )
}

function Hero() {
  return (
    <section className="space-y-4">
      <h1 className="text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">SpeakerWeave API</h1>
      <p className="max-w-2xl text-base text-muted-foreground">
        A complete integration surface for events, submissions, speakers, schedules, content, and
        evaluations—available as REST for software and MCP for AI agents.
      </p>
      <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">
        The in-app chat agent, the Slack bot, and the hosted MCP server all use the same
        organization-scoped tool layer, so every surface sees the same conference operations. Full
        guides and an interactive API reference live at{' '}
        <a
          href="https://speaker-weave.mintlify.site"
          className="font-medium text-primary underline underline-offset-2 hover:text-primary-strong"
        >
          the documentation site
        </a>
        .
      </p>
      <div className="flex items-start gap-3 rounded-xl border border-primary/20 bg-primary-subtle/60 p-4">
        <Sparkles className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
        <div className="text-sm text-foreground">
          <p className="font-semibold text-primary">SpeakerWeave speaks Sessionboard&rsquo;s protocol.</p>
          <p className="mt-1 text-muted-foreground">
            Existing integrations can keep the <Mono>{API_BASE_PATH}</Mono> base path and{' '}
            <Mono>{AUTH_HEADER}</Mono> authentication convention, while new agent workflows connect
            directly to the hosted MCP server.
          </p>
        </div>
      </div>
    </section>
  )
}

function BaseUrl() {
  return (
    <section id="base-url" className="scroll-mt-24 space-y-3">
      <SectionHeading icon={<Terminal className="h-4 w-4" />} title="Base URL" />
      <p className="text-sm text-muted-foreground">
        REST endpoints are relative to your dais host and live under <Mono>{API_BASE_PATH}</Mono>.
      </p>
      <CodeBlock code={`https://your-dais-host${API_BASE_PATH}`} />
    </section>
  )
}

function Authentication() {
  return (
    <section id="authentication" className="scroll-mt-24 space-y-3">
      <SectionHeading icon={<KeyRound className="h-4 w-4" />} title="Authentication" />
      <p className="text-sm leading-relaxed text-muted-foreground">
        Send every REST request with <Mono>{AUTH_HEADER}: dais_your_api_token</Mono>. Generate tokens
        from <span className="font-medium text-foreground">Settings → API tokens</span>; the raw
        value is shown once. Each token resolves to one organization, and resources outside that
        organization return <Mono>404</Mono>.
      </p>
      <p className="text-sm leading-relaxed text-muted-foreground">
        Prefer a terminal? From a checkout, run <Mono>pipx install ./cli</Mono>, then{' '}
        <Mono>sw auth login</Mono> with the same organization API token.
      </p>
      <CodeBlock code={AUTH_EXAMPLE} />
    </section>
  )
}

function Conventions() {
  return (
    <section id="conventions" className="scroll-mt-24 space-y-4">
      <SectionHeading title="Conventions" />
      <div className="grid gap-4 sm:grid-cols-3">
        <ConventionCard title="Pagination">
          Lists accept <Mono>page</Mono> (1-based) and <Mono>pageSize</Mono> (default 25, max 100),
          and return <Mono>{'{ data, page, pageSize, total }'}</Mono>.
        </ConventionCard>
        <ConventionCard title="Filtering">
          Use <Mono>status</Mono>, <Mono>track</Mono>, <Mono>filter</Mono>, or <Mono>type</Mono> where
          shown. Session and submission paths are aliases.
        </ConventionCard>
        <ConventionCard title="Errors & fields">
          Fields are <Mono>snake_case</Mono>, times are ISO-8601, invalid input is <Mono>400</Mono>,
          and missing or cross-org resources are <Mono>404</Mono>.
        </ConventionCard>
      </div>
    </section>
  )
}

function EndpointReference() {
  return (
    <section id="endpoints" className="scroll-mt-24 space-y-4">
      <SectionHeading title="REST endpoints" />
      <div className="overflow-hidden rounded-xl border border-border bg-card shadow-soft">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[680px] text-left text-sm">
            <thead className="border-b border-border bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="w-24 px-4 py-3 font-semibold">Method</th>
                <th className="px-4 py-3 font-semibold">Path</th>
                <th className="px-4 py-3 font-semibold">Description</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {REST_ENDPOINTS.map((endpoint) => (
                <tr key={`${endpoint.method}-${endpoint.path}`} className="align-top hover:bg-hover/60">
                  <td className="px-4 py-3"><MethodTag method={endpoint.method} /></td>
                  <td className="px-4 py-3"><code className="font-mono text-[13px] text-foreground">{API_BASE_PATH}{endpoint.path}</code></td>
                  <td className="px-4 py-3 text-muted-foreground">{endpoint.description}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  )
}

function Examples() {
  return (
    <section id="examples" className="scroll-mt-24 space-y-5">
      <SectionHeading title="curl examples" />
      <div className="grid gap-5">
        {CURL_EXAMPLES.map((example) => (
          <article key={example.title} className="rounded-xl border border-border bg-card p-5 shadow-soft">
            <h3 className="text-sm font-semibold text-foreground">{example.title}</h3>
            <p className="mb-3 mt-1 text-sm text-muted-foreground">{example.description}</p>
            <CodeBlock code={example.code} />
          </article>
        ))}
      </div>
    </section>
  )
}

function McpServer({ endpoint, config }: { endpoint: string; config: string }) {
  return (
    <section id="mcp-server" className="scroll-mt-24 space-y-5">
      <SectionHeading icon={<Bot className="h-4 w-4" />} title="MCP server" />
      <div className="rounded-xl border border-primary/20 bg-primary-subtle/60 p-5">
        <p className="text-sm font-semibold text-primary">Connector UI (recommended)</p>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          In claude.ai, Claude for Work, or ChatGPT, add a custom connector with URL{' '}
          <Mono>{endpoint}</Mono>. You&rsquo;ll be asked to authorize with an API token from{' '}
          <span className="font-medium text-foreground">Settings → API tokens</span>. No custom
          headers are needed.
        </p>
      </div>
      <p className="text-sm leading-relaxed text-muted-foreground">
        Power-user path: Streamable-HTTP clients that support custom headers can use the same
        organization API token as REST, supplied as{' '}
        <Mono>Authorization: Bearer …</Mono>. Add this entry to your client&rsquo;s MCP JSON configuration:
      </p>
      <CodeBlock code={config} />
      <div className="rounded-xl border border-border bg-card p-5 shadow-soft">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Resources</p>
        <p className="mt-2 text-sm text-muted-foreground">
          Event-scoped JSON resources are available at <Mono>dais://events/{'{event}'}/schedule</Mono>,{' '}
          <Mono>dais://events/{'{event}'}/speakers</Mono>, and{' '}
          <Mono>dais://events/{'{event}'}/content-status</Mono>.
        </p>
      </div>
      <div id="mcp-tools" className="scroll-mt-24 overflow-hidden rounded-xl border border-border bg-card shadow-soft">
        <div className="border-b border-border px-5 py-4">
          <h3 className="font-semibold text-foreground">Available tools</h3>
          <p className="mt-1 text-sm text-muted-foreground">All tools are scoped to the token&rsquo;s organization.</p>
        </div>
        <dl className="divide-y divide-border">
          {MCP_TOOLS.map((tool) => (
            <div key={tool.name} className="grid gap-1 px-5 py-3 sm:grid-cols-[220px_1fr] sm:gap-4">
              <dt><code className="font-mono text-[13px] font-medium text-primary">{tool.name}</code></dt>
              <dd className="text-sm text-muted-foreground">{tool.description}</dd>
            </div>
          ))}
        </dl>
      </div>
    </section>
  )
}

function CodeBlock({ code }: { code: string }) {
  return (
    <div className="group relative">
      <pre className="overflow-x-auto rounded-lg border border-border bg-status-solid p-4 pr-12 text-[13px] leading-relaxed text-slate-100">
        <code className="font-mono">{code}</code>
      </pre>
      <div className="absolute right-2 top-2 opacity-80 transition-opacity group-hover:opacity-100">
        <CopyButton value={code} label="Copy code" />
      </div>
    </div>
  )
}

function MethodTag({ method }: { method: HttpMethod }) {
  return (
    <span
      className={cn(
        'inline-flex min-w-14 items-center justify-center rounded-md px-2 py-1 font-mono text-[11px] font-semibold tracking-wide',
        method === 'GET' && 'bg-success/10 text-success-strong',
        method === 'POST' && 'bg-primary/10 text-primary',
        method === 'PATCH' && 'bg-warning/10 text-warning-strong',
        method === 'PUT' && 'bg-primary-subtle text-primary',
        method === 'DELETE' && 'bg-destructive/10 text-destructive',
      )}
    >
      {method}
    </span>
  )
}

function SectionHeading({ icon, title }: { icon?: React.ReactNode; title: string }) {
  return (
    <h2 className="flex items-center gap-2 text-xl font-semibold tracking-tight text-foreground">
      {icon && <span className="flex h-7 w-7 items-center justify-center rounded-md bg-primary-subtle text-primary">{icon}</span>}
      {title}
    </h2>
  )
}

function ConventionCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-border bg-card p-4 shadow-soft">
      <h3 className="text-sm font-semibold text-foreground">{title}</h3>
      <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{children}</p>
    </div>
  )
}

function Mono({ children }: { children: React.ReactNode }) {
  return <code className="rounded bg-muted px-1 py-0.5 font-mono text-[12px]">{children}</code>
}

function Footer() {
  return (
    <footer className="border-t border-border pt-6 text-sm text-muted-foreground">
      Manage API tokens in <Link to="/settings" className="text-primary hover:underline">Settings</Link>.
    </footer>
  )
}
