# HETMA Credential (test site)

Members of the HETMA community sign in with their Mighty account, upload training certificates from approved providers across the HETMA competency areas, and earn the **HETMA Credential**: a badge on their Mighty profile plus a public credential page they can add to LinkedIn. It runs on an **honor system**: uploads count as soon as the member confirms they're genuine. HETMA admins can spot-check, verify, revoke, restore and pause uploads, and every action is audited.

This is a **standalone test app**, built on the same stack and conventions as the HETMA Event Passport so it can move into the Passport later. Setup steps for the hosted test site: **[docs/SETUP.md](docs/SETUP.md)**. Working with Claude? Start with [CLAUDE.md](CLAUDE.md).

Wording: always "credential" or "HETMA Credential", never "certification" or "certified". The files members upload from vendors are "certificates".

## How it works

| Piece | What it does |
|---|---|
| Mighty (community.hetma.org) | Source of truth for who people are and their membership tier (General / Higher Ed Hub). Also shows the badge. |
| `mighty-auth` Edge Function | "Sign in with Mighty": OAuth 2.0 with PKCE as a confidential client. Creates or finds the member's account (keyed by Mighty member ID only), reads their tier with the Admin API, then leaves a one-time handoff that only the browser tab that started sign-in can redeem for a normal Supabase session. Mighty tokens are revoked right after use and never reach the browser. |
| `credential-sync` Edge Function | Makes the Mighty badge match the credential (adds or removes it). Reads Mighty first, so it's safe to retry. |
| Supabase Postgres | Uploads, credential status, areas, providers, staff roles, audit log. RLS on every table; every write goes through a `SECURITY DEFINER` function that re-checks the caller. |
| Supabase Storage | Private `certificates` bucket. Members upload into their own folder; staff can read all files; viewing uses 5-minute signed links. |
| Vite + vanilla JS on Vercel | The site: sign-in, member dashboard, admin workspace, public credential page. |

The credential is **active** when every active, required competency area has at least one upload that isn't revoked or expired. When that stops being true it becomes **inactive**, and the badge is removed.

## Screens

- `#/signin`: Sign in with your HETMA community account / New to HETMA? Join free
- `#/me`: progress ring, one row per area (upload, view, status, HETMA's note on revoked uploads), credential link and LinkedIn instructions
- `#/admin/uploads`: filter (Not checked / Verified / Revoked / All), search, **Random spot-check**, review dialog (open file, verify, revoke with reason, restore, pause uploads)
- `#/admin/members`: tier, areas done, credential and Mighty badge status, retry badge sync, pause uploads
- `#/admin/areas`: add and edit competency areas, required/optional, approved providers per area
- `#/admin/team`: super admins add or remove admins
- `#/admin/audit`: every staff action and setup change
- `#/c/<slug>`: public credential page (name, date, areas, status; never files, contact details or reasons)

## Local development (Linux sandbox, no Docker)

Requirements: Node 20+, PostgreSQL 16 on `127.0.0.1:5432` (user `postgres` / password `postgres`).

```bash
npm install
npm run stack:install   # once: downloads pinned Supabase Auth (GoTrue) + PostgREST binaries
npm run stack:start     # fresh DB + migrations + areas + demo members; prints env values
cp .env.example .env.local   # paste the printed VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY, set VITE_APP_ENV=development
npm run dev             # http://127.0.0.1:5173
```

The local stack runs Supabase Auth, PostgREST, a local runner for the **same** Edge Function code, a stand-in for Storage, and a **mock of Mighty** (`dev/local-stack/mock-mighty.mjs`) with OAuth, GraphQL `me`, plans and badges. "Sign in" locally shows a page where you pick a mock member:

| Mock member | Mighty ID | Demo state |
|---|---|---|
| Alex Kim | 1004 | Super admin |
| Jordan Rivera | 1001 | Higher Ed Hub, 7 of 10 areas uploaded |
| Priya Shah | 1002 | General, credential earned |
| Sam Newmember | 1003 | No account yet (first sign-in creates it) |

## Tests

GitHub Actions can run the build and all three suites on every push: move `ci/ci.yml` to `.github/workflows/ci.yml` (create those two folders in File Explorer) and commit. It needs no secrets.

```bash
npm test                  # unit: progress rules, file checks, PKCE, cookie parsing, tier mapping
npm run test:integration  # 35 tests against the local stack (run stack:start first)
npm run test:e2e          # 6 Playwright tests, phone + desktop (run stack:start first; set CHROMIUM_PATH if needed)
```

Integration tests cover: sign-in (PKCE redirect, cookie binding, single-use state, issuer check, cancelled sign-in, join hand-off, tab-bound single-use handoff (no login CSRF), no takeover through a pre-registered look-alike account, one account per Mighty member, tier mapping), upload validation (attestation, Mighty-linked accounts only, own folder only, provider/dates/area/file type and extension), RLS boundaries (own data only, no direct writes, no anonymous reads, no self-promotion), credential earn/end on expiry, public page contents, admin verify/revoke/restore with reasons and audit, no reviewing your own uploads, last super admin protection, area edits audited, and badge add/remove through Mighty (idempotent, staff-only for others).

## Known limitations and things to confirm on the real Mighty

- Confirm with a real sign-in that the ID Mighty returns at sign-in (`me.id`) is the member ID the Admin API uses for plans and badges. If tier lookups fail, the audit log says so.
- The join hand-off passes a return address (`from=`) to the community join page. If Mighty ignores it, new members land in the community and need to come back and press Sign in.
- Membership tier refreshes at each sign-in. Mighty webhooks (MemberPlanChanged etc.) could keep it current between sign-ins; not built yet.
- When an upload expires, the public page shows "no longer active" right away (it re-checks live), but the stored status and the Mighty badge only update the next time that member opens the site. There's no nightly job yet.
- The public page and the member's own page are the only places that show the credential; no PDF certificate or email yet.
- Members can't delete their own uploads (by design for the audit trail); admins revoke instead.
