import { SystemError, RetryStrategy } from './system-error';

/**
 * System health errors (codes 4000-4999)
 * Used for system health issues: state corruption, staleness, disk/memory issues
 */
export class SystemHealthError extends SystemError {
  constructor(
    code: number,
    message: string,
    severity: 'critical' | 'error' | 'warning',
    public readonly component?: string,
    retryStrategy?: RetryStrategy,
    metadata?: Record<string, unknown>,
  ) {
    super(code, message, severity, retryStrategy, metadata);
  }
}

export const SYSTEM_HEALTH_ERROR_CODES = {
  /** Clock drift detected — warning */
  CLOCK_DRIFT: 4001,
  /** Database connectivity failure — critical */
  DATABASE_FAILURE: 4002,
  /** Stale data detected — warning */
  STALE_DATA: 4003,
  /** State corruption — critical */
  STATE_CORRUPTION: 4004,
  /** Reconciliation discrepancy found — critical */
  RECONCILIATION_DISCREPANCY: 4005,
  /** Invalid configuration at startup — error */
  INVALID_CONFIGURATION: 4006,
  /** Resource not found — warning */
  NOT_FOUND: 4007,
  /** Match already approved — conflict */
  MATCH_ALREADY_APPROVED: 4008,
  /** Computed realizedPnl is NaN or Infinity — critical */
  INVALID_PNL_COMPUTATION: 4009,
  /** Prisma JSON field data corruption detected — critical */
  DATA_CORRUPTION_DETECTED: 4500,
  /** Concentration filter repository query failed — critical, fail-open */
  CONCENTRATION_FILTER_FAILURE: 4010,
  /** Backtest ingestion failure after all retries for a contract — error */
  BACKTEST_INGESTION_FAILURE: 4200,
  /** Kalshi/Polymarket/Goldsky API failure during backtesting — error */
  BACKTEST_EXTERNAL_API_ERROR: 4206,
  /** Data quality below threshold during backtesting — warning */
  BACKTEST_DATA_QUALITY_ERROR: 4207,
  /** PMXT Archive Parquet parse failure — error */
  BACKTEST_PARQUET_PARSE_ERROR: 4201,
  /** PMXT Archive depth ingestion failure after all retries — error */
  BACKTEST_DEPTH_INGESTION_FAILURE: 4208,
  /** OddsPipe API failure during backtesting — error */
  BACKTEST_ODDSPIPE_API_ERROR: 4209,
  /** Predexon API failure during matching validation — error */
  BACKTEST_PREDEXON_API_ERROR: 4202,
  /** Match validation engine failure — error */
  BACKTEST_VALIDATION_FAILURE: 4203,
  /** Backtest state machine invalid transition — error */
  BACKTEST_STATE_ERROR: 4204,
  /** Backtest report generation or sensitivity analysis failure — error */
  BACKTEST_REPORT_ERROR: 4205,
  /** Backtest simulation exceeded timeout — error */
  BACKTEST_TIMEOUT: 4210,
  /** Not enough historical data for backtest — error */
  BACKTEST_INSUFFICIENT_DATA: 4211,
  /** Invalid backtest configuration parameters — error */
  BACKTEST_INVALID_CONFIGURATION: 4212,
  /** All external pair providers failed during ingestion — warning */
  EXTERNAL_PAIR_INGESTION_FAILURE: 4220,
} as const;
