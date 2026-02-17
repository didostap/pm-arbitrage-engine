-- AlterTable
ALTER TABLE "risk_states" ADD COLUMN     "reserved_capital" DECIMAL(20,8) NOT NULL DEFAULT 0,
ADD COLUMN     "reserved_position_slots" INTEGER NOT NULL DEFAULT 0;
