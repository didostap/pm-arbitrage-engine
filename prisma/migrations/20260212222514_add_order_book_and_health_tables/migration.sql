-- CreateTable
CREATE TABLE "order_book_snapshots" (
    "id" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "contract_id" TEXT NOT NULL,
    "bids" JSONB NOT NULL,
    "asks" JSONB NOT NULL,
    "sequence_number" INTEGER,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_book_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_health_logs" (
    "id" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "last_update" TIMESTAMPTZ NOT NULL,
    "response_time_ms" DOUBLE PRECISION,
    "connection_state" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_health_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "order_book_snapshots_platform_contract_id_created_at_idx" ON "order_book_snapshots"("platform", "contract_id", "created_at");

-- CreateIndex
CREATE INDEX "order_book_snapshots_created_at_idx" ON "order_book_snapshots"("created_at");

-- CreateIndex
CREATE INDEX "platform_health_logs_platform_created_at_idx" ON "platform_health_logs"("platform", "created_at");

-- CreateIndex
CREATE INDEX "platform_health_logs_created_at_idx" ON "platform_health_logs"("created_at");
