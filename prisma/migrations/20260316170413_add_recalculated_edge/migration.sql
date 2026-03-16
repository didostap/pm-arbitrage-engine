-- AlterTable
ALTER TABLE "open_positions" ADD COLUMN     "last_recalculated_at" TIMESTAMPTZ,
ADD COLUMN     "recalculated_edge" DECIMAL(20,8),
ADD COLUMN     "recalculation_data_source" VARCHAR(20);
