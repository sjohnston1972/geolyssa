#!/usr/bin/env bash
# scripts/deploy.sh — build + deploy the Geolyssa Worker via Cloudflare API
#
# Requires environment variables (sourced from .env if present):
#   CLOUDFLARE_API_TOKEN  — token with Workers Scripts:Edit + Zone DNS:Edit
#   CLOUDFLARE_ACCOUNT_ID — Cloudflare account ID
#   ANTHROPIC_API_KEY     — set as a Worker secret
#
# Optional:
#   GEOLYSSA_WORKER_NAME  (default: geolyssa)
#   GEOLYSSA_HOSTNAME     (default: geolyssa.clydeford.net)
#   GEOLYSSA_ZONE_NAME    (default: clydeford.net)

set -euo pipefail

cd "$(dirname "$0")/.."

# Load .env if present (without exporting secrets globally)
if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

: "${CLOUDFLARE_API_TOKEN:?CLOUDFLARE_API_TOKEN not set}"
: "${CLOUDFLARE_ACCOUNT_ID:?CLOUDFLARE_ACCOUNT_ID not set}"
: "${ANTHROPIC_API_KEY:?ANTHROPIC_API_KEY not set}"

WORKER_NAME="${GEOLYSSA_WORKER_NAME:-geolyssa}"
HOSTNAME="${GEOLYSSA_HOSTNAME:-geolyssa.clydeford.net}"
ZONE_NAME="${GEOLYSSA_ZONE_NAME:-clydeford.net}"
R2_BUCKET="${GEOLYSSA_R2_BUCKET:-geolyssa-photos}"
D1_DB_NAME="${GEOLYSSA_D1_DB:-geolyssa}"
API="https://api.cloudflare.com/client/v4"
AUTH=(-H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}")

