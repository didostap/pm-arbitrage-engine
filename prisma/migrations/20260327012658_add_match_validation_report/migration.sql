-- CreateTable
CREATE TABLE "match_validation_reports" (
    "id" SERIAL NOT NULL,
    "correlation_id" TEXT NOT NULL,
    "run_timestamp" TIMESTAMPTZ NOT NULL,
    "total_our_matches" INTEGER NOT NULL,
    "total_oddspipe_pairs" INTEGER NOT NULL,
    "total_predexon_pairs" INTEGER NOT NULL,
    "confirmed_count" INTEGER NOT NULL,
    "our_only_count" INTEGER NOT NULL,
    "external_only_count" INTEGER NOT NULL,
    "conflict_count" INTEGER NOT NULL,
    "report_data" JSONB NOT NULL,
    "duration_ms" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "match_validation_reports_pkey" PRIMARY KEY ("id")
);
