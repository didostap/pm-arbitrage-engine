import { describe, it, expect } from 'vitest';
import { ExecutionError, EXECUTION_ERROR_CODES } from './execution-error';
import { SystemError } from './system-error';

describe('ExecutionError', () => {
  it('should extend SystemError', () => {
    const error = new ExecutionError(
      EXECUTION_ERROR_CODES.GENERIC_EXECUTION_FAILURE,
      'test error',
      'error',
    );
    expect(error).toBeInstanceOf(SystemError);
    expect(error).toBeInstanceOf(ExecutionError);
  });

  it('should store code, message, and severity', () => {
    const error = new ExecutionError(
      EXECUTION_ERROR_CODES.INSUFFICIENT_LIQUIDITY,
      'Not enough liquidity',
      'warning',
    );
    expect(error.code).toBe(2001);
    expect(error.message).toBe('Not enough liquidity');
    expect(error.severity).toBe('warning');
    expect(error.name).toBe('ExecutionError');
  });

  it('should accept optional retryStrategy and metadata', () => {
    const retry = {
      maxRetries: 3,
      initialDelayMs: 100,
      maxDelayMs: 1000,
      backoffMultiplier: 2,
    };
    const metadata = { orderId: 'abc-123' };
    const error = new ExecutionError(
      EXECUTION_ERROR_CODES.ORDER_REJECTED,
      'Order rejected',
      'error',
      retry,
      metadata,
    );
    expect(error.retryStrategy).toEqual(retry);
    expect(error.metadata).toEqual(metadata);
  });

  describe('EXECUTION_ERROR_CODES', () => {
    it('should define codes in the 2000-2999 range', () => {
      for (const [, code] of Object.entries(EXECUTION_ERROR_CODES)) {
        expect(code).toBeGreaterThanOrEqual(2000);
        expect(code).toBeLessThan(3000);
      }
    });

    it('should define all required codes', () => {
      expect(EXECUTION_ERROR_CODES.GENERIC_EXECUTION_FAILURE).toBe(2000);
      expect(EXECUTION_ERROR_CODES.INSUFFICIENT_LIQUIDITY).toBe(2001);
      expect(EXECUTION_ERROR_CODES.ORDER_REJECTED).toBe(2002);
      expect(EXECUTION_ERROR_CODES.ORDER_TIMEOUT).toBe(2003);
      expect(EXECUTION_ERROR_CODES.SINGLE_LEG_EXPOSURE).toBe(2004);
      expect(EXECUTION_ERROR_CODES.COMPLIANCE_BLOCKED).toBe(2009);
    });
  });
});
