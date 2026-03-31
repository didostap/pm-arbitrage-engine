-- CreateTable
CREATE TABLE "ingestion_quality_reports" (
    "id" SERIAL NOT NULL,
    "match_id" TEXT NOT NULL,
    "contract_id" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "assessment_type" TEXT NOT NULL,
    "date_range_start" TIMESTAMPTZ NOT NULL,
    "date_range_end" TIMESTAMPTZ NOT NULL,
    "quality_flags" JSONB NOT NULL,
    "correlation_id" TEXT,
    "records_assessed" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ingestion_quality_reports_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ingestion_quality_reports_match_id_assessment_type_idx" ON "ingestion_quality_reports"("match_id", "assessment_type");

-- CreateIndex
CREATE INDEX "ingestion_quality_reports_contract_id_source_idx" ON "ingestion_quality_reports"("contract_id", "source");

-- CreateIndex
CREATE INDEX "ingestion_quality_reports_created_at_idx" ON "ingestion_quality_reports"("created_at");
