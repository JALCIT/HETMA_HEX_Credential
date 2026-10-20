-- HETMA Credential — trusted operations. Every function re-checks the caller and
-- returns { ok:false, error, message } for expected business outcomes.

-- ---------------------------------------------------------------- completion
create or replace function private.is_complete(uid uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.competency_areas where is_active and is_required)
     and not exists (
       select 1 from public.competency_areas a
        where a.is_active and a.is_required
          and not exists (
            select 1 from public.submissions s
             where s.user_id = uid and s.area_id = a.id and s.status = 'active'
               and (s.expires_on is null or s.expires_on >= current_date)))
$$;

create or replace function private.new_slug()
returns text language sql volatile set search_path = '' as $$
  select encode(extensions.gen_random_bytes(12), 'hex')
$$;

-- Brings one member's credential row in line with their uploads. Returns the new
-- status and whether it changed (callers then ask credential-sync to update Mighty).
create or replace function private.recompute_credential(uid uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  cur public.credential_status;
  done boolean := private.is_complete(uid);
begin
  insert into public.credentials (user_id) values (uid) on conflict do nothing;
  select status into cur from public.credentials where user_id = uid for update;
  if done and cur <> 'active' then
    update public.credentials
       set status = 'active', slug = coalesce(slug, private.new_slug()),
           first_earned_at = coalesce(first_earned_at, now()), earned_at = now(), ended_at = null,
           badge_desired = true, updated_at = now()
     where user_id = uid;
    perform private.audit('credential_earned', uid, 'credential', uid::text, '{}');
    return jsonb_build_object('status', 'active', 'changed', true);
  elsif not done and cur = 'active' then
    update public.credentials
       set status = 'inactive', ended_at = now(), badge_desired = false, updated_at = now()
     where user_id = uid;
    perform private.audit('credential_ended', uid, 'credential', uid::text, '{}');
    return jsonb_build_object('status', 'inactive', 'changed', true);
  end if;
  return jsonb_build_object('status', cur, 'changed', false);
end $$;

create or replace function private.fail(code text, msg text)
returns jsonb language sql immutable set search_path = '' as $$
  select jsonb_build_object('ok', false, 'error', code, 'message', msg)
$$;

-- ---------------------------------------------------------------- member: upload
create or replace function public.submit_certificate(
  p_area_id uuid, p_provider_id uuid, p_provider_other text, p_completion_date date,
  p_expires_on date, p_file_path text, p_file_name text, p_file_type text, p_attested boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := auth.uid();
  prof public.profiles;
  other text := nullif(btrim(coalesce(p_provider_other, '')), '');
  sid uuid;
  result jsonb;
  found_file boolean;
  want_ext text;
begin
  if uid is null then return private.fail('not_signed_in', 'Sign in to upload a certificate.'); end if;
  if private.rate_limited('submit', 20, interval '10 minutes') then
    return private.fail('rate_limited', 'Too many uploads in a short time. Wait a few minutes and try again.');
  end if;
  select * into prof from public.profiles where id = uid;
  if prof.id is null then return private.fail('no_profile', 'Your account isn’t set up yet. Sign out and sign in again.'); end if;
  if prof.mighty_member_id is null then
    return private.fail('no_mighty_account', 'Sign in with your HETMA community account to upload certificates.');
  end if;
  if prof.upload_blocked then return private.fail('uploads_paused', 'Uploads are paused on your account. Contact HETMA for details.'); end if;
  if p_attested is not true then
    return private.fail('attestation_required', 'Tick the statement to confirm the certificate is genuine.');
  end if;
  if not exists (select 1 from public.competency_areas where id = p_area_id and is_active) then
    return private.fail('unknown_area', 'That competency area isn’t available.');
  end if;
  if p_provider_id is not null then
    if not exists (select 1 from public.providers where id = p_provider_id and is_active) then
      return private.fail('unknown_provider', 'Pick a provider from the list, or choose Other.');
    end if;
    other := null;
  elsif other is null or char_length(other) > 120 then
    return private.fail('provider_required', 'Enter the training provider’s name.');
  end if;
  if p_completion_date is null or p_completion_date > current_date + 1 or p_completion_date < date '1990-01-01' then
    return private.fail('bad_completion_date', 'Enter the date you completed the training.');
  end if;
  if p_expires_on is not null and p_expires_on < p_completion_date then
    return private.fail('bad_expiry', 'The expiration date can’t be before the completion date.');
  end if;
  if p_file_type not in ('application/pdf', 'image/png', 'image/jpeg')
     or p_file_path is null
     or p_file_path !~ ('^' || uid::text || '/[0-9a-f-]{36}\.(pdf|png|jpg)$') then
    return private.fail('bad_file', 'Upload a PDF, PNG or JPG file.');
  end if;
  want_ext := case p_file_type when 'application/pdf' then '.pdf' when 'image/png' then '.png' else '.jpg' end;
  if p_file_name is null or char_length(btrim(p_file_name)) not between 1 and 200 or right(p_file_path, 4) <> want_ext then
    return private.fail('bad_file', 'Upload a PDF, PNG or JPG file.');
  end if;
  -- The file must really be in storage (hosted projects; the local stack has no storage
  -- schema). Only the owner can write into their folder, so existence implies ownership.
  if to_regclass('storage.objects') is not null then
    execute 'select exists (select 1 from storage.objects where bucket_id = $1 and name = $2)'
      into found_file using 'certificates', p_file_path;
    if not found_file then return private.fail('file_missing', 'The file didn’t finish uploading. Try again.'); end if;
  end if;
  if exists (select 1 from public.submissions where file_path = p_file_path) then
    return private.fail('duplicate_file', 'That file was already submitted.');
  end if;

  insert into public.submissions (user_id, area_id, provider_id, provider_other, completion_date, expires_on,
                                  file_path, file_name, file_type, attested_at)
  values (uid, p_area_id, p_provider_id, other, p_completion_date, p_expires_on,
          p_file_path, btrim(p_file_name), p_file_type, now())
  returning id into sid;

  result := private.recompute_credential(uid);
  return jsonb_build_object('ok', true, 'submission_id', sid,
                            'credential_status', result ->> 'status', 'credential_changed', (result ->> 'changed')::boolean);
end $$;

-- Re-checks the caller's own credential (e.g. after an upload expired).
create or replace function public.refresh_my_credential()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare r jsonb;
begin
  if auth.uid() is null then return private.fail('not_signed_in', 'Sign in first.'); end if;
  r := private.recompute_credential(auth.uid());
  return jsonb_build_object('ok', true, 'credential_status', r ->> 'status', 'credential_changed', (r ->> 'changed')::boolean);
end $$;

-- ---------------------------------------------------------------- public page
create or replace function public.get_public_credential(p_slug text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare c public.credentials; p public.profiles;
begin
  if p_slug is null or p_slug !~ '^[a-z0-9]{12,32}$' then return jsonb_build_object('found', false); end if;
  select * into c from public.credentials where slug = p_slug;
  if c.user_id is null then return jsonb_build_object('found', false); end if;
  select * into p from public.profiles where id = c.user_id;
  return jsonb_build_object(
    'found', true,
    'name', p.full_name,
    'status', case when c.status = 'active' and private.is_complete(c.user_id) then 'active' else 'inactive' end,
    'earned_at', c.earned_at,
    'first_earned_at', c.first_earned_at,
    'areas', case when c.status = 'active' then coalesce((
       select jsonb_agg(a.name order by a.sort_order, a.name) from public.competency_areas a
        where a.is_active and a.is_required), '[]') else '[]' end);
end $$;

-- ---------------------------------------------------------------- admin: review
create or replace function public.admin_verify_submission(p_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare s public.submissions;
begin
  if not private.is_staff() then return private.fail('forbidden', 'Only HETMA admins can do that.'); end if;
  select * into s from public.submissions where id = p_id for update;
  if s.id is null then return private.fail('not_found', 'That upload no longer exists.'); end if;
  if s.user_id = auth.uid() then return private.fail('own_upload', 'You can’t review your own upload.'); end if;
  if s.status <> 'active' then return private.fail('not_active', 'Restore the upload before verifying it.'); end if;
  if s.verified_at is not null then return jsonb_build_object('ok', true, 'already', true); end if;
  update public.submissions set verified_at = now(), verified_by = auth.uid() where id = p_id;
  perform private.audit('verify_upload', s.user_id, 'submission', p_id::text, '{}');
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
  if s.user_id = auth.uid() then return private.fail('own_upload', 'You can’t review your own upload.'); end if;
  if s.status = 'revoked' then return private.fail('already_revoked', 'That upload is already revoked.'); end if;
  update public.submissions
     set status = 'revoked', revoked_at = now(), revoked_by = auth.uid(), revoke_reason = reason, verified_at = null, verified_by = null
   where id = p_id;
  perform private.audit('revoke_upload', s.user_id, 'submission', p_id::text, jsonb_build_object('reason', reason));
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
  if s.user_id = auth.uid() then return private.fail('own_upload', 'You can’t review your own upload.'); end if;
  if s.status = 'active' then return private.fail('not_revoked', 'That upload isn’t revoked.'); end if;
  update public.submissions set status = 'active', revoked_at = null, revoked_by = null, revoke_reason = null where id = p_id;
  perform private.audit('restore_upload', s.user_id, 'submission', p_id::text, '{}');
  r := private.recompute_credential(s.user_id);
  return jsonb_build_object('ok', true, 'user_id', s.user_id, 'credential_status', r ->> 'status', 'credential_changed', (r ->> 'changed')::boolean);
end $$;

create or replace function public.admin_set_upload_block(p_user_id uuid, p_blocked boolean, p_reason text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare reason text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  if not private.is_staff() then return private.fail('forbidden', 'Only HETMA admins can do that.'); end if;
  if p_user_id = auth.uid() then return private.fail('self', 'You can’t change this on your own account.'); end if;
  if p_blocked and (reason is null or char_length(reason) > 1000) then
    return private.fail('reason_required', 'Add a reason for pausing uploads.');
  end if;
  update public.profiles set upload_blocked = p_blocked, blocked_reason = case when p_blocked then reason end where id = p_user_id;
  if not found then return private.fail('not_found', 'That member doesn’t exist.'); end if;
  perform private.audit(case when p_blocked then 'block_uploads' else 'unblock_uploads' end, p_user_id, 'profile', p_user_id::text,
                        jsonb_build_object('reason', reason));
  return jsonb_build_object('ok', true);
end $$;

-- Upload list for the admin audit view (names joined in; staff only).
create or replace function public.admin_list_submissions(p_filter text default 'unverified', p_search text default '', p_limit int default 50, p_offset int default 0)
returns table (
  id uuid, user_id uuid, member_name text, mighty_member_id bigint, membership_tier public.membership_tier,
  area_id uuid, area_name text, area_code text, provider_name text, completion_date date, expires_on date,
  file_path text, file_name text, file_type text, attested_at timestamptz, status public.submission_status,
  verified_at timestamptz, revoked_at timestamptz, revoke_reason text, submitted_at timestamptz,
  credential_status public.credential_status, upload_blocked boolean, total_count bigint)
language plpgsql stable security definer set search_path = '' as $$
declare q text := '%' || lower(btrim(coalesce(p_search, ''))) || '%';
begin
  if not private.is_staff() then return; end if;
  return query
  select s.id, s.user_id, p.full_name, p.mighty_member_id, p.membership_tier,
         a.id, a.name, a.code, coalesce(pr.name, s.provider_other || ' (other)'), s.completion_date, s.expires_on,
         s.file_path, s.file_name, s.file_type, s.attested_at, s.status,
         s.verified_at, s.revoked_at, s.revoke_reason, s.submitted_at,
         c.status, p.upload_blocked, count(*) over ()
    from public.submissions s
    join public.profiles p on p.id = s.user_id
    join public.competency_areas a on a.id = s.area_id
    left join public.providers pr on pr.id = s.provider_id
    left join public.credentials c on c.user_id = s.user_id
   where (p_filter = 'all'
       or (p_filter = 'unverified' and s.status = 'active' and s.verified_at is null)
       or (p_filter = 'verified' and s.status = 'active' and s.verified_at is not null)
       or (p_filter = 'revoked' and s.status = 'revoked'))
     and (lower(p.full_name) like q or lower(a.name) like q or lower(coalesce(pr.name, s.provider_other, '')) like q)
   order by s.submitted_at desc, s.id
   limit least(greatest(coalesce(p_limit, 50), 1), 200) offset greatest(coalesce(p_offset, 0), 0);
end $$;

create or replace function public.admin_random_unverified()
returns uuid language sql volatile security definer set search_path = '' as $$
  select s.id from public.submissions s
   where private.is_staff() and s.status = 'active' and s.verified_at is null and s.user_id <> auth.uid()
   order by random() limit 1
$$;

create or replace function public.admin_list_members(p_search text default '', p_limit int default 50, p_offset int default 0)
returns table (
  user_id uuid, full_name text, mighty_member_id bigint, membership_tier public.membership_tier, tier_checked_at timestamptz,
  upload_blocked boolean, blocked_reason text, last_sign_in_at timestamptz, staff_role public.staff_role,
  credential_status public.credential_status, earned_at timestamptz, slug text, badge_desired boolean, badge_awarded boolean,
  badge_error text, areas_done bigint, uploads_total bigint, total_count bigint)
language plpgsql stable security definer set search_path = '' as $$
declare q text := '%' || lower(btrim(coalesce(p_search, ''))) || '%';
begin
  if not private.is_staff() then return; end if;
  return query
  select p.id, p.full_name, p.mighty_member_id, p.membership_tier, p.tier_checked_at,
         p.upload_blocked, p.blocked_reason, p.last_sign_in_at, sr.role,
         c.status, c.earned_at, c.slug, c.badge_desired, c.badge_awarded, c.badge_error,
         (select count(distinct s.area_id) from public.submissions s join public.competency_areas a on a.id = s.area_id
           where s.user_id = p.id and s.status = 'active' and a.is_active and a.is_required
             and (s.expires_on is null or s.expires_on >= current_date)),
         (select count(*) from public.submissions s where s.user_id = p.id),
         count(*) over ()
    from public.profiles p
    left join public.credentials c on c.user_id = p.id
    left join public.staff_roles sr on sr.user_id = p.id
   where lower(p.full_name) like q or coalesce(p.mighty_member_id::text, '') like q
   order by p.last_sign_in_at desc nulls last, p.created_at desc
   limit least(greatest(coalesce(p_limit, 50), 1), 200) offset greatest(coalesce(p_offset, 0), 0);
end $$;

-- ---------------------------------------------------------------- team
create or replace function public.admin_set_role(p_user_id uuid, p_role text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare cur public.staff_role;
begin
  if not private.is_super_admin() then return private.fail('forbidden', 'Only super admins can manage the team.'); end if;
  if p_role is not null and p_role not in ('super_admin', 'admin') then return private.fail('bad_role', 'Pick Admin or Super admin.'); end if;
  if not exists (select 1 from public.profiles where id = p_user_id) then return private.fail('not_found', 'That member doesn’t exist.'); end if;
  select role into cur from public.staff_roles where user_id = p_user_id;
  if cur = 'super_admin' and (p_role is distinct from 'super_admin')
     and (select count(*) from public.staff_roles where role = 'super_admin') <= 1 then
    return private.fail('last_super_admin', 'Add another super admin before removing the last one.');
  end if;
  if p_role is null then
    delete from public.staff_roles where user_id = p_user_id;
  else
    insert into public.staff_roles (user_id, role, granted_by) values (p_user_id, p_role::public.staff_role, auth.uid())
    on conflict (user_id) do update set role = excluded.role, granted_by = excluded.granted_by, granted_at = now();
  end if;
  perform private.audit('set_role', p_user_id, 'profile', p_user_id::text, jsonb_build_object('from', cur, 'to', p_role));
  return jsonb_build_object('ok', true);
end $$;

-- First super admin. Run by the database owner in the SQL editor only:
--   select public.bootstrap_super_admin('12345');        -- Mighty member ID
--   select public.bootstrap_super_admin('you@example.org'); -- local dev accounts
create or replace function public.bootstrap_super_admin(p_ident text)
returns text language plpgsql security definer set search_path = '' as $$
declare uid uuid;
begin
  select p.id into uid from public.profiles p where p.mighty_member_id::text = btrim(p_ident);
  if uid is null then select u.id into uid from auth.users u where lower(u.email) = lower(btrim(p_ident)); end if;
  if uid is null then return 'No account found. Sign in to the app once, then run this again.'; end if;
  insert into public.staff_roles (user_id, role) values (uid, 'super_admin')
  on conflict (user_id) do update set role = 'super_admin';
  insert into public.audit_log (action, target_user, target_type, target_id) values ('bootstrap_super_admin', uid, 'profile', uid::text);
  return 'Super admin granted.';
end $$;

-- ---------------------------------------------------------------- grants
revoke execute on all functions in schema public from public, anon, authenticated;
revoke execute on all functions in schema private from public, anon, authenticated;
grant execute on function private.is_staff(), private.is_super_admin(), private.staff_role(), private.is_https_url(text)
  to anon, authenticated, service_role;
grant execute on function public.get_public_credential(text) to anon, authenticated;
grant execute on function
  public.submit_certificate(uuid, uuid, text, date, date, text, text, text, boolean),
  public.refresh_my_credential(),
  public.admin_verify_submission(uuid), public.admin_revoke_submission(uuid, text),
  public.admin_restore_submission(uuid), public.admin_set_upload_block(uuid, boolean, text),
  public.admin_list_submissions(text, text, int, int), public.admin_random_unverified(),
  public.admin_list_members(text, int, int), public.admin_set_role(uuid, text)
  to authenticated;
revoke execute on function public.bootstrap_super_admin(text) from service_role;
