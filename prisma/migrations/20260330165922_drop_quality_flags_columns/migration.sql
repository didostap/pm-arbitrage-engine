/*
  Warnings:

  - You are about to drop the column `quality_flags` on the `backtest_positions` table. All the data in the column will be lost.
  - You are about to drop the column `quality_flags` on the `historical_depths` table. All the data in the column will be lost.
  - You are about to drop the column `quality_flags` on the `historical_prices` table. All the data in the column will be lost.
  - You are about to drop the column `quality_flags` on the `historical_trades` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "backtest_positions" DROP COLUMN "quality_flags";

-- AlterTable
ALTER TABLE "historical_depths" DROP COLUMN "quality_flags";

-- AlterTable
ALTER TABLE "historical_prices" DROP COLUMN "quality_flags";

-- AlterTable
ALTER TABLE "historical_trades" DROP COLUMN "quality_flags";
