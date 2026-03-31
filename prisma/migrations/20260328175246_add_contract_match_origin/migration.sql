-- CreateEnum
CREATE TYPE "MatchOrigin" AS ENUM ('DISCOVERY', 'PREDEXON', 'ODDSPIPE', 'MANUAL');

-- AlterTable
ALTER TABLE "contract_matches" ADD COLUMN     "origin" "MatchOrigin" NOT NULL DEFAULT 'DISCOVERY';

-- CreateIndex
CREATE INDEX "contract_matches_origin_idx" ON "contract_matches"("origin");

-- Backfill: Tag YAML-sourced pairs as MANUAL (operatorApproved but no rationale = manual config)
UPDATE "contract_matches"
SET "origin" = 'MANUAL'
WHERE "operator_approved" = true
AND "operator_rationale" IS NULL;
