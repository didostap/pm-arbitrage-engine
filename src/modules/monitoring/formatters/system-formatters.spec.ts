import { describe, it, expect } from 'vitest';
import {
  formatTradingHalted,
  formatTradingResumed,
  formatReconciliationDiscrepancy,
  formatSystemHealthCritical,
  formatTestAlert,
} from './system-formatters.js';

describe('formatTradingHalted', () => {
  it('should show URGENT header', () => {
    const result = formatTradingHalted({
      reason: 'DAILY_LOSS_LIMIT',
      details: {},
      haltTimestamp: new Date('2024-01-15T10:30:00Z'),
      severity: 'critical',
      timestamp: new Date(),
    });

    expect(result).toContain('\u{1F534}');
    expect(result).toContain('TRADING HALTED');
    expect(result).toContain('DAILY_LOSS_LIMIT');
  });
});

describe('formatTradingResumed', () => {
  it('should show removed reason and remaining', () => {
    const result = formatTradingResumed({
      removedReason: 'DAILY_LOSS_LIMIT',
      remainingReasons: [],
      resumeTimestamp: new Date('2024-01-15T12:00:00Z'),
      timestamp: new Date(),
    });

    expect(result).toContain('<b>Trading Resumed</b>');
    expect(result).toContain('No remaining halt reasons');
  });
});

describe('formatReconciliationDiscrepancy', () => {
  it('should show discrepancy details', () => {
    const result = formatReconciliationDiscrepancy({
      positionId: 'pos-1',
      pairId: 'pair-1',
      discrepancyType: 'order_status_mismatch',
      localState: 'FILLED',
      platformState: 'PENDING',
      recommendedAction: 'Manual review required',
      timestamp: new Date(),
    });

    expect(result).toContain('\u{1F534}');
    expect(result).toContain('Reconciliation Discrepancy');
    expect(result).toContain('order_status_mismatch');
  });
});

describe('formatSystemHealthCritical', () => {
  it('should show component and actions', () => {
    const result = formatSystemHealthCritical({
      component: 'database',
      diagnosticInfo: 'Connection pool exhausted',
      recommendedActions: ['Restart connection pool', 'Check DB load'],
      severity: 'critical',
      timestamp: new Date(),
    });

    expect(result).toContain('\u{1F534}');
    expect(result).toContain('System Health Critical');
    expect(result).toContain('<code>database</code>');
    expect(result).toContain('Restart connection pool');
  });
});

describe('formatTestAlert', () => {
  it('should produce health check message with uptime', () => {
    const result = formatTestAlert();
    expect(result).toContain('\u{1F7E2}');
    expect(result).toContain('Daily Test Alert');
    expect(result).toContain('Alerting system healthy');
    expect(result).toContain('Timestamp');
    expect(result).toContain('Uptime:');
  });
});
