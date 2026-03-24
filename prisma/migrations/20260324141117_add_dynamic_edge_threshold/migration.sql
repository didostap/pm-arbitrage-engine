-- AlterTable
ALTER TABLE "engine_config" ADD COLUMN     "depth_edge_scaling_factor" DECIMAL(20,8),
ADD COLUMN     "max_dynamic_edge_threshold" DECIMAL(20,8);
