-- AlterTable
ALTER TABLE "contract_matches" ADD COLUMN     "cluster_id" TEXT,
ADD COLUMN     "kalshi_raw_category" TEXT,
ADD COLUMN     "polymarket_raw_category" TEXT;

-- CreateTable
CREATE TABLE "correlation_clusters" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "correlation_clusters_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cluster_tag_mappings" (
    "id" TEXT NOT NULL,
    "cluster_id" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "raw_category" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cluster_tag_mappings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "correlation_clusters_name_key" ON "correlation_clusters"("name");

-- CreateIndex
CREATE UNIQUE INDEX "correlation_clusters_slug_key" ON "correlation_clusters"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "cluster_tag_mappings_cluster_id_platform_raw_category_key" ON "cluster_tag_mappings"("cluster_id", "platform", "raw_category");

-- CreateIndex
CREATE INDEX "contract_matches_cluster_id_idx" ON "contract_matches"("cluster_id");

-- AddForeignKey
ALTER TABLE "cluster_tag_mappings" ADD CONSTRAINT "cluster_tag_mappings_cluster_id_fkey" FOREIGN KEY ("cluster_id") REFERENCES "correlation_clusters"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contract_matches" ADD CONSTRAINT "contract_matches_cluster_id_fkey" FOREIGN KEY ("cluster_id") REFERENCES "correlation_clusters"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Seed default "Uncategorized" cluster (guarantees existence regardless of service state)
INSERT INTO correlation_clusters (id, name, slug, description, created_at, updated_at)
VALUES (gen_random_uuid(), 'Uncategorized', 'uncategorized', 'Default cluster for unclassified or failed-to-classify matches', NOW(), NOW());
