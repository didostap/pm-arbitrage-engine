-- AlterTable
ALTER TABLE "engine_config" ADD COLUMN     "retention_days_historical_depths" INTEGER,
ADD COLUMN     "retention_days_historical_prices" INTEGER,
ADD COLUMN     "retention_days_historical_trades" INTEGER;

-- Enable compression on all three hypertables
ALTER TABLE historical_prices SET (
  timescaledb.compress,
  timescaledb.compress_segmentby = 'platform, contract_id, source',
  timescaledb.compress_orderby = 'timestamp DESC'
);
ALTER TABLE historical_depths SET (
  timescaledb.compress,
  timescaledb.compress_segmentby = 'platform, contract_id, source',
  timescaledb.compress_orderby = 'timestamp DESC'
);
ALTER TABLE historical_trades SET (
  timescaledb.compress,
  timescaledb.compress_segmentby = 'platform, contract_id, source',
  timescaledb.compress_orderby = 'timestamp DESC'
);

-- Add automatic compression policies (7-day interval)
-- TimescaleDB background job compresses eligible chunks every 12h (default)
SELECT add_compression_policy('historical_prices',
  compress_after => INTERVAL '7 days', if_not_exists => true);
SELECT add_compression_policy('historical_depths',
  compress_after => INTERVAL '7 days', if_not_exists => true);
SELECT add_compression_policy('historical_trades',
  compress_after => INTERVAL '7 days', if_not_exists => true);
