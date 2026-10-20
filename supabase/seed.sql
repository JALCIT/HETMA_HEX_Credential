-- Starting list of competency areas and providers.
-- PLACEHOLDERS until HETMA finalizes the list. Admins can edit everything in the
-- Admin workspace (Areas tab) without code changes.
-- Applied by the local stack automatically. On a hosted test project, paste this
-- once into the SQL Editor after the migrations if you want the same starting list.

insert into public.competency_areas (code, name, description, sort_order) values
  ('NET', 'Networking for AV', 'IP networking fundamentals for AV systems: VLANs, multicast, QoS, AV-over-IP.', 10),
  ('AUD', 'Audio systems & microphones', 'Wireless and wired microphones, DSP, loudspeakers and room audio.', 20),
  ('VID', 'Video & display systems', 'Displays, projection, signal distribution and switching.', 30),
  ('CTL', 'Control systems & programming', 'Room control platforms, touch panels and programming basics.', 40),
  ('CAP', 'Lecture capture & streaming', 'Recording, streaming and video platforms used in teaching.', 50),
  ('UC', 'Conferencing & unified communications', 'Zoom Rooms, Microsoft Teams Rooms and hybrid meeting spaces.', 60),
  ('SIG', 'Digital signage', 'Content management and signage players.', 70),
  ('SUP', 'Customer support & service management', 'Support center practice, ticketing and service management.', 80),
  ('DES', 'AV design & standards', 'Industry standards and AV system design.', 90),
  ('ADA', 'Accessibility & ADA compliance', 'Assistive listening, captioning and accessible room design.', 100)
on conflict (code) do nothing;

insert into public.providers (name) values
  ('Netgear AV Academy'), ('Cisco Networking Academy'), ('Shure Audio Institute'), ('Biamp'), ('QSC Training'),
  ('Crestron'), ('Extron'), ('Panopto'), ('YuJa'), ('Kaltura'), ('Zoom'), ('Microsoft Teams Rooms'), ('Poly'),
  ('Four Winds Interactive'), ('Appspace'), ('HDI'), ('ITIL (PeopleCert)'), ('AVIXA')
on conflict (name) do nothing;

insert into public.provider_areas (provider_id, area_id)
select p.id, a.id from (values
  ('Netgear AV Academy', 'NET'), ('Cisco Networking Academy', 'NET'),
  ('Shure Audio Institute', 'AUD'), ('Biamp', 'AUD'), ('QSC Training', 'AUD'),
  ('Crestron', 'VID'), ('Extron', 'VID'), ('Crestron', 'CTL'), ('Extron', 'CTL'), ('QSC Training', 'CTL'),
  ('Panopto', 'CAP'), ('YuJa', 'CAP'), ('Kaltura', 'CAP'),
  ('Zoom', 'UC'), ('Microsoft Teams Rooms', 'UC'), ('Poly', 'UC'),
  ('Four Winds Interactive', 'SIG'), ('Appspace', 'SIG'),
  ('HDI', 'SUP'), ('ITIL (PeopleCert)', 'SUP'),
  ('AVIXA', 'DES'), ('AVIXA', 'ADA')
) v(provider, code)
join public.providers p on p.name = v.provider
join public.competency_areas a on a.code = v.code
on conflict do nothing;
