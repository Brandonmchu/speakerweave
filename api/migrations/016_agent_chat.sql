-- 016_agent_chat.sql — organization-scoped in-app agent threads and messages.
--
-- The browser never talks to these tables directly. FastAPI uses the service
-- role and must still include org_id on every read and write.

create table if not exists agent_threads (
  id              uuid primary key default gen_random_uuid(),
  org_id          text not null references orgs(org_id) on delete cascade,
  user_id         text not null,
  name            text not null default 'Chat',
  status          text not null default 'active',
  visibility      text not null default 'org',
  last_message_at timestamptz not null default now(),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint agent_threads_name_length check (char_length(name) between 1 and 100),
  constraint agent_threads_status_check check (status in ('active', 'archived')),
  constraint agent_threads_visibility_check check (visibility in ('org', 'private'))
);

create index if not exists idx_agent_threads_org_last_message
  on agent_threads(org_id, last_message_at desc, id desc);

create table if not exists agent_messages (
  id                uuid primary key default gen_random_uuid(),
  thread_id         uuid not null references agent_threads(id) on delete cascade,
  org_id            text not null references orgs(org_id) on delete cascade,
  user_id           text,
  sender_type       text not null,
  content           text not null,
  metadata          jsonb not null default '{}',
  reasoning_context jsonb not null default '{}',
  response_type     text not null default 'completion',
  turn_id           text not null,
  created_at        timestamptz not null default now(),
  constraint agent_messages_sender_type_check
    check (sender_type in ('user', 'agent', 'system')),
  constraint agent_messages_response_type_check
    check (response_type in ('completion', 'error'))
);

create index if not exists idx_agent_messages_thread_created
  on agent_messages(thread_id, created_at desc, id desc);
create index if not exists idx_agent_messages_org_thread
  on agent_messages(org_id, thread_id);
create index if not exists idx_agent_messages_turn
  on agent_messages(org_id, thread_id, turn_id);

alter table agent_threads enable row level security;
alter table agent_messages enable row level security;

revoke all on table agent_threads, agent_messages from anon, authenticated;
grant select, insert, update, delete on table agent_threads, agent_messages
  to service_role;
