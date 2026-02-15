-- Rollback: 20260212222514_add_order_book_and_health_tables
-- Drops order_book_snapshots and platform_health_logs tables and their indexes.

-- Drop indexes first
DROP INDEX IF EXISTS "order_book_snapshots_platform_contract_id_created_at_idx";
DROP INDEX IF EXISTS "order_book_snapshots_created_at_idx";
DROP INDEX IF EXISTS "platform_health_logs_platform_created_at_idx";
DROP INDEX IF EXISTS "platform_health_logs_created_at_idx";

-- Drop tables
DROP TABLE IF EXISTS "order_book_snapshots";
DROP TABLE IF EXISTS "platform_health_logs";
