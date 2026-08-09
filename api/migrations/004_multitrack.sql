-- 004_multitrack.sql — talks belong to one or more tracks; reviewers cover one
-- or more tracks.
--
-- ADDITIVE ONLY. `sessions.track_id` stays exactly where it is and keeps being
-- written as the PRIMARY track (the first one selected), so every existing
-- reader — schedule, program, v1, dashboard, taxonomy usage checks — is
-- unaffected. `session_tracks` is the full membership set, of which track_id is
-- always a member.
--
-- Idempotent: safe to run more than once.

-- ── session ↔ track membership ─────────────────────────────────────────────
create table if not exists session_tracks (
  org_id     text not null,
  session_id uuid not null references sessions(id) on delete cascade,
  track_id   uuid not null references tracks(id) on delete cascade,
  primary key (session_id, track_id)
);
create index if not exists idx_session_tracks_org on session_tracks(org_id);
create index if not exists idx_session_tracks_track on session_tracks(track_id);

-- Backfill: every session that already has a primary track becomes a
-- single-member multi-track session. Seeded/demo data included, so the new
-- reads (evaluation track chips, by_track assignment) light up immediately
-- instead of only for submissions made after this migration.
insert into session_tracks (org_id, session_id, track_id)
select s.org_id, s.id, s.track_id
from sessions s
where s.track_id is not null
on conflict (session_id, track_id) do nothing;

-- ── reviewers cover one or more tracks ─────────────────────────────────────
-- Empty array = "reviews everything", which is what every existing evaluator
-- means today, so the default needs no backfill.
alter table evaluators add column if not exists track_ids uuid[] not null default '{}';

-- ── RLS backstop (matches 001: service-role bypasses, no browser access) ────
alter table public.session_tracks enable row level security;
