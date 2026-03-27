-- CreateEnum
CREATE TYPE "BacktestStatus" AS ENUM ('IDLE', 'CONFIGURING', 'LOADING_DATA', 'SIMULATING', 'GENERATING_REPORT', 'COMPLETE', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "BacktestExitReason" AS ENUM ('EDGE_EVAPORATION', 'TIME_DECAY', 'PROFIT_CAPTURE', 'RESOLUTION_FORCE_CLOSE', 'INSUFFICIENT_DEPTH', 'SIMULATION_END');

-- CreateTable
CREATE TABLE "backtest_runs" (
    "id" TEXT NOT NULL,
    "status" "BacktestStatus" NOT NULL DEFAULT 'IDLE',
    "config" JSONB NOT NULL,
    "date_range_start" TIMESTAMPTZ NOT NULL,
    "date_range_end" TIMESTAMPTZ NOT NULL,
    "started_at" TIMESTAMPTZ NOT NULL,
    "completed_at" TIMESTAMPTZ,
    "total_positions" INTEGER,
    "win_count" INTEGER,
    "loss_count" INTEGER,
    "total_pnl" DECIMAL(20,10),
    "max_drawdown" DECIMAL(20,10),
    "sharpe_ratio" DECIMAL(20,10),
    "profit_factor" DECIMAL(20,10),
    "avg_holding_hours" DECIMAL(20,6),
    "capital_utilization" DECIMAL(20,10),
    "error_message" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "backtest_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "backtest_positions" (
    "id" SERIAL NOT NULL,
    "run_id" TEXT NOT NULL,
    "pair_id" TEXT NOT NULL,
    "kalshi_contract_id" TEXT NOT NULL,
    "polymarket_contract_id" TEXT NOT NULL,
    "kalshi_side" TEXT NOT NULL,
    "polymarket_side" TEXT NOT NULL,
    "entry_timestamp" TIMESTAMPTZ NOT NULL,
    "exit_timestamp" TIMESTAMPTZ,
    "kalshi_entry_price" DECIMAL(20,10) NOT NULL,
    "polymarket_entry_price" DECIMAL(20,10) NOT NULL,
    "kalshi_exit_price" DECIMAL(20,10),
    "polymarket_exit_price" DECIMAL(20,10),
    "position_size_usd" DECIMAL(20,6) NOT NULL,
    "entry_edge" DECIMAL(20,10) NOT NULL,
    "exit_edge" DECIMAL(20,10),
    "realized_pnl" DECIMAL(20,10),
    "fees" DECIMAL(20,6),
    "exit_reason" "BacktestExitReason",
    "holding_hours" DECIMAL(20,6),
    "quality_flags" JSONB,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "backtest_positions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "backtest_runs_status_idx" ON "backtest_runs"("status");

-- CreateIndex
CREATE INDEX "backtest_runs_started_at_idx" ON "backtest_runs"("started_at");

-- CreateIndex
CREATE INDEX "backtest_positions_run_id_idx" ON "backtest_positions"("run_id");

-- CreateIndex
CREATE INDEX "backtest_positions_exit_reason_idx" ON "backtest_positions"("exit_reason");

-- AddForeignKey
ALTER TABLE "backtest_positions" ADD CONSTRAINT "backtest_positions_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "backtest_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
