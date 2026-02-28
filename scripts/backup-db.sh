#!/usr/bin/env bash
# PM Arbitrage Engine — PostgreSQL backup script
# Runs hourly via cron. Compresses with gzip, 7-day rolling retention, 10GB size cap.
# Logs to syslog via logger -t pm-arbitrage-backup.

set -euo pipefail

CONTAINER_NAME="pm-arbitrage-postgres-dev"
BACKUP_DIR="/var/backups/pm-arbitrage"
LOCK_FILE="/var/lock/pm-arbitrage-backup.lock"
MAX_AGE_DAYS=7
MAX_DIR_BYTES=$((10 * 1024 * 1024 * 1024))  # 10GB
MIN_DISK_KB=1048576  # 1GB

log_info() { echo "$(date -Iseconds) INFO: $*" | logger -t pm-arbitrage-backup; }
log_warn() { echo "$(date -Iseconds) WARNING: $*" | logger -t pm-arbitrage-backup; }
log_error() { echo "$(date -Iseconds) ERROR: $*" | logger -t pm-arbitrage-backup; }

# Acquire lock to prevent concurrent runs
if ! (set -o noclobber; echo $$ > "${LOCK_FILE}") 2>/dev/null; then
  log_error "Backup already running (PID: $(cat "${LOCK_FILE}" 2>/dev/null || echo unknown))"
  exit 1
fi
trap 'rm -f "${LOCK_FILE}"' EXIT

# Pre-flight: verify Docker container is running
if ! docker ps --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
  log_error "PostgreSQL container '${CONTAINER_NAME}' not running"
  exit 1
fi

# Ensure backup directory exists
mkdir -p "${BACKUP_DIR}"

# Disk space check
AVAIL_KB=$(df "${BACKUP_DIR}" | awk 'NR==2 {print $4}')
if [ "$AVAIL_KB" -lt "$MIN_DISK_KB" ]; then
  log_warn "Low disk space (${AVAIL_KB}KB available in ${BACKUP_DIR})"
fi

# Perform backup (atomic write: dump to .tmp, then move)
TIMESTAMP=$(date +%Y-%m-%d-%H)
BACKUP_FILE="${BACKUP_DIR}/pmarbitrage-${TIMESTAMP}.sql.gz"
TEMP_FILE="${BACKUP_FILE}.tmp"

if docker exec "${CONTAINER_NAME}" pg_dump -U postgres pmarbitrage | gzip > "${TEMP_FILE}"; then
  # Verify gzip integrity
  if ! gzip -t "${TEMP_FILE}" 2>/dev/null; then
    log_error "Backup file corrupted (gzip integrity check failed)"
    rm -f "${TEMP_FILE}"
    exit 1
  fi
  mv "${TEMP_FILE}" "${BACKUP_FILE}"
  BACKUP_SIZE=$(stat -c %s "${BACKUP_FILE}" 2>/dev/null || stat -f %z "${BACKUP_FILE}" 2>/dev/null)
  log_info "Backup completed: ${BACKUP_FILE} (${BACKUP_SIZE} bytes)"
else
  log_error "pg_dump failed"
  rm -f "${TEMP_FILE}"
  exit 1
fi

# Verify backup is non-empty
BACKUP_SIZE=$(stat -c %s "${BACKUP_FILE}" 2>/dev/null || stat -f %z "${BACKUP_FILE}" 2>/dev/null)
if [ "$BACKUP_SIZE" -lt 100 ]; then
  log_error "Backup file suspiciously small (${BACKUP_SIZE} bytes), possible failure"
  rm -f "${BACKUP_FILE}"
  exit 1
fi

# Retention: delete backups older than 7 days
DELETED_COUNT=$(find "${BACKUP_DIR}" -name '*.sql.gz' -mtime +${MAX_AGE_DAYS} -delete -print | wc -l)
if [ "$DELETED_COUNT" -gt 0 ]; then
  log_info "Deleted ${DELETED_COUNT} backup(s) older than ${MAX_AGE_DAYS} days"
fi

# Size cap: if total exceeds 10GB, delete oldest beyond 7 most recent
# NOTE: du -sb is GNU-only (Linux/VPS). Will error on macOS — this script targets Ubuntu.
TOTAL_BYTES=$(du -sb "${BACKUP_DIR}" | cut -f1)
if [ "$TOTAL_BYTES" -gt "$MAX_DIR_BYTES" ]; then
  log_warn "Backup directory exceeds 10GB (${TOTAL_BYTES} bytes), removing oldest files"
  # Keep 7 most recent, delete the rest
  ls -t "${BACKUP_DIR}"/*.sql.gz 2>/dev/null | tail -n +8 | while read -r old_file; do
    rm -f "$old_file"
    log_info "Deleted oversized retention: $old_file"
  done
fi

log_info "Backup cycle complete"
exit 0
