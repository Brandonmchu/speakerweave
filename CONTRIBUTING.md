# Contributing to SpeakerWeave

Thank you for helping make conference operations more open. Bug fixes, tests, documentation, integrations, and focused product improvements are all welcome.

## Development setup

The setup below mirrors the README quickstart. You need Python 3.12, Node.js 20, npm, and a Supabase-compatible PostgreSQL/PostgREST environment.

```bash
git clone https://github.com/Brandonmchu/speakerweave.git
cd speakerweave

python3.12 -m venv api/venv
api/venv/bin/pip install -r api/requirements.txt

cd web
npm ci
cd ..

cp api/.env.example api/.env
cp web/.env.example web/.env
```

Fill in the required values described in `api/.env.example`, apply `api/migrations/*.sql` in filename order, then run the services in separate terminals:

```bash
cd api
venv/bin/python -m uvicorn main:app --reload --host 0.0.0.0 --port 8000
```

```bash
cd web
npm run dev
```

The test suites do not need external services or secrets: API tests replace the database and integrations with fakes, and `api/tests/conftest.py` blanks provider credentials before importing the app.

## The four required gates

Run these from the indicated directories before opening or updating a pull request.

1. API tests — from `api/`:

   ```bash
   venv/bin/python -m pytest -q
   ```

2. API lint — from `api/`:

   ```bash
   venv/bin/ruff check .
   ```

3. Web type and production-build verification — from `web/`:

   ```bash
   npx tsc --noEmit
   npm run build
   ```

4. Web tests — from `web/`:

   ```bash
   npm test -- --run
   ```

To run one test file:

```bash
cd api
venv/bin/python -m pytest -q tests/test_health.py

cd ../web
npm test -- --run tests/smoke.test.tsx
```

## Code conventions

- **Scope every tenant query.** The API uses a service-role database client, so every organization-owned read, write, update, and delete carries `org_id`. For a path-supplied identifier, fetch with both `id` and `org_id`, verify ownership, and return the same 404 for a missing or foreign row. Prefer `services.org_scope.fetch_scoped()` or `fetch_event()` rather than recreating this sequence.
- **Keep controls agent-drivable.** Use `web/src/ui/native-select.tsx` for any select an organizer, evaluator, speaker, browser test, or coding agent must operate. It renders a real HTML `<select>`; do not replace critical controls with portal-based pseudo-selects.
- **Make migrations additive.** Add a new zero-padded `api/migrations/NNN_description.sql` file after the current highest number. Do not edit a migration that may already have run. Keep migrations safe to apply in order and, where practical, safe to re-run.
- **Do not let best-effort side effects fail the primary write.** Audit/history rows, automatic provisioning, notifications, and similar follow-up work should log or record their own failure while preserving the successful user-requested mutation.
- **Queue transactional email.** Invitations and reminders belong in `email_outbox`; `services.outbox_worker` claims and retries them, and `services.mailer.send_email()` is the provider boundary. Preserve idempotency keys so a retry cannot double-send.

## Pull requests

Keep pull requests focused and explain the user-visible behavior and important tradeoffs. Include or update tests for behavior changes. Confirm all four gates are green, call out any new migration or environment variable, and describe how organization isolation was preserved for every affected query.
