// Mock of the parts of Mighty Networks this app uses, on :54400. Local development
// and tests only. It behaves like the real endpoints documented at
// docs.mightynetworks.com: OAuth authorize/token/revoke with PKCE (S256) and
// client_secret_post, the GraphQL `me` query, and the Admin REST API calls for a
// member's plans and badges. GET /__mock/state shows recorded badges; POST
// /__mock/reset clears them.
import http from 'node:http';
import { createHash, randomBytes } from 'node:crypto';

const PORT = 54400;
const ISSUER = `http://127.0.0.1:${PORT}`;
const CLIENT_ID = 'local-client-id', CLIENT_SECRET = 'local-client-secret', ADMIN_KEY = 'local-admin-key';
const GENERAL = 1736546, HIGHER_ED = 1819684;
export const MEMBERS = {
  1001: { name: 'Jordan Rivera', plans: [GENERAL, HIGHER_ED] },
  1002: { name: 'Priya Shah', plans: [GENERAL] },
  1003: { name: 'Sam Newmember', plans: [GENERAL] },
  1004: { name: 'Alex Kim', plans: [GENERAL, HIGHER_ED] },
};
// Any member ID from 2000 up also exists (tests use fresh ones): odd IDs General only.
const member = id => MEMBERS[id] || (Number(id) >= 2000 ? { name: `Test Member ${id}`, plans: Number(id) % 2 ? [GENERAL] : [GENERAL, HIGHER_ED] } : null);
const codes = new Map();   // code -> { member, challenge, redirect_uri, client_id }
const tokens = new Map();  // access token -> member id
let badges = {};           // member id -> Set(badge ids)
const calls = [];

