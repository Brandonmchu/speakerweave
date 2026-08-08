-- 001_init.sql — dais full schema (PLAN v2 §2)
-- Multi-tenant: org_id on EVERY tenant table. Backend uses service-role (bypasses RLS);
-- RLS is enabled as a backstop only — no direct browser access exists.
-- Status enums are CHECK constraints (cheap to evolve), not PG enums.

create extension if not exists btree_gist;
create extension if not exists citext;

-- ── tenancy ────────────────────────────────────────────────────────────────
create table if not exists orgs (
  org_id      text primary key,
  name        text not null default '',
  created_at  timestamptz not null default now()
);

create table if not exists org_memberships (
  org_id      text not null references orgs(org_id),
  user_id     text not null,
  role        text not null default 'admin' check (role in ('admin','member')),
  created_at  timestamptz not null default now(),
  primary key (org_id, user_id)
);

create table if not exists events (
  id           uuid primary key default gen_random_uuid(),
  org_id       text not null references orgs(org_id),
  name         text not null,
  slug         text not null unique,
  starts_at    timestamptz,
  ends_at      timestamptz,
  timezone     text not null default 'America/Los_Angeles',
  location     text,
  day_start    time not null default '08:00',
  day_end      time not null default '18:00',
  slot_minutes int  not null default 15 check (slot_minutes in (5,10,15,20,30,45,60)),
  settings     jsonb not null default '{}',
  created_at   timestamptz not null default now()
);
create index if not exists idx_events_org on events(org_id);

-- per-event friendly-id counters, allocated atomically
create table if not exists friendly_id_counters (
  event_id uuid not null references events(id),
  prefix   text not null,
  n        int  not null default 0,
  primary key (event_id, prefix)
);

create or replace function next_friendly_id(p_event_id uuid, p_prefix text default 'SESS')
returns int language sql as $$
  insert into friendly_id_counters (event_id, prefix, n) values (p_event_id, p_prefix, 1)
  on conflict (event_id, prefix) do update set n = friendly_id_counters.n + 1
  returning n;
$$;

-- ── people ─────────────────────────────────────────────────────────────────
create table if not exists contacts (
  id                    uuid primary key default gen_random_uuid(),
  org_id                text not null references orgs(org_id),
  event_id              uuid not null references events(id),
  email                 citext not null,
  first_name            text not null default '',
  last_name             text not null default '',
  photo_url             text,
  company_name          text,
  title                 text,
  about                 text,
  pronouns              text,
  linkedin_url          text,
  twitter_url           text,
  phone                 text,
  custom_fields         jsonb not null default '{}',
  last_portal_access_at timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  unique (event_id, email)
);
create index if not exists idx_contacts_org_event on contacts(org_id, event_id);

create table if not exists magic_link_tokens (
  id           uuid primary key default gen_random_uuid(),
  org_id       text not null references orgs(org_id),
  token_hash   text not null unique,
  purpose      text not null check (purpose in ('portal','review','demo')),
  contact_id   uuid references contacts(id),
  evaluator_id uuid,
  expires_at   timestamptz not null,
  used_at      timestamptz,
  revoked_at   timestamptz,
  created_at   timestamptz not null default now()
);
create index if not exists idx_mlt_purpose on magic_link_tokens(purpose, expires_at);

-- ── field library & forms ──────────────────────────────────────────────────
create table if not exists fields (
  id            uuid primary key default gen_random_uuid(),
  org_id        text not null references orgs(org_id),
  event_id      uuid references events(id),          -- null = org-global
  scope         text not null check (scope in ('contact','session')),
  internal_name text not null,
  public_name   text not null,
  field_type    text not null check (field_type in
    ('text','textarea','wysiwyg','number','email','phone','url','date','datetime',
     'checkbox','dropdown','multi_select','file','header','divider')),
  options       jsonb not null default '{}',          -- {choices:[], max_length, help}
  contains_pii  boolean not null default false,
  required      boolean not null default false,
  created_at    timestamptz not null default now()
);
create index if not exists idx_fields_org_event on fields(org_id, event_id);

