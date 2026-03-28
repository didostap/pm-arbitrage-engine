-- AlterTable
ALTER TABLE "engine_config" ADD COLUMN     "incremental_ingestion_cron_expression" TEXT,
ADD COLUMN     "incremental_ingestion_enabled" BOOLEAN,
ADD COLUMN     "staleness_threshold_oddspipe_ms" INTEGER,
ADD COLUMN     "staleness_threshold_platform_ms" INTEGER,
ADD COLUMN     "staleness_threshold_pmxt_ms" INTEGER,
ADD COLUMN     "staleness_threshold_validation_ms" INTEGER;

-- CreateTable
CREATE TABLE "data_source_freshness" (
    "id" SERIAL NOT NULL,
    "source" "HistoricalDataSource" NOT NULL,
    "last_successful_at" TIMESTAMPTZ,
    "last_attempt_at" TIMESTAMPTZ,
    "records_fetched" INTEGER NOT NULL DEFAULT 0,
    "contracts_updated" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'idle',
    "error_message" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "data_source_freshness_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "data_source_freshness_source_key" ON "data_source_freshness"("source");
