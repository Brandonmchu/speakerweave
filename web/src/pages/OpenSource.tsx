/**
 * Public open-source / self-host page (route: /open-source).
 *
 * Written for someone deciding whether to clone SpeakerWeave and run it for
 * their own conference. The dark sections say what the thing is and what ships
 * in the box; the `.doc` band is the practical reference — requirements,
 * quickstart, deploying, configuration, the demo seed, the swap points, and the
 * four gates — in the same document idiom as the developers page, because this
 * is a surface that shows the repository rather than sells it.
 *
 * Every command, path, environment variable and count on this page is taken
 * from the repository itself (README.md, AGENTS.md, docs-site/, the migration
 * folder, and the two test suites). Keep it that way.
 */
import { type ReactNode } from 'react'
import { Link } from 'react-router-dom'

import { CodeBlock, DOCS_URL, REPO_URL, SiteShell, vars } from '@/pages/siteShared'

const LICENSE_HREF = `${REPO_URL}/blob/main/LICENSE`
const AGENTS_HREF = `${REPO_URL}/blob/main/AGENTS.md`
const README_HREF = `${REPO_URL}/blob/main/README.md`
const EDGE_URL = 'https://speakerweave-web.brandon-c2f.workers.dev'

const NAV_ITEMS = [
  { id: 'requirements', label: 'Requirements' },
  { id: 'quickstart', label: 'Quickstart' },
  { id: 'deploying', label: 'Deploying' },
  { id: 'configuration', label: 'Configuration' },
  { id: 'demo-seed', label: 'Demo seed' },
  { id: 'swap-points', label: 'Swap points' },
  { id: 'quality-gates', label: 'Quality gates' },
  { id: 'coding-agent', label: 'Coding agents' },
]

/** Counted from the repository: collected pytest/vitest cases, `api/migrations/*.sql`,
 *  `REST_ENDPOINTS` and `MCP_TOOLS` in `web/src/lib/apiDocsContent.ts`. */
const STATS: Array<[string, string]> = [
  ['1,059 + 632', 'API and web tests in the repository'],
  ['19', 'ordered SQL migrations, applied in filename order'],
  ['25', 'stable /v1 REST endpoints behind org-scoped tokens'],
  ['14', 'tools on the hosted MCP server'],
]

const LIFECYCLE: Array<{ title: string; body: string; kicker: string }> = [
  {
    title: 'Call for papers',
    body: 'A multi-page form builder with reusable contact and session fields, show/hide/require rules, routing rules, saved drafts, and server-side enforcement of every rule the browser applies.',
    kicker: 'forms',
  },
  {
    title: 'Review and decisions',
    body: 'Weighted scale, select, and text criteria; track-aware reviewer assignment; review windows; multiple rounds including anonymized ones; recorded decisions; and optional AI first-pass triage that a human always overrides.',
    kicker: 'review',
  },
  {
    title: 'Speaker CRM',
    body: 'Per-event rosters plus an organization-wide people directory: deduplication and merge tools, notes, tags, custom fields, saved segments, history, and a sourcing pipeline.',
    kicker: 'directory',
  },
  {
    title: 'Content collection',
    body: 'Speaker portal tasks, uploads, approval and needs-changes states, comments, immutable file versions with restore, reminders, and ZIP/CSV exports.',
    kicker: 'portal',
  },
  {
    title: 'Agenda building',
    body: 'Drag-and-drop and click-to-place across multi-day room grids, live client and server conflict detection, and conflict-free auto-place.',
    kicker: 'schedule',
  },
  {
    title: 'Public program',
    body: 'Schedule and speaker pages, responsive script and iframe widgets, read-only JSON feeds, per-session calendar downloads, and a subscribable iCal feed.',
    kicker: 'publish',
  },
  {
    title: 'Transactional email',
    body: 'Invitations and reminders are queued to an outbox. The endpoint returns without waiting on a provider; a background worker claims rows with an optimistic compare-and-set, retries with backoff, and passes the row ID as the provider idempotency key.',
    kicker: 'outbox',
  },
]

