// Admin workspace for HETMA staff. Every action here is re-checked by the database
// (definer functions + RLS); hiding a button is never the only protection.
import { supabase, q, rpc, fileUrl, syncBadge } from '../api.js';
import { shell, go } from '../shell.js';
import { esc, icon, toast, openModal, closeModal, busy } from '../lib/dom.js';
import { openSigned } from '../lib/open.js';
import { fmtDate } from '../lib/credential.js';

const TABS = [
  ['uploads', 'Uploads'], ['members', 'Members'], ['areas', 'Areas & providers'], ['team', 'Team'], ['audit', 'Audit log'],
];
const TIER = { higher_ed: 'Higher Ed Hub', general: 'General', none: '—' };
const CRED = { active: 'Active', inactive: 'No longer active', none: 'In progress' };
const state = { filter: 'unverified', search: '', memberSearch: '' };
let me = null;

export async function renderAdmin(user, tab) {
  const roleRow = await q(supabase.from('staff_roles').select('role').eq('user_id', user.id).maybeSingle()).catch(() => null);
  if (!roleRow) { go('/me'); return; }
  me = { id: user.id, role: roleRow.role };
  if (!TABS.some(([k]) => k === tab)) tab = 'uploads';
  const main = shell(`
    <div class="admin-head"><h1>Admin</h1><p class="fine">Signed in as ${me.role === 'super_admin' ? 'super admin' : 'admin'}. Uploads already count; this is where HETMA spot-checks, verifies and revokes.</p></div>
    <nav class="tabs" aria-label="Admin sections">${TABS.map(([k, label]) => `<a href="#/admin/${k}" class="${k === tab ? 'active' : ''}" ${k === tab ? 'aria-current="page"' : ''}>${label}</a>`).join('')}</nav>
    <section id="tab" class="tab-body"><p class="loading">Loading…</p></section>`, { user, role: me.role, wide: true });
  const body = main.querySelector('#tab');
  try {
    await ({ uploads, members, areas, team, audit })[tab](body);
  } catch (e) { body.innerHTML = `<div class="notice error">${esc(e.message)}</div>`; }
}

const pill = (cls, text) => `<span class="chip s-${cls}">${esc(text)}</span>`;
const uploadStatus = r => r.status === 'revoked' ? pill('revoked', 'Revoked') : r.verified_at ? pill('verified', 'Verified') : pill('uploaded', 'Not checked');

// ---------------------------------------------------------------- uploads
async function uploads(body) {
  const rows = await rpc('admin_list_submissions', { p_filter: state.filter, p_search: state.search, p_limit: 100, p_offset: 0 });
  const total = rows[0]?.total_count || 0;
  body.innerHTML = `
    <div class="toolbar">
      <div class="seg" role="group" aria-label="Filter uploads">
        ${[['unverified', 'Not checked'], ['verified', 'Verified'], ['revoked', 'Revoked'], ['all', 'All']].map(([k, l]) => `<button type="button" data-filter="${k}" aria-pressed="${state.filter === k}">${l}</button>`).join('')}
      </div>
      <input type="search" id="up-search" placeholder="Search member, area or provider" aria-label="Search uploads" value="${esc(state.search)}">
      <button class="btn primary" type="button" id="spot">${icon('target')}Random spot-check</button>
    </div>
    <p class="fine">${total} upload${total === 1 ? '' : 's'}${total > rows.length ? `, showing the newest ${rows.length}` : ''}.</p>
    ${rows.length ? `<div class="table-wrap"><table class="data">
      <thead><tr><th>Member</th><th>Area</th><th>Provider</th><th>Uploaded</th><th>Status</th><th></th></tr></thead>
      <tbody>${rows.map(r => `<tr>
        <td><b>${esc(r.member_name || 'Unnamed member')}</b><div class="fine">${esc(TIER[r.membership_tier])}${r.upload_blocked ? ' · uploads paused' : ''}</div></td>
        <td>${esc(r.area_name)}</td><td>${esc(r.provider_name || '')}</td>
        <td class="num">${fmtDate(r.submitted_at)}</td><td>${uploadStatus(r)}</td>
        <td><button class="btn small" type="button" data-open="${esc(r.id)}">Review</button></td></tr>`).join('')}</tbody></table></div>`
      : `<div class="empty">No uploads match this filter.</div>`}`;
  body.querySelectorAll('[data-filter]').forEach(b => b.addEventListener('click', () => { state.filter = b.dataset.filter; uploads(body); }));
  let t;
  body.querySelector('#up-search').addEventListener('input', e => { clearTimeout(t); t = setTimeout(() => { state.search = e.target.value; uploads(body).then(() => { const s = body.querySelector('#up-search'); s.focus(); s.setSelectionRange(s.value.length, s.value.length); }); }, 300); });
  body.querySelector('#spot').addEventListener('click', async () => {
    const id = await rpc('admin_random_unverified');
    if (!id) return toast('Nothing left to spot-check.');
    const [row] = await rpc('admin_list_submissions', { p_filter: 'unverified', p_search: '', p_limit: 200, p_offset: 0 }).then(all => all.filter(r => r.id === id));
    if (row) reviewUpload(row, () => uploads(body));
  });
  body.querySelectorAll('[data-open]').forEach(b => b.addEventListener('click', () => reviewUpload(rows.find(r => r.id === b.dataset.open), () => uploads(body))));
}

