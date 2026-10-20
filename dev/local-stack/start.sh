#!/usr/bin/env bash
# Local Supabase-compatible stack for development and CI, without Docker:
#   Postgres (system install) + Supabase Auth (GoTrue) + PostgREST
#   + a local Edge Functions runner (same code as supabase/functions)
#   + a stand-in Storage service + a mock of Mighty's OAuth/API
#   + a tiny gateway on :54321 that routes like Supabase does.
# Usage: dev/local-stack/start.sh [--seed]
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
BIN_DIR="${BIN_DIR:-$ROOT/.local-stack/bin}"
RUN_DIR="${RUN_DIR:-$ROOT/.local-stack/run}"
DB_NAME="${DB_NAME:-hetma_credential_local}"
export PGHOST="${PGHOST:-127.0.0.1}" PGPORT="${PGPORT:-5432}" PGUSER="${PGUSER:-postgres}" PGPASSWORD="${PGPASSWORD:-postgres}"
JWT_SECRET="$(node -e "import('$ROOT/dev/local-stack/jwt.mjs').then(m=>console.log(m.LOCAL_JWT_SECRET))")"
mkdir -p "$RUN_DIR"
bash "$ROOT/dev/local-stack/stop.sh" >/dev/null 2>&1 || true

psql -q -d postgres -c "drop database if exists $DB_NAME with (force)" -c "create database $DB_NAME"
psql -q -v ON_ERROR_STOP=1 -d "$DB_NAME" -f "$ROOT/dev/local-stack/roles.sql"

# Supabase Auth runs its own migrations into the auth schema.
export GOTRUE_DB_DRIVER=postgres
export DATABASE_URL="postgres://supabase_auth_admin:postgres@$PGHOST:$PGPORT/$DB_NAME?sslmode=disable"
export GOTRUE_DB_DATABASE_URL="$DATABASE_URL" GOTRUE_DB_NAMESPACE=auth
export GOTRUE_JWT_SECRET="$JWT_SECRET" GOTRUE_JWT_EXP=3600 GOTRUE_JWT_AUD=authenticated GOTRUE_JWT_DEFAULT_GROUP_NAME=authenticated
export GOTRUE_JWT_ADMIN_ROLES=service_role
export GOTRUE_SITE_URL="${SITE_URL:-http://127.0.0.1:5173}" GOTRUE_URI_ALLOW_LIST="http://127.0.0.1:5173,http://localhost:5173,http://127.0.0.1:4173"
export API_EXTERNAL_URL="http://127.0.0.1:54321/auth/v1" GOTRUE_API_HOST=127.0.0.1 PORT=9999
export GOTRUE_EXTERNAL_EMAIL_ENABLED=true GOTRUE_MAILER_AUTOCONFIRM=true GOTRUE_DISABLE_SIGNUP=false
export GOTRUE_MAILER_OTP_EXP=300
export GOTRUE_RATE_LIMIT_EMAIL_SENT=1000 GOTRUE_RATE_LIMIT_TOKEN_REFRESH=10000 GOTRUE_RATE_LIMIT_VERIFY=10000 GOTRUE_RATE_LIMIT_SIGN_UP_SIGN_IN=100000 GOTRUE_RATE_LIMIT_OTP=100000
export GOTRUE_SMTP_HOST=localhost GOTRUE_SMTP_PORT=2500 GOTRUE_SMTP_ADMIN_EMAIL=dev@example.org GOTRUE_LOG_LEVEL=warn
(cd "$BIN_DIR" && ./auth migrate >"$RUN_DIR/auth-migrate.log" 2>&1) || { cat "$RUN_DIR/auth-migrate.log"; exit 1; }
psql -q -d "$DB_NAME" -c "grant usage on schema auth to anon, authenticated, service_role; grant select on auth.users to postgres;" >/dev/null

for f in "$ROOT"/supabase/migrations/*.sql; do
  psql -q -v ON_ERROR_STOP=1 -d "$DB_NAME" -f "$f" >/dev/null 2>"$RUN_DIR/migrate.err" || { cat "$RUN_DIR/migrate.err"; exit 1; }
done
psql -q -v ON_ERROR_STOP=1 -d "$DB_NAME" -f "$ROOT/supabase/seed.sql" >/dev/null

(cd "$BIN_DIR" && nohup ./auth serve >"$RUN_DIR/auth.log" 2>&1 </dev/null & echo $! >"$RUN_DIR/auth.pid")
PGRST_DB_URI="postgres://authenticator:postgres@$PGHOST:$PGPORT/$DB_NAME" PGRST_DB_SCHEMAS=public PGRST_DB_ANON_ROLE=anon \
PGRST_JWT_SECRET="$JWT_SECRET" PGRST_SERVER_PORT=3000 PGRST_SERVER_HOST=127.0.0.1 PGRST_DB_MAX_ROWS=1000 \
  nohup "$BIN_DIR/postgrest" >"$RUN_DIR/postgrest.log" 2>&1 </dev/null & echo $! >"$RUN_DIR/postgrest.pid"
nohup node "$ROOT/dev/local-stack/mock-mighty.mjs" >"$RUN_DIR/mock-mighty.log" 2>&1 </dev/null & echo $! >"$RUN_DIR/mock-mighty.pid"
nohup node "$ROOT/dev/local-stack/services.mjs" >"$RUN_DIR/services.log" 2>&1 </dev/null & echo $! >"$RUN_DIR/services.pid"
nohup node "$ROOT/dev/local-stack/proxy.mjs" >"$RUN_DIR/proxy.log" 2>&1 </dev/null & echo $! >"$RUN_DIR/proxy.pid"

for i in $(seq 1 40); do
  if curl -sf http://127.0.0.1:54321/auth/v1/health >/dev/null && curl -sf -o /dev/null http://127.0.0.1:54321/rest/v1/ -H "apikey: x" \
     && curl -sf -o /dev/null http://127.0.0.1:54400/health; then break; fi
  sleep 0.5
done
curl -sf http://127.0.0.1:54321/auth/v1/health >/dev/null || { echo "auth failed"; cat "$RUN_DIR/auth.log"; exit 1; }
if [[ "${1:-}" == "--seed" ]]; then node "$ROOT/dev/local-stack/seed-users.mjs"; fi
echo "Local stack ready: http://127.0.0.1:54321  (db: $DB_NAME)  mock Mighty: http://127.0.0.1:54400"
echo "VITE_SUPABASE_URL=http://127.0.0.1:54321"
echo "VITE_SUPABASE_ANON_KEY=$(node "$ROOT/dev/local-stack/jwt.mjs" anon)"
