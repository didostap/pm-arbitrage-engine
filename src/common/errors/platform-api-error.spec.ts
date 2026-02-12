import { describe, it, expect } from 'vitest';
import {
  PlatformApiError,
  KALSHI_ERROR_CODES,
  RETRY_STRATEGIES,
} from './platform-api-error.js';
import { PlatformId } from '../types/index.js';

describe('PlatformApiError', () => {
  it('should create error with all properties', () => {
    const error = new PlatformApiError(
      KALSHI_ERROR_CODES.UNAUTHORIZED,
      'Invalid API key',
      PlatformId.KALSHI,
      'critical',
    );

    expect(error.code).toBe(1001);
    expect(error.message).toBe('Invalid API key');
    expect(error.platformId).toBe(PlatformId.KALSHI);
    expect(error.severity).toBe('critical');
    expect(error.name).toBe('PlatformApiError');
    expect(error).toBeInstanceOf(Error);
  });

  it('should support retry strategy', () => {
    const error = new PlatformApiError(
      KALSHI_ERROR_CODES.RATE_LIMIT_EXCEEDED,
      'Rate limit exceeded',
      PlatformId.KALSHI,
      'warning',
      RETRY_STRATEGIES.RATE_LIMIT,
    );

    expect(error.retryStrategy).toBeDefined();
    expect(error.retryStrategy?.maxRetries).toBe(5);
  });

  it('should support metadata', () => {
    const error = new PlatformApiError(
      KALSHI_ERROR_CODES.MARKET_NOT_FOUND,
      'Market not found',
      PlatformId.KALSHI,
      'warning',
      undefined,
      { ticker: 'CPI-22DEC' },
    );

    expect(error.metadata).toEqual({ ticker: 'CPI-22DEC' });
  });

  it('should define all Kalshi error codes', () => {
    expect(KALSHI_ERROR_CODES.UNAUTHORIZED).toBe(1001);
    expect(KALSHI_ERROR_CODES.RATE_LIMIT_EXCEEDED).toBe(1002);
    expect(KALSHI_ERROR_CODES.INVALID_REQUEST).toBe(1003);
    expect(KALSHI_ERROR_CODES.MARKET_NOT_FOUND).toBe(1004);
    expect(KALSHI_ERROR_CODES.INSUFFICIENT_FUNDS).toBe(1005);
    expect(KALSHI_ERROR_CODES.ORDER_REJECTED).toBe(1006);
    expect(KALSHI_ERROR_CODES.SCHEMA_CHANGE).toBe(1007);
  });
});