function reviewUpload(r, after) {
  const own = r.user_id === me.id;
  const m = openModal(r.area_name, `${r.member_name || 'Unnamed member'} · ${TIER[r.membership_tier]}`, `
    <dl class="dl">
      <dt>Provider</dt><dd>${esc(r.provider_name || '')}</dd>
      <dt>Completed</dt><dd>${fmtDate(r.completion_date)}${r.expires_on ? ` · expires ${fmtDate(r.expires_on)}` : ''}</dd>
      <dt>Uploaded</dt><dd>${fmtDate(r.submitted_at)}, with the member’s statement that it’s genuine</dd>
      <dt>File</dt><dd><span class="mono">${esc(r.file_name)}</span></dd>
      <dt>Status</dt><dd>${uploadStatus(r)}${r.verified_at ? ` on ${fmtDate(r.verified_at)}` : ''}</dd>
      ${r.revoke_reason ? `<dt>Reason</dt><dd>${esc(r.revoke_reason)}</dd>` : ''}
      <dt>Credential</dt><dd>${esc(CRED[r.credential_status] || 'In progress')}</dd>
      <dt>Mighty member</dt><dd>${r.mighty_member_id ? esc(r.mighty_member_id) : '—'}</dd>
    </dl>
    <button class="btn" type="button" id="rv-file">${icon('file')}Open certificate</button>
    ${own ? '<p class="notice warn">This is your own upload. Another admin has to review it.</p>' : r.status === 'active' ? `
      <label for="rv-reason">Reason (shown to the member if you revoke)</label>
      <textarea id="rv-reason" maxlength="1000" placeholder="For example: The provider has no record of this certificate."></textarea>
      <p class="form-error" id="rv-error" hidden></p>
      <div class="actions">
        <button class="btn link-btn" type="button" id="rv-block">${r.upload_blocked ? 'Resume uploads for this member' : 'Pause uploads for this member'}</button>
        <button class="btn danger" type="button" id="rv-revoke">Revoke</button>
        ${r.verified_at ? '' : '<button class="btn good" type="button" id="rv-verify">Mark verified</button>'}
      </div>` : `
      <div class="actions"><button class="btn link-btn" type="button" id="rv-block">${r.upload_blocked ? 'Resume uploads for this member' : 'Pause uploads for this member'}</button>
      <button class="btn" type="button" id="rv-restore">Restore upload</button></div>`}`, { wide: true });
  const err = msg => { const e = m.querySelector('#rv-error'); if (e) { e.textContent = msg; e.hidden = !msg; } else toast(msg, 'error'); };
  m.querySelector('#rv-file').addEventListener('click', () => openSigned(() => fileUrl(r.file_path)).catch(e => toast(e.message, 'error')));
  const finish = async (res, msg) => {
    if (!res.ok) return err(res.message);
    closeModal();
    let note = msg;
    if (res.credential_changed) {
      const s = await syncBadge(r.user_id);
      note += res.credential_status === 'active'
        ? (s.action === 'badge_added' ? ' Credential restored and the Mighty badge was added back.' : ' Credential restored.')
        : (s.action === 'badge_removed' ? ' Their credential is no longer active and the Mighty badge was removed.' : s.ok ? ' Their credential is no longer active.' : ' Their credential is no longer active, but the Mighty badge couldn’t be removed. Retry from the Members tab.');
    }
    toast(note, res.credential_changed && res.credential_status !== 'active' ? 'ok' : 'ok');
    after();
  };
  m.querySelector('#rv-verify')?.addEventListener('click', e => busy(e.currentTarget, async () => finish(await rpc('admin_verify_submission', { p_id: r.id }), 'Marked verified.')));
  m.querySelector('#rv-revoke')?.addEventListener('click', e => busy(e.currentTarget, async () => {
    const reason = m.querySelector('#rv-reason').value.trim();
    if (reason.length < 3) return err('Add a reason so the member knows why.');
    finish(await rpc('admin_revoke_submission', { p_id: r.id, p_reason: reason }), 'Upload revoked. The member will see your reason.');
  }));
  m.querySelector('#rv-restore')?.addEventListener('click', e => busy(e.currentTarget, async () => finish(await rpc('admin_restore_submission', { p_id: r.id }), 'Upload restored.')));
  m.querySelector('#rv-block')?.addEventListener('click', () => blockMember(r.user_id, r.member_name, r.upload_blocked, after));
}

