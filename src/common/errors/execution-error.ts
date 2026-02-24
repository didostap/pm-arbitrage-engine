import { SystemError, RetryStrategy } from './system-error.js';

export class ExecutionError extends SystemError {
  constructor(
    code: number,
    message: string,
    severity: 'critical' | 'error' | 'warning',
    retryStrategy?: RetryStrategy,
    metadata?: Record<string, unknown>,
  ) {
    super(code, message, severity, retryStrategy, metadata);
  }
}

export const EXECUTION_ERROR_CODES = {
  GENERIC_EXECUTION_FAILURE: 2000,
  INSUFFICIENT_LIQUIDITY: 2001,
  ORDER_REJECTED: 2002,
  ORDER_TIMEOUT: 2003,
  SINGLE_LEG_EXPOSURE: 2004,
  INVALID_POSITION_STATE: 2005,
  RETRY_FAILED: 2006,
  CLOSE_FAILED: 2007,
  PARTIAL_EXIT_FAILURE: 2008,
  COMPLIANCE_BLOCKED: 2009,
} as const;
