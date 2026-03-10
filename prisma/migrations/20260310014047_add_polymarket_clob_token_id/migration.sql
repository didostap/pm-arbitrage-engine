-- AlterTable
ALTER TABLE "contract_matches" ADD COLUMN     "polymarket_clob_token_id" TEXT;

-- CreateIndex
CREATE INDEX "contract_matches_polymarket_clob_token_id_idx" ON "contract_matches"("polymarket_clob_token_id");
