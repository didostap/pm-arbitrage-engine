-- AlterTable
ALTER TABLE "risk_states" ADD COLUMN     "trading_halted" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "halt_reason" TEXT;
