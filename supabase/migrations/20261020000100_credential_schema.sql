-- HETMA Credential — schema, row level security and helpers.
-- Identity comes from the HETMA community on Mighty: every member row is keyed to
-- the Supabase auth user and carries the Mighty member ID. Mighty is the source of
-- truth for who people are and which membership plan they hold; this database keeps
-- only credential activity (uploads, reviews, credential status).

create extension if not exists pgcrypto with schema extensions;

create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to anon, authenticated, service_role;

-- ---------------------------------------------------------------- enums
create type public.staff_role as enum ('super_admin', 'admin');
create type public.membership_tier as enum ('none', 'general', 'higher_ed');
create type public.submission_status as enum ('active', 'revoked');
-- none: never earned · active: every required area covered · inactive: was active,
-- then an upload was revoked or expired (the public page says "no longer active").
create type public.credential_status as enum ('none', 'active', 'inactive');

-- ---------------------------------------------------------------- helpers
create or replace function private.touch_updated_at()
returns trigger language plpgsql set search_path = '' as $$
begin new.updated_at := now(); return new; end $$;

create or replace function private.is_https_url(u text)
returns boolean language sql immutable set search_path = '' as $$
  select u is null or (char_length(u) <= 500 and u ~ '^https://[^\s<>"'']+$')
$$;

-- ---------------------------------------------------------------- people
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  mighty_member_id bigint unique check (mighty_member_id > 0),
  full_name text not null default '' check (char_length(full_name) <= 120),
  avatar_url text check (private.is_https_url(avatar_url)),
  membership_tier public.membership_tier not null default 'none',
  tier_checked_at timestamptz,
  upload_blocked boolean not null default false,
  blocked_reason text check (char_length(blocked_reason) <= 1000),
  last_sign_in_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger profiles_touch before update on public.profiles
  for each row execute function private.touch_updated_at();

