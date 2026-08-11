-- 018_session_content_approval.sql — public-program content readiness gate.
--
-- Existing and newly created sessions remain publicly visible under the same
-- acceptance/scheduling rules until an organizer explicitly changes this.

alter table sessions
  add column if not exists content_approval text not null default 'approved'
  check (content_approval in ('draft', 'in_review', 'approved'));
