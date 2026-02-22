-- AlterTable
ALTER TABLE "open_positions" ADD COLUMN     "is_paper" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "is_paper" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "open_positions_is_paper_status_idx" ON "open_positions"("is_paper", "status");

-- CreateIndex
CREATE INDEX "orders_is_paper_status_idx" ON "orders"("is_paper", "status");
