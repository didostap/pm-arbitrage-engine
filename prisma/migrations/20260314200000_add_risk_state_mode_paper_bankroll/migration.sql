-- Step 1: Drop old unique constraint on singleton_key
DROP INDEX IF EXISTS "risk_states_singleton_key_key";

-- Step 2: Add mode column (existing row becomes 'live')
ALTER TABLE "risk_states" ADD COLUMN "mode" VARCHAR NOT NULL DEFAULT 'live';

-- Step 3: Add compound unique constraint on (singleton_key, mode)
ALTER TABLE "risk_states" ADD CONSTRAINT "risk_states_singleton_key_mode_key" UNIQUE ("singleton_key", "mode");

-- Step 4: Insert fresh paper risk state row
INSERT INTO risk_states (id, singleton_key, mode, daily_pnl, open_position_count, total_capital_deployed, trading_halted, reserved_capital, reserved_position_slots, created_at, updated_at)
VALUES (gen_random_uuid(), 'default', 'paper', 0, 0, 0, false, 0, 0, NOW(), NOW());

-- Step 5: Add paper_bankroll_usd column to engine_config
ALTER TABLE "engine_config" ADD COLUMN "paper_bankroll_usd" DECIMAL(20,8);
