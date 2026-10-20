// Member dashboard: progress across competency areas, uploads, credential link.
import { loadMe, uploadCertificate, fileUrl, rpc, syncBadge } from '../api.js';
import { shell } from '../shell.js';
import { esc, icon, toast, openModal, closeModal, busy } from '../lib/dom.js';
import { openSigned } from '../lib/open.js';
import { areaStatus, progress, fmtDate, checkFile, today, credentialId } from '../lib/credential.js';

const LABEL = { none: 'Not started', uploaded: 'Uploaded', verified: 'Verified by HETMA', expired: 'Expired', revoked: 'Revoked by HETMA' };
const TIER = { higher_ed: 'Higher Ed Hub', general: 'General member', none: '' };

function ring(done, total) {
  const r = 38, c = 2 * Math.PI * r, f = total ? (c * done) / total : 0;
  return `<svg class="ring" viewBox="0 0 92 92" role="img" aria-label="${done} of ${total} areas done">
    <circle cx="46" cy="46" r="${r}" fill="none" class="ring-track" stroke-width="9"/>
    <circle cx="46" cy="46" r="${r}" fill="none" class="ring-fill" stroke-width="9" stroke-linecap="round" stroke-dasharray="${f} ${c}" transform="rotate(-90 46 46)"/>
    <text x="46" y="52" text-anchor="middle">${done}/${total}</text></svg>`;
}

export async function renderMember(user, params) {
  const main = shell('<p class="loading">Loading your progress…</p>', { user });
  let me;
  try {
    // Re-check completion first (an upload may have expired since the last visit).
    const r = await rpc('refresh_my_credential').catch(() => null);
    if (r?.credential_changed) syncBadge();
    me = await loadMe(user.id);
  } catch (e) { main.innerHTML = `<div class="notice error">${esc(e.message)}</div>`; return; }
  // Re-render with the role known (shows the Admin link for staff).
  const page = shell('', { user, role: me.role });
  draw(page, user, me, params);
}

function draw(page, user, me, params) {
  const { profile, credential, areas, submissions } = me;
  const p = progress(areas, submissions);
  const active = credential?.status === 'active';
  const publicUrl = credential?.slug ? `${location.origin}/#/c/${credential.slug}` : '';
  const tier = TIER[profile?.membership_tier] || '';
  page.innerHTML = `
    ${params.get('welcome') ? `<div class="notice ok">${icon('check')}<span>Welcome to HETMA! Your community account is ready, and you can start uploading certificates.</span></div>` : ''}
    ${profile?.upload_blocked ? `<div class="notice error">${icon('lock')}<span>Uploads are paused on your account. Contact HETMA for details.</span></div>` : ''}
    ${active ? `
      <section class="earned" aria-label="Credential earned">
        <div class="earned-head"><img src="/assets/hetma-logo.svg" alt="" width="52" height="52"><div>
          <p class="eyebrow">Credential earned ${fmtDate(credential.earned_at)}</p>
          <h2>You’ve earned the HETMA Credential</h2></div></div>
        <p>Your HETMA badge is on your community profile. Share your credential page, or add it to LinkedIn: <b>Add profile section → Licenses &amp; certifications</b>, with <b>HETMA</b> as the issuing organization, <b>${esc(credentialId(credential.slug, credential.earned_at))}</b> as the credential ID and the link below as the credential URL.</p>
        <div class="copyrow"><code id="cred-url">${esc(publicUrl)}</code>
          <button class="btn" type="button" data-copy>${icon('share')}Copy link</button>
          <a class="btn ghost" href="#/c/${esc(credential.slug)}">View page</a></div>
      </section>` : credential?.status === 'inactive' ? `
      <div class="notice warn">${icon('info')}<span>Your HETMA Credential is no longer active because an upload was revoked or expired. Upload the missing areas to restore it.</span></div>` : ''}
    <section class="progress card">
      ${ring(p.done, p.total)}
      <div class="progress-text">
        <p class="eyebrow">${esc(profile?.full_name || 'Your progress')}${tier ? ` · ${esc(tier)}` : ''}</p>
        <h1>${active ? 'All areas complete' : p.total - p.done === 1 ? '1 area left to your HETMA Credential' : `${p.total - p.done} areas left to your HETMA Credential`}</h1>
        <div class="chips">
          <span class="chip s-uploaded">${p.done} done</span>
          <span class="chip s-verified">${p.verified} verified by HETMA</span>
          ${p.revoked ? `<span class="chip s-revoked">${p.revoked} revoked</span>` : ''}
          ${p.expired ? `<span class="chip s-expired">${p.expired} expired</span>` : ''}
          <span class="chip s-none">${p.none} not started</span>
        </div>
        <p class="fine">Uploads count as soon as you submit them. HETMA spot-checks certificates and may revoke any that aren’t genuine.</p>
      </div>
    </section>
    <section aria-label="Competency areas"><ul class="areas">
      ${areas.map(a => areaRow(a, submissions, profile)).join('')}
    </ul></section>`;

  page.querySelector('[data-copy]')?.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(publicUrl); toast('Link copied.'); }
    catch { const r = document.createRange(); r.selectNodeContents(page.querySelector('#cred-url')); getSelection().removeAllRanges(); getSelection().addRange(r); toast('Press Ctrl+C to copy the selected link.'); }
  });
  page.querySelectorAll('[data-upload]').forEach(b => b.addEventListener('click', () => openUpload(user, me, b.dataset.upload, () => refresh(page, user))));
  page.querySelectorAll('[data-view]').forEach(b => b.addEventListener('click', () => busy(b, async () => {
    try { await openSigned(() => fileUrl(b.dataset.view)); } catch (e) { toast(e.message, 'error'); }
  }, 'Opening…')));
}

