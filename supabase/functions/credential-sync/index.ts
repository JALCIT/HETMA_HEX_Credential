// Supabase Edge Function: makes the member's Mighty badge match their credential.
// Called by the app (with the signed-in user's JWT) after uploads and admin
// actions. Members can sync only themselves; staff can sync anyone.
import { createClient } from 'npm:@supabase/supabase-js@2';
import { handleCredentialSync } from '../_shared/mighty.js';

Deno.serve(req => handleCredentialSync(req, { env: Deno.env.toObject(), createClient, fetch }));
