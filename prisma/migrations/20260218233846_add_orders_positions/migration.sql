-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('PENDING', 'FILLED', 'PARTIAL', 'REJECTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PositionStatus" AS ENUM ('OPEN', 'SINGLE_LEG_EXPOSED', 'EXIT_PARTIAL', 'CLOSED', 'RECONCILIATION_REQUIRED');

-- CreateTable
CREATE TABLE "orders" (
    "order_id" TEXT NOT NULL,
    "platform" "Platform" NOT NULL,
    "contract_id" TEXT NOT NULL,
    "pair_id" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "price" DECIMAL(20,8) NOT NULL,
    "size" DECIMAL(20,8) NOT NULL,
    "status" "OrderStatus" NOT NULL,
    "fill_price" DECIMAL(20,8),
    "fill_size" DECIMAL(20,8),
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "orders_pkey" PRIMARY KEY ("order_id")
);

-- CreateTable
CREATE TABLE "open_positions" (
    "position_id" TEXT NOT NULL,
    "pair_id" TEXT NOT NULL,
    "polymarket_order_id" TEXT,
    "kalshi_order_id" TEXT,
    "polymarket_side" TEXT,
    "kalshi_side" TEXT,
    "entry_prices" JSONB NOT NULL,
    "sizes" JSONB NOT NULL,
    "expected_edge" DECIMAL(20,8) NOT NULL,
    "status" "PositionStatus" NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "open_positions_pkey" PRIMARY KEY ("position_id")
);

-- CreateIndex
CREATE INDEX "orders_pair_id_idx" ON "orders"("pair_id");

-- CreateIndex
CREATE INDEX "orders_platform_status_idx" ON "orders"("platform", "status");

-- CreateIndex
CREATE INDEX "orders_created_at_idx" ON "orders"("created_at");

-- CreateIndex
CREATE INDEX "open_positions_pair_id_idx" ON "open_positions"("pair_id");

-- CreateIndex
CREATE INDEX "open_positions_status_idx" ON "open_positions"("status");

-- CreateIndex
CREATE INDEX "open_positions_created_at_idx" ON "open_positions"("created_at");

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_pair_id_fkey" FOREIGN KEY ("pair_id") REFERENCES "contract_matches"("match_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "open_positions" ADD CONSTRAINT "open_positions_pair_id_fkey" FOREIGN KEY ("pair_id") REFERENCES "contract_matches"("match_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "open_positions" ADD CONSTRAINT "open_positions_polymarket_order_id_fkey" FOREIGN KEY ("polymarket_order_id") REFERENCES "orders"("order_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "open_positions" ADD CONSTRAINT "open_positions_kalshi_order_id_fkey" FOREIGN KEY ("kalshi_order_id") REFERENCES "orders"("order_id") ON DELETE SET NULL ON UPDATE CASCADE;