create table if not exists forms (
  id                uuid primary key default gen_random_uuid(),
  org_id            text not null references orgs(org_id),
  event_id          uuid not null references events(id),
  slug              text not null unique,
  name              text not null,
  kind              text not null default 'cfp' check (kind in ('cfp','portal')),
  welcome_html      text not null default '',
  settings          jsonb not null default '{}',
  -- settings: {close_at, submission_limit, max_speakers, confirmation_html, branding}
  created_at        timestamptz not null default now()
);
create index if not exists idx_forms_org_event on forms(org_id, event_id);

create table if not exists form_fields (
  id             uuid primary key default gen_random_uuid(),
  org_id         text not null references orgs(org_id),
  form_id        uuid not null references forms(id) on delete cascade,
  field_id       uuid not null references fields(id),
  page           int  not null default 1 check (page between 1 and 4),
  "order"        int  not null default 0,
  label_override text,
  help_text      text,
  required       boolean not null default false,
  unique (form_id, field_id)
);

create table if not exists question_rules (
  id              uuid primary key default gen_random_uuid(),
  org_id          text not null references orgs(org_id),
  form_id         uuid not null references forms(id) on delete cascade,
  target_field_id uuid not null references fields(id),
  logic           jsonb not null
  -- {when:[{field,op,value}], match:'all'|'any', action:'show'|'hide'|'require'}
);

create table if not exists routing_rules (
  id            uuid primary key default gen_random_uuid(),
  org_id        text not null references orgs(org_id),
  form_id       uuid not null references forms(id) on delete cascade,
  "order"       int not null default 0,
  when_logic    jsonb not null,
  set_track_id  uuid,
  set_format_id uuid,
  assign_plan_id uuid
);

-- ── taxonomy ───────────────────────────────────────────────────────────────
create table if not exists tracks (
  id       uuid primary key default gen_random_uuid(),
  org_id   text not null references orgs(org_id),
  event_id uuid not null references events(id),
  name     text not null,
  color    text not null default '#4F46E5',
  "order"  int not null default 0
);
create table if not exists rooms (
  id       uuid primary key default gen_random_uuid(),
  org_id   text not null references orgs(org_id),
  event_id uuid not null references events(id),
  name     text not null,
  "order"  int not null default 0,
  capacity int
);
create table if not exists formats (
  id                   uuid primary key default gen_random_uuid(),
  org_id               text not null references orgs(org_id),
  event_id             uuid not null references events(id),
  name                 text not null,
  default_duration_min int not null default 30
);
create table if not exists levels (
  id       uuid primary key default gen_random_uuid(),
  org_id   text not null references orgs(org_id),
  event_id uuid not null references events(id),
  name     text not null,
  "order"  int not null default 0
);
create table if not exists tags (
  id       uuid primary key default gen_random_uuid(),
  org_id   text not null references orgs(org_id),
  event_id uuid not null references events(id),
  name     text not null
);

-- ── sessions (single table: CFP submission → program session) ──────────────
create table if not exists sessions (
  id                   uuid primary key default gen_random_uuid(),
  org_id               text not null references orgs(org_id),
  event_id             uuid not null references events(id),
  friendly_id_raw      int  not null,
  friendly_id          text generated always as ('SESS-' || friendly_id_raw) stored,
  title                text not null,
  description          text not null default '',
  status               text not null default 'pending' check (status in
    ('draft','pending','accept_queue','accepted','decline_queue','declined','withdrawn')),
  is_abstract          boolean not null default true,
  starts_at            timestamptz,
  ends_at              timestamptz,
  room_id              uuid references rooms(id),
  track_id             uuid references tracks(id),
  format_id            uuid references formats(id),
  level_id             uuid references levels(id),
  capacity             int,
  custom_fields        jsonb not null default '{}',
  source_form_id       uuid references forms(id),
  form_answers         jsonb not null default '{}',   -- {field_id: value}
  submitter_contact_id uuid references contacts(id),
  submitted_at         timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique (event_id, friendly_id_raw),
  check (starts_at is null or ends_at is null or ends_at > starts_at),
  -- room double-booking backstop (half-open range: back-to-back is fine)
  exclude using gist (
    room_id with =,
    tstzrange(starts_at, ends_at, '[)') with &&
  ) where (room_id is not null and starts_at is not null and ends_at is not null
           and status in ('accepted','accept_queue'))
);
create index if not exists idx_sessions_org_event on sessions(org_id, event_id);
create index if not exists idx_sessions_sched on sessions(event_id, room_id, starts_at);
create index if not exists idx_sessions_status on sessions(event_id, status);

