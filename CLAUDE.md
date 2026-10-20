# HEx Credential — project brief for Claude

Read this first in every session. Last updated: 2026-10-20.

## What this is

A standalone **test site** for the HEx Credential. HETMA community members sign in with their Mighty account (community.hetma.org), upload vendor training certificates for each competency area, and earn the HEx Credential: a Mighty badge plus a public credential page. Honor system: uploads count once the member attests they're genuine; admins audit, verify and revoke.

It's built to move into the **HETMA Event Passport** later (same stack, same conventions: Vite + vanilla JS, Supabase, Vercel, RLS + definer functions, audit log, local Docker-free stack). Keep it that way.

- **Owner:** Dustin Myers. Repo: `JALCIT/HETMA_HEX_Credential`, local folder `HETMA_HEX_Credential` (GitHub Desktop).
- **Brand:** navy `#143649`, lime `#E0F08A`, Barlow + Barlow Condensed.
- **Wording:** "credential" / "HEx Credential". Never "certification" or "certified". Vendor documents are "certificates".
- **Test setup (Oct 20):** Supabase project `hetma-credential-test` (ref `mjjfdqwzxjqtfseamhsg`); Mighty OAuth app "HETMA Credential (test)" (Client ID `_KnqBPqFFhIgohk8Tjboodj6CB29shemC_F6fciCkN4`); Network ID `6821587`; badge "HEx Credential" ID `25410134`. The community has a "HEx Credential" space under Resources.
- **Mighty facts:** issuer `https://community.hetma.org`; plans General `1736546`, Higher Ed Hub `1819684`; Admin API base `https://api.mn.co/admin/v1/networks/{network}`.

## Ground rules (non-negotiable)

1. **Never** ask for, print, commit or paste secrets: Supabase service-role key, DB password, Mighty client secret, Mighty Admin API key. Secrets live only in Supabase → Edge Functions → Secrets. The browser gets only the public URL + anon key.
2. **Authorization lives in the database.** RLS on every table; every trusted write is a `SECURITY DEFINER` function with `set search_path = ''` that re-checks the caller. A hidden button is never the only protection.
3. **Mighty tokens never reach the browser.** `mighty-auth` is a backend-for-frontend: it owns state, the PKCE verifier and the code exchange, revokes Mighty tokens after reading `me`, and leaves a one-time handoff code that only the starting tab (holding a `bind` value in sessionStorage) can redeem at `/mighty-auth/redeem` for a Supabase sign-in token. Never add an endpoint that accepts a Mighty authorization `code` from the browser (Mighty's documented "token proxy" anti-pattern).
4. **Never link accounts by email.** Accounts are keyed by Mighty member ID only. Only accounts with a Mighty link can upload. Email/password sign-up must stay OFF on hosted projects.
5. **Every staff action is audited** (`private.audit(...)`); areas/providers have the `audit_changes` trigger.
6. **Database changes = a new migration** in `supabase/migrations/` (`YYYYMMDDHHMM00_name.sql`, next number). Never edit an applied migration. Re-grant execute on any new function explicitly (the RPC migration revokes everything by default). Then regenerate `supabase/setup-all-migrations.sql`:
   ```bash
   { printf -- "-- HEx Credential: complete database setup (all migrations, in order).\n-- Paste into Supabase -> SQL Editor -> Run, ONCE on a new, empty project. No demo data, no secrets.\n-- Then paste supabase/seed.sql for the starting list of competency areas and providers.\n\n"; for f in supabase/migrations/*.sql; do echo "-- ===== $(basename $f) ====="; cat "$f"; echo; done; } > supabase/setup-all-migrations.sql
   ```
7. Business errors return `{ ok:false, error, message }` instead of raising.
8. Ask the owner before anything destructive on the hosted project.

## Layout

- `src/main.js` router + sign-in page · `src/shell.js` frame · `src/api.js` Supabase calls
- `src/pages/member.js`, `admin.js`, `public.js` · `src/lib/credential.js` (pure, unit tested) · `src/lib/dom.js` (from the Passport)
- `supabase/migrations/` schema (`...0100`), RPCs (`...0200`), storage bucket + policies (`...0300`, skipped locally), super-admin self-review + area/provider delete + credential re-check (`...0400`), area code optional and unused in the UI (`...0500`) · `supabase/seed.sql` starting areas/providers
- `supabase/functions/_shared/mighty.js` all Edge Function logic (web-standard JS, runs on Deno and Node) · `mighty-auth/index.ts`, `credential-sync/index.ts` thin Deno entrypoints · `supabase/config.toml` (`mighty-auth` has `verify_jwt = false`)
- `dev/local-stack/` GoTrue + PostgREST + `services.mjs` (local Edge Functions runner + Storage stand-in) + `mock-mighty.mjs` + `proxy.mjs` on :54321 + `seed-users.mjs`

## Working on it

```bash
npm install && npm run stack:install
npm run stack:start          # resets the local DB every run
npm run dev
npm test && npm run test:integration && npm run test:e2e   # 12 unit, 38 integration, 7 e2e
```
Run `stack:start` before integration tests and again before e2e. Add tests for every new rule or screen. Check Edge Functions with `deno check supabase/functions/*/index.ts` when they change.

## Open items

- Confirm on real Mighty: `me.id` from sign-in = Admin API `member_id`; badge list response shape; join page honours `from=`.
- Not built: Mighty webhooks for tier changes, nightly expiry job, PDF credential or email, embedding in Mighty (would need `frame-ancestors` and a popup sign-in, since Mighty's authorize page can't be framed).
- Later: merge into the Event Passport (shared `profiles`/`staff_roles`, Passport's role names, one Supabase project).
