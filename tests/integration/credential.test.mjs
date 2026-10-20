import { describe, it, expect, beforeAll } from 'vitest';
import { mightySignIn, newUser, newAdmin, sql, must, anonClient, areas, submit, completeAll, newFilePath, mockState, SUPABASE_URL } from './helpers.mjs';

let n = 500000 + Math.floor(Math.random() * 100000) * 2;
const member = () => mightySignIn((n += 2) + 1);
const sync = (client, body = {}) => client.functions.invoke('credential-sync', { body });

let AREAS;
beforeAll(async () => { AREAS = await areas(); });

describe('uploads (honor system)', () => {
  it('requires the attestation', async () => {
    const m = await member();
    const r = await submit(m.client, m.id, AREAS[0].id, { p_attested: false });
    expect(r).toMatchObject({ ok: false, error: 'attestation_required' });
  });

  it('only accepts files in the member’s own folder', async () => {
    const m = await member(), other = await member();
    const r = await submit(m.client, m.id, AREAS[0].id, { p_file_path: newFilePath(other.id) });
    expect(r).toMatchObject({ ok: false, error: 'bad_file' });
  });

  it('validates provider, dates and area', async () => {
    const m = await member();
    expect(await submit(m.client, m.id, AREAS[0].id, { p_provider_other: '  ' })).toMatchObject({ error: 'provider_required' });
    expect(await submit(m.client, m.id, AREAS[0].id, { p_completion_date: '2099-01-01' })).toMatchObject({ error: 'bad_completion_date' });
    expect(await submit(m.client, m.id, AREAS[0].id, { p_expires_on: '2020-01-01' })).toMatchObject({ error: 'bad_expiry' });
    expect(await submit(m.client, m.id, '00000000-0000-0000-0000-000000000000')).toMatchObject({ error: 'unknown_area' });
    expect(await submit(m.client, m.id, AREAS[0].id, { p_file_type: 'text/html' })).toMatchObject({ error: 'bad_file' });
    expect(await submit(m.client, m.id, AREAS[0].id, { p_file_type: 'image/png' })).toMatchObject({ error: 'bad_file' }); // .pdf path
  });

  it('counts immediately and earns the credential when every required area has an upload', async () => {
    const m = await member();
    const first = await submit(m.client, m.id, AREAS[0].id);
    expect(first).toMatchObject({ ok: true, credential_status: 'none', credential_changed: false });
    const last = await completeAll(m.client, m.id);
    expect(last).toMatchObject({ ok: true, credential_status: 'active', credential_changed: true });
    const cred = must(await m.client.from('credentials').select('*').eq('user_id', m.id).single());
    expect(cred.slug).toMatch(/^[a-z0-9]{24}$/);
    expect(cred.badge_desired).toBe(true);
  });

  it('members can’t see the staff note on why their uploads were paused', async () => {
    const m = await member();
    const r = await m.client.from('profiles').select('blocked_reason').eq('id', m.id);
    expect(r.error).not.toBeNull();
  });

  it('members cannot write uploads or credentials directly', async () => {
    const m = await member();
    const ins = await m.client.from('submissions').insert({ user_id: m.id, area_id: AREAS[0].id, completion_date: '2026-01-01', file_path: newFilePath(m.id), file_name: 'x.pdf', file_type: 'application/pdf', attested_at: new Date().toISOString() });
    expect(ins.error).not.toBeNull();
    const up = await m.client.from('credentials').update({ status: 'active' }).eq('user_id', m.id).select();
    expect(up.error || up.data.length === 0).toBeTruthy();
  });

  it('members see only their own uploads; anonymous visitors see none', async () => {
    const a = await member(), b = await member();
    await submit(a.client, a.id, AREAS[0].id);
    const seen = must(await b.client.from('submissions').select('id, user_id'));
    expect(seen.every(s => s.user_id === b.id)).toBe(true);
    const anon = await anonClient().from('submissions').select('id');
    expect(anon.error || anon.data.length === 0).toBeTruthy();
  });

  it('blocked members cannot upload', async () => {
    const admin = await newAdmin();
    const m = await member();
    expect(must(await admin.client.rpc('admin_set_upload_block', { p_user_id: m.id, p_blocked: true, p_reason: 'Under review' }))).toMatchObject({ ok: true });
    expect(await submit(m.client, m.id, AREAS[0].id)).toMatchObject({ ok: false, error: 'uploads_paused' });
  });

  it('expired uploads stop counting', async () => {
    const m = await member();
    await completeAll(m.client, m.id);
    const [s] = await sql('select id from public.submissions where user_id = $1 limit 1', [m.id]);
    await sql(`update public.submissions set completion_date = '2020-01-01', expires_on = '2021-01-01' where id = $1`, [s.id]);
    const r = must(await m.client.rpc('refresh_my_credential'));
    expect(r).toMatchObject({ ok: true, credential_status: 'inactive', credential_changed: true });
  });
});

