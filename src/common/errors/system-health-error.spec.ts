import { describe, it, expect } from 'vitest';
import {
  SystemHealthError,
  SYSTEM_HEALTH_ERROR_CODES,
} from './system-health-error';

describe('SystemHealthError', () => {
  it('should create error with code 4000-4999', () => {
    const error = new SystemHealthError(
      4005,
      'Persistent snapshot write failure',
      'critical',
      'data-ingestion',
    );

    expect(error.code).toBe(4005);
    expect(error.message).toBe('Persistent snapshot write failure');
    expect(error.severity).toBe('critical');
    expect(error.component).toBe('data-ingestion');
    expect(error.name).toBe('SystemHealthError');
  });

  it('should include optional metadata', () => {
    const error = new SystemHealthError(
      4001,
      'Clock drift detected',
      'warning',
      'ntp-sync',
      undefined,
      { driftMs: 150 },
    );

    expect(error.metadata).toEqual({ driftMs: 150 });
  });

  it('should accept RECONCILIATION_DISCREPANCY code 4005', () => {
    const error = new SystemHealthError(
      SYSTEM_HEALTH_ERROR_CODES.RECONCILIATION_DISCREPANCY,
      'Order status mismatch detected during reconciliation',
      'warning',
      'reconciliation',
    );

    expect(error.code).toBe(4005);
    expect(error.severity).toBe('warning');
    expect(error.component).toBe('reconciliation');
  });

  // ============================================================
  // Story 10-9-1b: Depth & Third-Party Ingestion Error Codes
  // ============================================================

  it('[P1] should define BACKTEST_PARQUET_PARSE_ERROR with code 4201', () => {
    // Error code for Parquet parse failures during PMXT Archive ingestion
    expect(SYSTEM_HEALTH_ERROR_CODES.BACKTEST_PARQUET_PARSE_ERROR).toBe(4201);

    const error = new SystemHealthError(
      SYSTEM_HEALTH_ERROR_CODES.BACKTEST_PARQUET_PARSE_ERROR,
      'Failed to parse PMXT Parquet file: invalid column schema',
      'error',
      'pmxt-archive',
    );

    expect(error.code).toBe(4201);
    expect(error.severity).toBe('error');
    expect(error.component).toBe('pmxt-archive');
  });

  it('[P1] should define BACKTEST_DEPTH_INGESTION_FAILURE with code 4208', () => {
    // Error code for PMXT Archive download/ingestion failures
    expect(SYSTEM_HEALTH_ERROR_CODES.BACKTEST_DEPTH_INGESTION_FAILURE).toBe(
      4208,
    );

    const error = new SystemHealthError(
      SYSTEM_HEALTH_ERROR_CODES.BACKTEST_DEPTH_INGESTION_FAILURE,
      'PMXT Archive download failed after 3 retries',
      'error',
      'pmxt-archive',
      {
        maxRetries: 3,
        initialDelayMs: 1000,
        maxDelayMs: 8000,
        backoffMultiplier: 2,
      },
    );

    expect(error.code).toBe(4208);
    expect(error.retryStrategy).toEqual(
      expect.objectContaining({ maxRetries: 3 }),
    );
  });

  it('[P1] should define BACKTEST_ODDSPIPE_API_ERROR with code 4209', () => {
    // Error code for OddsPipe API failures
    expect(SYSTEM_HEALTH_ERROR_CODES.BACKTEST_ODDSPIPE_API_ERROR).toBe(4209);

    const error = new SystemHealthError(
      SYSTEM_HEALTH_ERROR_CODES.BACKTEST_ODDSPIPE_API_ERROR,
      'OddsPipe API returned 500 for candlestick fetch',
      'error',
      'oddspipe',
    );

    expect(error.code).toBe(4209);
    expect(error.component).toBe('oddspipe');
  });
});
