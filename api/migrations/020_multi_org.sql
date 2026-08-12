-- 020_multi_org.sql — multi-organization support for organizers and speakers.
--
-- Additive only. Two independent halves:
--
-- 1. Organizer switching. `org_memberships` already exists (001_init) but
--    nothing has ever read or written it. The list endpoint asks "which orgs
--    does THIS user belong to?", which is a lookup on the trailing half of the
--    (org_id, user_id) primary key — index it. Memberships themselves accrue
--    from auth._ensure_org_exists on first authentication, so no data
--    migration is needed or attempted here.
--
-- 2. Speaker cross-org sign-in. A speaker has no account: the emailed token IS
--    the credential, and it is bound to a verified EMAIL rather than to one
--    org's contact row (the whole point is to span orgs). magic_link_tokens
--    therefore learns a nullable `email` column and a new purpose,
--    'portal_choose'. The purpose is deliberately distinct from 'portal' so
--    this token can never be redeemed for a session at /public/session/redeem
--    — it can only be exchanged, after re-deriving the email's own contacts,
--    at /public/portal/choose.

create index if not exists idx_org_memberships_user on org_memberships(user_id);

alter table magic_link_tokens add column if not exists email text;

alter table magic_link_tokens drop constraint if exists magic_link_tokens_purpose_check;
alter table magic_link_tokens add constraint magic_link_tokens_purpose_check
  check (purpose in ('portal','review','demo','submitter','portal_choose'));

-- The cross-org sign-in lookup is by email ALONE (every org, every event); the
-- only existing index is unique (event_id, email), which cannot serve it.
create index if not exists idx_contacts_email on contacts(email);