describe('public credential page', () => {
  it('shows name, date and areas for an active credential, and nothing private', async () => {
    const m = await member();
    await completeAll(m.client, m.id);
    const { slug } = must(await m.client.from('credentials').select('slug').eq('user_id', m.id).single());
    const page = must(await anonClient().rpc('get_public_credential', { p_slug: slug }));
    expect(page).toMatchObject({ found: true, status: 'active' });
    expect(page.areas.length).toBe(AREAS.length);
    expect(JSON.stringify(page)).not.toMatch(/file_path|mighty_member_id|email|reason/);
  });
  it('unknown or malformed slugs return not found', async () => {
    expect(must(await anonClient().rpc('get_public_credential', { p_slug: 'abcdefabcdefabcdefabcdef' }))).toEqual({ found: false });
    expect(must(await anonClient().rpc('get_public_credential', { p_slug: "x' or 1=1 --" }))).toEqual({ found: false });
  });
});

describe('admin audit: verify, revoke, restore', () => {
  it('only staff can use admin functions', async () => {
    const m = await member();
    expect(must(await m.client.rpc('admin_verify_submission', { p_id: '00000000-0000-0000-0000-000000000000' }))).toMatchObject({ error: 'forbidden' });
    expect(must(await m.client.rpc('admin_list_submissions', {}))).toEqual([]);
    const audit = must(await m.client.from('audit_log').select('id'));
    expect(audit).toEqual([]);
  });

  it('revoking an upload ends the credential; restoring brings it back; all audited', async () => {
    const admin = await newAdmin();
    const m = await member();
    await completeAll(m.client, m.id);
    const [s] = await sql('select id from public.submissions where user_id = $1 limit 1', [m.id]);
    expect(must(await admin.client.rpc('admin_revoke_submission', { p_id: s.id, p_reason: '' }))).toMatchObject({ error: 'reason_required' });
    const rev = must(await admin.client.rpc('admin_revoke_submission', { p_id: s.id, p_reason: 'Issuer has no record of this certificate.' }));
    expect(rev).toMatchObject({ ok: true, credential_status: 'inactive', credential_changed: true });
    const mine = must(await m.client.from('submissions').select('status, revoke_reason').eq('id', s.id).single());
    expect(mine).toEqual({ status: 'revoked', revoke_reason: 'Issuer has no record of this certificate.' });
    const res = must(await admin.client.rpc('admin_restore_submission', { p_id: s.id }));
    expect(res).toMatchObject({ ok: true, credential_status: 'active', credential_changed: true });
    const log = await sql(`select action from public.audit_log where target_user = $1 order by id`, [m.id]);
    expect(log.map(l => l.action)).toEqual(expect.arrayContaining(['credential_earned', 'revoke_upload', 'credential_ended', 'restore_upload']));
  });

  it('verifying marks an upload without changing completion', async () => {
    const admin = await newAdmin();
    const m = await member();
    const { submission_id } = await submit(m.client, m.id, AREAS[0].id);
    expect(must(await admin.client.rpc('admin_verify_submission', { p_id: submission_id }))).toMatchObject({ ok: true });
    const row = must(await m.client.from('submissions').select('verified_at').eq('id', submission_id).single());
    expect(row.verified_at).not.toBeNull();
    const list = must(await admin.client.rpc('admin_list_submissions', { p_filter: 'verified', p_search: '' }));
    expect(list.some(r => r.id === submission_id)).toBe(true);
  });

  it('admins cannot review their own uploads; super admins can, and it is audited as a self-review', async () => {
    const admin = await newAdmin();
    await sql('insert into public.credentials (user_id) values ($1) on conflict do nothing', [admin.id]);
    const { submission_id } = await submit(admin.client, admin.id, AREAS[0].id);
    expect(must(await admin.client.rpc('admin_revoke_submission', { p_id: submission_id, p_reason: 'test reason' }))).toMatchObject({ error: 'own_upload' });
    expect(must(await admin.client.rpc('admin_verify_submission', { p_id: submission_id }))).toMatchObject({ error: 'own_upload' });

    const sup = await newAdmin('super_admin');
    const own = await submit(sup.client, sup.id, AREAS[0].id);
    expect(must(await sup.client.rpc('admin_verify_submission', { p_id: own.submission_id }))).toMatchObject({ ok: true });
    expect(must(await sup.client.rpc('admin_revoke_submission', { p_id: own.submission_id, p_reason: 'Wrong file' }))).toMatchObject({ ok: true });
    expect(must(await sup.client.rpc('admin_restore_submission', { p_id: own.submission_id }))).toMatchObject({ ok: true });
    const log = await sql(`select action, details from public.audit_log where target_id = $1 order by id`, [own.submission_id]);
    expect(log.map(l => l.action)).toEqual(['verify_upload', 'revoke_upload', 'restore_upload']);
    expect(log.every(l => l.details.self_review === true)).toBe(true);
  });

  it('the last super admin cannot be removed; admins cannot manage the team', async () => {
    const admin = await newAdmin('admin');
    const m = await member();
    expect(must(await admin.client.rpc('admin_set_role', { p_user_id: m.id, p_role: 'admin' }))).toMatchObject({ error: 'forbidden' });
    await sql(`delete from public.staff_roles where role = 'super_admin'`);
    const sup = await newAdmin('super_admin');
    expect(must(await sup.client.rpc('admin_set_role', { p_user_id: sup.id, p_role: null }))).toMatchObject({ error: 'last_super_admin' });
    expect(must(await sup.client.rpc('admin_set_role', { p_user_id: m.id, p_role: 'admin' }))).toMatchObject({ ok: true });
  });

  it('members cannot edit competency areas; staff edits are audited', async () => {
    const m = await member(), admin = await newAdmin();
    const bad = await m.client.from('competency_areas').update({ name: 'Hacked' }).eq('id', AREAS[0].id).select();
    expect(bad.error || bad.data.length === 0).toBeTruthy();
    const code = `T${Math.floor(Math.random() * 1e6)}`;
    const area = must(await admin.client.from('competency_areas').insert({ code, name: 'Temp area', is_required: false, sort_order: 999 }).select().single());
    must(await admin.client.from('competency_areas').update({ is_active: false }).eq('id', area.id));
    const log = await sql(`select action from public.audit_log where target_id = $1`, [area.id]);
    expect(log.map(l => l.action)).toEqual(['insert_competency_areas', 'update_competency_areas']);
  });
});

