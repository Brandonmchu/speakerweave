-- 002_seed_dev.sql — minimal dev/demo data for the Day-0 vertical slice (idempotent)

insert into orgs (org_id, name) values ('org_dev', 'Dais Dev Org')
on conflict (org_id) do nothing;

insert into events (id, org_id, name, slug, starts_at, ends_at, timezone, location)
values ('11111111-1111-1111-1111-111111111111', 'org_dev', 'AI Builders Summit 2026',
        'ai-builders-summit', '2026-10-12 08:00-07', '2026-10-13 18:00-07',
        'America/Los_Angeles', 'San Francisco, CA')
on conflict (slug) do nothing;

insert into tracks (id, org_id, event_id, name, color, "order") values
  ('22222222-2222-2222-2222-222222222201','org_dev','11111111-1111-1111-1111-111111111111','Engineering','#4F46E5',0),
  ('22222222-2222-2222-2222-222222222202','org_dev','11111111-1111-1111-1111-111111111111','Product','#0EA5E9',1),
  ('22222222-2222-2222-2222-222222222203','org_dev','11111111-1111-1111-1111-111111111111','Research','#10B981',2)
on conflict (id) do nothing;

insert into rooms (id, org_id, event_id, name, "order", capacity) values
  ('33333333-3333-3333-3333-333333333301','org_dev','11111111-1111-1111-1111-111111111111','Main Stage',0,400),
  ('33333333-3333-3333-3333-333333333302','org_dev','11111111-1111-1111-1111-111111111111','Workshop A',1,80),
  ('33333333-3333-3333-3333-333333333303','org_dev','11111111-1111-1111-1111-111111111111','Workshop B',2,80)
on conflict (id) do nothing;

insert into formats (id, org_id, event_id, name, default_duration_min) values
  ('44444444-4444-4444-4444-444444444401','org_dev','11111111-1111-1111-1111-111111111111','Keynote',45),
  ('44444444-4444-4444-4444-444444444402','org_dev','11111111-1111-1111-1111-111111111111','Talk',30),
  ('44444444-4444-4444-4444-444444444403','org_dev','11111111-1111-1111-1111-111111111111','Lightning Talk',15),
  ('44444444-4444-4444-4444-444444444404','org_dev','11111111-1111-1111-1111-111111111111','Workshop',90)
on conflict (id) do nothing;

insert into fields (id, org_id, event_id, scope, internal_name, public_name, field_type, options, required) values
  ('55555555-5555-5555-5555-555555555501','org_dev','11111111-1111-1111-1111-111111111111','session','abstract','Abstract','textarea','{"max_length":2000,"help":"One paragraph. What will the audience learn?"}',true),
  ('55555555-5555-5555-5555-555555555502','org_dev','11111111-1111-1111-1111-111111111111','session','track_choice','Track','dropdown','{"choices":["Engineering","Product","Research"]}',true),
  ('55555555-5555-5555-5555-555555555503','org_dev','11111111-1111-1111-1111-111111111111','session','format_choice','Session format','dropdown','{"choices":["Keynote","Talk","Lightning Talk","Workshop"]}',true),
  ('55555555-5555-5555-5555-555555555504','org_dev','11111111-1111-1111-1111-111111111111','session','takeaways','Key takeaways','textarea','{"max_length":1000,"help":"3-5 bullets the attendee leaves with."}',false),
  ('55555555-5555-5555-5555-555555555505','org_dev','11111111-1111-1111-1111-111111111111','contact','speaker_bio','Speaker bio','textarea','{"max_length":1500}',true),
  ('55555555-5555-5555-5555-555555555506','org_dev','11111111-1111-1111-1111-111111111111','session','prior_talk','Link to a prior talk recording','url','{"help":"Only shown if you have spoken before."}',false),
  ('55555555-5555-5555-5555-555555555507','org_dev','11111111-1111-1111-1111-111111111111','session','spoken_before','Have you spoken at a conference before?','checkbox','{}',false)
on conflict (id) do nothing;

insert into forms (id, org_id, event_id, slug, name, kind, welcome_html, settings) values
  ('66666666-6666-6666-6666-666666666601','org_dev','11111111-1111-1111-1111-111111111111',
   'call-for-speakers','Call for Speakers','cfp',
   '<h2>Welcome to the AI Builders Summit CFP!</h2><p>Sessions for our agenda will be selected from these submissions. Submissions close soon — we can''t wait to read yours.</p>',
   '{"submission_limit":3,"max_speakers":6}')
on conflict (id) do nothing;

insert into form_fields (org_id, form_id, field_id, page, "order", required)
select 'org_dev','66666666-6666-6666-6666-666666666601', f.id, 3, r.o, f.required
from fields f
join (values
  ('55555555-5555-5555-5555-555555555501',0),
  ('55555555-5555-5555-5555-555555555502',1),
  ('55555555-5555-5555-5555-555555555503',2),
  ('55555555-5555-5555-5555-555555555504',3),
  ('55555555-5555-5555-5555-555555555507',4),
  ('55555555-5555-5555-5555-555555555506',5)
) as r(fid,o) on r.fid::uuid = f.id
on conflict (form_id, field_id) do nothing;

-- question rule: prior_talk only shows when spoken_before is checked
insert into question_rules (id, org_id, form_id, target_field_id, logic) values
  ('77777777-7777-7777-7777-777777777701','org_dev','66666666-6666-6666-6666-666666666601',
   '55555555-5555-5555-5555-555555555506',
   '{"when":[{"field":"55555555-5555-5555-5555-555555555507","op":"eq","value":true}],"match":"all","action":"show"}')
on conflict (id) do nothing;
