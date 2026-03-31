-- Null out bloated qualityFlags JSONB on historical rows.
-- Per-row qualityFlags is dead code (never read back by any consumer).
-- Quality assessment results are now stored in ingestion_quality_reports table.
-- After this migration, run VACUUM FULL on affected tables to reclaim disk space.

UPDATE historical_prices SET quality_flags = NULL WHERE quality_flags IS NOT NULL;
UPDATE historical_trades SET quality_flags = NULL WHERE quality_flags IS NOT NULL;
UPDATE historical_depths SET quality_flags = NULL WHERE quality_flags IS NOT NULL;
UPDATE backtest_positions SET quality_flags = NULL WHERE quality_flags IS NOT NULL;
