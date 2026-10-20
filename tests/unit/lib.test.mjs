import { describe, it, expect } from 'vitest';
import { areaStatus, progress, credentialId, checkFile, isExpired } from '../../src/lib/credential.js';
import { pkceChallenge, readCookie, loadConfig, lookupTier, randomToken } from '../../supabase/functions/_shared/mighty.js';

const sub = (area, extra = {}) => ({ area_id: area, status: 'active', verified_at: null, expires_on: null, ...extra });

describe('area status and progress', () => {
  it('prefers a verified, unexpired upload', () => {
    const s = [sub('a'), sub('a', { verified_at: '2026-10-01' })];
    expect(areaStatus('a', s, '2026-10-20').status).toBe('verified');
  });
  it('reports expired, revoked and not started', () => {
    expect(areaStatus('a', [sub('a', { expires_on: '2026-01-01' })], '2026-10-20').status).toBe('expired');
    expect(areaStatus('a', [sub('a', { status: 'revoked' })], '2026-10-20').status).toBe('revoked');
    expect(areaStatus('a', [], '2026-10-20').status).toBe('none');
  });
  it('an upload expiring today still counts', () => {
    expect(isExpired({ expires_on: '2026-10-20' }, '2026-10-20')).toBe(false);
  });
  it('counts only required areas', () => {
    const areas = [{ id: 'a', is_required: true }, { id: 'b', is_required: true }, { id: 'c', is_required: false }];
    const p = progress(areas, [sub('a'), sub('c')], '2026-10-20');
    expect(p).toMatchObject({ total: 2, done: 1, none: 1 });
  });
});

describe('credential ID', () => {
  it('formats from the slug and year', () => {
    expect(credentialId('4cb918a1ffff0000aaaa1111', '2026-10-20T12:00:00Z')).toBe('HETMA-2026-4CB9-18A1');
    expect(credentialId('', null)).toBe('');
  });
});

describe('file check', () => {
  const file = (bytes, type, size) => new File([new Uint8Array(bytes), new Uint8Array(Math.max(0, size - bytes.length))], 'x', { type });
  it('accepts real PDF, PNG and JPG headers', async () => {
    expect(await checkFile(file([0x25, 0x50, 0x44, 0x46], 'application/pdf', 500))).toBe('');
    expect(await checkFile(file([0x89, 0x50, 0x4e, 0x47], 'image/png', 500))).toBe('');
    expect(await checkFile(file([0xff, 0xd8, 0xff], 'image/jpeg', 500))).toBe('');
  });
  it('rejects disguised, empty, oversized and other files', async () => {
    expect(await checkFile(file([0x3c, 0x68], 'application/pdf', 500))).toMatch(/doesn’t look like/);
    expect(await checkFile(file([0x25, 0x50, 0x44, 0x46], 'application/pdf', 10))).toMatch(/empty/);
    expect(await checkFile(file([0x25, 0x50, 0x44, 0x46], 'application/pdf', 11 * 1024 * 1024))).toMatch(/10 MB/);
    expect(await checkFile(file([0x25], 'text/html', 500))).toMatch(/PDF, PNG or JPG/);
    expect(await checkFile(null)).toMatch(/Choose/);
  });
});

describe('Mighty sign-in helpers', () => {
  it('computes the PKCE S256 challenge (RFC 7636 appendix B)', async () => {
    expect(await pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });
  it('random tokens are URL-safe and unique', () => {
    const a = randomToken(32), b = randomToken(32);
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a).not.toBe(b);
  });
  it('reads one cookie by name', () => {
    const req = new Request('https://x', { headers: { cookie: 'a=1; hc_mighty_oauth=abc%3D; b=2' } });
    expect(readCookie(req, 'hc_mighty_oauth')).toBe('abc=');
    expect(readCookie(req, 'missing')).toBeNull();
  });
  it('defaults to the HETMA community and its plans', () => {
    const c = loadConfig({ SUPABASE_URL: 'https://ref.supabase.co/' });
    expect(c.issuer).toBe('https://community.hetma.org');
    expect(c.authorizeUrl).toBe('https://community.hetma.org/oauth/authorize');
    expect(c.callbackUrl).toBe('https://ref.supabase.co/functions/v1/mighty-auth/callback');
    expect([c.planGeneral, c.planHigherEd]).toEqual(['1736546', '1819684']);
  });
  it('maps Mighty plans to a membership tier', async () => {
    const cfg = loadConfig({ MIGHTY_ADMIN_API_KEY: 'k', MIGHTY_NETWORK: 'n' });
    const fake = items => async () => new Response(JSON.stringify({ items }), { status: 200 });
    expect((await lookupTier(cfg, fake([{ id: 1736546 }, { id: 1819684 }]), 1)).tier).toBe('higher_ed');
    expect((await lookupTier(cfg, fake([{ id: 1736546 }]), 1)).tier).toBe('general');
    expect((await lookupTier(cfg, fake([]), 1)).tier).toBe('none');
    expect((await lookupTier(cfg, async () => new Response('{}', { status: 404 }), 1)).reason).toBe('plans_http_404');
    expect((await lookupTier(loadConfig({}), fake([]), 1)).reason).toBe('not_configured');
  });
});
