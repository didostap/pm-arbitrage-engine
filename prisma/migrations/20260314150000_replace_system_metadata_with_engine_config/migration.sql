-- DropTable
DROP TABLE "system_metadata";

-- CreateTable
CREATE TABLE "engine_config" (
    "id" TEXT NOT NULL,
    "singleton_key" TEXT NOT NULL DEFAULT 'default',
    "bankroll_usd" DECIMAL(20,8) NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "engine_config_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "engine_config_singleton_key_key" ON "engine_config"("singleton_key");
