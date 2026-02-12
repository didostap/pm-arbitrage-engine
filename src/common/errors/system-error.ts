export interface RetryStrategy {
  maxRetries: number;
  initialDelayMs: number;
  maxDelayMs: number;
  backoffMultiplier: number;
}

/**
 * Base error class for all system errors.
 * Subclasses define error code ranges:
 * - PlatformApiError: 1000-1999
 * - ExecutionError: 2000-2999 (future)
 * - RiskLimitError: 3000-3999 (future)
 * - SystemHealthError: 4000-4999 (future)
 */
export abstract class SystemError extends Error {
  constructor(
    public readonly code: number,
    message: string,
    public readonly severity: 'critical' | 'error' | 'warning',
    public readonly retryStrategy?: RetryStrategy,
    public readonly metadata?: Record<string, unknown>,
  ) {
    super(message);
    this.name = this.constructor.name;
  }
}
