-- CreateTable
CREATE TABLE "risk_states" (
    "id" TEXT NOT NULL,
    "singleton_key" TEXT NOT NULL DEFAULT 'default',
    "daily_pnl" DECIMAL(20,8) NOT NULL DEFAULT 0,
    "open_position_count" INTEGER NOT NULL DEFAULT 0,
    "last_reset_timestamp" TIMESTAMPTZ,
    "total_capital_deployed" DECIMAL(20,8) NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "risk_states_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "risk_states_singleton_key_key" ON "risk_states"("singleton_key");
