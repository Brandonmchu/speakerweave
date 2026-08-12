alter table events add column if not exists branding jsonb not null default '{}'::jsonb;
