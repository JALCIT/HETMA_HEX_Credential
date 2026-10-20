// Integration-test helpers: talk to the local stack exactly like the browser does
// (supabase-js + anon key + user JWT, plain HTTP for the sign-in redirects), and use
// a direct postgres connection only for fixtures with no API equivalent.
import { createClient } from '@supabase/supabase-js';
import pg from 'pg';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { anonKey, serviceKey } from '../../dev/local-stack/jwt.mjs';

export const SUPABASE_URL = 'http://127.0.0.1:54321';
export const MIGHTY = 'http://127.0.0.1:54400';
export const APP_URL = 'http://127.0.0.1:5173';
const DB_URL = process.env.DATABASE_URL_APP || 'postgres://postgres:postgres@127.0.0.1:5432/hetma_credential_local';
export const pool = new pg.Pool({ connectionString: DB_URL, max: 4 });
export const sql = (text, params) => pool.query(text, params).then(r => r.rows);

const opts = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } };
export const anonClient = () => createClient(SUPABASE_URL, anonKey(), opts);
export const serviceClient = () => createClient(SUPABASE_URL, serviceKey(), opts);
export const must = ({ data, error }) => { if (error) throw new Error(`${error.code}: ${error.message}`); return data; };

/** A plain password account (local stack only), e.g. a member with no Mighty link. */
export async function newUser(label = 'user') {
  const client = anonClient();
  const email = `${label}-${randomUUID().slice(0, 8)}@example.org`;
  const { data, error } = await client.auth.signUp({ email, password: `pw-${randomUUID()}`, options: { data: { full_name: `${label} Tester` } } });
  if (error) throw error;
  return { client, email, id: data.user.id };
}
let fakeMighty = 900000000 + Math.floor(Math.random() * 1e6);
export async function newAdmin(role = 'admin') {
  const u = await newUser(role);
  await sql('update public.profiles set mighty_member_id = $2 where id = $1', [u.id, ++fakeMighty]);
  await sql('insert into public.staff_roles (user_id, role) values ($1, $2)', [u.id, role]);
  return u;
}

// ---- Mighty sign-in, driven like a browser (manual redirects + one cookie).
export function parseLocation(res) { return new URL(res.headers.get('location')); }
const b64url = buf => Buffer.from(buf).toString('base64url');
export function newBind() { const bind = b64url(randomBytes(32)); return { bind, hash: b64url(createHash('sha256').update(bind).digest()) }; }
export async function startSignIn(mode = 'start', bind = newBind()) {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/mighty-auth/${mode}?bh=${bind.hash}`, { redirect: 'manual' });
  const cookie = (res.headers.get('set-cookie') || '').split(';')[0];
  return { res, cookie, location: parseLocation(res), bind };
}
export async function redeem(code, bind) {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/mighty-auth/redeem`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code, bind }) });
  return res.json();
}
export async function approveAt(authorizeUrl, memberId) {
  const u = new URL(authorizeUrl); u.searchParams.set('member', String(memberId));
  const res = await fetch(u, { redirect: 'manual' });
  return parseLocation(res); // the callback URL with code, state, iss
}
export async function callback(callbackUrl, cookie) {
  const res = await fetch(callbackUrl, { redirect: 'manual', headers: cookie ? { cookie } : {} });
  return parseLocation(res); // the app URL (#/auth?th=... or #/signin?error=...)
}
export function hashParams(appUrl) {
  const [route, query = ''] = appUrl.hash.slice(1).split('?');
  return { route, params: new URLSearchParams(query) };
}
/** Full sign-in as a mock Mighty member; returns a signed-in supabase client. */
export async function mightySignIn(memberId) {
  const { cookie, location, bind } = await startSignIn();
  const cb = await approveAt(location, memberId);
  const app = await callback(cb, cookie);
  const { route, params } = hashParams(app);
  if (route !== '/auth') throw new Error(`sign-in failed: ${app.hash}`);
  const r = await redeem(params.get('code'), bind.bind);
  if (!r.ok) throw new Error(`redeem failed: ${r.error}`);
  const client = anonClient();
  must(await client.auth.verifyOtp({ token_hash: r.token_hash, type: 'magiclink' }));
  const { data: { user } } = await client.auth.getUser();
  return { client, id: user.id };
}
export const mockState = () => fetch(`${MIGHTY}/__mock/state`).then(r => r.json());
export const newFilePath = (uid, ext = 'pdf') => `${uid}/${randomUUID()}.${ext}`;

export async function areas() { return sql('select id, code from public.competency_areas where is_active and is_required order by sort_order'); }
export async function submit(client, uid, areaId, extra = {}) {
  return must(await client.rpc('submit_certificate', {
    p_area_id: areaId, p_provider_id: null, p_provider_other: 'Test Provider', p_completion_date: '2026-09-01',
    p_expires_on: null, p_file_path: newFilePath(uid), p_file_name: 'cert.pdf', p_file_type: 'application/pdf', p_attested: true, ...extra,
  }));
}
export async function completeAll(client, uid) {
  let last;
  for (const a of await areas()) last = await submit(client, uid, a.id);
  return last;
}
