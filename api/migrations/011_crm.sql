-- 011_crm.sql — the organization-level Speaker CRM.
--
-- Everything dais had before this migration is scoped to ONE event: a contact
-- row is `(event_id, email)`, so the same human speaking at three of your
-- conferences is three unrelated rows with three sets of notes. That is fine
-- for running an event and useless for running a speaker program, which is a
-- question about people, not about one weekend in May: "who have we worked
-- with", "who said yes last year", "who is still worth chasing".
--
-- So this adds a layer ABOVE events. `directory_people` is the org's canonical
-- person record — one row per human per org, keyed on their email — and the
-- per-event `contacts` rows become that person's appearances. Nothing about
-- contacts changes; the directory is derived from them and then enriched with
-- the things an event row has no place to keep: tags, organizer-defined custom
-- fields, internal notes, a sourcing stage and the history of how it moved.
--
-- Idempotent and purely additive: every statement is `if not exists`, no
-- existing table is altered, and the backfill at the bottom is an upsert. Safe
-- to re-run, and safe to deploy before the code that reads it.

-- ── the canonical person ───────────────────────────────────────────────────
-- `email` is the identity: UNIQUE per org, citext so Ada@x.com and ada@x.com
-- are the same person (contacts.email is citext for the same reason).
--
-- `alt_emails` is what makes a merge non-destructive. When two records turn out
-- to be one human, the loser's address moves here so their existing per-event
-- contact rows — which are still keyed on THAT address — keep resolving to the
-- surviving person. The loser's row itself is never deleted, only stamped with
-- `merged_into`; a merge stays auditable and the FKs pointing at it stay valid.
create table if not exists directory_people (
  id             uuid primary key default gen_random_uuid(),
  org_id         text not null references orgs(org_id),
  email          citext not null,
  alt_emails     text[] not null default '{}',
  first_name     text not null default '',
  last_name      text not null default '',
  company_name   text,
  title          text,
  about          text,
  photo_url      text,
  linkedin_url   text,
  twitter_url    text,
  phone          text,
  -- Free-form organizer labels. A text[] rather than a join table because the
  -- only questions asked of it are "does this person have tag X" and "what tags
  -- exist" — both cheap over an array, neither worth two extra tables.
  tags           text[] not null default '{}',
  -- Values for the org's own field definitions (see directory_custom_fields),
  -- keyed by that definition's `key`. Schema-less on purpose: an organizer
  -- inventing a field must not require a migration.
  custom         jsonb not null default '{}',
  -- Sourcing pipeline. Open stages first, terminal stages last — the order the
  -- kanban board renders left to right.
  pipeline_stage text not null default 'identified' check (pipeline_stage in
    ('researching','identified','contacted','interested','confirmed','declined')),
  -- A person is IN the directory always, but on the BOARD only once enrolled.
  -- Without this every imported contact would flood the pipeline on day one.
  in_pipeline    boolean not null default false,
  score          int,
  rationale      text,
  -- Set on the losing record of a merge; the directory hides these rows.
  merged_into    uuid references directory_people(id),
  merged_at      timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (org_id, email)
);
create index if not exists idx_directory_people_org on directory_people(org_id);
create index if not exists idx_directory_people_stage on directory_people(org_id, pipeline_stage);

-- ── internal notes ─────────────────────────────────────────────────────────
-- Organizer-only, never shown to the speaker. Append-only by design: a note is
-- a record of what was true when it was written, so it is added and deleted,
-- never edited into something the author did not say.
create table if not exists directory_notes (
  id         uuid primary key default gen_random_uuid(),
  org_id     text not null references orgs(org_id),
  person_id  uuid not null references directory_people(id) on delete cascade,
  author     text not null default '',
  body       text not null,
  created_at timestamptz not null default now()
);
create index if not exists idx_directory_notes_person on directory_notes(person_id, created_at);

-- ── stage history ──────────────────────────────────────────────────────────
-- Every pipeline move, oldest first. `from_stage` is null for the enrolment
-- itself — there was nowhere to come from. This is what turns a kanban board
-- into a record: the column tells you where someone is, this tells you how long
-- they have been stuck there and who moved them.
create table if not exists directory_stage_history (
  id         uuid primary key default gen_random_uuid(),
  org_id     text not null references orgs(org_id),
  person_id  uuid not null references directory_people(id) on delete cascade,
  from_stage text,
  to_stage   text not null,
  actor      text not null default '',
  created_at timestamptz not null default now()
);
create index if not exists idx_directory_stage_history_person
  on directory_stage_history(person_id, created_at);

