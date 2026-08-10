# SpeakerWeave agent guide

This is the primary handoff for AI coding agents. Read it before changing the repository, then keep the invariants and gates below intact.

## (a) What this is and where things live

SpeakerWeave is a multi-tenant, open-source conference speaker-management platform. It covers CFP forms, reviews, decisions, speaker CRM and portals, content collection, scheduling, public programs, integrations, and transactional email.

```text
api/
├── main.py                    FastAPI assembly and process lifecycle
├── auth.py                    organizer JWT verification and org boundary
├── routes/                    HTTP surfaces: organizer, public, portal, v1, OAuth, Slack
├── services/                  domain logic and external-provider boundaries
├── migrations/               ordered additive SQL migrations, NNN_description.sql
├── scripts/seed_demo.py       deterministic demo reset/seed command
├── mcp_server.py              hosted MCP surface
├── slack_manifest.json        importable Slack application manifest
└── tests/                     pytest suite, fakes, and shared fixtures

web/
├── src/pages/                 route-level React product surfaces
├── src/lib/                   API clients and shared domain/browser logic
├── src/auth/                  organizer auth provider and token bridge
├── src/ui/native-select.tsx   agent-drivable select primitive
└── tests/                     Vitest and Testing Library suite

cli/
├── pyproject.toml              standalone Python 3.11+ speakerweave-cli package
├── src/speakerweave_cli/       Click command tree, HTTP client, config, output
└── tests/                      isolated mocked-HTTP pytest suite
```

Python tests live beside their shared fakes under `api/tests/`. Browser and TypeScript tests live under `web/tests/`; parity fixtures for rule and scheduling behavior are mirrored across the API and web suites.
CLI development and its separate test gate are documented in [`cli/README.md`](cli/README.md); do not add CLI tests to the API suite.

## (b) The four gates you must keep green

Run every command before handing work back. The paths are deliberate.

1. API tests — run from `api/`:

   ```bash
   venv/bin/python -m pytest -q
   ```

2. API lint — run from `api/`:

   ```bash
   venv/bin/ruff check .
   ```

3. Web type and production-build verification — run from `web/`:

   ```bash
   npx tsc --noEmit
   npm run build
   ```

4. Web tests — run from `web/`:

   ```bash
   npm test -- --run
   ```

Tests must remain hermetic. `api/tests/conftest.py` forces fake endpoints and blanks provider keys before the application imports; never make a test depend on a developer's credentials or a live service.

## (c) Conventions that are load-bearing

### Organization scoping is a security boundary

The API's service-role Supabase client bypasses RLS. Every organization-owned select, insert, update, and delete must carry `org_id`. For a record identifier supplied by a caller, fetch with `id` **and** `org_id`, verify the returned row, and respond with the same 404 whether the row is missing or belongs to another organization. Use the shared helper:

```python
from services.org_scope import fetch_scoped

session = await fetch_scoped(
    "sessions",
    session_id,
    org_id,
    "Session",
    columns="id, title, status",
)

await db(
    lambda: supabase.table("sessions")
    .update({"status": "accepted"})
    .eq("id", session["id"])
    .eq("org_id", org_id)
    .execute(),
    "accept_session",
)
```

`fetch_scoped()` automatically includes `org_id` in narrow projections and delegates the indistinguishable-not-found check to `auth.verify_org_access()`. Parent-event access should start with `services.org_scope.fetch_event()`.

### Migrations are additive and ordered

Never rewrite an applied migration. Add the next `api/migrations/NNN_description.sql` filename after the current highest number. Make it safe to run in sequence and, where practical, idempotent with `if exists`, `if not exists`, or guarded data changes. Update fakes and tests when schema behavior changes.

### Critical controls remain native

Controls that a user, test harness, browser agent, or coding agent must manipulate use `web/src/ui/native-select.tsx`, which renders an actual `<select>`. Do not replace these with portal-based pseudo-selects. Non-critical presentation menus may still use Radix primitives.

### Side effects do not undo primary writes

Audit/history recording, background provisioning, notifications, and other secondary work are best-effort unless the endpoint explicitly promises an atomic result. Catch and log or persist side-effect failures so a successful primary mutation is not reported as failed. Never silently weaken the primary write's validation or organization scope.

### Transactional email uses the outbox

Invitation and reminder endpoints write an organization-scoped `email_outbox` row and return without waiting on a provider. `api/services/outbox_worker.py` polls due rows, claims them with an optimistic compare-and-set, retries failures with backoff, and passes the row ID as the provider idempotency key. `api/services/mailer.py:send_email()` is the only delivery boundary; without `RESEND_API_KEY` it writes `.eml` files locally. Preserve queue durability, retry state, and idempotency when changing email behavior.

## (d) ADAPTING TO YOUR ORG'S STACK

The reference providers are replaceable, but their contracts are not.

