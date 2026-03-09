-- CreateIndex: functional btree index on audit_logs for pairId lookups from JSONB details column.
-- Prisma 6 does not support functional JSONB indexes in schema.prisma — raw SQL is the correct approach.
CREATE INDEX "idx_audit_logs_pair_id" ON "audit_logs" USING btree ((details->>'pairId'));
