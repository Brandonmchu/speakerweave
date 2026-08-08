import { Link } from 'react-router-dom'
import { ArrowLeft, KeyRound, Sparkles, Terminal } from 'lucide-react'

import {
  API_BASE_PATH,
  AUTH_EXAMPLE,
  AUTH_HEADER,
  DOC_SECTIONS,
  type DocEndpoint,
} from '@/lib/apiDocsContent'
import { cn } from '@/lib/utils'
import { CopyButton } from '@/pages/Forms'

/**
 * Public API reference (route: /developers). No auth required to READ the docs.
 *
 * Documents the read-only /v1 API — the surface that lets dais "speak
 * Sessionboard's protocol": x-access-token auth, the list + /search endpoint
 * pairs, the {data, page, pageSize, total} envelope, friendly IDs and paging.
 * Styling matches the restyled admin app (blue primary, white cards, soft
 * shadows) and reuses the Forms CopyButton for copy-to-clipboard on code blocks.
 */
export function ApiDocs() {
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

          {DOC_SECTIONS.map((section) => (
            <section key={section.id} id={section.id} className="scroll-mt-24 space-y-5">
              <h2 className="text-xl font-semibold tracking-tight text-foreground">{section.title}</h2>
              {section.endpoints.map((endpoint) => (
                <EndpointCard key={endpoint.id} endpoint={endpoint} />
              ))}
            </section>
          ))}

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
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-sm font-semibold text-primary-foreground">
            d
          </div>
          <span className="text-lg font-semibold tracking-tight text-foreground">dais</span>
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

const NAV_STATIC = [
  { id: 'base-url', label: 'Base URL' },
  { id: 'authentication', label: 'Authentication' },
  { id: 'conventions', label: 'Conventions' },
]

function SideNav() {
  return (
    <nav className="hidden md:block">
      <div className="sticky top-20 space-y-6 text-sm">
        <div className="space-y-1">
          {NAV_STATIC.map((item) => (
            <a
              key={item.id}
              href={`#${item.id}`}
              className="block rounded-md px-2 py-1 text-muted-foreground transition-colors hover:bg-hover hover:text-primary"
            >
              {item.label}
            </a>
          ))}
        </div>
        {DOC_SECTIONS.map((section) => (
          <div key={section.id} className="space-y-1">
            <p className="px-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {section.title}
            </p>
            {section.endpoints.map((endpoint) => (
              <a
                key={endpoint.id}
                href={`#${endpoint.id}`}
                className="flex items-center gap-2 rounded-md px-2 py-1 text-muted-foreground transition-colors hover:bg-hover hover:text-primary"
              >
                <MethodTag method={endpoint.method} compact />
                <span className="truncate">{endpoint.title}</span>
              </a>
            ))}
          </div>
        ))}
      </div>
    </nav>
  )
}

function Hero() {
  return (
    <section className="space-y-4">
      <h1 className="text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">
        dais API
      </h1>
      <p className="max-w-2xl text-base text-muted-foreground">
        A thin, read-only HTTP API over your program data — events, sessions and speakers. Point any
        script or integration at it with a single API key.
      </p>

      <div className="flex items-start gap-3 rounded-xl border border-primary/20 bg-primary-subtle/60 p-4">
        <Sparkles className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
        <div className="text-sm text-foreground">
          <p className="font-semibold text-primary">dais speaks Sessionboard&rsquo;s protocol.</p>
          <p className="mt-1 text-muted-foreground">
            The contract mirrors Sessionboard&rsquo;s own public API — a <code className="rounded bg-card px-1 py-0.5 font-mono text-[13px]">{API_BASE_PATH}</code>{' '}
            base path, the <code className="rounded bg-card px-1 py-0.5 font-mono text-[13px]">{AUTH_HEADER}</code>{' '}
            auth header, and a <code className="rounded bg-card px-1 py-0.5 font-mono text-[13px]">POST /resource/search</code>{' '}
            twin for every list — so tools already built for Sessionboard need barely any change.
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
        All endpoints are relative to your dais host and live under the{' '}
        <code className="rounded bg-muted px-1 py-0.5 font-mono text-[13px]">{API_BASE_PATH}</code>{' '}
        prefix.
      </p>
      <CodeBlock code={`https://your-dais-host${API_BASE_PATH}`} />
    </section>
  )
}

function Authentication() {
  return (
    <section id="authentication" className="scroll-mt-24 space-y-3">
      <SectionHeading icon={<KeyRound className="h-4 w-4" />} title="Authentication" />
      <p className="text-sm text-muted-foreground">
        Every request must carry an API key in the{' '}
        <code className="rounded bg-muted px-1 py-0.5 font-mono text-[13px]">{AUTH_HEADER}</code>{' '}
        header. Keys look like{' '}
        <code className="rounded bg-muted px-1 py-0.5 font-mono text-[13px]">dais_…</code> and are
        scoped to a single organization — a key can only read its own org&rsquo;s data. A missing or
        invalid key returns <code className="font-mono text-[13px]">401</code>.
      </p>
      <CodeBlock code={AUTH_EXAMPLE} />
      <div className="rounded-lg border border-border bg-card p-4 text-sm text-muted-foreground shadow-soft">
        <span className="font-medium text-foreground">Getting a key:</span> generate one from{' '}
        <span className="font-medium text-foreground">Settings → API tokens</span> in the dais app.
        The raw key is shown once at creation — store it somewhere safe. Tokens are read-only; write
        access is not exposed by the public API.
      </div>
    </section>
  )
}

function Conventions() {
  return (
    <section id="conventions" className="scroll-mt-24 space-y-4">
      <SectionHeading title="Conventions" />
      <div className="grid gap-4 sm:grid-cols-3">
        <ConventionCard title="Pagination">
          List and search endpoints take <Mono>page</Mono> (1-based, 1&ndash;999) and{' '}
          <Mono>pageSize</Mono> (default 25, max 100). Responses wrap results in{' '}
          <Mono>{'{ data, page, pageSize, total }'}</Mono>.
        </ConventionCard>
        <ConventionCard title="Friendly IDs">
          Alongside the UUID <Mono>id</Mono>, every session carries a human-readable{' '}
          <Mono>friendly_id</Mono> such as <Mono>SESS-8</Mono>.
        </ConventionCard>
        <ConventionCard title="Fields & search">
          Fields are <Mono>snake_case</Mono>, timestamps ISO-8601 UTC. Each collection offers a{' '}
          <Mono>GET</Mono> list and a <Mono>POST …/search</Mono> twin with filters in the body.
        </ConventionCard>
      </div>
    </section>
  )
}

function EndpointCard({ endpoint }: { endpoint: DocEndpoint }) {
  return (
    <article
      id={endpoint.id}
      className="scroll-mt-24 overflow-hidden rounded-xl border border-border bg-card shadow-soft"
    >
      <div className="border-b border-border px-5 py-4">
        <div className="flex flex-wrap items-center gap-3">
          <MethodTag method={endpoint.method} />
          <code className="min-w-0 break-all font-mono text-sm text-foreground">{endpoint.path}</code>
        </div>
        <h3 className="mt-3 text-base font-semibold text-foreground">{endpoint.title}</h3>
        <p className="mt-1 text-sm text-muted-foreground">{endpoint.description}</p>
      </div>

      {endpoint.params && endpoint.params.length > 0 && (
        <div className="border-b border-border px-5 py-4">
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Parameters
          </p>
          <dl className="space-y-2">
            {endpoint.params.map((param) => (
              <div key={param.name} className="flex flex-col gap-0.5 sm:flex-row sm:gap-3">
                <dt className="flex shrink-0 items-baseline gap-2 sm:w-40">
                  <code className="font-mono text-[13px] font-medium text-foreground">
                    {param.name}
                  </code>
                  <span className="text-xs text-muted-foreground">{param.type}</span>
                </dt>
                <dd className="text-sm text-muted-foreground">{param.description}</dd>
              </div>
            ))}
          </dl>
        </div>
      )}

      <div className="grid gap-5 px-5 py-4 lg:grid-cols-2">
        <div className="space-y-2">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Request
          </p>
          <CodeBlock code={endpoint.request} />
        </div>
        <div className="space-y-2">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Response
          </p>
          <CodeBlock code={endpoint.response} />
        </div>
      </div>
    </article>
  )
}

/* -------------------------------------------------------------------------- */
/* Small building blocks                                                      */
/* -------------------------------------------------------------------------- */

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

function MethodTag({ method, compact = false }: { method: 'GET' | 'POST'; compact?: boolean }) {
  return (
    <span
      className={cn(
        'inline-flex items-center justify-center rounded-md font-mono font-semibold tracking-wide',
        compact ? 'px-1.5 py-0.5 text-[10px]' : 'px-2 py-1 text-xs',
        method === 'GET'
          ? 'bg-success/10 text-success-strong'
          : 'bg-primary/10 text-primary'
      )}
    >
      {method}
    </span>
  )
}

function SectionHeading({ icon, title }: { icon?: React.ReactNode; title: string }) {
  return (
    <h2 className="flex items-center gap-2 text-xl font-semibold tracking-tight text-foreground">
      {icon && (
        <span className="flex h-7 w-7 items-center justify-center rounded-md bg-primary-subtle text-primary">
          {icon}
        </span>
      )}
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
      Need write access or webhooks?{' '}
      <Link to="/" className="text-primary hover:underline">
        Head back to the dais app
      </Link>{' '}
      — the public API is read-only by design.
    </footer>
  )
}
