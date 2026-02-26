import { PlatformId } from '../types/index.js';
import { RetryStrategy, SystemError } from './system-error.js';

/**
 * Error class for platform API errors (code range 1000-1999).
 *
 * Kalshi-specific codes:
 * - 1001: Unauthorized (CRITICAL, no retry)
 * - 1002: Rate Limit Exceeded (WARNING, exponential backoff)
 * - 1003: Invalid Request (ERROR, no retry)
 * - 1004: Market Not Found (WARNING, no retry)
 * - 1005: Insufficient Funds (WARNING, no retry)
 * - 1006: Order Rejected (WARNING, no retry)
 * - 1007: Schema Change (CRITICAL, no retry)
 * - 1100: Not Implemented (WARNING, no retry)
 *
 * Polymarket codes: 1008-1099 (see polymarket-error-codes.ts)
 */
export class PlatformApiError extends SystemError {
  constructor(
    code: number,
    message: string,
    public readonly platformId: PlatformId,
    severity: 'critical' | 'error' | 'warning',
    retryStrategy?: RetryStrategy,
    metadata?: Record<string, unknown>,
  ) {
    super(code, message, severity, retryStrategy, metadata);
  }
}

export const KALSHI_ERROR_CODES = {
  UNAUTHORIZED: 1001,
  RATE_LIMIT_EXCEEDED: 1002,
  INVALID_REQUEST: 1003,
  MARKET_NOT_FOUND: 1004,
  INSUFFICIENT_FUNDS: 1005,
  ORDER_REJECTED: 1006,
  SCHEMA_CHANGE: 1007,
  /** Method not implemented — warning, no retry */
  NOT_IMPLEMENTED: 1100,
} as const;

export const RETRY_STRATEGIES = {
  RATE_LIMIT: {
    maxRetries: 5,
    initialDelayMs: 1000,
    maxDelayMs: 60000,
    backoffMultiplier: 2,
  },
  NETWORK_ERROR: {
    maxRetries: 3,
    initialDelayMs: 500,
    maxDelayMs: 5000,
    backoffMultiplier: 2,
  },
  WEBSOCKET_RECONNECT: {
    maxRetries: Infinity,
    initialDelayMs: 1000,
    maxDelayMs: 60000,
    backoffMultiplier: 2,
  },
} as const satisfies Record<string, RetryStrategy>;