| Swap point | Change these files/functions | What must stay true |
|---|---|---|
| Database | For a PostgREST-compatible database, change client construction in `api/supabase_client.py` (`supabase`). For a different data API, also adapt `api/services/supabase_helpers.py` (`db`, `rows`, `first`) and the query call sites in `api/routes/` and `api/services/`. Replace Storage in `api/services/portal.py` (`store_upload`) and `api/services/content_pipeline.py` (`_download`) if needed. | Every tenant read/write remains scoped by `org_id`; by-ID access remains fetch → verify → indistinguishable 404; async routes must not block the event loop; immutable file versions remain addressable. |
| Auth | Any issuer is acceptable if it produces an HS256 JWT signed by `SUPABASE_JWT_SECRET` with `aud: authenticated`, `sub`, `exp`, and `org_id`. Change only `api/auth.py` (`verify_token`, `get_current_user_and_org`) and `web/src/auth/*` (`ClerkTokenBridge`, provider/pages) for an auth swap. | The API derives `org_id` from a verified token, never from request data; missing/invalid claims fail closed; foreign resources still return 404 rather than leaking existence. |
| Email | Keep `api/services/mailer.py:send_email()` as the public boundary. Replace `_send_via_resend()` and provider-specific configuration there; the caller remains `api/services/outbox_worker.py`. | No provider call blocks the primary write; the worker can retry; a stable `idempotency_key` reaches the provider; one bad recipient cannot sink an unrelated batch. |
| Hosting | Replace `api/railway.json` and/or `web/Dockerfile`; adapt `web/nginx/default.conf` if the host supplies routing. The API entrypoint is `uvicorn main:app`; the web artifact is Vite's `web/dist`. | Serve the SPA with history fallback, route backend/OAuth/MCP paths correctly, keep secrets server-only, inject `VITE_*` values at build time, expose health checks, and run migrations before code that requires them. |
| AI | Replace `api/services/ai_triage.py:_call_anthropic()` and `api/services/assistant.py:_call_anthropic()` plus their model constants/schema translation. | Triage still returns a complete, labelled heuristic result when AI is absent or fails; in-app and Slack tools still dispatch through organization-scoped `services.integration_api`; human decisions remain authoritative. |

Optional Slack and Airtable integrations are separate from these core swap points and must remain nonessential to conference workflows.

## (e) NO STACK? THE REFERENCE PATH

Use these defaults when the adopter has no provider preferences:

1. **Create a Supabase free-tier project.** Save the project URL, service-role key, database password/direct connection string, and JWT secret. In Supabase Storage, create a public bucket named `portal-files`.
2. **Run every migration in order.** From the repository root, use the direct PostgreSQL URL (not the HTTPS project URL):

   ```bash
   for migration in api/migrations/*.sql; do
     psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$migration"
   done
   ```

3. **Create a Clerk free application.** Add a JWT template named `supabase`, sign it with the same `SUPABASE_JWT_SECRET`, use HS256, set `aud` to `authenticated`, and include the active organization ID as `org_id`. Put the publishable key in `web/.env` as `VITE_CLERK_PUBLISHABLE_KEY`.
4. **Create a Resend free account.** Verify a sender/domain, then set `RESEND_API_KEY`, `MAIL_FROM_NAME`, and `MAIL_FROM_EMAIL`. Until this is done, development delivery safely writes `.eml` files to `api/outbox_dev/`.
5. **Create two Railway services from this repository.** Set one service's root directory to `api` and start it with `uvicorn main:app --host 0.0.0.0 --port $PORT`. Set the other service's root directory to `web` and deploy its included Dockerfile. Point the web service's runtime `BACKEND_URL` to the public API origin without a trailing slash.
6. **Set environment variables.** Copy the complete, commented list from `api/.env.example`; the required core values are `SUPABASE_URL`, `SUPABASE_SERVICE_API_KEY`, `SUPABASE_JWT_SECRET`, `PORTAL_SESSION_SECRET`, `FRONTEND_URL`, `PUBLIC_APP_URL`, `PUBLIC_API_URL`, and `CORS_ALLOWED_ORIGINS`. Set `OUTBOX_WORKER_ENABLED=1` when ready to send queued mail. The web variables are documented in `web/.env.example`; `VITE_*` values must be present at build time.
7. **Seed and verify.** Run the demo seed below, open `/demo`, then execute all four gates in section (b).

## (f) Demo seed and reseeding

The deterministic seed is `api/scripts/seed_demo.py`. It targets `org_dev` and the AI Builders Summit fixture IDs. Do not store production data in that organization.

From `api/`:

```bash
venv/bin/python -m scripts.seed_demo seed   # reset demo-owned rows, then repopulate
venv/bin/python -m scripts.seed_demo reset  # remove demo-owned rows only
venv/bin/python scripts/mint_dev_token.py   # print a short-lived organizer token
```

`seed` is the normal reseed command: it calls the scoped reset first and is intended to be repeatable. Use `--namespace NAME` to create/reset an isolated demo replica such as `org_replica_preview` without colliding with `org_dev`.

## (g) Integration surfaces

- **v1 API:** stable organization-token REST resources are routed in `api/routes/v1_routes.py` and implemented in `api/services/integration_api.py`.
- **CLI:** the standalone `speakerweave-cli` package and `sw` command live in `cli/`; follow [`cli/README.md`](cli/README.md) for install, commands, and its isolated pytest gate.
- **MCP:** Streamable HTTP tools/resources and bearer/OAuth auth live in `api/mcp_server.py` and mount at `/mcp` from `api/main.py`.
- **OAuth:** discovery, dynamic registration, PKCE authorization, and token rotation live in `api/routes/oauth_routes.py`, `api/services/oauth.py`, and `api/migrations/015_oauth.sql`.
- **Assistant:** shared prompts, tools, guarded execution, and the model loop live in `api/services/assistant.py`; the authenticated in-app boundary is `api/routes/assistant_routes.py` and Slack stays a thin transport in `api/services/slack_agent.py`.
- **Slack:** import `api/slack_manifest.json`; signed events enter through `api/routes/slack_routes.py` and delegate to the shared assistant engine.
- **Airtable:** per-organization configuration enters through `api/routes/integration_routes.py` and sync/upsert behavior lives in `api/services/airtable_sync.py`.
