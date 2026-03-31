-- CreateIndex
CREATE INDEX "historical_depths_contract_id_source_timestamp_idx" ON "historical_depths"("contract_id", "source", "timestamp");
