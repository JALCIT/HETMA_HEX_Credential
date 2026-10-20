// App frame (top bar, navigation, footer) and hash-route helpers.
import { auth } from './api.js';
import { config } from './config.js';
import { esc, icon } from './lib/dom.js';

const app = document.getElementById('app');

export function parseHash() {
  const [path, query = ''] = (location.hash.slice(1) || '/').split('?');
  return { parts: path.split('/').filter(Boolean), params: new URLSearchParams(query) };
}
export const go = route => { if (location.hash !== `#${route}`) location.hash = route; else window.dispatchEvent(new HashChangeEvent('hashchange')); };

const logo = `<img src="/assets/hetma-logo-light.svg" alt="HETMA" class="logo" width="76" height="40">`;

export function shell(content, { user, role, wide = false } = {}) {
  const env = config.appEnv !== 'production' ? `<span class="env-badge">${esc(config.appEnv === 'development' ? 'LOCAL' : 'TEST')}</span>` : '';
  const nav = user ? `
    <nav class="top-nav" aria-label="Main">
      <a href="#/me" class="${location.hash.startsWith('#/me') || location.hash === '' || location.hash === '#/' ? 'active' : ''}">My credential</a>
      ${role ? `<a href="#/admin" class="${location.hash.startsWith('#/admin') ? 'active' : ''}">Admin</a>` : ''}
      <button type="button" class="link-btn" data-signout>${icon('logout')}<span>Sign out</span></button>
    </nav>` : '';
  app.innerHTML = `
    <header class="topbar"><div class="topbar-inner ${wide ? 'wide' : ''}">
      <a class="brand" href="#/" aria-label="HETMA Credential home">${logo}<span>Credential</span></a>${env}${nav}
    </div></header>
    <main id="main" class="page ${wide ? 'wide' : ''}">${content}</main>
    <footer class="foot ${wide ? 'wide' : ''}"><span>HETMA Credential · sign-in through the <a href="https://community.hetma.org" rel="noopener" target="_blank">HETMA community</a></span></footer>`;
  app.querySelector('[data-signout]')?.addEventListener('click', signOut);
  return app.querySelector('#main');
}

async function signOut() {
  await auth.signOut();
  go('/signin');
}

