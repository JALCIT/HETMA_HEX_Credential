import { describe, it, expect } from 'vitest';
import { startSignIn, approveAt, callback, hashParams, mightySignIn, sql, anonClient, redeem, newBind, MIGHTY, SUPABASE_URL } from './helpers.mjs';

let next = 3000 + Math.floor(Math.random() * 100000) * 2;
const freshMember = (higherEd = false) => (next += 2) + (higherEd ? 0 : 1);

describe('Sign in with Mighty', () => {
  it('starts a PKCE authorization request at the community and sets a short-lived cookie', async () => {
    const { res, cookie, location } = await startSignIn();
    expect(res.status).toBe(302);
    expect(location.origin).toBe(MIGHTY);
    expect(location.pathname).toBe('/oauth/authorize');
    expect(location.searchParams.get('code_challenge_method')).toBe('S256');
    expect(location.searchParams.get('scope')).toBe('read:userinfo');
    expect(location.searchParams.get('state')).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(cookie).toMatch(/^hc_mo_[A-Za-z0-9]{16}=/);
    expect(res.headers.get('set-cookie')).toMatch(/HttpOnly/i);
    expect(res.headers.get('set-cookie')).toMatch(/SameSite=Lax/i);
  });

  it('creates one account per Mighty member, with name and tier from Mighty', async () => {
    const mid = freshMember(true);
    const a = await mightySignIn(mid);
    const [p] = await sql('select mighty_member_id, full_name, membership_tier, tier_checked_at from public.profiles where id = $1', [a.id]);
    expect(p.mighty_member_id).toBe(String(mid));
    expect(p.full_name).toBe(`Test Member ${mid}`);
    expect(p.membership_tier).toBe('higher_ed');
    expect(p.tier_checked_at).not.toBeNull();
    const b = await mightySignIn(mid);
    expect(b.id).toBe(a.id);
    const [{ n }] = await sql('select count(*)::int n from public.profiles where mighty_member_id = $1', [mid]);
    expect(n).toBe(1);
  });

  it('sets the General tier for General-only members', async () => {
    const mid = freshMember(false);
    const a = await mightySignIn(mid);
    const [p] = await sql('select membership_tier from public.profiles where id = $1', [a.id]);
    expect(p.membership_tier).toBe('general');
  });

  it('rejects a callback without the browser cookie that started it', async () => {
    const { location } = await startSignIn();
    const cb = await approveAt(location, freshMember());
    const app = await callback(cb, null);
    expect(hashParams(app).route).toBe('/signin');
    expect(hashParams(app).params.get('error')).toBe('session_mismatch');
  });

  it('accepts each state only once', async () => {
    const { cookie, location } = await startSignIn();
    const cb = await approveAt(location, freshMember());
    expect(hashParams(await callback(cb, cookie)).route).toBe('/auth');
    const again = await callback(cb, cookie);
    expect(hashParams(again).params.get('error')).toBe('expired');
  });

  it('rejects a response from a different issuer', async () => {
    const { cookie, location } = await startSignIn();
    const cb = await approveAt(location, freshMember());
    cb.searchParams.set('iss', 'https://evil.example');
    expect(hashParams(await callback(cb, cookie)).params.get('error')).toBe('wrong_issuer');
  });

  it('reports a cancelled sign-in', async () => {
    const { cookie, location } = await startSignIn();
    location.searchParams.set('deny', '1');
    const res = await fetch(location, { redirect: 'manual' });
    const app = await callback(new URL(res.headers.get('location')), cookie);
    expect(hashParams(app).params.get('error')).toBe('denied');
  });

  it('join sends new people to the community join page and back into sign-in', async () => {
    const { location } = await startSignIn('join');
    expect(location.pathname).toBe('/users/onboarding/plans');
    const from = new URL(location.searchParams.get('from'));
    expect(from.pathname).toBe('/oauth/authorize');
    expect(from.searchParams.get('state')).toBeTruthy();
  });

  it('refuses to start without the tab binding', async () => {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/mighty-auth/start`, { redirect: 'manual' });
    expect(hashParams(new URL(res.headers.get('location'))).params.get('error')).toBe('invalid_request');
  });

  it('the handoff code works once, and only for the tab that started sign-in (no login CSRF)', async () => {
    const { cookie, location, bind } = await startSignIn();
    const app = await callback(await approveAt(location, freshMember()), cookie);
    const code = hashParams(app).params.get('code');
    expect(hashParams(app).params.get('th')).toBeNull(); // no session token in the URL
    expect(await redeem(code, newBind().bind)).toMatchObject({ ok: false, error: 'session_mismatch' });
    // A failed attempt burns the code, so a stolen link is useless afterwards.
    expect(await redeem(code, bind.bind)).toMatchObject({ ok: false, error: 'expired' });

    const s2 = await startSignIn();
    const app2 = await callback(await approveAt(s2.location, freshMember()), s2.cookie);
    const code2 = hashParams(app2).params.get('code');
    const ok = await redeem(code2, s2.bind.bind);
    expect(ok).toMatchObject({ ok: true });
    expect((await anonClient().auth.verifyOtp({ token_hash: ok.token_hash, type: 'magiclink' })).error).toBeNull();
    expect((await anonClient().auth.verifyOtp({ token_hash: ok.token_hash, type: 'magiclink' })).error).not.toBeNull();
    expect(await redeem(code2, s2.bind.bind)).toMatchObject({ ok: false, error: 'expired' });
  });

  it('a pre-registered look-alike account is never linked to a Mighty member (no takeover)', async () => {
    const mid = freshMember();
    const attacker = anonClient();
    const email = `m${mid}@members.hetma-credential.invalid`;
    await attacker.auth.signUp({ email, password: 'attacker-password-123' });
    const { cookie, location } = await startSignIn();
    const app = await callback(await approveAt(location, mid), cookie);
    expect(hashParams(app).params.get('error')).toBe('account');
    const [{ n }] = await sql('select count(*)::int n from public.profiles where mighty_member_id = $1', [mid]);
    expect(n).toBe(0);
  });

  it('accounts without a Mighty link cannot upload', async () => {
    const plain = anonClient();
    const { data } = await plain.auth.signUp({ email: `plain-${Date.now()}@example.org`, password: 'pw-123456789' });
    const [area] = await sql('select id from public.competency_areas limit 1');
    const r = await plain.rpc('submit_certificate', { p_area_id: area.id, p_provider_id: null, p_provider_other: 'X', p_completion_date: '2026-09-01', p_expires_on: null, p_file_path: `${data.user.id}/${crypto.randomUUID()}.pdf`, p_file_name: 'a.pdf', p_file_type: 'application/pdf', p_attested: true });
    expect(r.data).toMatchObject({ ok: false, error: 'no_mighty_account' });
  });

  it('sign-up metadata can’t set a display name', async () => {
    const c = anonClient();
    const { data } = await c.auth.signUp({ email: `meta-${Date.now()}@example.org`, password: 'pw-123456789', options: { data: { full_name: 'Jane Doe' } } });
    const [p] = await sql('select full_name from public.profiles where id = $1', [data.user.id]);
    expect(p.full_name).toBe('');
  });

  it('browser roles cannot read sign-in transactions', async () => {
    const { client } = await mightySignIn(freshMember());
    const r = await client.from('oauth_transactions').select('*');
    expect(r.error).not.toBeNull();
    const anon = await anonClient().from('oauth_transactions').select('*');
    expect(anon.error).not.toBeNull();
  });

  it('a member cannot change their own Mighty ID, tier or block flag', async () => {
    const { client, id } = await mightySignIn(freshMember());
    const r = await client.from('profiles').update({ membership_tier: 'higher_ed', upload_blocked: false, mighty_member_id: 1 }).eq('id', id).select();
    expect(r.error || r.data.length === 0).toBeTruthy();
  });
});
