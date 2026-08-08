-- 003_invites_hash.sql — idempotency fingerprint for the calendar-invite ledger.
--
-- services/invites.py stores a sha256 of the calendar-relevant fields only
-- (starts_at, ends_at, title, location). A resend whose hash matches the stored
-- one is a no-op: no mail, no SEQUENCE bump. Anything else and clients would
-- either spam the speaker or ignore the update (SEQUENCE that never advances).
--
-- Null is the "never sent / cancelled" state, so no backfill is needed: the
-- first send after this migration writes the row's first hash.

alter table calendar_invites add column if not exists last_payload_hash text;
