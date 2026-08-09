-- 008_eval_windows.sql — an evaluation plan has a review window.
--
-- ABS-01: a plan already carries its name, criteria and reviewer pool, but it
-- had no dates, so "reviews are open Oct 1 – Oct 10" lived only in the invite
-- email. These two columns make the window part of the plan, and the reviewer
-- write path enforces it.
--
-- ADDITIVE AND NULLABLE. NULL means "no restriction", which is exactly what
-- every plan created before this migration means — seeded/demo plans keep
-- accepting reviews with no dates set, and every existing reader is unaffected
-- because nothing selects these columns by name.
--
-- Idempotent: safe to run more than once.

alter table evaluation_plans add column if not exists opens_at  timestamptz;
alter table evaluation_plans add column if not exists closes_at timestamptz;

comment on column evaluation_plans.opens_at is
  'Reviewers may not save a review before this instant. NULL = no lower bound.';
comment on column evaluation_plans.closes_at is
  'Reviewers may not save a review after this instant. NULL = no upper bound.';

-- PostgREST caches the schema; without this the new columns 404 until reload.
select pg_notify('pgrst', 'reload schema');
