-- CreateIndex
-- Covers freshness groupBy (contract_id, source) and cross-source deviation (contract_id, source, timestamp) queries.
-- On 245M-row table: reduces groupBy from ~98s full-table-scan to <10ms index lookup.
-- For production: run with CONCURRENTLY outside of Prisma migrate to avoid table locks.
CREATE INDEX "historical_prices_contract_id_source_timestamp_idx" ON "historical_prices"("contract_id", "source", "timestamp");
