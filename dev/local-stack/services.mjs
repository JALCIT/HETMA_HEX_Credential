// Local stand-ins for two hosted Supabase services, on :9100 behind the gateway:
//   /functions/v1/<name>/...  -> runs supabase/functions/_shared/mighty.js (same code as
//                                the deployed Edge Functions) with local settings
//   /storage/v1/...           -> a minimal private "certificates" bucket that applies
//                                the same rules as the storage policies migration
// Local development and CI only.
import http from 'node:http';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, randomBytes } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import pg from 'pg';
import { handleMightyAuth, handleCredentialSync } from '../../supabase/functions/_shared/mighty.js';
import { verify } from './jwt.mjs';
import { localEnv } from './local-env.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const STORE = join(ROOT, '.local-stack/storage');
mkdirSync(STORE, { recursive: true });
const db = new pg.Pool({ connectionString: process.env.DATABASE_URL_APP || 'postgres://postgres:postgres@127.0.0.1:5432/hetma_credential_local', max: 3 });
const signed = new Map(); // token -> { path, exp }

async function toRequest(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (v != null) headers.set(k, Array.isArray(v) ? v.join(', ') : v);
  return new Request(`http://127.0.0.1:54321${req.url}`, { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : body });
}
async function send(res, response) {
  const headers = {};
  response.headers.forEach((v, k) => { if (k !== 'set-cookie') headers[k] = v; });
  const cookies = response.headers.getSetCookie?.() || [];
  if (cookies.length) headers['set-cookie'] = cookies;
  res.writeHead(response.status, headers);
  res.end(Buffer.from(await response.arrayBuffer()));
}
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

async function storage(request) {
  const url = new URL(request.url);
  const m = url.pathname.match(/^\/storage\/v1\/object\/(sign\/)?certificates\/(.+)$/);
  if (!m) return json(404, { error: 'not_found', message: 'Only the certificates bucket exists locally.' });
  const isSign = Boolean(m[1]);
  const path = decodeURIComponent(m[2]);
  const ext = { pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg' };
  if (request.method === 'GET' && isSign) {
    const s = signed.get(url.searchParams.get('token'));
    if (!s || s.path !== path || s.exp < Date.now()) return json(400, { error: 'invalid_signature' });
    const file = join(STORE, path);
    if (!existsSync(file)) return json(404, { error: 'not_found' });
    return new Response(readFileSync(file), { headers: { 'Content-Type': ext[path.split('.').pop()] || 'application/octet-stream' } });
  }
  const claims = verify((request.headers.get('authorization') || '').replace(/^Bearer\s+/i, ''));
  if (!claims?.sub) return json(403, { error: 'unauthorized', message: 'Sign in first.' });
  const uid = claims.sub;
  if (request.method === 'POST' && !isSign) {
    if (!/^[0-9a-f-]{36}\/[0-9a-f-]{36}\.(pdf|png|jpg)$/.test(path) || path.split('/')[0] !== uid) {
      return json(403, { error: 'unauthorized', message: 'new row violates row-level security policy' });
    }
    const { rows } = await db.query('select upload_blocked, mighty_member_id from public.profiles where id = $1', [uid]);
    if (!rows[0] || rows[0].upload_blocked || !rows[0].mighty_member_id) return json(403, { error: 'unauthorized', message: 'new row violates row-level security policy' });
    let bytes;
    if ((request.headers.get('content-type') || '').includes('multipart/form-data')) {
      const form = await request.formData();
      const file = [...form.values()].find(v => typeof v === 'object' && 'arrayBuffer' in v);
      bytes = Buffer.from(await file.arrayBuffer());
    } else bytes = Buffer.from(await request.arrayBuffer());
    if (bytes.length > 10 * 1024 * 1024) return json(413, { error: 'Payload too large', message: 'The object exceeded the maximum allowed size' });
    const file = join(STORE, path);
    if (existsSync(file)) return json(409, { error: 'Duplicate', message: 'The resource already exists' });
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, bytes);
    return json(200, { Id: randomUUID(), Key: `certificates/${path}` });
  }
  if (request.method === 'POST' && isSign) {
    const owner = path.split('/')[0] === uid;
    const { rows } = await db.query('select 1 from public.staff_roles where user_id = $1', [uid]);
    if (!owner && !rows.length) return json(400, { error: 'not_found', message: 'Object not found' });
    const { expiresIn = 60 } = await request.json().catch(() => ({}));
    const token = randomBytes(24).toString('hex');
    signed.set(token, { path, exp: Date.now() + Math.min(Number(expiresIn) || 60, 3600) * 1000 });
    return json(200, { signedURL: `/object/sign/certificates/${path}?token=${token}` });
  }
  return json(405, { error: 'method_not_allowed' });
}

http.createServer(async (req, res) => {
  try {
    const request = await toRequest(req);
    const path = new URL(request.url).pathname;
    const deps = { env: localEnv, createClient, fetch };
    if (path.startsWith('/functions/v1/mighty-auth')) return send(res, await handleMightyAuth(request, deps));
    if (path.startsWith('/functions/v1/credential-sync')) return send(res, await handleCredentialSync(request, deps));
    if (path.startsWith('/storage/v1/')) return send(res, await storage(request));
    res.writeHead(404); res.end('not found');
  } catch (e) {
    console.error(e); res.writeHead(500); res.end(String(e.message));
  }
}).listen(9100, '127.0.0.1', () => console.log('functions + storage on 9100'));
