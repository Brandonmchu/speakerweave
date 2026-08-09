-- Submitter self-service: a CFP author manages their own submissions via a
-- magic link. Reuses magic_link_tokens with a new purpose, 'submitter', so the
-- token scopes to one contact (and thus one event's submissions) without a
-- Clerk account. The only schema change needed is widening the purpose CHECK;
-- everything else (contact_id, expires_at, revoked_at) already fits.
alter table magic_link_tokens drop constraint if exists magic_link_tokens_purpose_check;
alter table magic_link_tokens add constraint magic_link_tokens_purpose_check
  check (purpose in ('portal','review','demo','submitter'));