function areaRow(area, submissions, profile) {
  const { status, submission: s } = areaStatus(area.id, submissions);
  const provider = s ? (s.provider?.name || `${s.provider_other} (other)`) : '';
  const meta = s ? `${esc(provider)} · completed ${fmtDate(s.completion_date)}${s.expires_on ? ` · ${status === 'expired' ? 'expired' : 'expires'} ${fmtDate(s.expires_on)}` : ''}` : (area.is_required ? 'No certificate uploaded yet' : 'Optional area');
  const canUpload = !profile?.upload_blocked && ['none', 'revoked', 'expired'].includes(status);
  return `<li class="area" data-area="${esc(area.code)}">
    <span class="code">${esc(area.code)}</span>
    <div class="area-main">
      <span class="area-name">${esc(area.name)}</span>
      <span class="meta">${meta}</span>
      ${status === 'revoked' && s.revoke_reason ? `<div class="reason"><b>HETMA’s note:</b> ${esc(s.revoke_reason)}</div>` : ''}
    </div>
    <div class="area-actions">
      <span class="chip s-${status}">${LABEL[status]}</span>
      ${s && status !== 'revoked' ? `<button class="btn small ghost" type="button" data-view="${esc(s.file_path)}">${icon('eye')}View</button>` : ''}
      ${canUpload ? `<button class="btn small primary" type="button" data-upload="${esc(area.id)}">${icon('upload')}${status === 'none' ? 'Upload' : 'Upload again'}</button>` : ''}
    </div></li>`;
}

async function refresh(page, user) {
  const me = await loadMe(user.id);
  draw(page, user, me, new URLSearchParams());
}

function openUpload(user, me, areaId, done) {
  const area = me.areas.find(a => a.id === areaId);
  const linked = new Set(me.links.filter(l => l.area_id === areaId).map(l => l.provider_id));
  const list = me.providers.filter(p => linked.has(p.id));
  const options = (list.length ? list : me.providers).map(p => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('');
  const modal = openModal(area.name, 'Upload the certificate of completion your training provider gave you. It counts as soon as you submit.', `
    <form id="upload-form" class="form" novalidate>
      <label for="up-provider">Training provider</label>
      <select id="up-provider" name="provider">${options}<option value="other">Other (not listed)</option></select>
      <div id="up-other-wrap" hidden><label for="up-other">Provider name</label><input id="up-other" name="other" maxlength="120" placeholder="e.g. Biamp Systems Academy"></div>
      <div class="row2">
        <div><label for="up-date">Completion date</label><input id="up-date" name="completion" type="date" max="${today()}" value="${today()}" required></div>
        <div><label for="up-exp">Expires (optional)</label><input id="up-exp" name="expires" type="date"></div>
      </div>
      <label for="up-file">Certificate file</label>
      <input id="up-file" name="file" type="file" accept=".pdf,.png,.jpg,.jpeg,application/pdf,image/png,image/jpeg" required>
      <p class="fine">PDF, PNG or JPG, up to 10 MB. Only you and HETMA staff can open it.</p>
      <label class="attest"><input type="checkbox" id="up-attest" name="attest"><span>I confirm this certificate is genuine and was issued to me. I understand HETMA may verify it and revoke my credential if it is not.</span></label>
      <p class="form-error" id="up-error" role="alert" hidden></p>
      <div class="actions"><button type="button" class="btn ghost" data-cancel>Cancel</button><button type="submit" class="btn primary" id="up-submit" disabled>Submit</button></div>
    </form>`);
  const form = modal.querySelector('#upload-form');
  const err = form.querySelector('#up-error');
  const showErr = m => { err.textContent = m; err.hidden = !m; };
  form.provider.addEventListener('change', () => { form.querySelector('#up-other-wrap').hidden = form.provider.value !== 'other'; });
  form.attest.addEventListener('change', () => { form.querySelector('#up-submit').disabled = !form.attest.checked; });
  form.addEventListener('submit', e => {
    e.preventDefault();
    busy(form.querySelector('#up-submit'), async () => {
      showErr('');
      const file = form.file.files[0];
      const problem = await checkFile(file);
      if (problem) return showErr(problem);
      if (form.provider.value === 'other' && !form.other.value.trim()) return showErr('Enter the training provider’s name.');
      if (!form.completion.value) return showErr('Add the date you completed the training.');
      if (!form.attest.checked) return showErr('Tick the statement to confirm the certificate is genuine.');
      try {
        const path = await uploadCertificate(user.id, file);
        const r = await rpc('submit_certificate', {
          p_area_id: areaId,
          p_provider_id: form.provider.value === 'other' ? null : form.provider.value,
          p_provider_other: form.provider.value === 'other' ? form.other.value.trim() : null,
          p_completion_date: form.completion.value, p_expires_on: form.expires.value || null,
          p_file_path: path, p_file_name: file.name.slice(0, 200), p_file_type: file.type, p_attested: true,
        });
        if (!r.ok) return showErr(r.message);
        closeModal();
        if (r.credential_changed && r.credential_status === 'active') {
          toast('All areas done. You’ve earned the HETMA Credential!');
          syncBadge();
        } else toast(`${area.name} is done. It counts toward your credential now.`);
        done();
      } catch (e2) { showErr(e2.message); }
    }, 'Uploading…');
  });
}
