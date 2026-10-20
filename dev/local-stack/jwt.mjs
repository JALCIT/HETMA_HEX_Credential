// Minimal HS256 JWT signer/verifier for the local stack (anon/service keys). Local only.
import { createHmac, timingSafeEqual } from 'node:crypto';
const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
export function sign(payload, secret) {
  const data = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(payload)}`;
  return `${data}.${createHmac('sha256', secret).update(data).digest('base64url')}`;
}
export function verify(token, secret = LOCAL_JWT_SECRET) {
  const [h, p, s] = String(token || '').split('.');
  if (!s) return null;
  const want = createHmac('sha256', secret).update(`${h}.${p}`).digest();
  const got = Buffer.from(s, 'base64url');
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  const claims = JSON.parse(Buffer.from(p, 'base64url').toString());
  if (claims.exp && claims.exp * 1000 < Date.now()) return null;
  return claims;
}
export const LOCAL_JWT_SECRET = 'local-dev-only-jwt-secret-not-for-production-0000';
export const anonKey = () => sign({ role: 'anon', iss: 'supabase-local', iat: 1700000000, exp: 2000000000 }, LOCAL_JWT_SECRET);
export const serviceKey = () => sign({ role: 'service_role', iss: 'supabase-local', iat: 1700000000, exp: 2000000000 }, LOCAL_JWT_SECRET);
if (process.argv[2] === 'anon') console.log(anonKey());
