-- 013_session_revisions.sql — auditable title/description edits + restore.
--
-- The application treats this table as optional while an operator is between
-- deploy and migration: writes are best-effort and reads fall back to an empty
-- history until this migration is applied.

create table if not exists session_revisions (
  id         uuid primary key default gen_random_uuid(),
  org_id     text not null references orgs(org_id),
  session_id uuid not null references sessions(id) on delete cascade,
  field      text not null check (field in ('title', 'description')),
  old_value  text,
  new_value  text,
  actor      text not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_session_revisions_session
  on session_revisions(org_id, session_id, created_at desc);

alter table session_revisions enable row level security;
