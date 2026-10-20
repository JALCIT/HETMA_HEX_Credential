// Environment the local Edge Functions runner uses (mirrors the Supabase secrets).
import { serviceKey } from './jwt.mjs';
export const localEnv = {
  APP_URL: process.env.APP_URL || 'http://127.0.0.1:5173',
  SUPABASE_URL: 'http://127.0.0.1:54321',
  SUPABASE_SERVICE_ROLE_KEY: serviceKey(),
  MIGHTY_ISSUER: 'http://127.0.0.1:54400',
  MIGHTY_API_BASE: 'http://127.0.0.1:54400',
  MIGHTY_JOIN_URL: 'http://127.0.0.1:54400/users/onboarding/plans?auto_join=true',
  MIGHTY_NETWORK: 'hetma-local',
  MIGHTY_CLIENT_ID: 'local-client-id',
  MIGHTY_CLIENT_SECRET: 'local-client-secret',
  MIGHTY_ADMIN_API_KEY: 'local-admin-key',
  MIGHTY_BADGE_ID: '777',
  MIGHTY_PLAN_GENERAL: '1736546',
  MIGHTY_PLAN_HIGHER_ED: '1819684',
};
