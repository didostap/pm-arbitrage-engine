-- CreateTable
CREATE TABLE "calibration_runs" (
    "id" TEXT NOT NULL,
    "timestamp" TIMESTAMPTZ NOT NULL,
    "total_resolved_matches" INTEGER NOT NULL,
    "tiers" JSONB NOT NULL,
    "boundary_analysis" JSONB NOT NULL,
    "current_auto_approve_threshold" INTEGER NOT NULL,
    "current_min_review_threshold" INTEGER NOT NULL,
    "recommendations" JSONB NOT NULL,
    "minimum_data_met" BOOLEAN NOT NULL,
    "triggered_by" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "calibration_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "calibration_runs_timestamp_idx" ON "calibration_runs"("timestamp");
