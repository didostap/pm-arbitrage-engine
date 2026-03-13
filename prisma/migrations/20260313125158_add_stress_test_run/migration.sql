-- CreateTable
CREATE TABLE "stress_test_runs" (
    "id" TEXT NOT NULL,
    "timestamp" TIMESTAMPTZ NOT NULL,
    "num_scenarios" INTEGER NOT NULL,
    "num_positions" INTEGER NOT NULL,
    "bankroll_usd" DECIMAL(20,8) NOT NULL,
    "var95" DECIMAL(20,8) NOT NULL,
    "var99" DECIMAL(20,8) NOT NULL,
    "worst_case_loss" DECIMAL(20,8) NOT NULL,
    "drawdown_15pct_probability" DECIMAL(10,6) NOT NULL,
    "drawdown_20pct_probability" DECIMAL(10,6) NOT NULL,
    "drawdown_25pct_probability" DECIMAL(10,6) NOT NULL,
    "alert_emitted" BOOLEAN NOT NULL DEFAULT false,
    "suggestions" JSONB,
    "scenario_details" JSONB NOT NULL,
    "triggered_by" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stress_test_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "stress_test_runs_timestamp_idx" ON "stress_test_runs"("timestamp");
