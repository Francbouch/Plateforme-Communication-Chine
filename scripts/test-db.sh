#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
# Explicit local daemon: never use a remote Docker context.
unset DOCKER_HOST DOCKER_CONTEXT DOCKER_TLS DOCKER_TLS_VERIFY DOCKER_CERT_PATH
container="forgebridge-tests-$$"
trap 'docker --host=unix:///var/run/docker.sock rm -f "$container" >/dev/null 2>&1 || true' EXIT
docker --host=unix:///var/run/docker.sock run --name "$container" -e POSTGRES_HOST_AUTH_METHOD=trust -d postgres:17-alpine >/dev/null
for attempt in $(seq 1 30); do
 if docker --host=unix:///var/run/docker.sock exec "$container" pg_isready -h 127.0.0.1 -U postgres >/dev/null 2>&1; then break; fi
 sleep 1
done
run_sql(){ docker --host=unix:///var/run/docker.sock exec -i "$container" psql -U postgres -v ON_ERROR_STOP=1 < "$1"; }
run_sql tests/auth-schema.sql
for migration in supabase/migrations/*.sql; do run_sql "$migration"; done
run_sql tests/rls.sql
