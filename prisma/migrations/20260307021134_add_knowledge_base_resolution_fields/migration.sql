-- AlterTable
ALTER TABLE "contract_matches" ADD COLUMN "confidence_score" DOUBLE PRECISION,
ADD COLUMN "divergence_notes" TEXT,
ADD COLUMN "kalshi_resolution" TEXT,
ADD COLUMN "polymarket_resolution" TEXT,
ADD COLUMN "resolution_criteria_hash" TEXT,
ADD COLUMN "resolution_diverged" BOOLEAN,
ADD COLUMN "resolution_timestamp" TIMESTAMPTZ;
