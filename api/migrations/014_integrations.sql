-- 014_integrations.sql — organization-owned integration configuration.
--
-- Secrets live only in the server-side JSONB config. The organizer API returns
-- a masked token hint and never exposes this column directly.

create table if not exists org_integrations (
  org_id     text not null references orgs(org_id) on delete cascade,
  kind       text not null,
  config     jsonb not null default '{}',
  updated_at timestamptz not null default now(),
  unique (org_id, kind)
);

create index if not exists idx_org_integrations_org
  on org_integrations(org_id);

alter table org_integrations enable row level security;

-- The browser never talks to PostgREST directly. The FastAPI service-role
-- client is the only data path, and every query still carries org_id.
revoke all on table org_integrations from anon, authenticated;
grant select, insert, update, delete on table org_integrations to service_role;
