-- CreateTable
CREATE TABLE "risk_override_logs" (
    "id" SERIAL NOT NULL,
    "opportunity_id" TEXT NOT NULL,
    "rationale" TEXT NOT NULL,
    "approved" BOOLEAN NOT NULL,
    "original_rejection_reason" TEXT NOT NULL,
    "override_amount_usd" DECIMAL(18,8),
    "denial_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "risk_override_logs_pkey" PRIMARY KEY ("id")
);
