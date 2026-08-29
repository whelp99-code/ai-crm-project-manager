#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/common.sh"

BACKUP_DIR="$DEPLOY_DIR/backups"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
DUMP="$BACKUP_DIR/ai-crm-pm-$STAMP.dump"
MANIFEST="$BACKUP_DIR/ai-crm-pm-$STAMP.json"
mkdir -p "$BACKUP_DIR"
umask 077

echo "Creating PostgreSQL backup: $DUMP"
# Keep ACLs so runtime roles retain the exact least-privilege table grants after
# a disaster restore. Object ownership stays portable via --no-owner.
dc exec -T postgres pg_dump \
  --username "$POSTGRES_USER" \
  --dbname "$POSTGRES_DB" \
  --format custom \
  --no-owner > "$DUMP"

checksum="$(sha256sum "$DUMP" | awk '{print $1}')"
source_commit="$(git -C "$ROOT_DIR" rev-parse HEAD 2>/dev/null || echo unknown)"
cat > "$MANIFEST" <<EOF
{
  "createdAt": "$STAMP",
  "project": "AI-CRM+PM",
  "version": "2.5.0",
  "sourceCommit": "$source_commit",
  "database": "$POSTGRES_DB",
  "dump": "$(basename "$DUMP")",
  "sha256": "$checksum",
  "aclIncluded": true,
  "ownerIncluded": false
}
EOF
chmod 600 "$DUMP" "$MANIFEST"

echo "$checksum  $(basename "$DUMP")" > "$DUMP.sha256"
chmod 600 "$DUMP.sha256"
echo "Backup completed: $DUMP"