create table public.staff_roles (
  user_id uuid primary key references auth.users (id) on delete cascade,
  role public.staff_role not null,
  granted_by uuid references auth.users (id) on delete set null,
  granted_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- what counts
create table public.competency_areas (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (code ~ '^[A-Z0-9]{2,8}$'),
  name text not null check (char_length(btrim(name)) between 1 and 120),
  description text check (char_length(description) <= 1000),
  sort_order int not null default 0,
  is_required boolean not null default true,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger areas_touch before update on public.competency_areas
  for each row execute function private.touch_updated_at();

create table public.providers (
  id uuid primary key default gen_random_uuid(),
  name text not null unique check (char_length(btrim(name)) between 1 and 120),
  website_url text check (private.is_https_url(website_url)),
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create table public.provider_areas (
  provider_id uuid not null references public.providers (id) on delete cascade,
  area_id uuid not null references public.competency_areas (id) on delete cascade,
  primary key (provider_id, area_id)
);
create index provider_areas_area_idx on public.provider_areas (area_id);

-- ---------------------------------------------------------------- uploads
create table public.submissions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  area_id uuid not null references public.competency_areas (id) on delete restrict,
  provider_id uuid references public.providers (id) on delete set null,
  provider_other text check (provider_other is null or char_length(btrim(provider_other)) between 1 and 120),
  completion_date date not null,
  expires_on date,
  file_path text not null unique
    check (file_path ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}\.(pdf|png|jpg)$'),
  file_name text not null check (char_length(btrim(file_name)) between 1 and 200),
  file_type text not null check (file_type in ('application/pdf', 'image/png', 'image/jpeg')),
  attested_at timestamptz not null,
  status public.submission_status not null default 'active',
  verified_at timestamptz,
  verified_by uuid references auth.users (id) on delete set null,
  revoked_at timestamptz,
  revoked_by uuid references auth.users (id) on delete set null,
  revoke_reason text check (char_length(revoke_reason) <= 1000),
  submitted_at timestamptz not null default now(),
  check (expires_on is null or expires_on >= completion_date),
  check ((status = 'revoked') = (revoked_at is not null)),
  check (status = 'active' or verified_at is null)
);
create index submissions_user_area_idx on public.submissions (user_id, area_id);
create index submissions_review_idx on public.submissions (status, verified_at, submitted_at desc);

-- ---------------------------------------------------------------- credential
create table public.credentials (
  user_id uuid primary key references public.profiles (id) on delete cascade,
  slug text unique check (slug ~ '^[a-z0-9]{12,32}$'),
  status public.credential_status not null default 'none',
  first_earned_at timestamptz,
  earned_at timestamptz,
  ended_at timestamptz,
  -- Mighty badge reconciliation: desired follows status; awarded is what Mighty
  -- reported at the last successful sync (the credential-sync function).
  badge_desired boolean not null default false,
  badge_awarded boolean not null default false,
  badge_synced_at timestamptz,
  badge_error text check (char_length(badge_error) <= 500),
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- audit
create table public.audit_log (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  actor uuid references auth.users (id) on delete set null,
  action text not null,
  target_user uuid references auth.users (id) on delete set null,
  target_type text,
  target_id text,
  details jsonb not null default '{}'
);
create index audit_at_idx on public.audit_log (at desc);
create index audit_target_idx on public.audit_log (target_user, at desc);

create or replace function private.audit(p_action text, p_target_user uuid, p_target_type text, p_target_id text, p_details jsonb default '{}')
returns void language sql security definer set search_path = '' as $$
  insert into public.audit_log (actor, action, target_user, target_type, target_id, details)
  values (auth.uid(), p_action, p_target_user, p_target_type, p_target_id, coalesce(p_details, '{}'));
$$;

-- Setup tables record every change automatically (old -> new for edits).
create or replace function private.audit_changes()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  rec jsonb := case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end;
  changes jsonb := '{}';
  k text;
begin
  if tg_op = 'UPDATE' then
    for k in select jsonb_object_keys(to_jsonb(new)) loop
      if k not in ('updated_at') and (to_jsonb(old) -> k) is distinct from (to_jsonb(new) -> k) then
        changes := changes || jsonb_build_object(k, jsonb_build_object('from', to_jsonb(old) -> k, 'to', to_jsonb(new) -> k));
      end if;
    end loop;
    if changes = '{}' then return new; end if;
  end if;
  insert into public.audit_log (actor, action, target_type, target_id, details)
  values (auth.uid(), lower(tg_op) || '_' || tg_table_name, tg_table_name,
          coalesce(rec ->> 'id', rec ->> 'provider_id'),
          case when tg_op = 'UPDATE' then changes else rec end);
  return coalesce(new, old);
end $$;

create trigger areas_audit after insert or update or delete on public.competency_areas
  for each row execute function private.audit_changes();
create trigger providers_audit after insert or update or delete on public.providers
  for each row execute function private.audit_changes();
create trigger provider_areas_audit after insert or delete on public.provider_areas
  for each row execute function private.audit_changes();

-- ---------------------------------------------------------------- sign-in plumbing
-- One row per Mighty sign-in in progress (state + PKCE verifier). Only the
-- mighty-auth function (service role) touches it; no browser role can read it.
create table public.oauth_transactions (
  state text primary key check (char_length(state) between 32 and 128),
  nonce_hash text not null,            -- SHA-256 of the HttpOnly cookie value
  bind_hash text not null,             -- SHA-256 of a value only the starting browser tab holds
  code_verifier text not null,
  mode text not null default 'signin' check (mode in ('signin', 'join')),
  created_at timestamptz not null default now()
);

-- After Mighty confirms who someone is, the callback leaves a one-time handoff here.
-- The app redeems it (with the tab's bind value) for a Supabase session, so a sign-in
-- link can't be replayed into someone else's browser (login CSRF).
create table public.auth_handoffs (
  code_hash text primary key,
  bind_hash text not null,
  user_id uuid not null references auth.users (id) on delete cascade,
  is_new boolean not null default false,
  created_at timestamptz not null default now()
);

create table private.rate_limit_hits (
  id bigint generated always as identity primary key,
  user_id uuid not null,
  bucket text not null,
  at timestamptz not null default now()
);
create index rate_limit_lookup on private.rate_limit_hits (user_id, bucket, at);

-- Returns true when the caller has used up the bucket; otherwise records a hit.
create or replace function private.rate_limited(p_bucket text, p_max int, p_window interval)
returns boolean language plpgsql security definer set search_path = '' as $$
declare n int;
begin
  delete from private.rate_limit_hits where at < now() - interval '1 day';
  select count(*) into n from private.rate_limit_hits
   where user_id = auth.uid() and bucket = p_bucket and at > now() - p_window;
  if n >= p_max then return true; end if;
  insert into private.rate_limit_hits (user_id, bucket) values (auth.uid(), p_bucket);
  return false;
end $$;

-- ---------------------------------------------------------------- role helpers
create or replace function private.staff_role()
returns public.staff_role language sql stable security definer set search_path = '' as $$
  select role from public.staff_roles where user_id = auth.uid()
$$;
create or replace function private.is_staff()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.staff_roles where user_id = auth.uid())
$$;
create or replace function private.is_super_admin()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.staff_roles where user_id = auth.uid() and role = 'super_admin')
$$;
grant execute on function private.is_staff(), private.is_super_admin(), private.staff_role(), private.is_https_url(text)
  to anon, authenticated, service_role;

-- A profile and an empty credential row for every new auth user. Only app_metadata
-- (which only the service role can set) is trusted; user-supplied metadata is ignored.
-- mighty-auth then links the Mighty member ID explicitly.
create or replace function private.handle_new_user()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  a jsonb := coalesce(new.raw_app_meta_data, '{}');
  mid bigint := case when (a ->> 'mighty_member_id') ~ '^[0-9]{1,18}$' then (a ->> 'mighty_member_id')::bigint end;
begin
  insert into public.profiles (id, mighty_member_id, full_name)
  values (new.id, mid, left(btrim(coalesce(a ->> 'mighty_name', '')), 120))
  on conflict (id) do nothing;
  insert into public.credentials (user_id) values (new.id) on conflict do nothing;
  return new;
end $$;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function private.handle_new_user();

-- ---------------------------------------------------------------- row level security
alter table public.profiles enable row level security;
alter table public.staff_roles enable row level security;
alter table public.competency_areas enable row level security;
alter table public.providers enable row level security;
alter table public.provider_areas enable row level security;
alter table public.submissions enable row level security;
alter table public.credentials enable row level security;
alter table public.audit_log enable row level security;
alter table public.oauth_transactions enable row level security;
alter table public.auth_handoffs enable row level security;

-- Browser roles never write people, uploads, credentials or the audit log directly:
-- every change goes through a definer function that re-checks the caller.
revoke insert, update, delete, truncate on public.profiles, public.staff_roles, public.submissions,
  public.credentials, public.audit_log from anon, authenticated;
revoke all on public.oauth_transactions, public.auth_handoffs from anon, authenticated;
revoke all on public.profiles, public.staff_roles, public.submissions, public.credentials, public.audit_log from anon;
revoke insert, update, delete, truncate on public.competency_areas, public.providers, public.provider_areas from anon;
revoke delete, truncate on public.competency_areas, public.providers from authenticated;

create policy profiles_read on public.profiles for select to authenticated
  using (id = auth.uid() or private.is_staff());
create policy staff_read on public.staff_roles for select to authenticated
  using (user_id = auth.uid() or private.is_staff());

create policy areas_read on public.competency_areas for select to anon, authenticated
  using (is_active or private.is_staff());
create policy areas_write on public.competency_areas for insert to authenticated with check (private.is_staff());
create policy areas_update on public.competency_areas for update to authenticated
  using (private.is_staff()) with check (private.is_staff());

create policy providers_read on public.providers for select to anon, authenticated
  using (is_active or private.is_staff());
create policy providers_write on public.providers for insert to authenticated with check (private.is_staff());
create policy providers_update on public.providers for update to authenticated
  using (private.is_staff()) with check (private.is_staff());

create policy provider_areas_read on public.provider_areas for select to anon, authenticated using (true);
create policy provider_areas_write on public.provider_areas for insert to authenticated with check (private.is_staff());
create policy provider_areas_delete on public.provider_areas for delete to authenticated using (private.is_staff());
revoke update on public.provider_areas from authenticated;

create policy submissions_read on public.submissions for select to authenticated
  using (user_id = auth.uid() or private.is_staff());
create policy credentials_read on public.credentials for select to authenticated
  using (user_id = auth.uid() or private.is_staff());
create policy audit_read on public.audit_log for select to authenticated using (private.is_staff());
-- oauth_transactions, auth_handoffs: no policies at all (service role only).

-- Members may read their own profile, but not the staff-only note on why uploads were paused.
revoke select on public.profiles from authenticated;
grant select (id, mighty_member_id, full_name, avatar_url, membership_tier, tier_checked_at, upload_blocked,
              last_sign_in_at, created_at, updated_at) on public.profiles to authenticated;
