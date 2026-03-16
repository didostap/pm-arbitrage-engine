-- AlterTable
ALTER TABLE "contract_matches" ADD COLUMN     "kalshi_outcome_label" TEXT,
ADD COLUMN     "polymarket_outcome_label" TEXT;

-- AlterTable
ALTER TABLE "risk_states" ALTER COLUMN "mode" SET DATA TYPE TEXT;
