#!/usr/bin/env bash
set -Eeuo pipefail

required=(
  ADMIN_DATABASE_URL
  RUNTIME_API_DB_PASSWORD
  RUNTIME_WORKER_DB_PASSWORD
  MODEL_GATEWAY_DB_PASSWORD
  AUDIT_VERIFIER_DB_PASSWORD
)
for name in "${required[@]}"; do
  if [[ -z "${!name:-}" ]]; then
    echo "ERROR: $name is required" >&2
    exit 2
  fi
done

until pg_isready --dbname="$ADMIN_DATABASE_URL" >/dev/null 2>&1; do
  echo "Waiting for PostgreSQL..."
  sleep 2
done

psql "$ADMIN_DATABASE_URL" -v ON_ERROR_STOP=1 <<'SQL'
CREATE TABLE IF NOT EXISTS public.schema_migrations (
  filename text PRIMARY KEY,
  checksum text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
);
SQL

mapfile -t migrations < <(find packages/persistence/migrations -maxdepth 1 -type f -name '*.sql' | sort)
if [[ "${#migrations[@]}" -eq 0 ]]; then
  echo "ERROR: no SQL migrations found" >&2
  exit 3
fi

for migration in "${migrations[@]}"; do
  filename="$(basename "$migration")"
  checksum="$(sha256sum "$migration" | awk '{print $1}')"
  stored="$(
    psql "$ADMIN_DATABASE_URL" -At -v ON_ERROR_STOP=1 --set=filename="$filename" <<'SQL'
SELECT checksum
  FROM public.schema_migrations
 WHERE filename = :'filename';
SQL
  )"

  if [[ -n "$stored" ]]; then
    if [[ "$stored" != "$checksum" ]]; then
      echo "ERROR: migration checksum changed after application: $filename" >&2
      echo "stored=$stored current=$checksum" >&2
      exit 4
    fi
    echo "SKIP $filename"
    continue
  fi

  echo "APPLY $filename"
  psql "$ADMIN_DATABASE_URL" -v ON_ERROR_STOP=1 -f "$migration"
  psql "$ADMIN_DATABASE_URL" -v ON_ERROR_STOP=1 \
    --set=filename="$filename" \
    --set=checksum="$checksum" <<'SQL'
INSERT INTO public.schema_migrations(filename, checksum)
VALUES (:'filename', :'checksum');
SQL
done

psql "$ADMIN_DATABASE_URL" -v ON_ERROR_STOP=1 \
  -v api_password="$RUNTIME_API_DB_PASSWORD" \
  -v worker_password="$RUNTIME_WORKER_DB_PASSWORD" \
  -v model_password="$MODEL_GATEWAY_DB_PASSWORD" \
  -v audit_password="$AUDIT_VERIFIER_DB_PASSWORD" <<'SQL'
SELECT format('ALTER ROLE ai_crm_runtime_api LOGIN PASSWORD %L', :'api_password') \gexec
SELECT format('ALTER ROLE ai_crm_runtime_worker LOGIN PASSWORD %L', :'worker_password') \gexec
SELECT format('ALTER ROLE ai_crm_runtime_model_gateway LOGIN PASSWORD %L', :'model_password') \gexec
SELECT format('ALTER ROLE ai_crm_audit_verifier LOGIN PASSWORD %L', :'audit_password') \gexec

SELECT format('GRANT CONNECT ON DATABASE %I TO ai_crm_runtime_api', current_database()) \gexec
SELECT format('GRANT CONNECT ON DATABASE %I TO ai_crm_runtime_worker', current_database()) \gexec
SELECT format('GRANT CONNECT ON DATABASE %I TO ai_crm_runtime_model_gateway', current_database()) \gexec
SELECT format('GRANT CONNECT ON DATABASE %I TO ai_crm_audit_verifier', current_database()) \gexec

ALTER ROLE ai_crm_runtime_api SET statement_timeout = '30s';
ALTER ROLE ai_crm_runtime_api SET idle_in_transaction_session_timeout = '60s';
ALTER ROLE ai_crm_runtime_worker SET statement_timeout = '60s';
ALTER ROLE ai_crm_runtime_worker SET idle_in_transaction_session_timeout = '60s';
ALTER ROLE ai_crm_runtime_model_gateway SET statement_timeout = '60s';
SQL

echo "Migrations and runtime role credentials are ready."
