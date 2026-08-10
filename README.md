# SpeakerWeave

[![CI](https://github.com/Brandonmchu/speakerweave/actions/workflows/ci.yml/badge.svg)](https://github.com/Brandonmchu/speakerweave/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Live demo](https://img.shields.io/badge/live-demo-0f766e.svg)](https://speakerweave.com/demo)

SpeakerWeave is an open-source conference speaker-management platform for running the program side of an event—from call for papers through review, speaker operations, content collection, scheduling, and publication. It is built for teams that want a complete product they can host as-is or adapt behind clear database, auth, email, AI, and integration boundaries.

> **Building with an AI agent? Start at [AGENTS.md](AGENTS.md).** It maps the codebase, invariants, provider swap points, reference stack, and exact quality gates.

**Live demo:** [speakerweave.com](https://speakerweave.com) — enter the seeded workspace without signing up.

- **CFP and conditional forms:** multi-page form builder, reusable contact/session fields, show/hide/require rules, routing rules, drafts, and server-side enforcement.
- **Review workflows:** weighted scale, select, and text criteria; track-aware reviewer assignment; review windows; multiple rounds; anonymized rounds; decisions; and optional AI first-pass triage with human overrides.
- **Speaker CRM:** event rosters plus an organization-wide people directory, deduplication and merge tools, notes, tags, custom fields, saved segments, history, and a sourcing pipeline.
- **Content pipeline:** speaker portal tasks, uploads, approval/needs-changes states, comments, immutable file versions, restore, reminders, and ZIP/CSV exports.
- **Agenda builder:** drag-and-drop, click-to-place, multi-day room grids, live client and server conflict detection, and conflict-free auto-place.
- **Public program:** schedule and speaker pages, responsive script/iframe widgets, read-only JSON feeds, per-session calendar downloads, and a subscribable iCal feed.
- **Full REST API:** organization-scoped API tokens, a stable `/v1` integration surface, and interactive FastAPI OpenAPI docs.
- **Hosted MCP server:** remote Streamable HTTP at `/mcp`, with bearer-token access and OAuth 2.1 discovery/PKCE for Claude and ChatGPT connector UIs.
- **Ask SpeakerWeave + Slack agent bot:** authenticated in-app chat plus signed Slack mentions and DMs, both using the same organization-scoped assistant engine and tool layer as MCP.
- **Airtable sync:** per-organization credentials and upsert syncs for Speakers and Submissions.
- **Outbox-backed email:** queued invitations and reminders, retry/idempotency handling, Resend delivery, native calendar invitations, and local `.eml` output when no provider key is configured.

## Screenshots

[![SpeakerWeave landing page](docs/images/landing.jpg)](docs/images/landing.jpg)<br>
*Explore the product and enter the seeded conference workspace without signing up.*

[![SpeakerWeave agenda builder](docs/images/agenda.jpg)](docs/images/agenda.jpg)<br>
*Build a multi-room agenda with drag-and-drop scheduling and live conflict feedback.*

[![SpeakerWeave review workflow](docs/images/review.jpg)](docs/images/review.jpg)<br>
*Run structured, track-aware reviews and make program decisions from one workspace.*

## Architecture overview

The browser never connects directly to the database. nginx serves the React/Vite build and proxies application API, public feed, MCP, and OAuth requests to FastAPI. FastAPI uses `supabase-py` as a PostgREST client with a Supabase service-role key; all tenant queries are scoped in the application by `org_id`, with database RLS enabled as a backstop. When enabled, the API lifespan also runs the email outbox worker.

```text
Browser / embedded widget / MCP client / Slack
                       |
                       v
              +-----------------+
              | nginx + React   |  static Vite SPA
              | /api /public    |  reverse proxy
              | /mcp /oauth     |
              +--------+--------+
                       |
                       v
              +-----------------+
              | FastAPI         |
              | REST + MCP      |
              | OAuth + worker  |
              +---+---------+---+
                  |         |
          PostgREST|         | HTTPS
                  v         v
       +----------------+  Resend / Anthropic /
       | Supabase       |  Slack / Airtable
       | Postgres       |
       | Storage        |
       +----------------+
```

The reference production shape is two application services—`api/` and `web/`—plus Supabase. The outbox worker is an in-process background task, not a third deployment.

## Quickstart: self-host

### Prerequisites

- Python 3.12 with `venv` and `pip`
- Node.js 20 with npm
- PostgreSQL plus `psql`; the shortest path for this implementation is a Supabase project because the API expects PostgREST, a service-role key, and Supabase Storage
- A Supabase `portal-files` Storage bucket marked **public** if you want speaker uploads or the full demo seed

The SQL uses the `btree_gist` and `citext` extensions. Migrations `014` and `015` also apply grants to Supabase's `anon`, `authenticated`, and `service_role` roles. A plain PostgreSQL deployment is viable, but it needs equivalent roles/grants and either PostgREST + compatible Storage or a replacement for the Supabase client/storage adapter.

### 1. Clone and install

```bash
git clone https://github.com/Brandonmchu/speakerweave.git
cd speakerweave

python3.12 -m venv api/venv
source api/venv/bin/activate
pip install -r api/requirements.txt

cd web
npm ci
cd ..
```

### 2. Configure the environment

```bash
cp api/.env.example api/.env
cp web/.env.example web/.env
```

At minimum, replace these values in `api/.env`:

- `SUPABASE_URL`: the PostgREST project URL
- `SUPABASE_SERVICE_API_KEY`: the service-role key; never expose it to the browser
- `SUPABASE_JWT_SECRET`: a long HS256 secret used to verify organizer JWTs and mint local demo tokens
- `PORTAL_SESSION_SECRET`: a separate long secret for speaker/reviewer/submitter session cookies

The API example contains every environment variable read by the Python code, including optional integrations and operational defaults. For local dev, leave `VITE_BACKEND_URL` empty so Vite proxies to `http://localhost:8000`; leave `VITE_CLERK_PUBLISHABLE_KEY` unset to use the built-in dev-token flow. To enable Clerk, set that build-time web variable and configure a Clerk JWT template named `supabase` that is HS256-signed with `SUPABASE_JWT_SECRET` and includes `aud: authenticated` plus an `org_id` claim.

### 3. Apply migrations in order

From the repository root, use the database's direct PostgreSQL connection string—not `SUPABASE_URL`, which is the HTTP PostgREST URL:

```bash
DATABASE_URL='postgresql://postgres:password@host:5432/postgres'

for migration in api/migrations/*.sql; do
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$migration"
done
```

The zero-padded filenames make the shell loop apply exactly `001` through `015`. All migrations are intended to be safe to re-run. Before seeding, create a public Storage bucket named `portal-files` in Supabase Dashboard → Storage.

### 4. Seed the demo workspace

```bash
cd api
source venv/bin/activate
python -m scripts.seed_demo seed
python scripts/mint_dev_token.py
```

`seed` resets and repopulates the known demo rows in `org_dev`; do not use that organization for production data. The second command prints a short-lived organizer JWT for `/dev-login`. You can also use `/demo`, which obtains the same kind of token from the deliberately public `org_dev` demo endpoint.

### 5. Run the API and web app

Terminal one:

```bash
cd api
source venv/bin/activate
uvicorn main:app --reload --host 0.0.0.0 --port 8000
```

Terminal two:

```bash
cd web
npm run dev
```

Open [http://localhost:5173/demo](http://localhost:5173/demo). API health is at [http://localhost:8000/health](http://localhost:8000/health), and FastAPI's generated docs are at [http://localhost:8000/docs](http://localhost:8000/docs).

### Deploying

Railway is the reference, but any two-service host works:

1. **API service:** root directory `api`; install with `pip install -r requirements.txt`; start with `uvicorn main:app --host 0.0.0.0 --port $PORT`; health check `/health`; run migrations as a release/one-off job.
2. **Web service:** root directory `web`; build the included Dockerfile. Set runtime `BACKEND_URL` to the public API origin with no trailing slash. Keep build-time `VITE_BACKEND_URL` empty for nginx's same-origin proxy, and pass `VITE_CLERK_PUBLISHABLE_KEY` at build time if Clerk is enabled.
3. **Cross-service URLs:** on the API, set `FRONTEND_URL` and `PUBLIC_APP_URL` to the public web origin, `PUBLIC_API_URL` to the directly reachable API origin, and `CORS_ALLOWED_ORIGINS` to an explicit comma-separated allowlist.
4. **Workers:** set `OUTBOX_WORKER_ENABLED=1` to drain queued mail. Multiple uvicorn workers are supported by optimistic row claims, although in-process rate limits are divided by the configured worker count.

## Tech stack + bring your own

| Layer | This implementation | Swap guidance |
|---|---|---|
| Database | Supabase Postgres, Supabase Storage, and `supabase-py`/PostgREST | Use whatever you'd like — just point the data layer at compatible PostgREST or replace its client and storage adapter. In this implementation, we use `SUPABASE_URL` plus `SUPABASE_SERVICE_API_KEY` with Supabase Postgres. |
| Auth | Clerk in the SPA; HS256 JWT verification in FastAPI | Use whatever you'd like — just point web token acquisition at a JWT issuer that supplies an `org_id` claim and signs with `SUPABASE_JWT_SECRET`. In this implementation, we use Clerk's `supabase` JWT template; the dev-token flow needs no external auth. |
| Email | One `send_email` boundary in `api/services/mailer.py` | Use whatever you'd like — just point the outbox worker at your provider implementation of that function. In this implementation, we use Resend and write local `.eml` files when its key is absent. |
| Hosting | Two Railway services: uvicorn API and nginx/static SPA | Use whatever you'd like — just point a Python container or uvicorn service and a static SPA host at one another. In this implementation, we use Railway. |
| AI | Optional triage and shared in-app/Slack tool-use adapters | Use whatever you'd like — just point `api/services/ai_triage.py` and `api/services/assistant.py` at your model provider. In this implementation, we use Anthropic; triage falls back to reviewer-score heuristics and the assistant returns a configuration message without a key. |
| Integrations | Optional, per-organization Airtable settings; Slack Events API bot | Use whatever you'd like — just point the integration service boundaries at your systems. In this implementation, we use Airtable and Slack, and the core conference workflows run without either. |

## Integrations

### REST API and API tokens

Open `/developers` on any deployment for the endpoint reference and copyable examples. An organizer creates a token under **Settings → API tokens**; the raw `dais_…` value is shown once and only its SHA-256 hash is stored. Send it as `x-access-token` to `/v1`:

```bash
curl https://speakerweave.com/v1/events \
  -H 'x-access-token: dais_your_api_token'
```

The stable integration API covers events, submissions/sessions, speakers/contacts, schedules, tracks, formats, rooms, content status, and evaluation summaries. The application itself is also RESTful, and its complete generated OpenAPI explorer is available at the API service's `/docs`.

### MCP for Claude and other header-capable clients

API tokens also authenticate the hosted Streamable HTTP MCP endpoint. Put this in the MCP JSON configuration used by Claude Code/Desktop or another client that supports remote HTTP servers and custom headers:

```json
{
  "mcpServers": {
    "speakerweave": {
      "type": "http",
      "url": "https://speakerweave.com/mcp",
      "headers": {
        "Authorization": "Bearer dais_your_api_token"
      }
    }
  }
}
```

For claude.ai, Claude for Work, or ChatGPT connector UIs, add a custom connector with only `https://speakerweave.com/mcp`. The client discovers `/.well-known/oauth-protected-resource` and `/.well-known/oauth-authorization-server`, dynamically registers, uses authorization code + PKCE, and opens SpeakerWeave's approval page. Paste an API token from Settings there; SpeakerWeave exchanges it for short-lived OAuth access and rotating refresh tokens without storing or forwarding the raw API token. `PUBLIC_APP_URL` must be the externally visible origin for this flow.

### Slack agent

Create a Slack app from [`api/slack_manifest.json`](api/slack_manifest.json), install it, and configure:

- `SLACK_SIGNING_SECRET`
- `SLACK_BOT_TOKEN`
- `SLACK_DEFAULT_ORG`
- `ANTHROPIC_API_KEY` for real agent answers

The manifest subscribes to `app_mention` and `message.im` and points Slack at `/api/slack/events`. The current implementation binds all incoming Slack workspaces to `SLACK_DEFAULT_ORG`; add a workspace-to-organization installation table before using one deployment for multiple Slack workspaces.

### Airtable

Configure Airtable per organization in **Settings → Integrations**. The personal access token needs access to the target base and these scopes:

- `data.records:read`
- `data.records:write`
- `schema.bases:read`
- `schema.bases:write` if SpeakerWeave should create the `Speakers` and `Submissions` tables

The sync upserts speakers by email and submissions by friendly ID. `AIRTABLE_API_KEY` and `AIRTABLE_BASE_ID` are only an environment fallback for `org_dev`; production organizations store masked, server-side configuration in `org_integrations`.

### Embeds and feeds

Settings generates script and iframe snippets for `/e/{event_slug}/schedule` and `/e/{event_slug}/speakers`, with track, accent-color, and compact-layout options. The script loader at `/public/program/{event_slug}/embed.js` auto-resizes its iframe. The same public data is available as JSON under `/public/program/{event_slug}/{schedule|speakers}`, and the complete accepted, scheduled program is available at `/public/program/{event_slug}/calendar.ics`.

## Starter prompt for your AI

```text
Clone https://github.com/Brandonmchu/speakerweave and stand it up for our organization.
Use the following instead of the reference choices:
- Hosting: [leave blank]        # e.g. Fly.io, Render, AWS, bare VM — needs a Python container + static SPA + Postgres reachability
- Database: [leave blank]       # any Postgres; run migrations/ in order; we use Supabase's PostgREST client, so either use Supabase or swap services/supabase_client
- Auth: [leave blank]           # any JWT issuer with an org_id claim (HS256, SUPABASE_JWT_SECRET); reference impl is Clerk; the dev-token flow needs nothing
- Email: [leave blank]          # any provider; implement one send function in services/mailer.py; reference impl is Resend
- Domain: [leave blank]
Then: run the test suites (api: pytest; web: vitest), seed a demo workspace, and give me the admin URL and an API token.
```

No preferences? Tell your agent: **use the reference stack exactly as documented in [AGENTS.md section (e)](AGENTS.md#e-no-stack-the-reference-path).**

## Repository layout

```text
.
├── api/
│   ├── main.py                 # FastAPI assembly, middleware, routes, MCP mount, worker lifecycle
│   ├── app/core/               # settings, logging, and response security
│   ├── routes/                 # organizer, public, REST v1, OAuth, Slack, portal, review routes
│   ├── services/               # domain services and external-provider boundaries
│   ├── migrations/             # ordered PostgreSQL schema/data migrations 001..015
│   ├── scripts/seed_demo.py    # deterministic, resettable demo workspace
│   ├── mcp_server.py           # hosted MCP tools/resources and auth boundary
│   ├── slack_manifest.json     # importable Slack app manifest
│   └── tests/                  # pytest suite
└── web/
    ├── src/                    # React application, pages, API clients, and shared logic
    ├── tests/                  # Vitest + Testing Library suite
    ├── nginx/default.conf      # SPA serving, reverse proxy, caching, and embed headers
    ├── Dockerfile              # Vite build and nginx runtime
    └── package.json            # web scripts and dependencies
```

## Tests and quality gates

```bash
# API
cd api
venv/bin/python -m pytest -q
venv/bin/ruff check .

# Web
cd ../web
npx tsc --noEmit
npm run build
npm test -- --run
```

The form-rule and schedule-conflict engines have matching Python and TypeScript fixtures so browser behavior and server validation are exercised against the same cases.

## License

SpeakerWeave is available under the [MIT License](LICENSE).

Built for the **Kill My SaaS challenge** through an agentic build process: human product direction paired with AI agents implementing, reviewing, and testing the system.
