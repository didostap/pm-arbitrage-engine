-- AlterTable
ALTER TABLE "backtest_runs" ADD COLUMN     "report" JSONB,
ADD COLUMN     "sensitivity_results" JSONB,
ADD COLUMN     "walk_forward_results" JSONB;
