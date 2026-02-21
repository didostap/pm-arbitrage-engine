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
});
