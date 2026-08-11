-- 019_slack_agent_threads.sql — Slack conversations mapped to agent threads.
--
-- The browser never talks to this table directly. FastAPI uses the service
-- role and must still include org_id on every read and write.

create table if not exists slack_agent_threads (
  id              uuid primary key default gen_random_uuid(),
  org_id          text not null references orgs(org_id) on delete cascade,
  channel_id      text not null,
  thread_ts       text not null,
  channel_type    text not null default 'channel',
  agent_thread_id uuid not null references agent_threads(id) on delete cascade,
  created_at      timestamptz not null default now(),
  unique (channel_id, thread_ts)
);

create index if not exists idx_slack_agent_threads_channel_created
  on slack_agent_threads(channel_id, created_at desc);

alter table slack_agent_threads enable row level security;

revoke all on table slack_agent_threads from anon, authenticated;
grant select, insert, update, delete on table slack_agent_threads to service_role;