create table if not exists session_tags (
  session_id uuid not null references sessions(id) on delete cascade,
  tag_id     uuid not null references tags(id) on delete cascade,
  primary key (session_id, tag_id)
);

create table if not exists session_participants (
  id         uuid primary key default gen_random_uuid(),
  org_id     text not null references orgs(org_id),
  session_id uuid not null references sessions(id) on delete cascade,
  contact_id uuid not null references contacts(id),
  role       text not null check (role in ('speaker','chairperson','moderator','submitter')),
  is_primary boolean not null default false,
  unique (session_id, contact_id, role)
);
create index if not exists idx_sp_contact on session_participants(contact_id);

-- ── evaluation ─────────────────────────────────────────────────────────────
create table if not exists evaluation_plans (
  id             uuid primary key default gen_random_uuid(),
  org_id         text not null references orgs(org_id),
  event_id       uuid not null references events(id),
  name           text not null,
  instructions   text not null default '',
  anonymized     boolean not null default false,
  scale          text not null default '1_5' check (scale in ('1_5','1_10')),
  criteria       jsonb not null default '[]',   -- [{name, weight}] weights sum 100
  status         text not null default 'draft' check (status in ('draft','open','closed')),
  session_filter jsonb not null default '{}',
  created_at     timestamptz not null default now()
);

create table if not exists evaluators (
  id             uuid primary key default gen_random_uuid(),
  org_id         text not null references orgs(org_id),
  plan_id        uuid not null references evaluation_plans(id) on delete cascade,
  email          citext not null,
  name           text not null default '',
  invited_at     timestamptz,
  last_active_at timestamptz,
  unique (plan_id, email)
);

create table if not exists assignments (
  id           uuid primary key default gen_random_uuid(),
  org_id       text not null references orgs(org_id),
  plan_id      uuid not null references evaluation_plans(id) on delete cascade,
  evaluator_id uuid not null references evaluators(id) on delete cascade,
  session_id   uuid not null references sessions(id) on delete cascade,
  unique (plan_id, evaluator_id, session_id)
);
create index if not exists idx_assignments_evaluator on assignments(evaluator_id);

create table if not exists reviews (
  id               uuid primary key default gen_random_uuid(),
  org_id           text not null references orgs(org_id),
  assignment_id    uuid not null unique references assignments(id) on delete cascade,
  scores           jsonb not null default '{}',   -- {criterion_name: number}
  overall          numeric,
  comment          text,
  internal_comment text,
  abstained        boolean not null default false,
  abstain_reason   text,
  is_draft         boolean not null default true,
  started_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  submitted_at     timestamptz
);

-- ── portal / tasks / files ─────────────────────────────────────────────────
create table if not exists portals (
  id           uuid primary key default gen_random_uuid(),
  org_id       text not null references orgs(org_id),
  event_id     uuid not null references events(id),
  name         text not null default 'Speakers',
  filter       jsonb not null default '{}',
  welcome_html text not null default '',
  accent_color text not null default '#4F46E5',
  logo_url     text
);

create table if not exists tasks (
  id          uuid primary key default gen_random_uuid(),
  org_id      text not null references orgs(org_id),
  event_id    uuid not null references events(id),
  portal_id   uuid references portals(id),
  session_id  uuid references sessions(id),
  kind        text not null default 'todo' check (kind in ('todo','file_request','form')),
  name        text not null,
  description text not null default '',
  link_url    text,
  due_at      timestamptz,
  required    boolean not null default false,
  form_id     uuid references forms(id),
  "order"     int not null default 0
);

