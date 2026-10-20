-- HETMA Credential — private storage bucket for certificate files.
-- Files live at certificates/<auth user id>/<random uuid>.<pdf|png|jpg>.
-- Members may upload into their own folder and read their own files; HETMA staff
-- may read every file. Nobody can list, overwrite or delete through the API.
-- Viewing always goes through short-lived signed URLs (createSignedUrl).
--
-- The local development stack has no Storage service, so this whole migration is
-- skipped there (the storage schema doesn't exist).

do $migration$
begin
  if to_regclass('storage.buckets') is null then
    raise notice 'storage schema not present: skipping certificate bucket setup (local stack)';
    return;
  end if;

  insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values ('certificates', 'certificates', false, 10485760, array['application/pdf', 'image/png', 'image/jpeg'])
  on conflict (id) do update
    set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

  execute $p$drop policy if exists certificates_insert_own on storage.objects$p$;
  execute $p$drop policy if exists certificates_read_own_or_staff on storage.objects$p$;

  execute $p$
    create policy certificates_insert_own on storage.objects for insert to authenticated
    with check (
      bucket_id = 'certificates'
      and (storage.foldername(name))[1] = auth.uid()::text
      and name ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}\.(pdf|png|jpg)$'
      and exists (select 1 from public.profiles p where p.id = auth.uid() and p.mighty_member_id is not null and not p.upload_blocked)
    )$p$;

  execute $p$
    create policy certificates_read_own_or_staff on storage.objects for select to authenticated
    using (
      bucket_id = 'certificates'
      and ((storage.foldername(name))[1] = auth.uid()::text or private.is_staff())
    )$p$;
end
$migration$;
