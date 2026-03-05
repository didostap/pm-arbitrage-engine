-- AlterTable
ALTER TABLE "open_positions" ADD COLUMN     "entry_close_price_kalshi" DECIMAL(20,8),
ADD COLUMN     "entry_close_price_polymarket" DECIMAL(20,8),
ADD COLUMN     "entry_kalshi_fee_rate" DECIMAL(20,8),
ADD COLUMN     "entry_polymarket_fee_rate" DECIMAL(20,8);