const REFERENCE_STACK: Array<[string, string]> = [
  ['FastAPI on Python 3.12', 'API, MCP server, OAuth, outbox worker'],
  ['React 19 + Vite 6 + Tailwind', 'SPA with route-level code splitting'],
  ['Supabase Postgres + Storage', 'Org-scoped data, RLS backstop, file versions'],
  ['Clerk', 'Organizer auth — dev-token flow works without it'],
  ['Resend', 'Transactional email and calendar invitations'],
  ['Railway + Cloudflare Workers', 'Reference hosting and the edge web tier'],
  ['OpenAI or Anthropic', 'Chat agent (either one), AI triage'],
  ['Airtable', 'Optional per-organization sync'],
]

const OPTIONAL_LAYERS: Array<{ layer: string; enable: ReactNode }> = [
  {
    layer: 'AI chat agent',
    enable: (
      <>
        <code>OPENAI_API_KEY</code> or <code>ANTHROPIC_API_KEY</code>
      </>
    ),
  },
  {
    layer: 'Email delivery',
    enable: (
      <>
        <code>RESEND_API_KEY</code> — without it, mail writes local <code>.eml</code> files
      </>
    ),
  },
  {
    layer: 'Clerk auth',
    enable: (
      <>
        <code>VITE_CLERK_PUBLISHABLE_KEY</code> plus a <code>supabase</code> JWT template
      </>
    ),
  },
  {
    layer: 'Slack agent',
    enable: (
      <>
        The manifest at <code>api/slack_manifest.json</code>, Events and Interactivity on the same
        URL, then <code>SLACK_BOT_TOKEN</code>, <code>SLACK_SIGNING_SECRET</code>,{' '}
        <code>SLACK_DEFAULT_ORG</code>, and the agent provider key
      </>
    ),
  },
  {
    layer: 'Airtable sync',
    enable: <>Per-organization settings in the product UI — no environment variables</>,
  },
]

const CLONE_CODE = `git clone ${REPO_URL}.git
cd speakerweave

python3.12 -m venv api/venv
source api/venv/bin/activate
pip install -r api/requirements.txt

cd web
npm ci
cd ..`

const ENV_CODE = `cp api/.env.example api/.env
cp web/.env.example web/.env`

const MIGRATE_CODE = `DATABASE_URL='postgresql://postgres:password@host:5432/postgres'

for migration in api/migrations/*.sql; do
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$migration"
done`

const SEED_CODE = `cd api
source venv/bin/activate
python -m scripts.seed_demo seed
python scripts/mint_dev_token.py`

const RUN_API_CODE = `cd api
source venv/bin/activate
uvicorn main:app --reload --host 0.0.0.0 --port 8000`

const RUN_WEB_CODE = `cd web
npm run dev`

const WORKER_CODE = `cd web && npm run build && npx wrangler deploy`

const SEED_COMMANDS_CODE = `venv/bin/python -m scripts.seed_demo seed   # reset demo-owned rows, then repopulate
venv/bin/python -m scripts.seed_demo reset  # remove demo-owned rows only
venv/bin/python scripts/mint_dev_token.py   # print a short-lived organizer token`

const GATES: Array<{ title: string; where: string; body: string; code: string }> = [
  {
    title: 'API tests',
    where: 'api/',
    body: 'The pytest suite, including cross-organization 404 coverage over every event-scoped endpoint.',
    code: 'venv/bin/python -m pytest -q',
  },
  {
    title: 'API lint',
    where: 'api/',
    body: 'Ruff over the whole Python tree.',
    code: 'venv/bin/ruff check .',
  },
  {
    title: 'Web types and production build',
    where: 'web/',
    body: 'Type-check, then prove the Vite build still produces a deployable bundle.',
    code: 'npx tsc --noEmit\nnpm run build',
  },
  {
    title: 'Web tests',
    where: 'web/',
    body: 'Vitest and Testing Library, including the rule and scheduling fixtures mirrored from the API suite.',
    code: 'npm test -- --run',
  },
]

const STARTER_PROMPT = `Clone ${REPO_URL} and stand it up for our organization.
Use the following instead of the reference choices:
- Hosting: [leave blank]        # e.g. Fly.io, Render, AWS, bare VM — needs a Python container + static SPA + Postgres reachability
- Database: [leave blank]       # any Postgres; run migrations/ in order; we use Supabase's PostgREST client, so either use Supabase or swap services/supabase_client
- Auth: [leave blank]           # any JWT issuer with an org_id claim (HS256, SUPABASE_JWT_SECRET); reference impl is Clerk; the dev-token flow needs nothing
- Email: [leave blank]          # any provider; implement one send function in services/mailer.py; reference impl is Resend
- Domain: [leave blank]
Then: run the test suites (api: pytest; web: vitest), seed a demo workspace, and give me the admin URL and an API token.`

