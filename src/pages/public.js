// Public credential page: #/c/<slug>. No sign-in. Shows only the name, the date
// earned, the areas covered and whether the credential is active.
import { publicCredential } from '../api.js';
import { shell } from '../shell.js';
import { esc, icon, toast } from '../lib/dom.js';
import { fmtDate, credentialId } from '../lib/credential.js';

export async function renderPublic(slug) {
  const main = shell('<p class="loading">Checking this credential…</p>');
  let c;
  try { c = await publicCredential(slug || ''); } catch { c = { found: false, error: true }; }
  if (!c.found) {
    main.innerHTML = `<section class="credential missing"><h1>Credential not found</h1><p>${c.error ? 'We couldn’t check this credential right now. Try again shortly.' : 'This link doesn’t match a HEx Credential. Check that you copied the whole link.'}</p></section>`;
    return;
  }
  const active = c.status === 'active';
  const id = credentialId(slug, c.earned_at || c.first_earned_at);
  document.title = active ? `${c.name} · HEx Credential` : 'HEx Credential';
  main.innerHTML = `
    <article class="credential ${active ? '' : 'inactive'}">
      <div class="cred-head">
        <img src="/assets/hetma-logo.svg" alt="HETMA" width="72" height="72">
        <div><p class="eyebrow">${active ? 'Verified HETMA credential' : 'HETMA credential'}</p>
          <h1 class="cred-name">${esc(c.name || 'HETMA member')}</h1></div>
      </div>
      ${active ? `
        <h2>HEx Credential</h2>
        <p class="lede">Issued by HETMA on ${fmtDate(c.earned_at)} for completed training in every HETMA competency area.</p>
        <h3 class="eyebrow">Competency areas (${c.areas.length})</h3>
        <ul class="area-list">${c.areas.map(a => `<li>${icon('check')}<span>${esc(a)}</span></li>`).join('')}</ul>`
      : `<div class="notice warn">${icon('info')}<span>This credential is no longer active.</span></div>`}
      <dl class="verify">
        <div><dt>Credential ID</dt><dd class="mono">${esc(id)}</dd></div>
        <div><dt>Status</dt><dd><b class="${active ? 'ok' : 'bad'}">${active ? 'Active' : 'Not active'}</b></dd></div>
        <div><dt>Issuer</dt><dd>HETMA</dd></div>
      </dl>
      <button class="btn ghost small" type="button" id="copy-link">${icon('share')}Copy link</button>
    </article>
    <p class="fine center">This page is public. It never shows certificate files, contact details or why a credential ended.</p>`;
  main.querySelector('#copy-link').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(location.href); toast('Link copied.'); } catch { toast('Copy the address from your browser’s address bar.', 'error'); }
  });
}
