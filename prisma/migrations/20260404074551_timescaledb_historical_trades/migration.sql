-- 1. Install TimescaleDB extension (must be first, before any hypertable operations)
CREATE EXTENSION IF NOT EXISTS timescaledb;

/*
  Warnings:

  - The primary key for the `historical_trades` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - A unique constraint covering the columns `[platform,contract_id,source,external_trade_id,timestamp]` on the table `historical_trades` will be added. If there are existing duplicate values, this will fail.

*/
-- 2. Prisma-generated SQL (PK change, unique constraint change)

-- DropIndex
DROP INDEX "historical_trades_platform_contract_id_source_external_trad_key";

-- AlterTable
ALTER TABLE "historical_trades" DROP CONSTRAINT "historical_trades_pkey",
ADD CONSTRAINT "historical_trades_pkey" PRIMARY KEY ("id", "timestamp");

-- CreateIndex
CREATE UNIQUE INDEX "historical_trades_platform_contract_id_source_external_trad_key" ON "historical_trades"("platform", "contract_id", "source", "external_trade_id", "timestamp");

-- 3. Convert to hypertable (AFTER PK/constraint changes — hypertable validates partitioning column in all unique/PK constraints)
SELECT create_hypertable('historical_trades', 'timestamp',
  migrate_data => true,
  chunk_time_interval => INTERVAL '1 day',
  if_not_exists => TRUE
);

-- 4. Drop unused indexes (0 scans each, saving ~808 MB)
DROP INDEX IF EXISTS "historical_trades_platform_contract_id_timestamp_idx";
DROP INDEX IF EXISTS "historical_trades_timestamp_idx";
