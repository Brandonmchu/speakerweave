-- 010_speaker_status.sql — the organizer's manual speaker workflow status.
--
-- A speaker moves through a workflow the software cannot infer: you INVITE them
-- to speak, they CONFIRM, or they DECLINE. Dais already derives two related
-- signals — whether a portal magic link was ever minted ("invited to the
-- portal") and how much onboarding is outstanding — but neither answers the
-- question a program chair actually asks a week out: "who has said yes?"
--
-- So this is a deliberately separate, manually-set column. Derived state stays
-- derived; this is the organizer's own record of where the conversation stands,
-- and it is what the roster filter narrows by.
--
-- NULL is a first-class value: "not set yet". Most of a roster is NULL on day
-- one, and forcing a default would fabricate a workflow position nobody chose.
-- The CHECK therefore allows NULL alongside the three real states.
--
-- Idempotent: safe to re-run. Additive and nullable, so every existing contact
-- row, reader and writer is unaffected.
alter table contacts add column if not exists speaker_status text;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'contacts_speaker_status_check'
  ) then
    alter table contacts add constraint contacts_speaker_status_check
      check (speaker_status is null or speaker_status in ('invited', 'confirmed', 'declined'));
  end if;
end $$;

comment on column contacts.speaker_status is
  'Organizer-set speaker workflow status: invited | confirmed | declined. NULL = not set. '
  'Distinct from the derived portal-invite and onboarding-progress signals.';
