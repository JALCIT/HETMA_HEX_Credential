// Local demo data: accounts exactly as mighty-auth would create them, plus example
// uploads. Sign in locally with "Sign in with Mighty" and pick a mock member:
//   Alex Kim (1004)      super admin
//   Jordan Rivera (1001) member with 7 of 10 areas uploaded
//   Priya Shah (1002)    member who has earned the credential
//   Sam Newmember (1003) nobody yet (first sign-in creates the account)
import { createClient } from '@supabase/supabase-js';
import pg from 'pg';
import { serviceKey } from './jwt.mjs';

const admin = createClient('http://127.0.0.1:54321', serviceKey(), { auth: { persistSession: false } });
const db = new pg.Client({ connectionString: process.env.DATABASE_URL_APP || 'postgres://postgres:postgres@127.0.0.1:5432/hetma_credential_local' });
await db.connect();

async function member(id, name, tier) {
  const { data, error } = await admin.auth.admin.createUser({
    email: `m${id}@members.hetma-credential.invalid`, email_confirm: true,
    app_metadata: { provider: 'mighty', mighty_member_id: String(id), mighty_name: name },
  });
  if (error) throw error;
  await db.query(`update public.profiles set mighty_member_id = $3, full_name = $4, membership_tier = $2, tier_checked_at = now(), last_sign_in_at = now() - interval '2 days' where id = $1`, [data.user.id, tier, id, name]);
  return data.user.id;
}
const alex = await member(1004, 'Alex Kim', 'higher_ed');
const jordan = await member(1001, 'Jordan Rivera', 'higher_ed');
const priya = await member(1002, 'Priya Shah', 'general');
await db.query(`select public.bootstrap_super_admin('1004')`);

const areas = (await db.query('select id, code from public.competency_areas order by sort_order')).rows;
const prov = (await db.query('select id, name from public.providers')).rows;
const providerFor = code => prov.find(p => ({ NET: 'Netgear AV Academy', AUD: 'Shure Audio Institute', VID: 'Extron', CTL: 'Crestron', CAP: 'Panopto', UC: 'Zoom', SIG: 'Appspace', SUP: 'HDI', DES: 'AVIXA', ADA: 'AVIXA' }[code] === p.name)).id;
async function upload(uid, code, daysAgo, extra = {}) {
  const a = areas.find(x => x.code === code);
  const id = crypto.randomUUID();
  await db.query(`insert into public.submissions (id, user_id, area_id, provider_id, completion_date, file_path, file_name, file_type, attested_at, submitted_at, verified_at, verified_by)
                  values ($1, $2, $3, $4, current_date - $5::int - 3, $6, $7, 'application/pdf', now() - make_interval(days => $5), now() - make_interval(days => $5), $8, $9)`,
    [id, uid, a.id, providerFor(code), daysAgo, `${uid}/${crypto.randomUUID()}.pdf`, `${code}_certificate.pdf`, extra.verified ? new Date() : null, extra.verified ? alex : null]);
}
for (const [i, code] of ['NET', 'AUD', 'VID', 'CAP', 'SUP', 'CTL', 'UC'].entries()) await upload(jordan, code, 40 - i * 5, { verified: i < 3 });
for (const [i, a] of areas.entries()) await upload(priya, a.code, 60 - i * 4, { verified: i < 4 });
await db.query('select private.recompute_credential($1)', [jordan]);
await db.query('select private.recompute_credential($1)', [priya]);
await db.end();
console.log('Seeded demo members: Alex Kim (super admin, 1004), Jordan Rivera (1001), Priya Shah (1002, credential earned).');
process.exit(0);
