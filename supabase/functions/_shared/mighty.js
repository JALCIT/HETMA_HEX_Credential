// Shared logic for the mighty-auth and credential-sync Edge Functions.
// Plain JavaScript using only web-standard APIs (fetch, crypto.subtle, Request,
// Response, URL) so the same file runs on Supabase Edge Functions (Deno) and in the
// local Node runner used for development and tests. Dependencies are injected.
//
// Sign-in follows Mighty's "backend for frontend" pattern for confidential clients
// (docs.mightynetworks.com/api/oauth-client-architectures): this function creates
// state + PKCE verifier, receives the callback on its own route, exchanges the code
// with the client secret and never hands Mighty tokens to the browser. The browser
// only receives a one-time Supabase sign-in token for this app.

const enc = new TextEncoder();

// Newer Supabase projects may turn off the legacy service-role key and expose the
// new secret keys as a JSON dictionary instead ({"default": "sb_secret_..."}).
function secretKeyFrom(json) {
  try { const keys = JSON.parse(json || '{}'); return keys.default || Object.values(keys)[0] || ''; }
  catch { return ''; }
}

export function loadConfig(env) {
  const issuer = (env.MIGHTY_ISSUER || 'https://community.hetma.org').replace(/\/+$/, '');
  const supabaseUrl = (env.SUPABASE_URL || '').replace(/\/+$/, '');
  return {
    appUrl: (env.APP_URL || '').replace(/\/+$/, ''),
    supabaseUrl,
    serviceKey: env.SUPABASE_SERVICE_ROLE_KEY || secretKeyFrom(env.SUPABASE_SECRET_KEYS),
    issuer,
    authorizeUrl: env.MIGHTY_AUTHORIZE_URL || `${issuer}/oauth/authorize`,
    tokenUrl: env.MIGHTY_TOKEN_URL || `${issuer}/oauth/token`,
    revokeUrl: env.MIGHTY_REVOKE_URL || `${issuer}/oauth/revoke`,
    joinUrl: env.MIGHTY_JOIN_URL || `${issuer}/users/onboarding/plans?auto_join=true`,
    apiBase: (env.MIGHTY_API_BASE || 'https://api.mn.co').replace(/\/+$/, ''),
    network: env.MIGHTY_NETWORK || '',
    clientId: env.MIGHTY_CLIENT_ID || '',
    clientSecret: env.MIGHTY_CLIENT_SECRET || '',
    adminKey: env.MIGHTY_ADMIN_API_KEY || '',
    badgeId: String(env.MIGHTY_BADGE_ID || '').trim(),
    planGeneral: String(env.MIGHTY_PLAN_GENERAL || '1736546'),
    planHigherEd: String(env.MIGHTY_PLAN_HIGHER_ED || '1819684'),
    callbackUrl: env.MIGHTY_CALLBACK_URL || `${supabaseUrl}/functions/v1/mighty-auth/callback`,
    userEmailDomain: env.MEMBER_EMAIL_DOMAIN || 'members.hetma-credential.invalid',
  };
}

// ---------------------------------------------------------------- small helpers
export const b64url = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export const randomToken = (n = 32) => b64url(crypto.getRandomValues(new Uint8Array(n)));
export const sha256 = async text => b64url(await crypto.subtle.digest('SHA-256', enc.encode(text)));
export const pkceChallenge = verifier => sha256(verifier);

