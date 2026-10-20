// Data access layer. All authorization is enforced by Postgres (RLS + definer
// functions) and the Edge Functions; this module only shapes requests and turns
// errors into readable messages.
import { createClient } from '@supabase/supabase-js';
import { config } from './config.js';

export const supabase = createClient(config.supabaseUrl || 'http://invalid.localhost', config.supabaseAnonKey || 'missing', {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
});
export const auth = supabase.auth;
export const functionsUrl = name => `${config.supabaseUrl}/functions/v1/${name}`;

export class ApiError extends Error { constructor(message, code) { super(message); this.code = code; } }
function friendly(error) {
  if (!error) return 'Something went wrong.';
  if (error.code === '42501' || /permission denied|not authorized|row-level security/i.test(error.message)) return 'You don’t have permission to do that.';
  if (error.code === '23505') return 'That value is already in use.';
  if (error.code === '23514') return 'Some values aren’t valid. Check the form and try again.';
  if (/Failed to fetch|NetworkError/i.test(error.message)) return 'Can’t reach the server. Check your connection and try again.';
  return error.message && error.message.length < 160 ? error.message : 'Something went wrong. Please try again.';
}
export async function q(promise) {
  const { data, error } = await promise;
  if (error) { if (import.meta.env.DEV) console.warn('[api]', error.code, error.message); throw new ApiError(friendly(error), error.code); }
  return data;
}
export const rpc = (fn, args) => q(supabase.rpc(fn, args));

// ---------------------------------------------------------------- member
export async function loadMe(uid) {
  const [profile, role, credential, areas, providers, links, submissions] = await Promise.all([
    q(supabase.from('profiles').select('id, mighty_member_id, full_name, membership_tier, upload_blocked').eq('id', uid).maybeSingle()),
    q(supabase.from('staff_roles').select('role').eq('user_id', uid).maybeSingle()),
    q(supabase.from('credentials').select('*').eq('user_id', uid).maybeSingle()),
    q(supabase.from('competency_areas').select('*').eq('is_active', true).order('sort_order').order('name')),
    q(supabase.from('providers').select('id, name').eq('is_active', true).order('name')),
    q(supabase.from('provider_areas').select('provider_id, area_id')),
    q(supabase.from('submissions').select('*, provider:providers(name)').eq('user_id', uid).order('submitted_at', { ascending: false })),
  ]);
  return { profile, role: role?.role || null, credential, areas, providers, links, submissions };
}

export async function uploadCertificate(uid, file) {
  const ext = { 'application/pdf': 'pdf', 'image/png': 'png', 'image/jpeg': 'jpg' }[file.type];
  const path = `${uid}/${crypto.randomUUID()}.${ext}`;
  await q(supabase.storage.from('certificates').upload(path, file, { contentType: file.type, upsert: false }));
  return path;
}
export async function fileUrl(path) {
  const data = await q(supabase.storage.from('certificates').createSignedUrl(path, 300));
  return data.signedUrl;
}
// Ask the credential-sync function to make the Mighty badge match. Never throws.
export async function syncBadge(userId) {
  try {
    const { data, error } = await supabase.functions.invoke('credential-sync', { body: userId ? { user_id: userId } : {} });
    return error ? { ok: false, error: 'unreachable' } : data;
  } catch { return { ok: false, error: 'unreachable' }; }
}
export const publicCredential = slug => rpc('get_public_credential', { p_slug: slug });

// ---------------------------------------------------------------- Mighty sign-in
// The tab that starts sign-in keeps a random "bind" value; only its hash travels to
// the server. Finishing sign-in requires the value itself, so a sign-in link can't be
// replayed into another person's browser.
const b64url = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export async function startMightySignIn(mode = 'start') {
  const bind = b64url(crypto.getRandomValues(new Uint8Array(32)));
  sessionStorage.setItem('hc_bind', bind); // throws if storage is blocked; caller shows a message
  const hash = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(bind)));
  location.assign(`${functionsUrl(`mighty-auth/${mode}`)}?bh=${encodeURIComponent(hash)}`);
}
export async function redeemSignIn(code) {
  let bind = null;
  try { bind = sessionStorage.getItem('hc_bind'); sessionStorage.removeItem('hc_bind'); } catch { bind = null; }
  if (!bind) return { ok: false, error: 'new_tab' };
  try {
    const res = await fetch(functionsUrl('mighty-auth/redeem'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code, bind }) });
    const r = await res.json();
    if (!r.ok) return r;
    const { error } = await auth.verifyOtp({ token_hash: r.token_hash, type: 'magiclink' });
    return error ? { ok: false, error: 'session' } : { ok: true, isNew: r.is_new };
  } catch { return { ok: false, error: 'unavailable' }; }
}
