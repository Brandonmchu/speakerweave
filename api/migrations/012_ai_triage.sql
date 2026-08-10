-- 012_ai_triage.sql — AI first-pass triage results live on the plan.
--
-- ABS-14: a program chair with 200 abstracts wants a ranked first pass before
-- the committee reads anything. The triage run produces, per reviewable
-- submission, a short summary, a suggested disposition (advance/discuss/
-- decline), a first-pass numeric score, and the rationale behind it. Those
-- results belong to the PLAN that framed them (its criteria, its scale, its
-- reviewer pool), so they are stored on the plan rather than on each session.
--
-- Shape (jsonb):
--   {
--     "generated_at": "2026-08-10T…Z",
--     "source": "anthropic" | "heuristic",   -- heuristic = no API key configured
--     "model": "claude-haiku-4-5" | null,
--     "items": [
--       {"session_id": "…", "title": "…", "summary": "…",
--        "suggestion": "advance" | "discuss" | "decline",
--        "score": 4.2, "rationale": "…",
--        "override_score": null | 3.0}      -- human override, persisted
--     ]
--   }
--
-- ADDITIVE AND NULLABLE. NULL means "no triage has been run", which is what
-- every plan created before this migration means. Nothing selects this column
-- by name, so every existing reader is unaffected.
--
-- Idempotent: safe to run more than once.

alter table evaluation_plans add column if not exists ai_triage jsonb;

comment on column evaluation_plans.ai_triage is
  'AI first-pass triage for this plan: {generated_at, source, model, items[]}. '
  'NULL = never run. Each item carries an optional human override_score, so an '
  'admin correction survives a reload without re-running the model.';

-- PostgREST caches the schema; without this the new column 404s until reload.
select pg_notify('pgrst', 'reload schema');
