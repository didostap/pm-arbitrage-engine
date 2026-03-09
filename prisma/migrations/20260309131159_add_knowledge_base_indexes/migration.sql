-- CreateIndex
CREATE INDEX "contract_matches_resolution_diverged_idx" ON "contract_matches"("resolution_diverged");

-- CreateIndex
CREATE INDEX "contract_matches_confidence_score_idx" ON "contract_matches"("confidence_score");
