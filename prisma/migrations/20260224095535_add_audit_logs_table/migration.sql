-- CreateTable
CREATE TABLE "audit_logs" (
    "id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "event_type" TEXT NOT NULL,
    "module" TEXT NOT NULL,
    "correlation_id" TEXT,
    "details" JSONB NOT NULL,
    "previous_hash" VARCHAR(64) NOT NULL,
    "current_hash" VARCHAR(64) NOT NULL,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "idx_audit_logs_created_at" ON "audit_logs"("created_at");

-- CreateIndex
CREATE INDEX "idx_audit_logs_event_type" ON "audit_logs"("event_type");

-- CreateIndex
CREATE INDEX "idx_audit_logs_correlation_id" ON "audit_logs"("correlation_id");
