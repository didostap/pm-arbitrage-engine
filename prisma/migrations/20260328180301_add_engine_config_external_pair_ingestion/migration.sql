-- AlterTable
ALTER TABLE "engine_config" ADD COLUMN     "external_pair_dedup_title_threshold" DOUBLE PRECISION,
ADD COLUMN     "external_pair_ingestion_cron_expression" TEXT,
ADD COLUMN     "external_pair_ingestion_enabled" BOOLEAN,
ADD COLUMN     "external_pair_llm_concurrency" INTEGER;