export function readCookie(req, name) {
  const raw = req.headers.get('cookie') || '';
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

function cookie(cfg, name, value, maxAge) {
  const secure = cfg.callbackUrl.startsWith('https://') ? '; Secure' : '';
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

const redirect = (location, headers = {}) =>
  new Response(null, { status: 302, headers: { Location: location, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', ...headers } });

const appRedirect = (cfg, route, extraHeaders) => redirect(`${cfg.appUrl}/#${route}`, extraHeaders);

// One cookie per sign-in attempt, so two tabs signing in at once don't collide.
const cookieName = state => `hc_mo_${String(state).replace(/[^A-Za-z0-9]/g, '').slice(0, 16)}`;
const TX_TTL_MS = 15 * 60 * 1000;
const HANDOFF_TTL_MS = 5 * 60 * 1000;
const UA = 'hetma-credential/1.0 (+https://hetma.org)';

function adminClient(cfg, createClient) {
  return createClient(cfg.supabaseUrl, cfg.serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
}

async function audit(db, action, targetUser, details = {}) {
  await db.from('audit_log').insert({ action, target_user: targetUser || null, target_type: 'system', target_id: targetUser || null, details });
}

// ---------------------------------------------------------------- Mighty API calls
async function mightyAdmin(cfg, f, method, path, body) {
  const res = await f(`${cfg.apiBase}/admin/v1/networks/${encodeURIComponent(cfg.network)}${path}`, {
    method,
    headers: { Authorization: `Bearer ${cfg.adminKey}`, Accept: 'application/json', 'User-Agent': UA, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  if (res.status !== 204) { try { data = await res.json(); } catch { data = null; } }
  return { status: res.status, ok: res.ok, data };
}
const itemsOf = data => (Array.isArray(data) ? data : Array.isArray(data?.items) ? data.items : Array.isArray(data?.data) ? data.data : []);

export async function lookupTier(cfg, f, mightyId) {
  if (!cfg.adminKey || !cfg.network) return { tier: null, reason: 'not_configured' };
  const r = await mightyAdmin(cfg, f, 'GET', `/members/${mightyId}/plans?per_page=100`);
  if (!r.ok) return { tier: null, reason: `plans_http_${r.status}` };
  const ids = itemsOf(r.data).map(p => String(p.id));
  const tier = ids.includes(cfg.planHigherEd) ? 'higher_ed' : ids.includes(cfg.planGeneral) ? 'general' : 'none';
  return { tier, planIds: ids };
}

// Make Mighty's badge match what the credential says. Reads Mighty first so every
// call is idempotent (safe to retry, safe if someone changed the badge by hand).
export async function syncBadge(cfg, f, db, userId) {
  const { data: cred } = await db.from('credentials').select('badge_desired, badge_awarded, badge_error, badge_synced_at').eq('user_id', userId).maybeSingle();
  const { data: prof } = await db.from('profiles').select('mighty_member_id').eq('id', userId).maybeSingle();
  if (!cred || !prof) return { ok: false, error: 'not_found' };
  if (!prof.mighty_member_id) return { ok: true, skipped: 'no_mighty_account' };
  if (!cfg.adminKey || !cfg.network || !cfg.badgeId) return { ok: true, skipped: 'not_configured' };
  const mid = prof.mighty_member_id;
  // Nothing to change and checked within the last minute: don't call Mighty again.
  if (cred.badge_desired === cred.badge_awarded && !cred.badge_error && cred.badge_synced_at
      && Date.now() - Date.parse(cred.badge_synced_at) < 60_000) return { ok: true, action: null, recent: true };
  const fail = async message => {
    await db.from('credentials').update({ badge_error: message.slice(0, 500), badge_synced_at: new Date().toISOString() }).eq('user_id', userId);
    await audit(db, 'badge_sync_failed', userId, { message: message.slice(0, 200) });
    return { ok: false, error: 'badge_sync_failed', message };
  };
  try {
    const list = await mightyAdmin(cfg, f, 'GET', `/members/${mid}/badges?per_page=100`);
    if (!list.ok) return fail(`Mighty badge list returned HTTP ${list.status}`);
    const has = itemsOf(list.data).some(b => String(b.id) === cfg.badgeId || String(b.badge_id) === cfg.badgeId);
    let action = null;
    if (cred.badge_desired && !has) {
      const r = await mightyAdmin(cfg, f, 'POST', `/members/${mid}/badges`, { badge_id: Number(cfg.badgeId) });
      if (!r.ok) return fail(`Mighty add badge returned HTTP ${r.status}`);
      action = 'badge_added';
    } else if (!cred.badge_desired && has) {
      const r = await mightyAdmin(cfg, f, 'DELETE', `/members/${mid}/badges/${cfg.badgeId}/`);
      if (!r.ok && r.status !== 404) return fail(`Mighty remove badge returned HTTP ${r.status}`);
      action = 'badge_removed';
    }
    await db.from('credentials').update({ badge_awarded: cred.badge_desired, badge_error: null, badge_synced_at: new Date().toISOString() }).eq('user_id', userId);
    if (action) await audit(db, action, userId, { mighty_member_id: mid });
    return { ok: true, action, badge_awarded: cred.badge_desired };
  } catch (e) {
    return fail(`Couldn't reach Mighty: ${e.message}`);
  }
}

// ---------------------------------------------------------------- mighty-auth
export async function handleMightyAuth(req, { env, createClient, fetch: f = fetch }) {
  const cfg = loadConfig(env);
  const url = new URL(req.url);
  const action = url.pathname.split('/').filter(Boolean).pop();
  if (!cfg.appUrl || !cfg.clientId || !cfg.clientSecret || !cfg.network || !cfg.serviceKey) {
    return new Response('Mighty sign-in is not configured yet.', { status: 503 });
  }
  const db = adminClient(cfg, createClient);
  if (action === 'redeem') return redeem(cfg, db, req);
  if (req.method !== 'GET') return new Response('Method not allowed', { status: 405 });
  if (action === 'start' || action === 'join') return begin(cfg, db, action === 'join' ? 'join' : 'signin', url);
  if (action === 'callback') return callback(cfg, db, req, url, f);
  return new Response('Not found', { status: 404 });
}

async function begin(cfg, db, mode, url) {
  // bh = SHA-256 of a random value the starting browser tab keeps (see redeem).
  const bindHash = url.searchParams.get('bh') || '';
  if (!/^[A-Za-z0-9_-]{43}$/.test(bindHash)) return appRedirect(cfg, '/signin?error=invalid_request');
  const state = randomToken(32);
  const verifier = randomToken(48);
  const nonce = randomToken(32);
  await db.from('oauth_transactions').delete().lt('created_at', new Date(Date.now() - TX_TTL_MS).toISOString());
  await db.from('auth_handoffs').delete().lt('created_at', new Date(Date.now() - HANDOFF_TTL_MS).toISOString());
  const { count } = await db.from('oauth_transactions').select('state', { count: 'exact', head: true })
    .gt('created_at', new Date(Date.now() - 60_000).toISOString());
  if ((count || 0) > 300) return appRedirect(cfg, '/signin?error=busy');
  const { error } = await db.from('oauth_transactions').insert({ state, nonce_hash: await sha256(nonce), bind_hash: bindHash, code_verifier: verifier, mode });
  if (error) return appRedirect(cfg, '/signin?error=unavailable');
  const authorize = new URL(cfg.authorizeUrl);
  authorize.search = new URLSearchParams({
    response_type: 'code', client_id: cfg.clientId, redirect_uri: cfg.callbackUrl, scope: 'read:userinfo',
    state, code_challenge: await pkceChallenge(verifier), code_challenge_method: 'S256',
  }).toString();
  let target = authorize.toString();
  if (mode === 'join') {
    const join = new URL(cfg.joinUrl);
    join.searchParams.set('from', target);
    target = join.toString();
  }
  return redirect(target, { 'Set-Cookie': cookie(cfg, cookieName(state), nonce, TX_TTL_MS / 1000) });
}

async function callback(cfg, db, req, url, f) {
  const p = url.searchParams;
  const clear = { 'Set-Cookie': cookie(cfg, cookieName(p.get('state') || ''), '', 0) };
  if (p.get('error')) return appRedirect(cfg, `/signin?error=${p.get('error') === 'access_denied' ? 'denied' : 'mighty_error'}`, clear);
  const code = p.get('code'), state = p.get('state'), iss = p.get('iss');
  if (!code || !state) return appRedirect(cfg, '/signin?error=invalid_request', clear);
  // RFC 9207: the response must come from our community's authorization server.
  if (iss !== cfg.issuer) return appRedirect(cfg, '/signin?error=wrong_issuer', clear);

  // One use only: claim and delete the transaction in a single statement.
  const { data: tx } = await db.from('oauth_transactions').delete().eq('state', state).select().maybeSingle();
  if (!tx || Date.now() - Date.parse(tx.created_at) > TX_TTL_MS) return appRedirect(cfg, '/signin?error=expired', clear);
  const nonce = readCookie(req, cookieName(state));
  if (!nonce || (await sha256(nonce)) !== tx.nonce_hash) return appRedirect(cfg, '/signin?error=session_mismatch', clear);

  // Exchange the code (confidential client, client_secret_post + PKCE).
  let tokens;
  try {
    const res = await f(cfg.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json', 'User-Agent': UA },
      body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: cfg.callbackUrl, client_id: cfg.clientId, client_secret: cfg.clientSecret, code_verifier: tx.code_verifier }),
    });
    if (!res.ok) return appRedirect(cfg, '/signin?error=token_exchange', clear);
    tokens = await res.json();
  } catch { return appRedirect(cfg, '/signin?error=unavailable', clear); }

  // Who signed in? (Mighty API, acting as the member.)
  let me;
  try {
    const res = await f(`${cfg.apiBase}/networks/${encodeURIComponent(cfg.network)}/graphql`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokens.access_token}`, 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': UA },
      body: JSON.stringify({ query: 'query { me { id name } }' }),
    });
    me = (await res.json())?.data?.me;
  } catch { me = null; }
  // We only needed the identity: hand the tokens straight back to Mighty.
  await Promise.allSettled([tokens.access_token, tokens.refresh_token].filter(Boolean).map(token =>
    f(cfg.revokeUrl, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA },
      body: new URLSearchParams({ token, client_id: cfg.clientId, client_secret: cfg.clientSecret }) })));
  const mightyId = me && /^[0-9]{1,18}$/.test(String(me.id)) ? String(me.id) : null;
  if (!mightyId) return appRedirect(cfg, '/signin?error=no_identity', clear);
  const name = String(me.name || '').trim().slice(0, 120);

  // Find or create the matching app account (never matched by email).
  const email = `m${mightyId}@${cfg.userEmailDomain}`;
  let { data: prof } = await db.from('profiles').select('id').eq('mighty_member_id', mightyId).maybeSingle();
  if (!prof) {
    let userId = null;
    const { data: created, error } = await db.auth.admin.createUser({
      email, email_confirm: true, app_metadata: { provider: 'mighty', mighty_member_id: mightyId },
    });
    if (created?.user) userId = created.user.id;
    else if (error && /already/i.test(error.message)) {
      // The login exists but its profile wasn't linked (e.g. an earlier attempt stopped half way).
      // Only reuse it if this function made it for this member (app_metadata can't be set
      // by users); otherwise someone pre-registered the address, so refuse.
      const { data: found } = await db.auth.admin.generateLink({ type: 'magiclink', email });
      const meta = found?.user?.app_metadata || {};
      if (meta.provider === 'mighty' && String(meta.mighty_member_id) === mightyId) userId = found.user.id;
    }
    if (!userId) return appRedirect(cfg, '/signin?error=account', clear);
    const { error: linkErr } = await db.from('profiles').update({ mighty_member_id: mightyId }).eq('id', userId);
    if (linkErr) return appRedirect(cfg, '/signin?error=account', clear);
    prof = { id: userId };
    await audit(db, 'account_created', userId, { mighty_member_id: mightyId });
  }
  const update = { full_name: name, last_sign_in_at: new Date().toISOString() };
  try {
    const t = await lookupTier(cfg, f, mightyId);
    if (t.tier) Object.assign(update, { membership_tier: t.tier, tier_checked_at: new Date().toISOString() });
    else if (t.reason !== 'not_configured') await audit(db, 'tier_lookup_failed', prof.id, { reason: t.reason });
  } catch (e) { await audit(db, 'tier_lookup_failed', prof.id, { reason: String(e.message).slice(0, 200) }); }
  await db.from('profiles').update(update).eq('id', prof.id);
  try { await syncBadge(cfg, f, db, prof.id); } catch { /* recorded inside; never blocks sign-in */ }

  // Leave a one-time handoff that only the tab which started sign-in can redeem.
  const handoff = randomToken(32);
  const { error: hErr } = await db.from('auth_handoffs').insert({ code_hash: await sha256(handoff), bind_hash: tx.bind_hash, user_id: prof.id, is_new: tx.mode === 'join' });
  if (hErr) return appRedirect(cfg, '/signin?error=session', clear);
  return appRedirect(cfg, `/auth?code=${encodeURIComponent(handoff)}`, clear);
}

// POST { code, bind } from the app: swaps a handoff for a one-time Supabase sign-in
// token, but only for the browser tab holding the bind value it started with.
async function redeem(cfg, db, req) {
  const cors = { 'Access-Control-Allow-Origin': cfg.appUrl, 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS', Vary: 'Origin' };
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (req.method !== 'POST') return json({ ok: false, error: 'method_not_allowed' }, 405);
  let body = {};
  try { body = await req.json(); } catch { body = {}; }
  const code = typeof body.code === 'string' ? body.code : '';
  const bind = typeof body.bind === 'string' ? body.bind : '';
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(code) || !/^[A-Za-z0-9_-]{20,100}$/.test(bind)) return json({ ok: false, error: 'invalid_request' }, 400);
  const { data: h } = await db.from('auth_handoffs').delete().eq('code_hash', await sha256(code)).select().maybeSingle();
  if (!h || Date.now() - Date.parse(h.created_at) > HANDOFF_TTL_MS) return json({ ok: false, error: 'expired' }, 400);
  if ((await sha256(bind)) !== h.bind_hash) return json({ ok: false, error: 'session_mismatch' }, 400);
  const { data: u } = await db.auth.admin.getUserById(h.user_id);
  if (!u?.user?.email) return json({ ok: false, error: 'account' }, 400);
  const { data: link, error } = await db.auth.admin.generateLink({ type: 'magiclink', email: u.user.email });
  const tokenHash = link?.properties?.hashed_token;
  if (error || !tokenHash) return json({ ok: false, error: 'session' }, 500);
  return json({ ok: true, token_hash: tokenHash, is_new: h.is_new });
}

// ---------------------------------------------------------------- credential-sync
export async function handleCredentialSync(req, { env, createClient, fetch: f = fetch }) {
  const cfg = loadConfig(env);
  const cors = {
    'Access-Control-Allow-Origin': cfg.appUrl || '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    Vary: 'Origin',
  };
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (req.method !== 'POST') return json({ ok: false, error: 'method_not_allowed' }, 405);
  const db = adminClient(cfg, createClient);
  const jwt = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const { data: who, error } = jwt ? await db.auth.getUser(jwt) : { data: null, error: true };
  if (error || !who?.user) return json({ ok: false, error: 'not_signed_in' }, 401);
  let body = {};
  try { body = await req.json(); } catch { body = {}; }
  const target = typeof body.user_id === 'string' && /^[0-9a-f-]{36}$/i.test(body.user_id) ? body.user_id : who.user.id;
  if (target !== who.user.id) {
    const { data: role } = await db.from('staff_roles').select('role').eq('user_id', who.user.id).maybeSingle();
    if (!role) return json({ ok: false, error: 'forbidden' }, 403);
  }
  return json(await syncBadge(cfg, f, db, target));
}
