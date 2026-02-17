import { SystemError, RetryStrategy } from './system-error.js';

export class RiskLimitError extends SystemError {
  constructor(
    code: number,
    message: string,
    severity: 'critical' | 'error' | 'warning',
    public readonly limitType: string,
    public readonly currentValue: number,
    public readonly threshold: number,
    retryStrategy?: RetryStrategy,
    metadata?: Record<string, unknown>,
  ) {
    super(code, message, severity, retryStrategy, metadata);
  }
}

export const RISK_ERROR_CODES = {
  POSITION_SIZE_EXCEEDED: 3001,
  MAX_OPEN_PAIRS_EXCEEDED: 3002,
  DAILY_LOSS_LIMIT_BREACHED: 3003, // Story 4.2
  OVERRIDE_DENIED_HALT_ACTIVE: 3004, // Story 4.3
  BUDGET_RESERVATION_FAILED: 3005, // Story 4.4
} as const;
