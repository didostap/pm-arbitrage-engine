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
} as const;
