-- 007_content_pipeline.sql — content-collection pipeline (PLAN: content depth)
--
-- Two capabilities layer onto the existing portal file flow:
--   1. Versioning — reuses files.version (already declared in 001_init.sql). A
--      re-upload of a task deliverable inserts a NEW files row with an
--      incremented version rather than overwriting, so history is preserved and
--      prior versions stay downloadable. This migration only adds the lookup
--      index; no schema change is required for versioning itself.
--   2. Per-item comments — a small thread keyed to a content item
--      (a task_assignment) so an organizer can leave feedback ("headshot too
--      low-res") and the speaker can reply from their portal.
--
-- Idempotent: safe to re-run (create ... if not exists / add column if not exists).

-- ── per-item comments / feedback ─────────────────────────────────────────────
create table if not exists content_comments (
  id                 uuid primary key default gen_random_uuid(),
  org_id             text not null references orgs(org_id),
  event_id           uuid references events(id),
  -- the content item the thread hangs off: a task_assignment (file deliverable)
  task_assignment_id uuid not null references task_assignments(id) on delete cascade,
  -- the speaker who owns the item (denormalized for cheap speaker-side scoping)
  contact_id         uuid references contacts(id) on delete cascade,
  author_role        text not null default 'organizer' check (author_role in ('organizer','speaker')),
  author_label       text,
  body               text not null,
  created_at         timestamptz not null default now()
);
create index if not exists idx_content_comments_assignment
  on content_comments(task_assignment_id, created_at);
create index if not exists idx_content_comments_org on content_comments(org_id);

-- ── versioning support ───────────────────────────────────────────────────────
-- files.version exists since 001; keep this add idempotent for older DBs and add
-- the index the version-history lookup rides.
alter table files add column if not exists version int not null default 1;
create index if not exists idx_files_assignment on files(task_assignment_id, version);

-- ── RLS backstop (service-role bypasses; no direct browser access exists) ─────
alter table content_comments enable row level security;
