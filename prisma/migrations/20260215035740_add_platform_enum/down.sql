-- Rollback: 20260215035740_add_platform_enum
-- Reverts Platform enum columns back to TEXT columns in order_book_snapshots and platform_health_logs.

-- Drop indexes that reference the enum-typed columns
DROP INDEX IF EXISTS "order_book_snapshots_platform_contract_id_created_at_idx";
DROP INDEX IF EXISTS "platform_health_logs_platform_created_at_idx";

-- order_book_snapshots: Revert enum column back to TEXT
ALTER TABLE "order_book_snapshots" ADD COLUMN "platform_old" TEXT;
UPDATE "order_book_snapshots" SET "platform_old" = "platform"::TEXT;
ALTER TABLE "order_book_snapshots" ALTER COLUMN "platform_old" SET NOT NULL;
ALTER TABLE "order_book_snapshots" DROP COLUMN "platform";
ALTER TABLE "order_book_snapshots" RENAME COLUMN "platform_old" TO "platform";

-- platform_health_logs: Revert enum column back to TEXT
ALTER TABLE "platform_health_logs" ADD COLUMN "platform_old" TEXT;
UPDATE "platform_health_logs" SET "platform_old" = "platform"::TEXT;
ALTER TABLE "platform_health_logs" ALTER COLUMN "platform_old" SET NOT NULL;
ALTER TABLE "platform_health_logs" DROP COLUMN "platform";
ALTER TABLE "platform_health_logs" RENAME COLUMN "platform_old" TO "platform";

-- Recreate original TEXT-based indexes
CREATE INDEX "order_book_snapshots_platform_contract_id_created_at_idx" ON "order_book_snapshots"("platform", "contract_id", "created_at");
CREATE INDEX "platform_health_logs_platform_created_at_idx" ON "platform_health_logs"("platform", "created_at");

-- Drop the Platform enum type
DROP TYPE IF EXISTS "Platform";
