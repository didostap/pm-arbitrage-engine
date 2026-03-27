-- CreateEnum
CREATE TYPE "DataCatalogStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETE', 'FAILED');

-- CreateTable
CREATE TABLE "historical_depths" (
    "id" SERIAL NOT NULL,
    "platform" "Platform" NOT NULL,
    "contract_id" TEXT NOT NULL,
    "source" "HistoricalDataSource" NOT NULL,
    "bids" JSONB NOT NULL,
    "asks" JSONB NOT NULL,
    "timestamp" TIMESTAMPTZ NOT NULL,
    "update_type" TEXT,
    "ingestion_ts" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "quality_flags" JSONB,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "historical_depths_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "data_catalog" (
    "id" SERIAL NOT NULL,
    "source" "HistoricalDataSource" NOT NULL,
    "file_path" TEXT NOT NULL,
    "file_size" BIGINT,
    "time_range_start" TIMESTAMPTZ,
    "time_range_end" TIMESTAMPTZ,
    "record_count" INTEGER,
    "status" "DataCatalogStatus" NOT NULL DEFAULT 'PENDING',
    "checksum" TEXT,
    "metadata" JSONB,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "data_catalog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "historical_depths_platform_contract_id_timestamp_idx" ON "historical_depths"("platform", "contract_id", "timestamp");

-- CreateIndex
CREATE INDEX "historical_depths_source_timestamp_idx" ON "historical_depths"("source", "timestamp");

-- CreateIndex
CREATE INDEX "historical_depths_timestamp_idx" ON "historical_depths"("timestamp");

-- CreateIndex
CREATE UNIQUE INDEX "historical_depths_platform_contract_id_source_timestamp_key" ON "historical_depths"("platform", "contract_id", "source", "timestamp");

-- CreateIndex
CREATE UNIQUE INDEX "data_catalog_source_file_path_key" ON "data_catalog"("source", "file_path");
