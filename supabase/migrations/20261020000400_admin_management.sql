-- HEx Credential: super admins can review their own uploads; areas and providers
-- can be deleted (or hidden when uploads depend on them); credentials are
-- re-checked for everyone after the list of areas changes.

-- ---------------------------------------------------------------- review rules
-- Admins still can't review their own uploads (someone else checks them). Super
-- admins can, and the audit entry says it was a self-review.
create or replace function private.can_review(owner uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select owner <> auth.uid() or private.is_super_admin()
$$;

create or replace function public.admin_verify_submission(p_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare s public.submissions;
begin
  if not private.is_staff() then return private.fail('forbidden', 'Only HETMA admins can do that.'); end if;
  select * into s from public.submissions where id = p_id for update;
  if s.id is null then return private.fail('not_found', 'That upload no longer exists.'); end if;
  if not private.can_review(s.user_id) then return private.fail('own_upload', 'You can’t review your own upload.'); end if;
  if s.status <> 'active' then return private.fail('not_active', 'Restore the upload before verifying it.'); end if;
  if s.verified_at is not null then return jsonb_build_object('ok', true, 'already', true); end if;
  update public.submissions set verified_at = now(), verified_by = auth.uid() where id = p_id;
  perform private.audit('verify_upload', s.user_id, 'submission', p_id::text,
    case when s.user_id = auth.uid() then '{"self_review": true}'::jsonb else '{}'::jsonb end);
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.admin_revoke_submission(p_id uuid, p_reason text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare s public.submissions; reason text := btrim(coalesce(p_reason, '')); r jsonb;
begin
  if not private.is_staff() then return private.fail('forbidden', 'Only HETMA admins can do that.'); end if;
  if private.rate_limited('review', 300, interval '5 minutes') then return private.fail('rate_limited', 'Too many review actions. Wait a few minutes.'); end if;
  if char_length(reason) not between 3 and 1000 then
    return private.fail('reason_required', 'Add a reason so the member knows why.');
  end if;
  select * into s from public.submissions where id = p_id for update;
  if s.id is null then return private.fail('not_found', 'That upload no longer exists.'); end if;
  if not private.can_review(s.user_id) then return private.fail('own_upload', 'You can’t review your own upload.'); end if;
  if s.status = 'revoked' then return private.fail('already_revoked', 'That upload is already revoked.'); end if;
  update public.submissions
     set status = 'revoked', revoked_at = now(), revoked_by = auth.uid(), revoke_reason = reason, verified_at = null, verified_by = null
   where id = p_id;
  perform private.audit('revoke_upload', s.user_id, 'submission', p_id::text,
    jsonb_build_object('reason', reason) || case when s.user_id = auth.uid() then '{"self_review": true}'::jsonb else '{}'::jsonb end);
  r := private.recompute_credential(s.user_id);
  return jsonb_build_object('ok', true, 'user_id', s.user_id, 'credential_status', r ->> 'status', 'credential_changed', (r ->> 'changed')::boolean);
end $$;

create or replace function public.admin_restore_submission(p_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare s public.submissions; r jsonb;
begin
  if not private.is_staff() then return private.fail('forbidden', 'Only HETMA admins can do that.'); end if;
  select * into s from public.submissions where id = p_id for update;
  if s.id is null then return private.fail('not_found', 'That upload no longer exists.'); end if;
  if not private.can_review(s.user_id) then return private.fail('own_upload', 'You can’t review your own upload.'); end if;
  if s.status = 'active' then return private.fail('not_revoked', 'That upload isn’t revoked.'); end if;
  update public.submissions set status = 'active', revoked_at = null, revoked_by = null, revoke_reason = null where id = p_id;
  perform private.audit('restore_upload', s.user_id, 'submission', p_id::text,
    case when s.user_id = auth.uid() then '{"self_review": true}'::jsonb else '{}'::jsonb end);
  r := private.recompute_credential(s.user_id);
  return jsonb_build_object('ok', true, 'user_id', s.user_id, 'credential_status', r ->> 'status', 'credential_changed', (r ->> 'changed')::boolean);
end $$;

-- ---------------------------------------------------------------- re-check everyone
-- After the list of required areas changes, completion can change for anyone.
-- Returns the members whose credential changed so the app can update their badges.
create or replace function public.admin_recheck_credentials()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare uid uuid; r jsonb; changed uuid[] := '{}'; n int := 0;
begin
  if not private.is_staff() then return private.fail('forbidden', 'Only HETMA admins can do that.'); end if;
  for uid in
    select user_id from public.credentials
    union select distinct user_id from public.submissions
  loop
    r := private.recompute_credential(uid);
    n := n + 1;
    if (r ->> 'changed')::boolean then changed := changed || uid; end if;
  end loop;
  if cardinality(changed) > 0 then
    perform private.audit('recheck_credentials', null, 'system', null, jsonb_build_object('checked', n, 'changed', cardinality(changed)));
  end if;
  return jsonb_build_object('ok', true, 'checked', n, 'changed_user_ids', to_jsonb(changed));
end $$;

-- ---------------------------------------------------------------- delete or hide
-- Super admins only. Areas/providers that uploads point to are hidden instead of
-- deleted, so members' records and files stay intact.
create or replace function public.admin_delete_area(p_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare a public.competency_areas; used int;
begin
  if not private.is_super_admin() then return private.fail('forbidden', 'Only super admins can delete areas.'); end if;
  select * into a from public.competency_areas where id = p_id for update;
  if a.id is null then return private.fail('not_found', 'That area no longer exists.'); end if;
  select count(*) into used from public.submissions where area_id = p_id;
  if used > 0 then
    update public.competency_areas set is_active = false where id = p_id;
    return jsonb_build_object('ok', true, 'result', 'hidden', 'uploads', used);
  end if;
  delete from public.competency_areas where id = p_id;  -- provider links cascade; audit trigger records it
  return jsonb_build_object('ok', true, 'result', 'deleted');
end $$;

create or replace function public.admin_delete_provider(p_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare p public.providers; used int;
begin
  if not private.is_super_admin() then return private.fail('forbidden', 'Only super admins can delete providers.'); end if;
  select * into p from public.providers where id = p_id for update;
  if p.id is null then return private.fail('not_found', 'That provider no longer exists.'); end if;
  select count(*) into used from public.submissions where provider_id = p_id;
  if used > 0 then
    update public.providers set is_active = false where id = p_id;
    return jsonb_build_object('ok', true, 'result', 'hidden', 'uploads', used);
  end if;
  delete from public.providers where id = p_id;
  return jsonb_build_object('ok', true, 'result', 'deleted');
end $$;

-- Hidden providers disappear from the upload form, but stay linked to areas so
-- un-hiding them restores everything. (No other changes to the upload rules.)

revoke execute on function private.can_review(uuid) from public, anon, authenticated;
revoke execute on function public.admin_recheck_credentials(), public.admin_delete_area(uuid), public.admin_delete_provider(uuid)
  from public, anon;
grant execute on function public.admin_recheck_credentials(), public.admin_delete_area(uuid), public.admin_delete_provider(uuid)
  to authenticated;
