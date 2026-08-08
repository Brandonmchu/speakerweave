# dais — open-source conference speaker management

An open-source alternative to [Sessionboard](https://www.sessionboard.com/) — the "program layer"
for conferences: collect talk submissions, review and score them, schedule the accepted ones,
onboard speakers, and publish the program. Built for the **"Kill My SaaS 1"** hackathon.

### ▶︎ Live demo (one click, no sign-up)

**https://web-production-54adad.up.railway.app/demo** → **Enter the demo workspace**

Drops you straight into a seeded "AI Builders Summit 2026" workspace — 20 speakers, ~20
submissions, a scheduled agenda with a real conflict, an evaluation round with reviews, and
onboarding tasks in progress. Explore everything without an account.

Prefer your own workspace? Sign in with Google/email at `/sign-in` (Clerk) and create an event.

---

## The six things it does (the walkthrough)

Mirroring the requirements walkthrough, in the order an organizer works:

1. **Custom submission forms with conditional logic** — a real form builder (`Forms`): drag fields
   from a library across pages, add plain-English rules ("Show *Link to a prior talk* when *Have
   you spoken before?* is checked"), category routing, drafts, and per-user submission limits. The
   public form (`/submit/:slug`) evaluates rules live in the browser **and** the server enforces
   them — a hidden field's answer can't be smuggled in.
2. **Self-service speaker portal** (`/portal/:token`, magic-link) — speakers edit their bio and
   headshot, see their sessions and acceptance status, and work a task checklist: mark to-dos done,
   upload slides and documents. One identity per speaker (no separate "portal username").
3. **Automated communications** (`Comms`) — email templates with merge tags, compose to a filtered
   audience (by role + submission status) with a live recipient count and rendered preview, and a
   send log. Plus **real RFC-5545 calendar invites** (`.ics`, `METHOD:REQUEST`/`CANCEL`, sequence
   bumps) delivered as native Gmail/Outlook invitations — something Sessionboard itself doesn't do.
4. **Evaluation workflows** (`Evaluation`) — create a plan with weighted criteria, invite
   reviewers by magic link, assign submissions, and watch a live summary (progress, top sessions,
   the "thought-provoking" widest-disagreement pick). Reviewers score on a clean **save-and-next**
   scorecard (`/review/:token`). Accept/decline right from the summary.
5. **Drag-and-drop scheduling with conflict detection** (`Agenda`) — a room × time grid; drag
   accepted sessions from the unscheduled tray. Conflicts (room double-books, speaker in two rooms)
   highlight **live while you drag**, before you drop — Sessionboard only recomputes on refresh.
   Views: List / Day / Week / Rooms / Conflicts.
6. **Real-time onboarding dashboard** (`Dashboard`) — every speaker × their outstanding tasks,
   submission funnel, last portal visit, and last email, sorted so the people who still owe you
   something float to the top.

## Why it's better than the incumbent (not just a clone)

- **Real calendar invites.** Verified across Sessionboard's 226 help-center articles: they have
  none. dais sends native `.ics` invitations with proper cancel/reschedule semantics.
- **Live conflict detection while dragging** — theirs updates on page refresh.
- **Conditional logic on any field type** with show/hide/require + routing — theirs triggers on
  only checkbox/dropdown/number and is show-only.
- **Self-serve, one-click demo** — theirs is a "request a demo" enterprise wall (a pain the
  customer called out on video). dais is fast and instantly explorable.
- **One speaker identity** — kills their single biggest documented support burden (Email ≠ Portal
  Username).

## Architecture

```
web  ── React 19 + Vite + TypeScript + Tailwind (shadcn-style UI), one API client
 │        Clerk for organizer auth; magic-link cookie sessions for speakers/reviewers
 ▼
api  ── FastAPI (Python 3.12), supabase-py (PostgREST, no ORM)
 │        service-role key → org isolation enforced in the app layer on every query
 ▼
Supabase Postgres  ── 33-table schema modeled on Sessionboard's own API shapes
                       (single sessions table for CFP abstracts → program sessions;
                        accept_queue/decline_queue staging statuses; friendly IDs;
                        a room-overlap EXCLUDE constraint as a scheduling backstop)
Supabase Storage   ── portal-files bucket (headshots, slides)
Resend             ── transactional email (see "Deferred" below)
Railway            ── two services (api + web), git-push deploys
```

**Auth model:** organizers authenticate with Clerk; the backend verifies a Supabase-shaped HS256
JWT carrying `org_id`. Speakers and reviewers never sign up — they follow a single-use magic link
that mints a short-lived HttpOnly session cookie. The demo entrance issues a scoped read/write
token for the shared demo org.

**Tenancy:** the backend uses Supabase's service-role key (bypassing RLS by design), so every
query carries an `org_id` predicate and every by-id fetch is verify-or-404. RLS is enabled as a
backstop. This was independently audited (see below).

## Quality

- **~450 backend tests, ~200 frontend tests**, all green; ruff + tsc + build clean.
- **Independently reviewed by Codex** (adversarial code review): tenant isolation, auth, the
  Python↔TypeScript rule-engine parity, ICS correctness, and data-safety. Findings were triaged
  and the real ones fixed (HTML sanitization, ICS cancel state, answer whitelisting, server-side
  form limits, and more) — see `../research/10-codex-code-review.md`.
- **Verified end-to-end in a real browser** on the live deployment — see `../research/`.
- The conditional-logic engine runs **identically** in the browser and on the server, proven
  against one shared fixture file, so what a speaker sees is exactly what validates.

## Local development

```bash
# API  (Python 3.12)
cd api && python3 -m venv venv && source venv/bin/activate
pip install -r requirements.txt
cp .env.example .env    # fill SUPABASE_URL / SUPABASE_SERVICE_API_KEY / SUPABASE_JWT_SECRET / CLERK_SECRET_KEY
python main.py                       # :8000  (docs at /docs)

# Web
cd web && npm install
cp .env.example .env    # VITE_CLERK_PUBLISHABLE_KEY / VITE_BACKEND_URL (empty = same-origin proxy)
npm run dev                          # :5173

# Seed the demo workspace
cd api && venv/bin/python -m scripts.seed_demo seed
# A local dev token for the demo org: venv/bin/python scripts/mint_dev_token.py
```

Database migrations are plain, idempotent SQL in `api/migrations/` (applied via the Supabase CLI).

## Deferred (honest status)

- **Real email delivery** is the one external dependency not yet wired — it needs a verified
  **Resend** sending domain. Until then, the mailer writes messages to a dev outbox and records
  them in the send log, and every magic-link invite is **also surfaced as a copyable link** in the
  admin UI, so the reviewer and portal flows work end-to-end without delivered email. Turning on
  real delivery is a one-line transport change.
- A few Sessionboard surfaces are intentionally out of scope per the brief (payments, multi-
  language, sponsors/exhibitors, the AI features) — the focus is the six firm requirements, done
  well and fast.

## License

MIT.
