# Security notes

## Sign-in (Mighty OAuth)

- Confidential client, Authorization Code + PKCE (S256), `client_secret_post`, scope `read:userinfo` only.
- `mighty-auth/start` creates a random `state`, a PKCE verifier and a random nonce. State and verifier are stored server-side (`oauth_transactions`, unreadable by browser roles); the nonce goes in an `HttpOnly; Secure; SameSite=Lax` cookie and only its SHA-256 is stored.
- `mighty-auth/callback` requires: `iss` equal to `https://community.hetma.org` (RFC 9207), a state that exists, is under 15 minutes old and is deleted as it's read (single use), and the cookie nonce matching the stored hash (binds the callback to the browser that started it).
- Mighty access/refresh tokens are used once to read `me { id name }`, then revoked. They're never stored or sent to the browser.
- Accounts are keyed by Mighty member ID (`profiles.mighty_member_id`, unique). No email matching. The internal login email is a placeholder at a `.invalid` domain, so no mail is ever sent.
- **Login CSRF protection:** before sign-in, the browser tab stores a random `bind` value in sessionStorage and sends only its SHA-256. The callback returns a one-time handoff code (not a session token) in the URL fragment. The tab redeems it at `mighty-auth/redeem` by presenting `bind`; the server checks the hash, deletes the handoff on first use (even a failed one), expires it after 5 minutes, and only then creates a single-use Supabase sign-in token. A sign-in link sent to someone else's browser is useless.
- **No takeover through look-alike accounts:** if a login already exists for the member's internal email, it's reused only when its `app_metadata` (settable only by the service role) says this function created it for this Mighty member. Supabase email sign-up must be **off** on hosted projects (docs/SETUP.md step 2.6); even so, only Mighty-linked accounts can upload, and sign-up metadata is never used for names.
- One cookie per sign-in attempt (named from the state), so parallel tabs don't collide.

## Data

- RLS on every table. Members read only their own profile, uploads and credential. Staff read all. Anonymous visitors read only active areas/providers and the public credential RPC.
- Members can read their own profile except the staff note on why uploads were paused (column-level grant).
- Browser roles can't insert, update or delete profiles, uploads, credentials, staff roles or the audit log. All changes go through definer functions that check `auth.uid()` and staff role, enforce attestation and a Mighty link, validate the file path is in the caller's own folder with a matching extension, confirm the file really exists in storage (hosted), and rate-limit uploads (20 per 10 minutes) and reviews.
- Staff can't review their own uploads or pause their own uploads. The last super admin can't be removed. `bootstrap_super_admin` can only be run by the database owner.
- Every staff action and every change to areas/providers is written to `audit_log`.

## Files

- Private `certificates` bucket, 10 MB limit, PDF/PNG/JPG only (enforced by the bucket). Paths are `<user id>/<random uuid>.<ext>`; insert only into your own folder and only if uploads aren't paused; read only your own folder or as staff; no update/delete/list.
- The browser also checks the first bytes of each file (real PDF/PNG/JPEG headers) before uploading.
- Files open through 5-minute signed URLs. The public credential page never exposes files, emails, Mighty IDs or revoke reasons.

## Hosting

- Strict CSP in `vercel.json` (`script-src 'self'`, `connect-src` only Supabase, `frame-ancestors 'none'`), HSTS, nosniff, no referrer leakage across origins.

## Known risks

- Honor system: a determined member can upload a fake certificate. Mitigations are the attestation, random spot-checks, revocation (which removes the badge) and the audit trail.
- `mighty-auth/start` refuses new sign-ins above ~300 per minute; `credential-sync` skips calling Mighty when nothing changed in the last minute. Storage uploads themselves aren't rate-limited beyond Supabase's defaults (orphan files are possible but only in the uploader's own folder).
- Badge sync depends on Mighty's Admin API. Failures are recorded (`badge_error`, audit log) and retryable from Admin → Members.
