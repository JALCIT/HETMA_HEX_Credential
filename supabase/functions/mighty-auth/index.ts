// Supabase Edge Function: "Sign in with Mighty" (deploy with JWT verification OFF;
// see supabase/config.toml). Routes: /mighty-auth/start, /mighty-auth/join,
// /mighty-auth/callback. All logic lives in ../_shared/mighty.js.
import { createClient } from 'npm:@supabase/supabase-js@2';
import { handleMightyAuth } from '../_shared/mighty.js';

Deno.serve(req => handleMightyAuth(req, { env: Deno.env.toObject(), createClient, fetch }));