-- ── saved segments ─────────────────────────────────────────────────────────
-- A segment is a saved FILTER, not a saved list of ids: "AI Experts" means
-- whatever currently matches tag=AI, and a speaker tagged tomorrow joins it
-- without anyone reopening the segment. `kind='curated'` freezes the membership
-- into `member_ids` instead, for the list that must not move.
create table if not exists directory_segments (
  id         uuid primary key default gen_random_uuid(),
  org_id     text not null references orgs(org_id),
  name       text not null,
  kind       text not null default 'dynamic' check (kind in ('dynamic','curated')),
  filter     jsonb not null default '{}',
  member_ids jsonb not null default '[]',
  created_at timestamptz not null default now(),
  unique (org_id, name)
);
create index if not exists idx_directory_segments_org on directory_segments(org_id);

-- ── organizer-defined fields ───────────────────────────────────────────────
-- The definitions behind directory_people.custom. `key` is the stable machine
-- name the jsonb is keyed on; `label` is what the organizer typed and can be
-- renamed without rewriting every person's stored value.
create table if not exists directory_custom_fields (
  id         uuid primary key default gen_random_uuid(),
  org_id     text not null references orgs(org_id),
  key        text not null,
  label      text not null,
  field_type text not null default 'text' check (field_type in ('text','dropdown','number','date')),
  options    jsonb not null default '[]',   -- ["Internal","External"] for dropdowns
  "order"    int not null default 0,
  created_at timestamptz not null default now(),
  unique (org_id, key)
);
create index if not exists idx_directory_custom_fields_org on directory_custom_fields(org_id);

-- RLS backstop, matching every other tenant table: the API uses the
-- service-role key and bypasses this, and no browser talks to PostgREST.
alter table directory_people        enable row level security;
alter table directory_notes         enable row level security;
alter table directory_stage_history enable row level security;
alter table directory_segments      enable row level security;
alter table directory_custom_fields enable row level security;

-- ── backfill ───────────────────────────────────────────────────────────────
-- Every contact the org already has, collapsed across events by lower(email).
-- `distinct on` picks one winner per (org, email); ordering by the richest row
-- first means the person inherits the most complete profile anyone ever filled
-- in, rather than whichever event happened to sort first.
--
-- `on conflict do nothing` makes this safe to re-run: a person the organizer
-- has since edited by hand is never overwritten by their oldest event row.
insert into directory_people (
  org_id, email, first_name, last_name, company_name, title, about,
  photo_url, linkedin_url, twitter_url, phone, created_at
)
select distinct on (c.org_id, lower(c.email::text))
  c.org_id,
  lower(c.email::text)::citext,
  coalesce(c.first_name, ''),
  coalesce(c.last_name, ''),
  c.company_name,
  c.title,
  c.about,
  c.photo_url,
  c.linkedin_url,
  c.twitter_url,
  c.phone,
  c.created_at
from contacts c
where c.email is not null and c.email::text <> ''
order by
  c.org_id,
  lower(c.email::text),
  -- richest first: a row with a bio and a company beats a bare name+email
  (case when coalesce(c.about, '') <> '' then 1 else 0 end
   + case when coalesce(c.company_name, '') <> '' then 1 else 0 end
   + case when coalesce(c.title, '') <> '' then 1 else 0 end
   + case when coalesce(c.first_name, '') <> '' then 1 else 0 end) desc,
  c.created_at asc
on conflict (org_id, email) do nothing;

comment on table directory_people is
  'Org-level canonical person. One row per human per org, keyed on email; the '
  'per-event contacts rows are this person''s appearances.';
comment on column directory_people.alt_emails is
  'Addresses absorbed by a merge. Per-event contact rows keyed on these still '
  'resolve to this person.';
comment on column directory_people.merged_into is
  'Set on the LOSING record of a merge. The row is kept (never deleted) so the '
  'merge stays auditable and existing foreign keys stay valid.';
