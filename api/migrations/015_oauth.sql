-- 015_oauth.sql — OAuth 2.1 public clients and opaque MCP credentials.
--
-- Raw client grants, authorization codes, access tokens, and refresh tokens
-- never coexist here: only SHA-256 hashes of bearer values are persisted.
-- FastAPI is the sole data path and uses the service_role client.

create table if not exists oauth_clients (
  id            uuid primary key default gen_random_uuid(),
  client_id     text not null unique,
  redirect_uris jsonb not null,
  name          text not null,
  created_at    timestamptz not null default now(),
  constraint oauth_clients_redirect_uris_array
    check (jsonb_typeof(redirect_uris) = 'array')
);

create table if not exists oauth_codes (
  code_hash      text primary key,
  client_id      text not null references oauth_clients(client_id) on delete cascade,
  org_id         text not null references orgs(org_id) on delete cascade,
  redirect_uri   text not null,
  code_challenge text not null,
  expires_at     timestamptz not null,
  used_at        timestamptz
);

create index if not exists idx_oauth_codes_expiry
  on oauth_codes(expires_at);

create table if not exists oauth_tokens (
  token_hash   text primary key,
  refresh_hash text not null unique,
  client_id    text not null references oauth_clients(client_id) on delete cascade,
  org_id       text not null references orgs(org_id) on delete cascade,
  expires_at   timestamptz not null,
  revoked_at   timestamptz,
  created_at   timestamptz not null default now()
);

create index if not exists idx_oauth_tokens_org_client
  on oauth_tokens(org_id, client_id);
create index if not exists idx_oauth_tokens_expiry
  on oauth_tokens(expires_at);

alter table oauth_clients enable row level security;
alter table oauth_codes enable row level security;
alter table oauth_tokens enable row level security;

-- These internal authorization tables must never be reachable with browser
-- anon/authenticated credentials. The service role is explicit because new
-- Supabase projects no longer auto-expose newly-created public tables.
revoke all on table oauth_clients, oauth_codes, oauth_tokens from anon, authenticated;
grant select, insert, update, delete on table oauth_clients, oauth_codes, oauth_tokens
  to service_role;
