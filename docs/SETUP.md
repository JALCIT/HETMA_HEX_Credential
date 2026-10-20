# Setting up the HEx Credential test site

This puts the app online as a **separate test site**: its own Supabase project, its own Vercel project, its own Mighty sign-in app. Nothing here touches the live Event Passport or its database.

Plan on about an hour the first time. Do the steps in order. Anything marked **secret** is typed only into the Supabase or Mighty dashboards, never into chat, email, GitHub or Vercel.

## 1. Put the code on GitHub

The code is already in your `HETMA_HEX_Credential` folder, which GitHub Desktop links to the `JALCIT/HETMA_HEX_Credential` repository.

1. Open GitHub Desktop and select **HETMA_HEX_Credential**. You'll see all the new files as changes.
2. Commit them to `main` (for example "First version of the HEx Credential test site"), then **Push origin**.
3. On github.com, check the repository is **private**.

## 2. Create the Supabase project

1. At supabase.com → **New project**. Name: `hetma-credential-test`. Pick a strong database password and save it in your password manager (**secret**). Region: US East (or whichever is closest).
2. When it's ready, open **Project Settings → API** and note:
   - the **Project URL** (e.g. `https://abcd1234.supabase.co`). The part before `.supabase.co` is your **project ref**.
   - the **anon / publishable key** (public, safe to put in Vercel).
3. **SQL Editor → New query**: paste all of `supabase/setup-all-migrations.sql` → **Run**.
4. New query: paste `supabase/seed.sql` → **Run**. (The starting list of 10 placeholder competency areas and providers. You can change them later in the Admin workspace.)
5. Check **Storage**: a private bucket named `certificates` should now exist.
6. **Authentication → Sign In / Providers**:
   - Keep **Email** enabled (the app uses it internally to start sessions).
   - Turn **off** "Allow new users to sign up". **Important for security**: accounts must be created only by the Mighty sign-in function.
   - Also turn off **Anonymous sign-ins** if it's on.

## 3. Create the sign-in app in Mighty

> **Done for the test site (Oct 20):** OAuth app "HETMA Credential (test)" (Client ID `_KnqBPqFFhIgohk8Tjboodj6CB29shemC_F6fciCkN4`), Admin API key "HETMA Credential (test) - badges and plans", Network ID `6821587`, badge "HEx Credential" ID `25410134`. The steps below are for reference.

In your Mighty admin (community.hetma.org):

1. **Integrations → OAuth Applications → New OAuth Application**
   - Name: `HEx Credential (test)`
   - Client type: **Confidential**
   - Scopes: **read:userinfo** only
   - Redirect URI: `https://<project ref>.supabase.co/functions/v1/mighty-auth/callback`
   - Save. Note the **Client ID** (public) and the **Client Secret** (**secret**).
2. **Integrations → Admin API**: create a key limited to members and badges. Note the key (**secret**) and your **Network ID**.
3. **Badges**: create a badge named **HEx Credential**. Note its **badge ID**. (The Admin API's "Return all badges for the Network" lists IDs if the dashboard doesn't show it.)

## 4. Deploy the two Edge Functions

On your computer, in the project folder (PowerShell or Terminal), once:

```bash
npm install
npx supabase login
npx supabase link --project-ref <project ref>
```

Then deploy (repeat these two lines whenever the functions change):

```bash
npx supabase functions deploy mighty-auth --no-verify-jwt
npx supabase functions deploy credential-sync
```

`mighty-auth` must be deployed with `--no-verify-jwt`: people arrive there from a plain browser link, before they have a session. The function protects itself with OAuth state, PKCE and a cookie instead.

## 5. Add the function secrets

> **Done (Oct 20):** `APP_URL`, `MIGHTY_NETWORK`, `MIGHTY_CLIENT_ID`, `MIGHTY_BADGE_ID` are set. **Still to add yourself:** `MIGHTY_CLIENT_SECRET` and `MIGHTY_ADMIN_API_KEY`.

Supabase → **Edge Functions → Secrets** → add each one (typing them here keeps them out of files and command history):

| Name | Value |
|---|---|
| `APP_URL` | `https://hetma-hex-credential.vercel.app` (no trailing slash) |
| `MIGHTY_NETWORK` | `6821587` |
| `MIGHTY_CLIENT_ID` | `_KnqBPqFFhIgohk8Tjboodj6CB29shemC_F6fciCkN4` |
| `MIGHTY_CLIENT_SECRET` | From step 3.1 (**secret**) |
| `MIGHTY_ADMIN_API_KEY` | From step 3.2 (**secret**) |
| `MIGHTY_BADGE_ID` | `25410134` |

Already set by Supabase, don't add: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` (or `SUPABASE_SECRET_KEYS` on newer projects; the functions use either).
Optional, with defaults already right for HETMA: `MIGHTY_ISSUER` (`https://community.hetma.org`), `MIGHTY_PLAN_GENERAL` (`1736546`), `MIGHTY_PLAN_HIGHER_ED` (`1819684`).

## 6. Put the site on Vercel

> **Done (Oct 20):** Vercel project `hetma-hex-credential` (team "jalcit's projects"), live at **https://hetma-hex-credential.vercel.app**. Every push to `main` redeploys it. Supabase Site URL is set to the same address.

1. vercel.com → **Add New → Project** → import the `JALCIT/HETMA_HEX_Credential` repository. Framework: Vite (detected).
2. Environment variables:
   - `VITE_SUPABASE_URL` = the Project URL
   - `VITE_SUPABASE_ANON_KEY` = the anon / publishable key
   - `VITE_APP_ENV` = `preview` (shows a TEST badge)
3. Deploy. Copy the site address, then go back and set the `APP_URL` secret (step 5).
4. Supabase → **Authentication → URL Configuration**: set **Site URL** to the same address.

## 7. Make yourself the first super admin

1. Open the site and **Sign in with your HETMA community account**.
2. Supabase → SQL Editor:
   ```sql
   select full_name, mighty_member_id from public.profiles;
   select public.bootstrap_super_admin('<your mighty_member_id>');
   ```
3. Reload the site. **Admin** appears in the top bar. Add other staff from **Admin → Team** after they've signed in once.

## If sign-in fails at "We couldn’t set up your account"

Hosted Supabase might reject the internal placeholder email domain. Add a function secret `MEMBER_EMAIL_DOMAIN` set to a domain HETMA controls that never receives mail (for example `members.invalid.hetma.org`), and try again.

## 8. Test checklist

- [ ] Sign in works and shows your name and tier (General or Higher Ed Hub).
- [ ] **Admin → Audit log** shows no "Couldn't read membership tier from Mighty" entries. (If it does, the Mighty member ID from sign-in may not match the Admin API's member ID. Tell Claude what it says.)
- [ ] Upload a certificate: the area shows **Uploaded**, and **View** opens the file.
- [ ] With a test member account, upload all 10 areas: the credential is earned, the **HEx Credential** badge appears on that member's Mighty profile, and the public page shows **Active**.
- [ ] As an admin, revoke one of that member's uploads: the badge disappears in Mighty, the public page says **no longer active**, and the member sees your reason.
- [ ] Restore it: the badge comes back.
- [ ] In a private window, use **New to HETMA? Join free** with a brand-new email: after joining, you land back on the site signed in. (If you end up in the community instead, the join page ignored the return address. The fallback is to come back and press Sign in.)
- [ ] Try it on a phone.

## What stays on the test site

This test site has its own database and member list. When it's working, the same code and migrations move into the Event Passport project, following the Passport's migration rules.