say() { printf '\033[0;36m▸\033[0m %s\n' "$*"; }
ok()  { printf '\033[0;32m✓\033[0m %s\n' "$*"; }
die() { printf '\033[0;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

# ─── 1. BUILD ────────────────────────────────────────────────────────
say "Building bundle"
bash scripts/build.sh
[[ -f build/worker.js ]] || die "build/worker.js not produced"

# ─── 2. RESOLVE ZONE ID ──────────────────────────────────────────────
say "Resolving zone ID for ${ZONE_NAME}"
ZONE_ID=$(curl -s "${AUTH[@]}" "${API}/zones?name=${ZONE_NAME}" |
  grep -oE '"id":"[a-f0-9]{32}"' | head -1 | cut -d'"' -f4)
[[ -n "${ZONE_ID}" ]] || die "Could not resolve zone ID for ${ZONE_NAME}"
ok "Zone ID: ${ZONE_ID}"

# ─── 2a. ENSURE R2 BUCKET ────────────────────────────────────────────
say "Ensuring R2 bucket: ${R2_BUCKET}"
R2_RESP=$(curl -s -X POST "${AUTH[@]}" -H "Content-Type: application/json" \
  "${API}/accounts/${CLOUDFLARE_ACCOUNT_ID}/r2/buckets" \
  --data "{\"name\":\"${R2_BUCKET}\"}")
if echo "${R2_RESP}" | grep -qE '"success":\s*true'; then
  ok "R2 bucket created"
elif echo "${R2_RESP}" | grep -qi 'already exists\|duplicate'; then
  ok "R2 bucket already exists"
else
  echo "${R2_RESP}" >&2
  die "R2 bucket provisioning failed"
fi

# ─── 2b. ENSURE D1 DATABASE ──────────────────────────────────────────
say "Resolving D1 database: ${D1_DB_NAME}"
D1_LIST=$(curl -s "${AUTH[@]}" "${API}/accounts/${CLOUDFLARE_ACCOUNT_ID}/d1/database?name=${D1_DB_NAME}")
D1_ID=$(printf '%s' "${D1_LIST}" | grep -oE '"uuid":"[a-f0-9-]+"' | head -1 | cut -d'"' -f4)
if [[ -z "${D1_ID}" ]]; then
  say "D1 database not found, creating"
  D1_CREATE=$(curl -s -X POST "${AUTH[@]}" -H "Content-Type: application/json" \
    "${API}/accounts/${CLOUDFLARE_ACCOUNT_ID}/d1/database" \
    --data "{\"name\":\"${D1_DB_NAME}\"}")
  D1_ID=$(printf '%s' "${D1_CREATE}" | grep -oE '"uuid":"[a-f0-9-]+"' | head -1 | cut -d'"' -f4)
  [[ -n "${D1_ID}" ]] || { echo "${D1_CREATE}" >&2; die "D1 create failed"; }
fi
ok "D1 ID: ${D1_ID}"

# ─── 2c. APPLY SCHEMA MIGRATION ──────────────────────────────────────
say "Applying D1 schema migration"
# Fresh-install schema (no-op if the table already exists).
MIG_RESP=$(curl -s -X POST "${AUTH[@]}" -H "Content-Type: application/json" \
  "${API}/accounts/${CLOUDFLARE_ACCOUNT_ID}/d1/database/${D1_ID}/query" \
  --data '{"sql":"CREATE TABLE IF NOT EXISTS journal_entries (id TEXT PRIMARY KEY, device_id TEXT NOT NULL, rock_json TEXT NOT NULL, rock_type TEXT NOT NULL, date TEXT, location TEXT, lat REAL, lng REAL, note TEXT, photo_key TEXT, created_at INTEGER NOT NULL, alternatives TEXT, macrostrat_json TEXT); CREATE INDEX IF NOT EXISTS idx_device_created ON journal_entries(device_id, created_at DESC);"}')
echo "${MIG_RESP}" | grep -qE '"success":\s*true' || { echo "${MIG_RESP}" >&2; die "Migration failed"; }

# Incremental ALTERs for pre-existing databases. SQLite has no IF NOT
# EXISTS for columns, so we just run ALTER and swallow "duplicate column".
d1_try_alter() {
  local sql="$1"
  local resp
  resp=$(curl -s -X POST "${AUTH[@]}" -H "Content-Type: application/json" \
    "${API}/accounts/${CLOUDFLARE_ACCOUNT_ID}/d1/database/${D1_ID}/query" \
    --data "{\"sql\":\"${sql}\"}")
  if echo "${resp}" | grep -qE '"success":\s*true'; then return 0; fi
  if echo "${resp}" | grep -qi 'duplicate column\|already exists'; then return 0; fi
  echo "${resp}" >&2
  return 1
}
d1_try_alter "ALTER TABLE journal_entries ADD COLUMN alternatives TEXT;" \
  || die "Schema upgrade failed"
d1_try_alter "ALTER TABLE journal_entries ADD COLUMN macrostrat_json TEXT;" \
  || die "Schema upgrade failed (macrostrat_json)"
ok "Schema applied"

# ─── 3. UPLOAD WORKER SCRIPT ─────────────────────────────────────────
say "Uploading Worker: ${WORKER_NAME}"
METADATA=$(cat <<EOF
{
  "main_module": "worker.js",
  "compatibility_date": "2025-04-01",
  "compatibility_flags": ["nodejs_compat"],
  "bindings": [
    { "type": "d1", "name": "DB", "id": "${D1_ID}" },
    { "type": "r2_bucket", "name": "PHOTOS", "bucket_name": "${R2_BUCKET}" }
  ],
  "keep_bindings": ["secret_text"]
}
EOF
)

UPLOAD_RESP=$(curl -s -X PUT "${AUTH[@]}" \
  "${API}/accounts/${CLOUDFLARE_ACCOUNT_ID}/workers/scripts/${WORKER_NAME}" \
  -F "metadata=${METADATA};type=application/json" \
  -F "worker.js=@build/worker.js;type=application/javascript+module")

echo "${UPLOAD_RESP}" | grep -qE '"success":\s*true' || {
  echo "${UPLOAD_RESP}" >&2
  die "Worker upload failed"
}
ok "Worker uploaded"

# ─── 4. SET SECRET ───────────────────────────────────────────────────
# The Anthropic API key uses safe characters (alnum + `-_`), so inline JSON is fine.
# Verify before sending, so a bad key doesn't silently ship.
if [[ ! "${ANTHROPIC_API_KEY}" =~ ^[A-Za-z0-9_-]+$ ]]; then
  die "ANTHROPIC_API_KEY contains unexpected characters — refusing to embed in JSON without escaping"
fi
say "Setting ANTHROPIC_API_KEY secret"
SECRET_BODY=$(printf '{"name":"ANTHROPIC_API_KEY","text":"%s","type":"secret_text"}' "${ANTHROPIC_API_KEY}")
SECRET_RESP=$(curl -s -X PUT "${AUTH[@]}" \
  -H "Content-Type: application/json" \
  "${API}/accounts/${CLOUDFLARE_ACCOUNT_ID}/workers/scripts/${WORKER_NAME}/secrets" \
  --data "${SECRET_BODY}")
echo "${SECRET_RESP}" | grep -qE '"success":\s*true' || {
  echo "${SECRET_RESP}" >&2
  die "Failed to set secret"
}
ok "Secret set"

# ─── 5. BIND CUSTOM DOMAIN ───────────────────────────────────────────
say "Binding custom domain ${HOSTNAME} (creates DNS + route)"
DOMAIN_BODY=$(cat <<EOF
{
  "zone_id": "${ZONE_ID}",
  "hostname": "${HOSTNAME}",
  "service": "${WORKER_NAME}",
  "environment": "production"
}
EOF
)
DOMAIN_RESP=$(curl -s -X PUT "${AUTH[@]}" \
  -H "Content-Type: application/json" \
  "${API}/accounts/${CLOUDFLARE_ACCOUNT_ID}/workers/domains" \
  --data "${DOMAIN_BODY}")
if echo "${DOMAIN_RESP}" | grep -qE '"success":\s*true'; then
  ok "Custom domain bound"
elif echo "${DOMAIN_RESP}" | grep -q 'already exists'; then
  ok "Custom domain already bound"
else
  echo "${DOMAIN_RESP}" >&2
  die "Custom domain binding failed"
fi

# ─── 6. PURGE EDGE CACHE ─────────────────────────────────────────────
say "Purging zone cache"
PURGE_RESP=$(curl -s -X POST "${AUTH[@]}" \
  -H "Content-Type: application/json" \
  "${API}/zones/${ZONE_ID}/purge_cache" \
  --data '{"purge_everything":true}')
if echo "${PURGE_RESP}" | grep -qE '"success":\s*true'; then
  ok "Cache purged"
else
  echo "${PURGE_RESP}" >&2
  echo "(non-fatal — new deploys may take up to a minute to propagate)" >&2
fi

echo ""
ok "Geolyssa deployed → https://${HOSTNAME}"
