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

  // ============================================================
  // Story 10-9-2: Cross-Platform Pair Matching Validation Error Codes
  // ============================================================

  it('[P1] should define BACKTEST_PREDEXON_API_ERROR with code 4202', () => {
    expect(SYSTEM_HEALTH_ERROR_CODES.BACKTEST_PREDEXON_API_ERROR).toBe(4202);

    const error = new SystemHealthError(
      SYSTEM_HEALTH_ERROR_CODES.BACKTEST_PREDEXON_API_ERROR,
      'Predexon API failed after 3 retries',
      'error',
      'predexon',
    );

    expect(error.code).toBe(4202);
    expect(error.severity).toBe('error');
    expect(error.component).toBe('predexon');
  });

  it('[P1] should define BACKTEST_VALIDATION_FAILURE with code 4203', () => {
    expect(SYSTEM_HEALTH_ERROR_CODES.BACKTEST_VALIDATION_FAILURE).toBe(4203);

    const error = new SystemHealthError(
      SYSTEM_HEALTH_ERROR_CODES.BACKTEST_VALIDATION_FAILURE,
      'Match validation engine failed during comparison',
      'error',
      'match-validation',
    );

    expect(error.code).toBe(4203);
    expect(error.severity).toBe('error');
    expect(error.component).toBe('match-validation');
  });

  // ============================================================
  // Story 10-9-3: Backtest Simulation Engine Error Codes
  // ============================================================

  it('[P1] should define BACKTEST_STATE_ERROR with code 4204', () => {
    expect(SYSTEM_HEALTH_ERROR_CODES.BACKTEST_STATE_ERROR).toBe(4204);

    const error = new SystemHealthError(
      SYSTEM_HEALTH_ERROR_CODES.BACKTEST_STATE_ERROR,
      'Invalid state transition: idle → simulating',
      'error',
      'backtest-engine',
    );

    expect(error.code).toBe(4204);
    expect(error.severity).toBe('error');
    expect(error.component).toBe('backtest-engine');
  });

  it('[P1] should define BACKTEST_TIMEOUT with code 4210', () => {
    expect(SYSTEM_HEALTH_ERROR_CODES.BACKTEST_TIMEOUT).toBe(4210);

    const error = new SystemHealthError(
      SYSTEM_HEALTH_ERROR_CODES.BACKTEST_TIMEOUT,
      'Backtest simulation exceeded 300s timeout',
      'error',
      'backtest-engine',
    );

    expect(error.code).toBe(4210);
    expect(error.severity).toBe('error');
    expect(error.component).toBe('backtest-engine');
  });

  it('[P1] should define BACKTEST_INSUFFICIENT_DATA with code 4211', () => {
    expect(SYSTEM_HEALTH_ERROR_CODES.BACKTEST_INSUFFICIENT_DATA).toBe(4211);

    const error = new SystemHealthError(
      SYSTEM_HEALTH_ERROR_CODES.BACKTEST_INSUFFICIENT_DATA,
      'Data coverage below 50% minimum threshold',
      'error',
      'backtest-engine',
    );

    expect(error.code).toBe(4211);
    expect(error.severity).toBe('error');
    expect(error.component).toBe('backtest-engine');
  });

  it('[P1] should define BACKTEST_INVALID_CONFIGURATION with code 4212', () => {
    expect(SYSTEM_HEALTH_ERROR_CODES.BACKTEST_INVALID_CONFIGURATION).toBe(4212);

    const error = new SystemHealthError(
      SYSTEM_HEALTH_ERROR_CODES.BACKTEST_INVALID_CONFIGURATION,
      'Invalid backtest configuration: dateRangeStart >= dateRangeEnd',
      'error',
      'backtest-engine',
    );

    expect(error.code).toBe(4212);
    expect(error.severity).toBe('error');
    expect(error.component).toBe('backtest-engine');
  });

  it('[P1] should have no duplicate error codes across all SYSTEM_HEALTH_ERROR_CODES', () => {
    const codes = Object.values(SYSTEM_HEALTH_ERROR_CODES);
    const uniqueCodes = new Set(codes);
    expect(uniqueCodes.size).toBe(codes.length);
  });
});
