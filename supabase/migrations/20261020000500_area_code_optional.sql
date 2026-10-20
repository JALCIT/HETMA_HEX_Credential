-- HEx Credential: area codes are no longer shown or entered anywhere in the app.
-- The column stays (the starting list in seed.sql uses it to link providers), but
-- new areas don't need one. Unique still applies to areas that have a code.
alter table public.competency_areas alter column code drop not null;