function blockMember(userId, name, blocked, after) {
  if (blocked) {
    return rpc('admin_set_upload_block', { p_user_id: userId, p_blocked: false, p_reason: null })
      .then(r => { if (!r.ok) return toast(r.message, 'error'); closeModal(); toast(`${name || 'Member'} can upload again.`); after(); });
  }
  const m = openModal('Pause uploads', name || 'Member', `
    <label for="bl-reason">Reason (kept in the audit log)</label><textarea id="bl-reason" maxlength="1000"></textarea>
    <p class="form-error" id="bl-error" hidden></p>
    <div class="actions"><button class="btn ghost" type="button" data-cancel>Cancel</button><button class="btn danger" type="button" id="bl-go">Pause uploads</button></div>`);
  m.querySelector('#bl-go').addEventListener('click', e => busy(e.currentTarget, async () => {
    const r = await rpc('admin_set_upload_block', { p_user_id: userId, p_blocked: true, p_reason: m.querySelector('#bl-reason').value });
    if (!r.ok) { const el = m.querySelector('#bl-error'); el.textContent = r.message; el.hidden = false; return; }
    closeModal(); toast('Uploads paused for this member.'); after();
  }));
}

// ---------------------------------------------------------------- members
async function members(body) {
  const rows = await rpc('admin_list_members', { p_search: state.memberSearch, p_limit: 100, p_offset: 0 });
  const required = await q(supabase.from('competency_areas').select('id', { count: 'exact', head: false }).eq('is_active', true).eq('is_required', true));
  const total = rows[0]?.total_count || 0;
  const badge = r => !r.mighty_member_id ? '<span class="fine">No Mighty link</span>'
    : r.badge_error ? `<span class="chip s-revoked" title="${esc(r.badge_error)}">Sync failed</span>`
    : r.badge_desired === r.badge_awarded ? (r.badge_awarded ? pill('verified', 'On profile') : '<span class="fine">—</span>')
    : pill('expired', 'Pending');
  body.innerHTML = `
    <div class="toolbar"><input type="search" id="mb-search" placeholder="Search name or Mighty member ID" aria-label="Search members" value="${esc(state.memberSearch)}"></div>
    <p class="fine">${total} member${total === 1 ? '' : 's'} have signed in. Tier comes from Mighty and refreshes each time they sign in.</p>
    ${rows.length ? `<div class="table-wrap"><table class="data">
      <thead><tr><th>Member</th><th>Tier</th><th>Areas</th><th>Credential</th><th>Mighty badge</th><th></th></tr></thead>
      <tbody>${rows.map(r => `<tr>
        <td><b>${esc(r.full_name || 'Unnamed member')}</b>${r.staff_role ? ` <span class="chip s-none">${r.staff_role === 'super_admin' ? 'Super admin' : 'Admin'}</span>` : ''}
          <div class="fine">${r.mighty_member_id ? `Mighty #${esc(r.mighty_member_id)}` : 'No Mighty link'}${r.last_sign_in_at ? ` · last sign-in ${fmtDate(r.last_sign_in_at)}` : ''}${r.upload_blocked ? ' · <b>uploads paused</b>' : ''}</div></td>
        <td>${esc(TIER[r.membership_tier])}</td>
        <td class="num">${r.areas_done}/${required.length}</td>
        <td>${r.credential_status === 'active' ? `<a href="#/c/${esc(r.slug)}">${pill('verified', 'Active')}</a>` : esc(CRED[r.credential_status] || 'In progress')}</td>
        <td>${badge(r)}</td>
        <td class="row-actions">
          ${r.mighty_member_id && (r.badge_error || r.badge_desired !== r.badge_awarded) ? `<button class="btn small" type="button" data-sync="${esc(r.user_id)}">Retry badge</button>` : ''}
          ${r.user_id !== me.id ? `<button class="btn small ghost" type="button" data-block="${esc(r.user_id)}">${r.upload_blocked ? 'Resume uploads' : 'Pause uploads'}</button>` : ''}
        </td></tr>`).join('')}</tbody></table></div>` : '<div class="empty">No members found.</div>'}`;
  let t;
  body.querySelector('#mb-search').addEventListener('input', e => { clearTimeout(t); t = setTimeout(() => { state.memberSearch = e.target.value; members(body).then(() => { const s = body.querySelector('#mb-search'); s.focus(); s.setSelectionRange(s.value.length, s.value.length); }); }, 300); });
  body.querySelectorAll('[data-sync]').forEach(b => b.addEventListener('click', () => busy(b, async () => {
    const r = await syncBadge(b.dataset.sync);
    toast(r.ok ? (r.action === 'badge_added' ? 'Badge added in Mighty.' : r.action === 'badge_removed' ? 'Badge removed in Mighty.' : r.skipped ? 'Mighty badge sync isn’t set up yet.' : 'Badge already up to date.') : (r.message || 'Couldn’t reach Mighty.'), r.ok ? 'ok' : 'error');
    members(body);
  }, 'Syncing…')));
  body.querySelectorAll('[data-block]').forEach(b => b.addEventListener('click', () => {
    const r = rows.find(x => x.user_id === b.dataset.block);
    blockMember(r.user_id, r.full_name, r.upload_blocked, () => members(body));
  }));
}

// ---------------------------------------------------------------- areas & providers
async function areas(body) {
  const [list, providers, links] = await Promise.all([
    q(supabase.from('competency_areas').select('*').order('sort_order').order('name')),
    q(supabase.from('providers').select('*').order('name')),
    q(supabase.from('provider_areas').select('*')),
  ]);
  const provNames = areaId => links.filter(l => l.area_id === areaId).map(l => providers.find(p => p.id === l.provider_id)?.name).filter(Boolean);
  body.innerHTML = `
    <div class="toolbar"><button class="btn primary" type="button" id="area-new">${icon('plus')}Add area</button><button class="btn" type="button" id="prov-new">${icon('plus')}Add provider</button></div>
    <p class="fine">Members need an upload in every <b>required, active</b> area to earn the credential. Changing the list re-checks members the next time they upload or sign in. Every change is in the audit log.</p>
    <div class="table-wrap"><table class="data">
      <thead><tr><th>Code</th><th>Area</th><th>Providers</th><th>Required</th><th>Active</th><th></th></tr></thead>
      <tbody>${list.map(a => `<tr class="${a.is_active ? '' : 'muted'}">
        <td class="mono">${esc(a.code)}</td><td><b>${esc(a.name)}</b><div class="fine">${esc(a.description || '')}</div></td>
        <td class="fine">${esc(provNames(a.id).join(', ') || 'Any provider')}</td>
        <td>${a.is_required ? 'Yes' : 'Optional'}</td><td>${a.is_active ? 'Yes' : 'Hidden'}</td>
        <td><button class="btn small" type="button" data-edit="${esc(a.id)}">Edit</button></td></tr>`).join('')}</tbody></table></div>`;
  const reload = () => areas(body);
  body.querySelector('#area-new').addEventListener('click', () => editArea(null, providers, links, reload));
  body.querySelector('#prov-new').addEventListener('click', () => newProvider(reload));
  body.querySelectorAll('[data-edit]').forEach(b => b.addEventListener('click', () => editArea(list.find(a => a.id === b.dataset.edit), providers, links, reload)));
}

function editArea(a, providers, links, after) {
  const chosen = new Set(a ? links.filter(l => l.area_id === a.id).map(l => l.provider_id) : []);
  const m = openModal(a ? `Edit ${a.name}` : 'Add competency area', '', `
    <form id="area-form" class="form" novalidate>
      <div class="row2"><div><label for="ar-code">Code</label><input id="ar-code" name="code" maxlength="8" required value="${esc(a?.code || '')}" ${a ? 'readonly' : ''} placeholder="NET"></div>
      <div><label for="ar-order">Order</label><input id="ar-order" name="order" type="number" value="${esc(a?.sort_order ?? 100)}"></div></div>
      <label for="ar-name">Name</label><input id="ar-name" name="name" maxlength="120" required value="${esc(a?.name || '')}">
      <label for="ar-desc">Description</label><textarea id="ar-desc" name="description" maxlength="1000">${esc(a?.description || '')}</textarea>
      <label class="check"><input type="checkbox" name="required" ${!a || a.is_required ? 'checked' : ''}> Required for the credential</label>
      <label class="check"><input type="checkbox" name="active" ${!a || a.is_active ? 'checked' : ''}> Active (shown to members)</label>
      <fieldset><legend>Approved providers for this area</legend><div class="checks">
        ${providers.filter(p => p.is_active).map(p => `<label class="check"><input type="checkbox" name="prov" value="${esc(p.id)}" ${chosen.has(p.id) ? 'checked' : ''}> ${esc(p.name)}</label>`).join('')}
      </div><p class="fine">Leave all unchecked to allow any listed provider. Members can always pick “Other”.</p></fieldset>
      <p class="form-error" id="ar-error" hidden></p>
      <div class="actions"><button type="button" class="btn ghost" data-cancel>Cancel</button><button type="submit" class="btn primary">Save</button></div>
    </form>`, { wide: true });
  const form = m.querySelector('#area-form');
  form.addEventListener('submit', e => {
    e.preventDefault();
    busy(form.querySelector('button[type=submit]'), async () => {
      const values = { name: form.name.value.trim(), description: form.description.value.trim() || null, sort_order: Number(form.order.value) || 0, is_required: form.required.checked, is_active: form.active.checked };
      try {
        let id = a?.id;
        if (a) await q(supabase.from('competency_areas').update(values).eq('id', a.id));
        else id = (await q(supabase.from('competency_areas').insert({ ...values, code: form.code.value.trim().toUpperCase() }).select('id').single())).id;
        const want = new Set([...form.querySelectorAll('input[name=prov]:checked')].map(i => i.value));
        const add = [...want].filter(p => !chosen.has(p)).map(provider_id => ({ provider_id, area_id: id }));
        const remove = [...chosen].filter(p => !want.has(p));
        if (add.length) await q(supabase.from('provider_areas').insert(add));
        if (remove.length) await q(supabase.from('provider_areas').delete().eq('area_id', id).in('provider_id', remove));
        closeModal(); toast('Saved.'); after();
      } catch (err) { const el = form.querySelector('#ar-error'); el.textContent = err.code === '23514' ? 'Codes are 2–8 capital letters or digits, and names can’t be empty.' : err.message; el.hidden = false; }
    });
  });
}

function newProvider(after) {
  const m = openModal('Add provider', 'Then link it to areas from each area’s Edit screen.', `
    <form id="pv-form" class="form" novalidate><label for="pv-name">Provider name</label><input id="pv-name" name="name" maxlength="120" required>
    <label for="pv-url">Website (optional)</label><input id="pv-url" name="url" type="url" placeholder="https://">
    <p class="form-error" id="pv-error" hidden></p>
    <div class="actions"><button type="button" class="btn ghost" data-cancel>Cancel</button><button type="submit" class="btn primary">Add</button></div></form>`);
  const form = m.querySelector('#pv-form');
  form.addEventListener('submit', e => {
    e.preventDefault();
    busy(form.querySelector('button[type=submit]'), async () => {
      try { await q(supabase.from('providers').insert({ name: form.name.value.trim(), website_url: form.url.value.trim() || null })); closeModal(); toast('Provider added.'); after(); }
      catch (err) { const el = form.querySelector('#pv-error'); el.textContent = err.message; el.hidden = false; }
    });
  });
}

// ---------------------------------------------------------------- team
async function team(body) {
  const staff = await rpc('admin_list_members', { p_search: '', p_limit: 200, p_offset: 0 }).then(r => r.filter(x => x.staff_role));
  const isSuper = me.role === 'super_admin';
  body.innerHTML = `
    <p class="fine">Admins review uploads and manage areas. Super admins can also manage this team. People must sign in to this site once before you can add them.</p>
    ${isSuper ? `<div class="toolbar"><input type="search" id="tm-search" placeholder="Find a member to add" aria-label="Find a member"><div id="tm-results" class="results"></div></div>` : ''}
    <div class="table-wrap"><table class="data"><thead><tr><th>Name</th><th>Role</th><th></th></tr></thead><tbody>
      ${staff.map(s => `<tr><td><b>${esc(s.full_name || 'Unnamed')}</b><div class="fine">${s.mighty_member_id ? `Mighty #${esc(s.mighty_member_id)}` : 'No Mighty link'}</div></td>
        <td>${isSuper ? `<select data-role="${esc(s.user_id)}" aria-label="Role for ${esc(s.full_name)}"><option value="admin" ${s.staff_role === 'admin' ? 'selected' : ''}>Admin</option><option value="super_admin" ${s.staff_role === 'super_admin' ? 'selected' : ''}>Super admin</option></select>` : esc(s.staff_role === 'super_admin' ? 'Super admin' : 'Admin')}</td>
        <td>${isSuper ? `<button class="btn small ghost" type="button" data-remove="${esc(s.user_id)}">Remove</button>` : ''}</td></tr>`).join('')}
    </tbody></table></div>`;
  if (!isSuper) return;
  const set = async (uid, role) => { const r = await rpc('admin_set_role', { p_user_id: uid, p_role: role }); toast(r.ok ? 'Team updated.' : r.message, r.ok ? 'ok' : 'error'); team(body); };
  body.querySelectorAll('[data-role]').forEach(s => s.addEventListener('change', () => set(s.dataset.role, s.value)));
  body.querySelectorAll('[data-remove]').forEach(b => b.addEventListener('click', () => set(b.dataset.remove, null)));
  let t;
  body.querySelector('#tm-search').addEventListener('input', e => {
    clearTimeout(t);
    t = setTimeout(async () => {
      const term = e.target.value.trim();
      const box = body.querySelector('#tm-results');
      if (term.length < 2) { box.innerHTML = ''; return; }
      const found = (await rpc('admin_list_members', { p_search: term, p_limit: 8, p_offset: 0 })).filter(x => !x.staff_role);
      box.innerHTML = found.length ? found.map(f => `<div class="result"><span><b>${esc(f.full_name || 'Unnamed')}</b> <span class="fine">${f.mighty_member_id ? `Mighty #${esc(f.mighty_member_id)}` : ''} · ${esc(TIER[f.membership_tier])}</span></span><button class="btn small" type="button" data-add="${esc(f.user_id)}">Make admin</button></div>`).join('') : '<p class="fine">No matching members who aren’t already on the team.</p>';
      box.querySelectorAll('[data-add]').forEach(b => b.addEventListener('click', () => set(b.dataset.add, 'admin')));
    }, 300);
  });
}

// ---------------------------------------------------------------- audit
const ACTION = {
  verify_upload: 'Verified an upload', revoke_upload: 'Revoked an upload', restore_upload: 'Restored an upload',
  block_uploads: 'Paused uploads', unblock_uploads: 'Resumed uploads', set_role: 'Changed a team role',
  credential_earned: 'Credential earned', credential_ended: 'Credential no longer active', account_created: 'Account created (first sign-in)',
  badge_added: 'Mighty badge added', badge_removed: 'Mighty badge removed', badge_sync_failed: 'Mighty badge sync failed',
  tier_lookup_failed: 'Couldn’t read membership tier from Mighty', bootstrap_super_admin: 'First super admin set',
};
async function audit(body) {
  const rows = await q(supabase.from('audit_log').select('*').order('id', { ascending: false }).limit(150));
  const ids = [...new Set(rows.flatMap(r => [r.actor, r.target_user]).filter(Boolean))];
  const people = ids.length ? await q(supabase.from('profiles').select('id, full_name').in('id', ids)) : [];
  const who = id => !id ? 'System' : esc(people.find(p => p.id === id)?.full_name || 'Unknown');
  const detail = r => r.details?.reason ? `“${esc(r.details.reason)}”` : r.action === 'set_role' ? `${esc(r.details?.from || 'none')} → ${esc(r.details?.to || 'none')}` : r.target_type && r.target_type !== 'system' && r.target_type !== 'submission' && r.target_type !== 'profile' && r.target_type !== 'credential' ? esc(Object.keys(r.details || {}).join(', ')) : '';
  body.innerHTML = `<p class="fine">The latest 150 entries. Every staff action and every change to areas or providers is recorded.</p>
    <div class="table-wrap"><table class="data"><thead><tr><th>When</th><th>Who</th><th>What</th><th>Member</th><th>Details</th></tr></thead><tbody>
    ${rows.map(r => `<tr><td class="num">${new Date(r.at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</td>
      <td>${who(r.actor)}</td><td>${esc(ACTION[r.action] || r.action.replace(/_/g, ' '))}</td><td>${r.target_user ? who(r.target_user) : ''}</td><td class="fine">${detail(r)}</td></tr>`).join('')}
    </tbody></table></div>`;
}
