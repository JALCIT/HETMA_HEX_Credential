// HETMA Credential — app shell and router (hash routes, no framework).
//   #/            -> your progress (or sign-in when signed out)
//   #/signin      -> Sign in with Mighty / Join HETMA
//   #/auth?th=... -> finishes a Mighty sign-in (one-time token from mighty-auth)
//   #/me          -> member dashboard
//   #/admin/:tab  -> HETMA staff (uploads, members, areas, team, audit)
//   #/c/:slug     -> public credential page (no sign-in)
import '@fontsource/barlow/400.css';
import '@fontsource/barlow/500.css';
import '@fontsource/barlow/600.css';
import '@fontsource/barlow-condensed/600.css';
import '@fontsource/barlow-condensed/700.css';
import './styles.css';
import { auth, startMightySignIn, redeemSignIn } from './api.js';
import { shell, go, parseHash } from './shell.js';
import { config, isConfigured } from './config.js';
import { esc, icon } from './lib/dom.js';
import { SIGNIN_ERRORS } from './lib/credential.js';
import { renderMember } from './pages/member.js';
import { renderAdmin } from './pages/admin.js';
import { renderPublic } from './pages/public.js';

let session = null;

function renderSignIn(params) {
  const err = params.get('error');
  const local = config.appEnv === 'development';
  shell(`
    <section class="hero">
      <p class="eyebrow">HETMA Credential</p>
      <h1>Show the training behind your work.</h1>
      <p class="lede">Upload certificates from approved training providers across the HETMA competency areas. When every area is covered, you earn the HETMA Credential, a badge on your community profile and a page you can add to LinkedIn.</p>
      ${err ? `<div class="notice error" role="alert">${icon('info')}<span>${esc(SIGNIN_ERRORS[err] || 'Sign-in didn’t finish. Try again.')}</span></div>` : ''}
      <div class="signin-actions">
        <button type="button" class="btn primary big" id="signin-mighty" data-mode="start">Sign in with your HETMA community account</button>
        <button type="button" class="btn ghost big" id="join-hetma" data-mode="join">New to HETMA? Join free</button>
      </div>
      <p class="fine">You sign in on community.hetma.org, HETMA’s community on Mighty. This site only learns your member ID and name, and never sees your password.${local ? ' <b>Local mode:</b> sign-in uses a mock of Mighty.' : ''}</p>
    </section>
    <section class="how">
      <div><span class="step">1</span><h3>Train</h3><p>Complete courses from manufacturers and training providers in each competency area.</p></div>
      <div><span class="step">2</span><h3>Upload</h3><p>Upload each certificate and confirm it’s genuine. It counts right away.</p></div>
      <div><span class="step">3</span><h3>Share</h3><p>Earn the HETMA Credential and share your public credential page.</p></div>
    </section>`);
  document.querySelectorAll('[data-mode]').forEach(b => b.addEventListener('click', async () => {
    b.disabled = true;
    try { await startMightySignIn(b.dataset.mode); }
    catch { b.disabled = false; go('/signin?error=storage'); }
  }));
}

async function finishSignIn(params) {
  const code = params.get('code');
  history.replaceState(null, '', `${location.pathname}#/signin`); // the code is single-use; drop it from the address bar
  shell('<p class="loading">Signing you in…</p>');
  const r = code ? await redeemSignIn(code) : { ok: false, error: 'link' };
  if (!r.ok) return go(`/signin?error=${encodeURIComponent(r.error || 'link')}`);
  session = (await auth.getSession()).data.session;
  go(r.isNew ? '/me?welcome=1' : '/me');
}

async function route_() {
  const { parts, params } = parseHash();
  const [first, second] = parts;
  if (!isConfigured()) {
    shell('<div class="notice error">This site isn’t configured yet: set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.</div>');
    return;
  }
  if (first === 'c') return renderPublic(second);
  if (first === 'auth') return finishSignIn(params);
  session = (await auth.getSession()).data.session;
  if (first === 'signin' || !session) return renderSignIn(params);
  if (first === 'admin') return renderAdmin(session.user, second || 'uploads');
  return renderMember(session.user, params);
}

window.addEventListener('hashchange', route_);
auth.onAuthStateChange(event => { if (event === 'SIGNED_OUT' && !location.hash.startsWith('#/c/')) go('/signin'); });
route_();
