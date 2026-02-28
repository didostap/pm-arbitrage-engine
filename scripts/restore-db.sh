#!/usr/bin/env bash
# PM Arbitrage Engine — PostgreSQL backup restore & verification script
# Restores a backup to a temporary database, verifies row counts, then cleans up.
# Usage: ./restore-db.sh <backup-file.sql.gz>

set -euo pipefail

CONTAINER_NAME="pm-arbitrage-postgres-dev"
TEMP_DB="pmarbitrage_verify"

# --- Cleanup trap: always drop temp database on exit ---
cleanup() {
  echo "Cleaning up temporary database '${TEMP_DB}'..."
  docker exec "${CONTAINER_NAME}" psql -U postgres -c "DROP DATABASE IF EXISTS ${TEMP_DB};" 2>/dev/null || true
}
trap cleanup EXIT

# --- Argument validation ---
if [ -z "${1:-}" ] || [ ! -f "${1}" ]; then
  echo "Usage: restore-db.sh <backup-file.sql.gz>"
  echo "Error: Backup file not found: ${1:-<not provided>}"
  exit 1
fi

BACKUP_FILE="$1"
echo "Restore verification for: ${BACKUP_FILE}"

# --- Pre-flight: verify Docker container is running ---
if ! docker ps --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
  echo "ERROR: PostgreSQL container '${CONTAINER_NAME}' not running"
  exit 1
fi

# --- Pre-flight: verify DB connectivity ---
if ! docker exec "${CONTAINER_NAME}" psql -U postgres -c "SELECT 1;" > /dev/null 2>&1; then
  echo "ERROR: Cannot connect to PostgreSQL"
  exit 1
fi

# --- Create temporary database ---
echo "Creating temporary database '${TEMP_DB}'..."
docker exec "${CONTAINER_NAME}" psql -U postgres -c "DROP DATABASE IF EXISTS ${TEMP_DB};"
docker exec "${CONTAINER_NAME}" psql -U postgres -c "CREATE DATABASE ${TEMP_DB};"

# --- Restore backup ---
echo "Restoring backup to '${TEMP_DB}'..."
if ! gunzip -c "${BACKUP_FILE}" | docker exec -i "${CONTAINER_NAME}" psql -U postgres "${TEMP_DB}" > /dev/null 2>&1; then
  echo "ERROR: Restore failed"
  exit 1
fi

echo "Restore completed. Verifying row counts..."

# --- Row count verification ---
TABLES=("orders" "open_positions" "contract_matches" "audit_logs" "risk_states" "order_book_snapshots" "platform_health_logs" "system_metadata")
PASS=true

echo ""
echo "Table                    | Rows"
echo "-------------------------|------"

for table in "${TABLES[@]}"; do
  COUNT=$(docker exec "${CONTAINER_NAME}" psql -U postgres -d "${TEMP_DB}" -t -A -c "SELECT COUNT(*) FROM ${table};" 2>/dev/null || echo "MISSING")
  if [ "$COUNT" = "MISSING" ]; then
    printf "%-25s| %s\n" "$table" "TABLE MISSING"
    PASS=false
  else
    printf "%-25s| %s\n" "$table" "$COUNT"
  fi
done

echo ""

# --- Report result ---
if [ "$PASS" = true ]; then
  echo "RESULT: PASS — All tables present in backup"
else
  echo "RESULT: FAIL — One or more tables missing from backup"
  exit 1
fi

echo "Verification complete. Temporary database will be dropped by cleanup handler."
exit 0