const CLOSING_LINKS: Array<{ label: string; href?: string; to?: string }> = [
  { label: 'Source on GitHub', href: REPO_URL },
  { label: 'MIT License', href: LICENSE_HREF },
  { label: 'Documentation site', href: DOCS_URL },
  { label: 'API reference', to: '/developers' },
  { label: 'Live demo workspace', to: '/demo' },
  { label: 'AGENTS.md', href: AGENTS_HREF },
]

export function OpenSource() {
  return (
    <SiteShell badge="Open source">
      {/* ── hero ─────────────────────────────────────────────────────────── */}
      <section className="wrap hero" style={{ display: 'block', paddingTop: 34 }}>
        <div className="rv in">
          <p className="eyebrow">MIT licensed · self-hostable</p>
          <h1 className="h1 serif" style={{ maxWidth: '19ch' }}>
            Clone the whole platform and run your conference on it.
          </h1>
          <p className="lede" style={{ maxWidth: '70ch' }}>
            SpeakerWeave is a complete conference speaker-management product — call for papers,
            review, decisions, speaker CRM, content collection, scheduling, and the public program —
            not a starter kit. Two services and a Postgres database. The database, auth, email,
            hosting, and AI layers are documented swap points, so you can host it as it ships or
            point it at the stack you already run.
          </p>
          <div className="ctas">
            <a href={REPO_URL} className="btn p">
              Clone the repository →
            </a>
            <a href={DOCS_URL} className="btn t">
              Read the docs →
            </a>
          </div>

          <div className="statline">
            {STATS.map(([value, label]) => (
              <div key={label}>
                <b>{value}</b>
                <span>{label}</span>
              </div>
            ))}
          </div>
          <p className="note">
            Python and React, no proprietary services required to boot. Self-host in about fifteen
            minutes.
          </p>
        </div>
      </section>

      {/* ── what you get ─────────────────────────────────────────────────── */}
      <section className="wrap sect">
        <div className="rv">
          <p className="eyebrow">What you get</p>
          <h2 className="h2 serif">The whole program lifecycle.</h2>
          <p className="lede">
            Every stage below ships working, with the fixtures and tests that keep it that way.
          </p>
        </div>
        <div className="numtop" style={{ marginTop: 36 }}>
          {LIFECYCLE.map(({ title, body, kicker }, index) => (
            <div key={title} className="num rv" style={vars({ '--d': `${index * 0.05}s` })}>
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

      {/* ── also in the repo + reference stack ───────────────────────────── */}
      <section className="wrap sect" style={{ paddingTop: 0 }}>
        <div className="split top">
          <div className="rv">
            <p className="eyebrow">Also in the repository</p>
            <h2 className="h2 serif sm">Integration surfaces.</h2>
            <ul className="checklist">
              <li>
                <span>
                  <strong>Hosted MCP server</strong> — Streamable HTTP at{' '}
                  <code className="mono">/mcp</code> with 14 organization-scoped tools, bearer-token
                  access, and OAuth 2.1 discovery plus PKCE for the Claude and ChatGPT connector
                  UIs.
                </span>
              </li>
              <li>
                <span>
                  <strong>REST API</strong> — a stable <code className="mono">/v1</code> surface with
                  organization API tokens (only the SHA-256 hash is stored) and FastAPI&rsquo;s
                  generated OpenAPI explorer at <code className="mono">/docs</code>.
                </span>
              </li>
              <li>
                <span>
                  <strong>
                    <code className="mono">sw</code> CLI
                  </strong>{' '}
                  — a standalone Python 3.11+ package in <code className="mono">cli/</code> with its
                  own test suite: <code className="mono">pipx install ./cli</code>, then{' '}
                  <code className="mono">sw auth login</code>.
                </span>
              </li>
              <li>
                <span>
                  <strong>AI chat agent</strong> — one provider-neutral runtime shared by in-app Ask
                  and the Slack bot, with a permission gate in front of every sensitive action. It
                  stays dormant until you set a provider key.
                </span>
              </li>
              <li>
                <span>
                  <strong>Airtable sync</strong> — per-organization credentials with keyed upserts
                  for Speakers and Submissions.
                </span>
              </li>
              <li>
                <span>
                  <strong>Documentation site</strong> — the Mintlify source lives in{' '}
                  <code className="mono">docs-site/</code>; run{' '}
                  <code className="mono">mint dev</code> to preview it or connect the repository to
                  publish your own.
                </span>
              </li>
            </ul>
          </div>

          <div className="rv" style={vars({ '--d': '.1s' })}>
            <p className="eyebrow">Reference stack</p>
            <h2 className="h2 serif sm">What it runs on by default.</h2>
            <dl className="stack">
              {REFERENCE_STACK.map(([name, role]) => (
                <div key={name} className="strow">
                  <dt>{name}</dt>
                  <dd>{role}</dd>
                </div>
              ))}
            </dl>
            <p className="note">
              None of these are load-bearing choices. The contracts they satisfy are — see{' '}
              <a href="#swap-points">swap points</a> below.
            </p>
          </div>
        </div>
      </section>

      {/* ── document band ────────────────────────────────────────────────── */}
      <div className="doc">
        <div className="wrap doclayout">
          <nav className="docnav" aria-label="On this page">
            {NAV_ITEMS.map((item) => (
              <a key={item.id} href={`#${item.id}`}>
                {item.label}
              </a>
            ))}
          </nav>

          <div>
            <section className="docsect">
              <p className="eyebrow">Self-hosting</p>
              {/* The hero owns the page's `h1`; this band opens at `h2` so the
                  document keeps one heading spine. */}
              <h2>Run it yourself</h2>
              <p className="lede">
                Everything below is verified against the repository. The reference production shape
                is two application services — <code className="m">api/</code> and{' '}
                <code className="m">web/</code> — plus Postgres. The outbox worker is an in-process
                background task, not a third deployment.
              </p>
              <div className="callout">
                <b>The browser never talks to the database.</b>
                <p>
                  The web tier serves the Vite build and proxies <code className="m">/api</code>,{' '}
                  <code className="m">/public</code>, <code className="m">/mcp</code>, and the OAuth
                  paths to FastAPI. FastAPI holds the service-role key and scopes every tenant query
                  by <code className="m">org_id</code>, with database RLS enabled as a backstop.
                </p>
              </div>
            </section>

            {/* ── requirements ─────────────────────────────────────────── */}
            <section id="requirements" className="docsect">
              <h2>Requirements</h2>
              <ul className="checklist">
                <li>
                  <span>
                    <strong>Python 3.12</strong> with <code className="m">venv</code> and{' '}
                    <code className="m">pip</code>.
                  </span>
                </li>
                <li>
                  <span>
                    <strong>Node.js 20</strong> with npm.
                  </span>
                </li>
                <li>
                  <span>
                    <strong>
                      PostgreSQL and <code className="m">psql</code>
                    </strong>{' '}
                    — the shortest path for this implementation is a Supabase project, because the
                    API expects PostgREST, a service-role key, and Supabase Storage.
                  </span>
                </li>
                <li>
                  <span>
                    <strong>
                      A public <code className="m">portal-files</code> Storage bucket
                    </strong>{' '}
                    if you want speaker uploads or the full demo seed.
                  </span>
                </li>
              </ul>
              <p>
                The SQL uses the <code className="m">btree_gist</code> and{' '}
                <code className="m">citext</code> extensions, and migrations{' '}
                <code className="m">014</code> and <code className="m">015</code> apply grants to
                Supabase&rsquo;s <code className="m">anon</code>,{' '}
                <code className="m">authenticated</code>, and <code className="m">service_role</code>{' '}
                roles. A plain PostgreSQL deployment is viable, but it needs equivalent roles and
                grants plus either PostgREST and a compatible Storage service, or a replacement for
                the Supabase client and storage adapter.
              </p>
            </section>

            {/* ── quickstart ───────────────────────────────────────────── */}
            <section id="quickstart" className="docsect">
              <h2>Quickstart</h2>
              <p>
                From a clean checkout to a seeded conference workspace on{' '}
                <code className="m">localhost</code>.
              </p>

              <div style={{ marginTop: 28 }}>
                <h3>1. Clone and install</h3>
                <CodeBlock code={CLONE_CODE} label="Copy clone and install commands" />
              </div>

              <div style={{ marginTop: 28 }}>
                <h3>2. Configure the environment</h3>
                <CodeBlock code={ENV_CODE} label="Copy environment setup commands" />
                <p>
                  At minimum, replace <code className="m">SUPABASE_URL</code> (the PostgREST project
                  URL), <code className="m">SUPABASE_SERVICE_API_KEY</code> (the service-role key —
                  never expose it to the browser), <code className="m">SUPABASE_JWT_SECRET</code> (a
                  long HS256 secret used to verify organizer JWTs and mint local demo tokens), and{' '}
                  <code className="m">PORTAL_SESSION_SECRET</code> (a separate long secret for
                  speaker, reviewer, and submitter session cookies) in{' '}
                  <code className="m">api/.env</code>. Every variable the Python code reads is
                  documented in <code className="m">api/.env.example</code>.
                </p>
                <p>
                  For local development, leave <code className="m">VITE_BACKEND_URL</code> empty so
                  Vite proxies to <code className="m">http://localhost:8000</code>, and leave{' '}
                  <code className="m">VITE_CLERK_PUBLISHABLE_KEY</code> unset to use the built-in
                  dev-token flow.
                </p>
              </div>

              <div style={{ marginTop: 28 }}>
                <h3>3. Apply migrations in order</h3>
                <p>
                  From the repository root, using the database&rsquo;s direct PostgreSQL connection
                  string — not <code className="m">SUPABASE_URL</code>, which is the HTTP PostgREST
                  URL.
                </p>
                <CodeBlock code={MIGRATE_CODE} label="Copy migration commands" />
                <p>
                  The zero-padded <code className="m">NNN_description.sql</code> filenames make the
                  shell loop apply all 19 migrations in order, and every migration is intended to be
                  safe to re-run. Create the public <code className="m">portal-files</code> Storage
                  bucket before seeding.
                </p>
              </div>

              <div style={{ marginTop: 28 }}>
                <h3>4. Seed the demo workspace</h3>
                <CodeBlock code={SEED_CODE} label="Copy seed commands" />
                <p>
                  The second command prints a short-lived organizer JWT for{' '}
                  <code className="m">/dev-login</code>. You can also use{' '}
                  <code className="m">/demo</code>, which obtains the same kind of token from the
                  deliberately public <code className="m">org_dev</code> demo endpoint.
                </p>
              </div>

              <div style={{ marginTop: 28 }}>
                <h3>5. Run the API and the web app</h3>
                <p>Terminal one:</p>
                <CodeBlock code={RUN_API_CODE} label="Copy API run commands" />
                <p>Terminal two:</p>
                <CodeBlock code={RUN_WEB_CODE} label="Copy web run commands" />
                <p>
                  Open <code className="m">http://localhost:5173/demo</code>. API health is at{' '}
                  <code className="m">http://localhost:8000/health</code>, and FastAPI&rsquo;s
                  generated OpenAPI explorer is at{' '}
                  <code className="m">http://localhost:8000/docs</code>.
                </p>
              </div>
            </section>

            {/* ── deploying ────────────────────────────────────────────── */}
            <section id="deploying" className="docsect">
              <h2>Deploying</h2>
              <p>
                Two production web tiers ship in the repository, and both are exercised against the
                live site. Railway is the reference host for the API.
              </p>

              <h3 style={{ marginTop: 28 }}>Railway (reference)</h3>
              <div className="tablewrap">
                <table className="doctable">
                  <thead>
                    <tr>
                      <th style={{ width: 110 }}>Service</th>
                      <th style={{ width: 130 }}>Root directory</th>
                      <th>Build and start</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td>API</td>
                      <td>
                        <code>api</code>
                      </td>
                      <td>
                        Install with <code>pip install -r requirements.txt</code>, start with{' '}
                        <code>uvicorn main:app --host 0.0.0.0 --port $PORT</code>, health check{' '}
                        <code>/health</code>. Run migrations as a release or one-off job.
                      </td>
                    </tr>
                    <tr>
                      <td>Web</td>
                      <td>
                        <code>web</code>
                      </td>
                      <td>
                        Build the included <code>Dockerfile</code> (nginx serving the Vite build with
                        precompressed assets and the backend proxy). Set runtime{' '}
                        <code>BACKEND_URL</code> to the public API origin with no trailing slash, and
                        pass <code>VITE_CLERK_PUBLISHABLE_KEY</code> at build time if Clerk is
                        enabled.
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <p>
                On the API service, set <code className="m">FRONTEND_URL</code> and{' '}
                <code className="m">PUBLIC_APP_URL</code> to the public web origin,{' '}
                <code className="m">PUBLIC_API_URL</code> to the directly reachable API origin, and{' '}
                <code className="m">CORS_ALLOWED_ORIGINS</code> to an explicit comma-separated
                allowlist. Set <code className="m">OUTBOX_WORKER_ENABLED=1</code> to drain queued
                mail. Multiple uvicorn workers are supported by optimistic row claims, although
                in-process rate limits are divided by the configured worker count.
              </p>

              <h3 style={{ marginTop: 32 }}>Cloudflare Workers (edge web tier)</h3>
              <p>
                The web tier also ships as a Cloudflare Worker —{' '}
                <code className="m">web/wrangler.jsonc</code> plus{' '}
                <code className="m">web/worker/index.js</code> — serving static assets from the edge
                with Brotli and SPA fallback, and the same <code className="m">/api</code>,{' '}
                <code className="m">/public</code>, <code className="m">/mcp</code>, and OAuth proxy
                contract as the nginx image, SSE chat streaming included. Point{' '}
                <code className="m">BACKEND_URL</code> in <code className="m">wrangler.jsonc</code>{' '}
                at your API origin, then:
              </p>
              <CodeBlock code={WORKER_CODE} label="Copy Cloudflare deploy command" />
              <p>
                The reference edge deployment runs live at <a href={EDGE_URL}>{EDGE_URL}</a> against
                the same API and database as the primary site.
              </p>

              <div className="callout">
                <b>Any other host works too.</b>
                <p>
                  The hosting contract is deliberately small: serve the SPA with history fallback,
                  route <code className="m">/api</code>, <code className="m">/public</code>,{' '}
                  <code className="m">/mcp</code>, <code className="m">/oauth</code>, and{' '}
                  <code className="m">/.well-known/oauth-*</code> to the API origin, keep secrets
                  server-side, inject <code className="m">VITE_*</code> values at build time, expose
                  health checks, and run migrations before code that requires them. The API tier is a
                  standard Python container: <code className="m">uvicorn main:app</code>.
                </p>
              </div>
            </section>

            {/* ── configuration ────────────────────────────────────────── */}
            <section id="configuration" className="docsect">
              <h2>Configuration</h2>
              <p>
                The core product runs on four secrets and a database. Everything below is an optional
                layer that activates with configuration alone and stays dormant otherwise — no code
                changes, no dead UI.
              </p>
              <div className="tablewrap">
                <table className="doctable">
                  <thead>
                    <tr>
                      <th style={{ width: 170 }}>Layer</th>
                      <th>Enable with</th>
                    </tr>
                  </thead>
                  <tbody>
                    {OPTIONAL_LAYERS.map(({ layer, enable }) => (
                      <tr key={layer}>
                        <td>{layer}</td>
                        <td>{enable}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p>
                Server variables are documented in <code className="m">api/.env.example</code> and web
                variables in <code className="m">web/.env.example</code>. Anything named{' '}
                <code className="m">VITE_*</code> is baked into the bundle at build time, not read at
                runtime.
              </p>
            </section>

            {/* ── demo seed ────────────────────────────────────────────── */}
            <section id="demo-seed" className="docsect">
              <h2>The demo seed</h2>
              <p>
                <code className="m">api/scripts/seed_demo.py</code> builds a deterministic demo
                conference — the same AI Builders Summit workspace the public demo uses. It targets
                the <code className="m">org_dev</code> organization; do not store production data
                there. Run these from <code className="m">api/</code>:
              </p>
              <CodeBlock code={SEED_COMMANDS_CODE} label="Copy demo seed commands" />
              <p>
                <code className="m">seed</code> is the normal reseed command: it calls the scoped
                reset first and is intended to be repeatable. Pass{' '}
                <code className="m">--namespace NAME</code> to create or reset an isolated replica
                such as <code className="m">org_replica_preview</code> without colliding with{' '}
                <code className="m">org_dev</code>. The full seed needs the public{' '}
                <code className="m">portal-files</code> bucket, because it writes speaker files.
              </p>
            </section>

            {/* ── swap points ──────────────────────────────────────────── */}
            <section id="swap-points" className="docsect">
              <h2>Swap points</h2>
              <p>
                The reference providers are replaceable; their contracts are not. This table is the
                short form of <a href={AGENTS_HREF}>AGENTS.md</a> section (d), which is what a coding
                agent should read before changing any of these.
              </p>
              <div className="tablewrap">
                <table className="doctable">
                  <thead>
                    <tr>
                      <th style={{ width: 110 }}>Layer</th>
                      <th style={{ width: 300 }}>Change these</th>
                      <th>What must stay true</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td>Database</td>
                      <td>
                        <code>api/supabase_client.py</code> for a PostgREST-compatible database. For
                        a different data API, also <code>api/services/supabase_helpers.py</code> (
                        <code>db</code>, <code>rows</code>, <code>first</code>) and the query call
                        sites. Storage lives in <code>api/services/portal.py</code> (
                        <code>store_upload</code>) and <code>api/services/content_pipeline.py</code> (
                        <code>_download</code>).
                      </td>
                      <td>
                        Every tenant read and write stays scoped by <code>org_id</code>; by-ID access
                        stays fetch → verify → indistinguishable 404; async routes never block the
                        event loop; file versions stay immutable and addressable.
                      </td>
                    </tr>
                    <tr>
                      <td>Auth</td>
                      <td>
                        <code>api/auth.py</code> (<code>verify_token</code>,{' '}
                        <code>get_current_user_and_org</code>) and <code>web/src/auth/*</code>. Any
                        issuer works that produces an HS256 JWT signed with{' '}
                        <code>SUPABASE_JWT_SECRET</code> carrying <code>aud: authenticated</code>,{' '}
                        <code>sub</code>, <code>exp</code>, and <code>org_id</code>.
                      </td>
                      <td>
                        The API derives <code>org_id</code> from a verified token, never from request
                        data; missing or invalid claims fail closed; foreign resources return 404
                        rather than leaking existence.
                      </td>
                    </tr>
                    <tr>
                      <td>Email</td>
                      <td>
                        Keep <code>api/services/mailer.py:send_email()</code> as the public boundary
                        and replace <code>_send_via_resend()</code> plus its configuration. The caller
                        stays <code>api/services/outbox_worker.py</code>.
                      </td>
                      <td>
                        No provider call blocks the primary write; the worker can retry; a stable{' '}
                        <code>idempotency_key</code> reaches the provider; one bad recipient cannot
                        sink an unrelated batch.
                      </td>
                    </tr>
                    <tr>
                      <td>Hosting</td>
                      <td>
                        <code>web/Dockerfile</code> + <code>web/nginx/default.conf</code>, or{' '}
                        <code>web/wrangler.jsonc</code> + <code>web/worker/index.js</code>, and{' '}
                        <code>api/railway.json</code>. The API entrypoint is{' '}
                        <code>uvicorn main:app</code>; the web artifact is Vite&rsquo;s{' '}
                        <code>web/dist</code>.
                      </td>
                      <td>
                        Serve the SPA with history fallback, route backend, OAuth, and MCP paths
                        correctly, keep secrets server-only, inject <code>VITE_*</code> at build time,
                        expose health checks, and run migrations before code that requires them.
                      </td>
                    </tr>
                    <tr>
                      <td>AI triage</td>
                      <td>
                        <code>api/services/ai_triage.py:_call_anthropic()</code>, or{' '}
                        <code>api/services/assistant.py:_call_anthropic()</code> for the{' '}
                        <code>/api/assistant/chat</code> boundary, plus their model constants and
                        schema translation.
                      </td>
                      <td>
                        Triage still returns a complete, labelled heuristic result when AI is absent
                        or fails; <code>services/assistant.py</code> stays isolated from the agent
                        runtime; human decisions remain authoritative.
                      </td>
                    </tr>
                    <tr>
                      <td>Chat agent</td>
                      <td>
                        Provider choice is configuration, not code:{' '}
                        <code>ASSISTANT_PROVIDER</code> selects between{' '}
                        <code>api/agent/runtime_openai.py</code> and{' '}
                        <code>api/agent/runtime_anthropic.py</code>. A third provider means one new
                        runtime module implementing the same semantic event stream.
                      </td>
                      <td>
                        In-app Ask and Slack remain transports over{' '}
                        <code>agent/service.run_turn</code>; the feature stays absent by default;
                        permission-gated tools never execute without explicit approval; all tool
                        execution stays org-scoped through the shared registry.
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <p>
                Slack and Airtable sit outside these core swap points and must remain nonessential to
                the conference workflows.
              </p>
            </section>

            {/* ── quality gates ────────────────────────────────────────── */}
            <section id="quality-gates" className="docsect">
              <h2>Quality gates</h2>
              <p>
                Four commands, run before any change is handed back. The working directories are
                deliberate. Keeping these green is the whole contract for a fork.
              </p>
              {GATES.map(({ title, where, body, code }, index) => (
                <div key={title} className="docrule" style={{ marginTop: 28 }}>
                  <h3>
                    {index + 1}. {title} — from <code className="m">{where}</code>
                  </h3>
                  <p>{body}</p>
                  <CodeBlock code={code} label={`Copy ${title.toLowerCase()} command`} />
                </div>
              ))}
              <p style={{ marginTop: 28 }}>
                Tests must stay hermetic. <code className="m">api/tests/conftest.py</code> forces fake
                endpoints and blanks provider keys before the application imports, so no test depends
                on a developer&rsquo;s credentials or a live service. The form-rule and
                schedule-conflict engines have matching Python and TypeScript fixtures, so browser
                behavior and server validation are exercised against the same cases. The{' '}
                <code className="m">sw</code> CLI keeps its own isolated pytest suite under{' '}
                <code className="m">cli/tests/</code>.
              </p>
            </section>

            {/* ── coding agents ────────────────────────────────────────── */}
            <section id="coding-agent" className="docsect">
              <h2>Pointing a coding agent at it</h2>
              <p>
                <a href={AGENTS_HREF}>AGENTS.md</a> is the primary handoff for AI coding agents, and
                it is written to be read first: the repository map, the invariants that are
                load-bearing (organization scoping as a security boundary, additive ordered
                migrations, native critical controls, side effects that never undo primary writes,
                the email outbox, Slack as a transport over the agent runtime), the swap-point table
                above with its contracts, a reference path for adopters with no stack preferences,
                the demo seed commands, and the four gates.
              </p>
              <p>
                A workable starting prompt, from the <a href={README_HREF}>README</a> — fill in the
                blanks you care about and leave the rest:
              </p>
              <CodeBlock code={STARTER_PROMPT} label="Copy starter prompt" />
              <p>
                No preferences? Tell your agent to use the reference stack exactly as documented in{' '}
                <a href={`${AGENTS_HREF}#e-no-stack-the-reference-path`}>AGENTS.md section (e)</a>:
                Supabase, Clerk, Resend, and two Railway services, in that order.
              </p>
              <div className="callout">
                <b>The agent surfaces are optional in both directions.</b>
                <p>
                  Your fork can be adopted by an agent, and it can also serve one: the hosted MCP
                  server at <code className="m">/mcp</code> exposes the same conference operations to
                  Claude, ChatGPT, or any Streamable-HTTP client, and the in-app agent stays entirely
                  absent until you supply a key.
                </p>
              </div>
            </section>
          </div>
        </div>
      </div>

      {/* ── close ────────────────────────────────────────────────────────── */}
      <section className="wrap sect">
        <div className="rv">
          <p className="eyebrow">Everything you need</p>
          <h2 className="h2 serif sm">Start here.</h2>
          <div className="linkgrid">
            {CLOSING_LINKS.map(({ label, href, to }) =>
              to ? (
                <Link key={label} to={to}>
                  <span>{label}</span>
                  <span aria-hidden="true">→</span>
                </Link>
              ) : (
                <a key={label} href={href}>
                  <span>{label}</span>
                  <span aria-hidden="true">→</span>
                </a>
              )
            )}
          </div>
          <p className="note" style={{ marginTop: 26 }}>
            SpeakerWeave is released under the MIT License. Fork it, rename it, run it for your
            event.
          </p>
        </div>
      </section>
    </SiteShell>
  )
}
