-- 005_program_published.sql — record WHEN an organizer publishes the programme.
--
-- ADDITIVE ONLY, and deliberately NOT a visibility gate. The public schedule
-- (routes/program_routes.py) serves accepted+scheduled sessions regardless of
-- this column, and must keep doing so — a publish flag that defaulted to
-- "unpublished" would hide a schedule that already works today. This timestamp
-- is an explicit, visible affirmation plus an audit of when "Publish schedule"
-- was pressed; nothing reads it to decide whether the public page renders.
--
-- Idempotent: safe to run more than once. Nullable, no default, so existing
-- events are simply "never explicitly published" until the organizer says so.

alter table events add column if not exists program_published_at timestamptz;
