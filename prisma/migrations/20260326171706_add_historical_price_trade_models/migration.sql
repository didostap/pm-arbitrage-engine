-- CreateEnum
CREATE TYPE "HistoricalDataSource" AS ENUM ('KALSHI_API', 'POLYMARKET_API', 'GOLDSKY', 'POLY_DATA', 'PMXT_ARCHIVE', 'ODDSPIPE', 'PREDEXON');

-- CreateTable
CREATE TABLE "historical_prices" (
    "id" SERIAL NOT NULL,
    "platform" "Platform" NOT NULL,
    "contract_id" TEXT NOT NULL,
    "source" "HistoricalDataSource" NOT NULL,
    "interval_minutes" INTEGER NOT NULL,
    "timestamp" TIMESTAMPTZ NOT NULL,
    "open" DECIMAL(20,10) NOT NULL,
    "high" DECIMAL(20,10) NOT NULL,
    "low" DECIMAL(20,10) NOT NULL,
    "close" DECIMAL(20,10) NOT NULL,
    "volume" DECIMAL(20,6),
    "open_interest" DECIMAL(20,6),
    "ingestion_ts" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "quality_flags" JSONB,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "historical_prices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "historical_trades" (
    "id" SERIAL NOT NULL,
    "platform" "Platform" NOT NULL,
    "contract_id" TEXT NOT NULL,
    "source" "HistoricalDataSource" NOT NULL,
    "external_trade_id" TEXT,
    "price" DECIMAL(20,10) NOT NULL,
    "size" DECIMAL(20,6) NOT NULL,
    "side" TEXT NOT NULL,
    "timestamp" TIMESTAMPTZ NOT NULL,
    "ingestion_ts" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "quality_flags" JSONB,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "historical_trades_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "historical_prices_platform_contract_id_timestamp_idx" ON "historical_prices"("platform", "contract_id", "timestamp");

-- CreateIndex
CREATE INDEX "historical_prices_source_timestamp_idx" ON "historical_prices"("source", "timestamp");

-- CreateIndex
CREATE INDEX "historical_prices_timestamp_idx" ON "historical_prices"("timestamp");

-- CreateIndex
CREATE UNIQUE INDEX "historical_prices_platform_contract_id_source_interval_minu_key" ON "historical_prices"("platform", "contract_id", "source", "interval_minutes", "timestamp");

-- CreateIndex
CREATE INDEX "historical_trades_platform_contract_id_timestamp_idx" ON "historical_trades"("platform", "contract_id", "timestamp");

-- CreateIndex
CREATE INDEX "historical_trades_source_timestamp_idx" ON "historical_trades"("source", "timestamp");

-- CreateIndex
CREATE INDEX "historical_trades_timestamp_idx" ON "historical_trades"("timestamp");

-- CreateIndex
CREATE UNIQUE INDEX "historical_trades_platform_contract_id_source_external_trad_key" ON "historical_trades"("platform", "contract_id", "source", "external_trade_id");
