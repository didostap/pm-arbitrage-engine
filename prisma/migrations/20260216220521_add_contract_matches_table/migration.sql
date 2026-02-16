-- CreateTable
CREATE TABLE "contract_matches" (
    "match_id" TEXT NOT NULL,
    "polymarket_contract_id" TEXT NOT NULL,
    "kalshi_contract_id" TEXT NOT NULL,
    "polymarket_description" TEXT,
    "kalshi_description" TEXT,
    "operator_approved" BOOLEAN NOT NULL DEFAULT false,
    "operator_approval_timestamp" TIMESTAMPTZ,
    "operator_rationale" TEXT,
    "first_traded_timestamp" TIMESTAMPTZ,
    "total_cycles_traded" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "contract_matches_pkey" PRIMARY KEY ("match_id")
);

-- CreateIndex
CREATE INDEX "contract_matches_operator_approved_idx" ON "contract_matches"("operator_approved");

-- CreateIndex
CREATE UNIQUE INDEX "contract_matches_polymarket_contract_id_kalshi_contract_id_key" ON "contract_matches"("polymarket_contract_id", "kalshi_contract_id");
