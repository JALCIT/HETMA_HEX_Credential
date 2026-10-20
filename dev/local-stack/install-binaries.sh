#!/usr/bin/env bash
# Downloads pinned Supabase Auth (GoTrue) and PostgREST release binaries (Linux x86-64).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"; BIN_DIR="${BIN_DIR:-$ROOT/.local-stack/bin}"
AUTH_VERSION="${AUTH_VERSION:-v2.197.0}"; PGRST_VERSION="${PGRST_VERSION:-v12.2.12}"
mkdir -p "$BIN_DIR"; cd "$BIN_DIR"
if [[ ! -x auth ]]; then
  curl -fsSL -o auth.tgz "https://github.com/supabase/auth/releases/download/$AUTH_VERSION/auth-$AUTH_VERSION-x86.tar.gz"
  tar xzf auth.tgz && rm auth.tgz
fi
if [[ ! -x postgrest ]]; then
  curl -fsSL -o pgrst.tar.xz "https://github.com/PostgREST/postgrest/releases/download/$PGRST_VERSION/postgrest-$PGRST_VERSION-linux-static-x86-64.tar.xz"
  tar xJf pgrst.tar.xz && rm pgrst.tar.xz
fi
echo "binaries in $BIN_DIR"
