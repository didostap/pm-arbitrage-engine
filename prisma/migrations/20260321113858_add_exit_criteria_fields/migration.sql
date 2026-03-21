-- AlterTable
ALTER TABLE "open_positions" ADD COLUMN     "entry_confidence_score" DOUBLE PRECISION,
ADD COLUMN     "exit_mode" VARCHAR(10),
ADD COLUMN     "last_eval_criteria" JSONB;
