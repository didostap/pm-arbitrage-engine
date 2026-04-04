-- Story 10-95-2: Hypertable conversion for historical_depths (151 GB, 106M rows)
-- PREREQUISITE: Full pg_dump backup MUST be taken before running this migration.
-- Hypertable conversion is NOT reversible via standard migration rollback.

-- 1. Disable statement timeout for large data migration
-- Deferred finding from 10-95-1 code review: transaction timeout risk
SET LOCAL statement_timeout = 0;
SET LOCAL lock_timeout = 0;

-- 2. Drop bloated index before PK change (AC #3)
DROP INDEX IF EXISTS "historical_depths_timestamp_idx";

-- 3. Alter PK to composite: @id(id) → @@id([id, timestamp])
ALTER TABLE "historical_depths" DROP CONSTRAINT "historical_depths_pkey",
ADD CONSTRAINT "historical_depths_pkey" PRIMARY KEY ("id", "timestamp");

-- 4. Convert to hypertable (requires PK to include partitioning column)
-- create_default_indexes => FALSE: prevents TimescaleDB from recreating a
-- standalone timestamp DESC index — chunk pruning replaces it (AC #3).
SELECT create_hypertable('historical_depths', 'timestamp',
  migrate_data => true,
  chunk_time_interval => INTERVAL '1 day',
  if_not_exists => TRUE,
  create_default_indexes => FALSE
);