describe('Mighty badge sync', () => {
  it('adds the badge when earned and removes it when revoked', async () => {
    const admin = await newAdmin();
    const m = await member();
    const [{ mighty_member_id: mid }] = await sql('select mighty_member_id from public.profiles where id = $1', [m.id]);
    await completeAll(m.client, m.id);
    const r1 = await sync(m.client);
    expect(r1.data).toMatchObject({ ok: true, action: 'badge_added' });
    expect((await mockState()).badges[mid]).toEqual([777]);
    expect((await sync(m.client)).data).toMatchObject({ ok: true, action: null }); // nothing to change
    const [s] = await sql('select id from public.submissions where user_id = $1 limit 1', [m.id]);
    must(await admin.client.rpc('admin_revoke_submission', { p_id: s.id, p_reason: 'Not genuine' }));
    const r2 = await sync(admin.client, { user_id: m.id });
    expect(r2.data).toMatchObject({ ok: true, action: 'badge_removed' });
    expect((await mockState()).badges[mid]).toEqual([]);
    const cred = must(await admin.client.from('credentials').select('badge_awarded, badge_error').eq('user_id', m.id).single());
    expect(cred).toEqual({ badge_awarded: false, badge_error: null });
  });

  it('members can only sync themselves; accounts without Mighty are skipped', async () => {
    const a = await member(), b = await member();
    expect((await sync(a.client, { user_id: b.id })).error).not.toBeNull();
    const plain = await newUser('nomighty');
    expect((await sync(plain.client)).data).toMatchObject({ ok: true, skipped: 'no_mighty_account' });
  });

  it('rejects calls without a signed-in user', async () => {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/credential-sync`, { method: 'POST', body: '{}' });
    expect(res.status).toBe(401);
  });
});

describe('managing areas and providers', () => {
  it('only super admins can delete; unused areas are deleted, used ones hidden', async () => {
    const admin = await newAdmin('admin'), sup = await newAdmin('super_admin');
    const make = async code => must(await sup.client.from('competency_areas')
      .insert({ code, name: `Test ${code}`, is_required: false, sort_order: 999 }).select('id').single()).id;
    const unused = await make(`T${String(n).slice(-5)}`), used = await make(`U${String(n).slice(-5)}`);
    const m = await member();
    expect(await submit(m.client, m.id, used)).toMatchObject({ ok: true });

    expect(must(await admin.client.rpc('admin_delete_area', { p_id: unused }))).toMatchObject({ error: 'forbidden' });
    expect(must(await sup.client.rpc('admin_delete_area', { p_id: unused }))).toMatchObject({ ok: true, result: 'deleted' });
    expect(await sql('select 1 from public.competency_areas where id = $1', [unused])).toHaveLength(0);
    expect(must(await sup.client.rpc('admin_delete_area', { p_id: used }))).toMatchObject({ ok: true, result: 'hidden', uploads: 1 });
    expect(await sql('select is_active from public.competency_areas where id = $1', [used])).toEqual([{ is_active: false }]);
    expect(await sql('select count(*)::int as c from public.submissions where area_id = $1', [used])).toEqual([{ c: 1 }]);
    const anon = await anonClient().rpc('admin_delete_area', { p_id: used });
    expect(anon.error).not.toBeNull();
  });

  it('providers: unused are deleted, used ones hidden so uploads keep the name', async () => {
    const admin = await newAdmin('admin'), sup = await newAdmin('super_admin');
    const make = async name => must(await sup.client.from('providers').insert({ name }).select('id').single()).id;
    const usedName = `Used ${n}`;
    const unused = await make(`Unused ${n}`), used = await make(usedName);
    const m = await member();
    expect(await submit(m.client, m.id, AREAS[0].id, { p_provider_id: used, p_provider_other: null })).toMatchObject({ ok: true });
    expect(must(await admin.client.rpc('admin_delete_provider', { p_id: unused }))).toMatchObject({ error: 'forbidden' });
    expect(must(await sup.client.rpc('admin_delete_provider', { p_id: unused }))).toMatchObject({ ok: true, result: 'deleted' });
    expect(must(await sup.client.rpc('admin_delete_provider', { p_id: used }))).toMatchObject({ ok: true, result: 'hidden' });
    const [s] = await sql('select p.name from public.submissions s join public.providers p on p.id = s.provider_id where s.user_id = $1', [m.id]);
    expect(s.name).toBe(usedName);
  });

  it('re-checks everyone when the required areas change', async () => {
    const sup = await newAdmin('super_admin');
    const m = await member();
    expect(await completeAll(m.client, m.id)).toMatchObject({ credential_status: 'active' });
    const extra = must(await sup.client.from('competency_areas')
      .insert({ code: `X${String(n).slice(-5)}`, name: 'Extra required area', is_required: true, sort_order: 999 }).select('id').single()).id;
    try {
      const r1 = must(await sup.client.rpc('admin_recheck_credentials'));
      expect(r1.ok).toBe(true);
      expect(r1.changed_user_ids).toContain(m.id);
      expect(must(await m.client.from('credentials').select('status').eq('user_id', m.id).single()).status).toBe('inactive');
    } finally {
      expect(must(await sup.client.rpc('admin_delete_area', { p_id: extra }))).toMatchObject({ result: 'deleted' });
    }
    const r2 = must(await sup.client.rpc('admin_recheck_credentials'));
    expect(r2.changed_user_ids).toContain(m.id);
    expect(must(await m.client.from('credentials').select('status').eq('user_id', m.id).single()).status).toBe('active');
    const plain = await member();
    expect(must(await plain.client.rpc('admin_recheck_credentials'))).toMatchObject({ error: 'forbidden' });
  });
});
