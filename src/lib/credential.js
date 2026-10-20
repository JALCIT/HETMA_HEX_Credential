// Pure helpers shared by the member, admin and public pages (unit tested).

export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const FILE_TYPES = { 'application/pdf': 'PDF', 'image/png': 'PNG', 'image/jpeg': 'JPG' };

export const today = () => new Date().toISOString().slice(0, 10);
export const isExpired = (s, on = today()) => Boolean(s.expires_on && s.expires_on < on);

export function fmtDate(value) {
  if (!value) return '';
  const d = /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T12:00:00`) : new Date(value);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

/** Status of one area for one member: none | uploaded | verified | expired | revoked. */
export function areaStatus(areaId, submissions, on = today()) {
  const mine = submissions.filter(s => s.area_id === areaId);
  const active = mine.filter(s => s.status === 'active');
  const current = active.find(s => !isExpired(s, on));
  if (current) {
    const verified = active.find(s => !isExpired(s, on) && s.verified_at);
    return { status: verified ? 'verified' : 'uploaded', submission: verified || current };
  }
  if (active.length) return { status: 'expired', submission: active[0] };
  if (mine.length) return { status: 'revoked', submission: mine[0] };
  return { status: 'none', submission: null };
}

export function progress(areas, submissions, on = today()) {
  const required = areas.filter(a => a.is_required);
  const counts = { none: 0, uploaded: 0, verified: 0, expired: 0, revoked: 0 };
  for (const a of required) counts[areaStatus(a.id, submissions, on).status]++;
  return { total: required.length, done: counts.uploaded + counts.verified, ...counts };
}

/** Human-friendly credential ID shown on the public page, e.g. HETMA-2026-3F9A-0C21. */
export function credentialId(slug, earnedAt) {
  if (!slug) return '';
  const year = earnedAt ? new Date(earnedAt).getUTCFullYear() : '';
  const s = slug.toUpperCase();
  return `HETMA-${year}-${s.slice(0, 4)}-${s.slice(4, 8)}`;
}

/** Checks a file by its first bytes, not just its name. Returns an error message or ''. */
export async function checkFile(file) {
  if (!file) return 'Choose your certificate file.';
  if (!FILE_TYPES[file.type]) return 'Upload a PDF, PNG or JPG file.';
  if (file.size > MAX_FILE_BYTES) return 'That file is over 10 MB. Export a smaller PDF or image and try again.';
  if (file.size < 100) return 'That file looks empty. Choose the certificate file again.';
  const head = new Uint8Array(await file.slice(0, 8).arrayBuffer());
  const starts = sig => sig.every((b, i) => head[i] === b);
  const ok = file.type === 'application/pdf' ? starts([0x25, 0x50, 0x44, 0x46])
    : file.type === 'image/png' ? starts([0x89, 0x50, 0x4e, 0x47])
    : starts([0xff, 0xd8, 0xff]);
  return ok ? '' : 'That file doesn’t look like a real PDF, PNG or JPG. Export it again and retry.';
}

export const SIGNIN_ERRORS = {
  denied: 'Sign-in was cancelled in Mighty.',
  expired: 'That sign-in took too long or was already used. Try again.',
  session_mismatch: 'Sign-in has to finish in the same browser it started in. Try again.',
  wrong_issuer: 'That sign-in didn’t come from the HETMA community. Try again.',
  token_exchange: 'Mighty didn’t accept the sign-in. Try again.',
  no_identity: 'Mighty didn’t tell us who you are. Try again.',
  account: 'We couldn’t set up your account. Try again, or contact HETMA.',
  session: 'We couldn’t start your session. Try again.',
  link: 'That sign-in link is no longer valid. Sign in again.',
  unavailable: 'Sign-in is unavailable right now. Try again in a few minutes.',
  mighty_error: 'Mighty reported a problem. Try again.',
  invalid_request: 'That sign-in link is incomplete. Try again.',
  new_tab: 'Sign-in has to finish in the same browser tab it started in. Try again from this tab.',
  storage: 'Your browser is blocking this site’s storage, which sign-in needs. Allow site data for this site, or try another browser.',
  busy: 'Lots of people are signing in right now. Wait a minute and try again.',
};