create table if not exists task_assignments (
  id           uuid primary key default gen_random_uuid(),
  org_id       text not null references orgs(org_id),
  task_id      uuid not null references tasks(id) on delete cascade,
  contact_id   uuid not null references contacts(id) on delete cascade,
  status       text not null default 'todo' check (status in ('todo','submitted','approved','denied','done')),
  completed_at timestamptz,
  file_id      uuid,
  unique (task_id, contact_id)
);
create index if not exists idx_ta_contact on task_assignments(contact_id);

create table if not exists files (
  id                 uuid primary key default gen_random_uuid(),
  org_id             text not null references orgs(org_id),
  event_id           uuid not null references events(id),
  contact_id         uuid references contacts(id),
  session_id         uuid references sessions(id),
  task_assignment_id uuid references task_assignments(id),
  bucket_path        text not null,
  filename           text not null,
  mimetype           text not null,
  size               bigint not null default 0,
  version            int not null default 1,
  created_at         timestamptz not null default now()
);

create table if not exists resource_pages (
  id        uuid primary key default gen_random_uuid(),
  org_id    text not null references orgs(org_id),
  event_id  uuid not null references events(id),
  portal_id uuid references portals(id),
  title     text not null,
  body_html text not null default '',
  "order"   int not null default 0
);

-- ── comms ──────────────────────────────────────────────────────────────────
create table if not exists email_templates (
  id        uuid primary key default gen_random_uuid(),
  org_id    text not null references orgs(org_id),
  event_id  uuid not null references events(id),
  key       text not null,
  subject   text not null,
  body_html text not null,
  unique (event_id, key)
);

create table if not exists email_outbox (
  id           uuid primary key default gen_random_uuid(),
  org_id       text not null references orgs(org_id),
  event_id     uuid not null references events(id),
  contact_id   uuid references contacts(id),
  template_key text not null,
  payload      jsonb not null default '{}',
  dedupe_key   text,
  send_after   timestamptz not null default now(),
  attempts     int not null default 0,
  last_error   text,
  status       text not null default 'queued' check (status in ('queued','sent','failed','cancelled')),
  sent_at      timestamptz,
  created_at   timestamptz not null default now(),
  unique (event_id, dedupe_key)
);
create index if not exists idx_outbox_due on email_outbox(status, send_after);

create table if not exists calendar_invites (
  id           uuid primary key default gen_random_uuid(),
  org_id       text not null references orgs(org_id),
  session_id   uuid not null references sessions(id) on delete cascade,
  contact_id   uuid not null references contacts(id) on delete cascade,
  ics_uid      text not null unique,
  sequence     int not null default 0,
  last_method  text not null default 'REQUEST' check (last_method in ('REQUEST','CANCEL')),
  last_sent_at timestamptz,
  unique (session_id, contact_id)
);

-- ── misc ───────────────────────────────────────────────────────────────────
create table if not exists events_log (
  id         bigint generated always as identity primary key,
  org_id     text not null,
  event_id   uuid,
  entity     text not null,
  entity_id  text,
  action     text not null,
  created_at timestamptz not null default now()
);
create index if not exists idx_events_log on events_log(event_id, id desc);

create table if not exists api_tokens (
  id           uuid primary key default gen_random_uuid(),
  org_id       text not null references orgs(org_id),
  name         text not null,
  token_hash   text not null unique,
  scopes       text[] not null default '{}',
  created_at   timestamptz not null default now(),
  last_used_at timestamptz
);

-- ── RLS backstop (no direct client access exists; service_role bypasses) ───
do $$
declare t text;
begin
  for t in
    select tablename from pg_tables where schemaname = 'public'
  loop
    execute format('alter table public.%I enable row level security', t);
  end loop;
end $$;
