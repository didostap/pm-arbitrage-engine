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
