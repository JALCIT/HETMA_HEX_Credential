// Browser-visible configuration. Only the public project URL and the anon
// (publishable) key belong here; both are safe to expose because every table is
// protected by Row Level Security. Never put a service-role key in VITE_* vars.
export const config = {
  supabaseUrl: import.meta.env.VITE_SUPABASE_URL || '',
  supabaseAnonKey: import.meta.env.VITE_SUPABASE_ANON_KEY || '',
  appEnv: import.meta.env.VITE_APP_ENV || 'development', // development | preview | production
};
export const isConfigured = () => Boolean(config.supabaseUrl && config.supabaseAnonKey);