const b64url = buf => buf.toString('base64url');
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
async function body(req) { const c = []; for await (const x of req) c.push(x); return Buffer.concat(c).toString(); }
function send(res, status, data, headers = {}) {
  const isJson = typeof data !== 'string';
  res.writeHead(status, { 'Content-Type': isJson ? 'application/json' : 'text/html; charset=utf-8', ...headers });
  res.end(isJson ? JSON.stringify(data) : data);
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, ISSUER);
  const p = url.pathname;
  calls.push(`${req.method} ${p}`);
  if (p === '/health') return send(res, 200, { ok: true });
  if (p === '/__mock/state') return send(res, 200, { badges: Object.fromEntries(Object.entries(badges).map(([k, v]) => [k, [...v]])), calls: calls.slice(-50) });
  if (p === '/__mock/reset' && req.method === 'POST') { badges = {}; calls.length = 0; return send(res, 200, { ok: true }); }
  if (p === '/.well-known/oauth-authorization-server') {
    return send(res, 200, { issuer: ISSUER, authorization_endpoint: `${ISSUER}/oauth/authorize`, token_endpoint: `${ISSUER}/oauth/token`, code_challenge_methods_supported: ['S256'], authorization_response_iss_parameter_supported: true });
  }

  // Stand-in for the community's join page: "creates" a member and continues to `from`.
  if (p === '/users/onboarding/plans') {
    const from = url.searchParams.get('from') || '/';
    return send(res, 200, `<!doctype html><title>Join HETMA (mock)</title><h1>Join HETMA (mock Mighty)</h1>
      <p>Pretend you created a free account, then continue.</p><a id="continue" href="${esc(from)}">Continue</a>`);
  }

  if (p === '/oauth/authorize') {
    const q = url.searchParams;
    if (q.get('client_id') !== CLIENT_ID || q.get('response_type') !== 'code' || !q.get('state') || q.get('code_challenge_method') !== 'S256' || !q.get('code_challenge')) {
      return send(res, 400, 'Invalid authorization request');
    }
    if (q.get('member')) {
      const code = b64url(randomBytes(24));
      codes.set(code, { member: Number(q.get('member')), challenge: q.get('code_challenge'), redirect_uri: q.get('redirect_uri'), client_id: q.get('client_id') });
      const back = new URL(q.get('redirect_uri'));
      back.search = new URLSearchParams({ code, state: q.get('state'), iss: ISSUER }).toString();
      res.writeHead(302, { Location: back.toString() }); return res.end();
    }
    if (q.get('deny')) {
      const back = new URL(q.get('redirect_uri'));
      back.search = new URLSearchParams({ error: 'access_denied', state: q.get('state'), iss: ISSUER }).toString();
      res.writeHead(302, { Location: back.toString() }); return res.end();
    }
    const link = id => { const u = new URL(url); u.searchParams.set('member', id); return u.pathname + u.search; };
    const deny = new URL(url); deny.searchParams.set('deny', '1');
    return send(res, 200, `<!doctype html><meta name="viewport" content="width=device-width"><title>Sign in to HETMA (mock)</title>
      <style>body{font-family:system-ui;max-width:480px;margin:40px auto;padding:0 16px}a{display:block;padding:12px;margin:8px 0;border:1px solid #ccc;border-radius:8px;text-decoration:none;color:#143649}</style>
      <h1>Sign in to HETMA</h1><p>Local mock of Mighty. Choose who you are:</p>
      ${Object.entries(MEMBERS).map(([id, m]) => `<a data-member="${id}" href="${esc(link(id))}">${esc(m.name)} <small>(member ${id})</small></a>`).join('')}
      <a href="${esc(deny.pathname + deny.search)}">Cancel</a>`);
  }

  if (p === '/oauth/token' && req.method === 'POST') {
    const f = new URLSearchParams(await body(req));
    if (f.get('client_id') !== CLIENT_ID || f.get('client_secret') !== CLIENT_SECRET) return send(res, 401, { error: 'invalid_client' });
    const c = codes.get(f.get('code'));
    codes.delete(f.get('code'));
    if (!c || f.get('grant_type') !== 'authorization_code' || c.redirect_uri !== f.get('redirect_uri')) return send(res, 400, { error: 'invalid_grant' });
    const challenge = b64url(createHash('sha256').update(f.get('code_verifier') || '').digest());
    if (challenge !== c.challenge) return send(res, 400, { error: 'invalid_grant', error_description: 'PKCE verification failed' });
    const access = b64url(randomBytes(24));
    tokens.set(access, c.member);
    return send(res, 200, { access_token: access, refresh_token: b64url(randomBytes(24)), token_type: 'Bearer', expires_in: 3600, scope: 'read:userinfo' });
  }
  if (p === '/oauth/revoke' && req.method === 'POST') { const f = new URLSearchParams(await body(req)); tokens.delete(f.get('token')); return send(res, 200, {}); }

  const gql = p.match(/^\/networks\/([^/]+)\/graphql$/);
  if (gql && req.method === 'POST') {
    const id = tokens.get((req.headers.authorization || '').replace(/^Bearer\s+/i, ''));
    if (!id) return send(res, 401, { errors: [{ message: 'Unauthorized' }] });
    // Like the real API: `id` is a Relay global ID, `resourceId` the numeric member ID.
    const q = JSON.parse(await body(req) || '{}').query || '';
    const me = { id: Buffer.from(`Member-${id}`).toString('base64'), resourceId: String(id), name: member(id)?.name || `Member ${id}` };
    const fields = (q.match(/me\s*\{([^}]*)\}/)?.[1] || '').trim().split(/\s+/).filter(Boolean);
    const bad = fields.filter(f => !(f in me));
    if (bad.length) return send(res, 200, { errors: [{ message: `Field '${bad[0]}' doesn't exist on type 'Member'` }] });
    return send(res, 200, { data: { me: Object.fromEntries(fields.map(f => [f, me[f]])) } });
  }

  const admin = p.match(/^\/admin\/v1\/networks\/([^/]+)\/members\/(\d+)\/(plans|badges)(?:\/(\d+))?\/?$/);
  if (admin) {
    if ((req.headers.authorization || '') !== `Bearer ${ADMIN_KEY}`) return send(res, 401, { error: 'Unauthorized' });
    const [, , mid, what, badgeId] = admin;
    const m = member(mid);
    if (!m) return send(res, 404, { error: 'Member not found' });
    if (what === 'plans' && req.method === 'GET') {
      return send(res, 200, { items: m.plans.map(id => ({ id, name: id === GENERAL ? 'HETMA (General)' : 'HETMA (Higher Ed Hub)' })) });
    }
    badges[mid] ||= new Set();
    if (what === 'badges' && req.method === 'GET' && !badgeId) return send(res, 200, { items: [...badges[mid]].map(id => ({ id, title: 'HEx Credential' })) });
    if (what === 'badges' && req.method === 'POST') {
      const { badge_id } = JSON.parse(await body(req) || '{}');
      if (!badge_id) return send(res, 422, { error: 'badge_id required' });
      badges[mid].add(Number(badge_id));
      return send(res, 201, { id: Number(badge_id), title: 'HEx Credential' });
    }
    if (what === 'badges' && req.method === 'DELETE' && badgeId) {
      if (!badges[mid].delete(Number(badgeId))) return send(res, 404, { error: 'Badge not found' });
      res.writeHead(204); return res.end();
    }
  }
  send(res, 404, { error: 'not_found' });
}).listen(PORT, '127.0.0.1', () => console.log(`mock Mighty on ${PORT}`));
