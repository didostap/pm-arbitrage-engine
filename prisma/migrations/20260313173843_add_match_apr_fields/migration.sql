-- AlterTable
ALTER TABLE "contract_matches" ADD COLUMN     "last_annualized_return" DECIMAL(20,8),
ADD COLUMN     "last_computed_at" TIMESTAMPTZ,
ADD COLUMN     "last_net_edge" DECIMAL(20,8);

-- CreateIndex
CREATE INDEX "contract_matches_last_annualized_return_idx" ON "contract_matches"("last_annualized_return");

-- CreateIndex
CREATE INDEX "contract_matches_last_net_edge_idx" ON "contract_matches"("last_net_edge");

-- CreateIndex
CREATE INDEX "contract_matches_last_computed_at_idx" ON "contract_matches"("last_computed_at");
