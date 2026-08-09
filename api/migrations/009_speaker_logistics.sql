-- 009_speaker_logistics.sql — travel & logistics on the speaker record.
--
-- Flights, hotel nights, arrival times, dietary/accessibility needs and the
-- "who's picking them up from the airport" detail are things an organizer needs
-- ON the speaker, not scattered across onboarding tasks. Tasks track work to be
-- DONE (upload a headshot, sign a release); this is a durable property of the
-- person, readable at a glance from the profile drawer and editable inline.
--
-- One nullable text column: free-form on purpose. Every conference models travel
-- differently (some comp hotels, some reimburse, some do neither) and a rigid
-- schema would fit none of them. The column is additive and nullable, so every
-- existing contact row, reader and writer is unaffected.
--
-- Idempotent: safe to re-run.
alter table contacts add column if not exists logistics_notes text;

comment on column contacts.logistics_notes is
  'Free-form travel & logistics for this speaker: flights, hotel, arrival/departure, ground transport, dietary and accessibility needs.';
