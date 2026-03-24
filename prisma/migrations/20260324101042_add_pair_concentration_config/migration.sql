-- AlterTable
ALTER TABLE "engine_config" ADD COLUMN     "pair_cooldown_minutes" INTEGER,
ADD COLUMN     "pair_diversity_threshold" INTEGER,
ADD COLUMN     "pair_max_concurrent_positions" INTEGER;
