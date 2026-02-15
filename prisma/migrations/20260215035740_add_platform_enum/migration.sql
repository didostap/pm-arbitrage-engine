-- CreateEnum
CREATE TYPE "Platform" AS ENUM ('KALSHI', 'POLYMARKET');

-- AlterTable order_book_snapshots: Safe migration from String to Enum
-- Step 1: Add temporary column with enum type
ALTER TABLE "order_book_snapshots" ADD COLUMN "platform_new" "Platform";

-- Step 2: Migrate existing data (convert lowercase strings to uppercase enum values)
UPDATE "order_book_snapshots" SET "platform_new" =
  CASE
    WHEN LOWER("platform") = 'kalshi' THEN 'KALSHI'::"Platform"
    WHEN LOWER("platform") = 'polymarket' THEN 'POLYMARKET'::"Platform"
    ELSE 'KALSHI'::"Platform" -- Default fallback
  END;

-- Step 3: Make the new column NOT NULL (all rows should have values now)
ALTER TABLE "order_book_snapshots" ALTER COLUMN "platform_new" SET NOT NULL;

-- Step 4: Drop old column and rename new column
ALTER TABLE "order_book_snapshots" DROP COLUMN "platform";
ALTER TABLE "order_book_snapshots" RENAME COLUMN "platform_new" TO "platform";

-- AlterTable platform_health_logs: Safe migration from String to Enum
-- Step 1: Add temporary column with enum type
ALTER TABLE "platform_health_logs" ADD COLUMN "platform_new" "Platform";

-- Step 2: Migrate existing data (convert lowercase strings to uppercase enum values)
UPDATE "platform_health_logs" SET "platform_new" =
  CASE
    WHEN LOWER("platform") = 'kalshi' THEN 'KALSHI'::"Platform"
    WHEN LOWER("platform") = 'polymarket' THEN 'POLYMARKET'::"Platform"
    ELSE 'KALSHI'::"Platform" -- Default fallback
  END;

-- Step 3: Make the new column NOT NULL (all rows should have values now)
ALTER TABLE "platform_health_logs" ALTER COLUMN "platform_new" SET NOT NULL;

-- Step 4: Drop old column and rename new column
ALTER TABLE "platform_health_logs" DROP COLUMN "platform";
ALTER TABLE "platform_health_logs" RENAME COLUMN "platform_new" TO "platform";

-- CreateIndex (recreate indexes after column changes)
CREATE INDEX "order_book_snapshots_platform_contract_id_created_at_idx" ON "order_book_snapshots"("platform", "contract_id", "created_at");

-- CreateIndex
CREATE INDEX "platform_health_logs_platform_created_at_idx" ON "platform_health_logs"("platform", "created_at");
