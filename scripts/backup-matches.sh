#!/usr/bin/env bash
# PM Arbitrage Engine — Contract matching data dump & restore
#
# Focused backup of the 3 tables that form the contract matching mechanism:
#   - correlation_clusters   (14 rows — risk grouping)
#   - cluster_tag_mappings   (54 rows — category → cluster mapping)
#   - contract_matches       (25K+ rows — curated cross-platform pairs)
#
# Usage:
#   ./scripts/backup-matches.sh dump  [output-file]    # Create a new dump
#   ./scripts/backup-matches.sh restore <input-file>    # Restore from dump
#   ./scripts/backup-matches.sh list                    # List available dumps
#
# Requires: Docker container running, Prisma migrations applied.
# Data-only dump — schema managed by Prisma.

set -euo pipefail

CONTAINER_NAME="${PM_PG_CONTAINER:-pm-arbitrage-postgres}"
DB_NAME="pmarbitrage"
DB_USER="postgres"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BACKUP_DIR="${SCRIPT_DIR}/../backups/matches"
TABLES=("correlation_clusters" "cluster_tag_mappings" "contract_matches")

# --- Helpers ---

preflight() {
  if ! docker ps --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
    echo "ERROR: PostgreSQL container '${CONTAINER_NAME}' not running"
    echo "Start it with: docker-compose -f docker-compose.dev.yml up -d"
    exit 1
  fi
}

row_counts() {
  for t in "${TABLES[@]}"; do
    COUNT=$(docker exec "${CONTAINER_NAME}" psql -U "${DB_USER}" "${DB_NAME}" -t -A -c "SELECT COUNT(*) FROM ${t};")
    printf "  %-25s %s rows\n" "$t" "$COUNT"
  done
}

# --- Commands ---

cmd_dump() {
  preflight
  mkdir -p "${BACKUP_DIR}"

  TIMESTAMP=$(date +%Y%m%d-%H%M%S)
  OUTPUT="${1:-${BACKUP_DIR}/matches-${TIMESTAMP}.sql.gz}"

  echo "Dumping ${#TABLES[@]} tables..."
  row_counts

  TABLE_FLAGS=""
  for t in "${TABLES[@]}"; do
    TABLE_FLAGS+=" --table=${t}"
  done

  # Data-only dump: schema is managed by Prisma migrations.
  # --no-owner --no-privileges: portable across environments.
  # COPY format (default) is fast and handles FK ordering automatically.
  docker exec "${CONTAINER_NAME}" pg_dump -U "${DB_USER}" "${DB_NAME}" \
    --data-only --no-owner --no-privileges ${TABLE_FLAGS} \
    | gzip > "${OUTPUT}"

  SIZE=$(stat -f %z "${OUTPUT}" 2>/dev/null || stat -c %s "${OUTPUT}" 2>/dev/null)
  echo ""
  echo "Dump complete: ${OUTPUT} ($(( SIZE / 1024 )) KB)"

  # Maintain a "latest" symlink for convenience
  ln -sf "$(basename "${OUTPUT}")" "${BACKUP_DIR}/latest.sql.gz"
}

cmd_restore() {
  local INPUT="${1:?Usage: $0 restore <file.sql.gz>}"
  [[ -f "${INPUT}" ]] || { echo "ERROR: File not found: ${INPUT}"; exit 1; }
  preflight

  echo "Source: ${INPUT}"
  echo ""
  echo "This will TRUNCATE and replace all data in:"
  echo "  - correlation_clusters"
  echo "  - cluster_tag_mappings"
  echo "  - contract_matches"
  echo ""
  echo "Dependent tables (orders, open_positions) will also be cleared (CASCADE)."
  echo ""
  read -p "Continue? [y/N] " -n 1 -r
  echo
  [[ ${REPLY} =~ ^[Yy]$ ]] || { echo "Aborted."; exit 1; }

  echo "Truncating tables..."
  docker exec "${CONTAINER_NAME}" psql -U "${DB_USER}" "${DB_NAME}" -c \
    "TRUNCATE TABLE contract_matches, cluster_tag_mappings, correlation_clusters CASCADE;"

  echo "Restoring data..."
  gunzip -c "${INPUT}" | docker exec -i "${CONTAINER_NAME}" psql -U "${DB_USER}" "${DB_NAME}" > /dev/null

  echo ""
  echo "Restored row counts:"
  row_counts
  echo ""
  echo "Restore complete."
}

cmd_list() {
  if [[ ! -d "${BACKUP_DIR}" ]]; then
    echo "No backups found. Run '$0 dump' to create one."
    exit 0
  fi

  echo "Available dumps in ${BACKUP_DIR}:"
  echo ""

  # shellcheck disable=SC2012
  ls -lh "${BACKUP_DIR}"/matches-*.sql.gz 2>/dev/null | awk '{print "  " $NF " (" $5 ")"}'

  LATEST=$(readlink "${BACKUP_DIR}/latest.sql.gz" 2>/dev/null || echo "none")
  echo ""
  echo "Latest: ${LATEST}"
}

# --- Entry point ---

case "${1:-}" in
  dump)    cmd_dump "${2:-}" ;;
  restore) cmd_restore "${2:-}" ;;
  list)    cmd_list ;;
  *)
    echo "Usage: $0 {dump|restore|list} [file]"
    echo ""
    echo "Commands:"
    echo "  dump [output]     Create a new dump (default: backups/matches/matches-<timestamp>.sql.gz)"
    echo "  restore <file>    Restore from a dump file (TRUNCATES existing data)"
    echo "  list              List available dump files"
    exit 1
    ;;
esac
