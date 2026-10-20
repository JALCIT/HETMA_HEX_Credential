#!/usr/bin/env bash
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"; RUN_DIR="${RUN_DIR:-$ROOT/.local-stack/run}"
for s in auth postgrest proxy services mock-mighty; do [[ -f "$RUN_DIR/$s.pid" ]] && kill "$(cat "$RUN_DIR/$s.pid")" 2>/dev/null; rm -f "$RUN_DIR/$s.pid"; done; true
