import { describe, it, expect, vi } from 'vitest';

vi.mock('../services/correlation-context', () => ({
  getCorrelationId: vi.fn(() => 'test-correlation-id'),
}));

import {
  BacktestDataIngestedEvent,
  BacktestDataQualityWarningEvent,
  BacktestValidationCompletedEvent,
} from './backtesting.events';
import { BaseEvent } from './base.event';
import { EVENT_NAMES } from './event-catalog';

describe('BacktestDataIngestedEvent', () => {
  it('[P1] should construct with required fields', () => {
    const event = new BacktestDataIngestedEvent({
      source: 'KALSHI_API',
      platform: 'kalshi',
      contractId: 'KXBTC-24DEC31',
      recordCount: 1500,
      dateRange: { start: new Date('2025-01-01'), end: new Date('2025-03-01') },
      correlationId: 'test-corr-id',
    });

    expect(event).toEqual(
      expect.objectContaining({
        source: 'KALSHI_API',
        platform: 'kalshi',
        contractId: 'KXBTC-24DEC31',
        recordCount: 1500,
        correlationId: 'test-corr-id',
      }),
    );
    expect(event.timestamp).toBeInstanceOf(Date);
    expect(event.dateRange.start).toBeInstanceOf(Date);
    expect(event.dateRange.end).toBeInstanceOf(Date);
  });

  it('[P1] should inherit from BaseEvent', () => {
    const event = new BacktestDataIngestedEvent({
      source: 'POLYMARKET_API',
      platform: 'polymarket',
      contractId: '0x1234',
      recordCount: 500,
      dateRange: { start: new Date(), end: new Date() },
    });
    expect(event).toBeInstanceOf(BaseEvent);
  });

  it('[P1] should use correlationId from context when not provided', () => {
    const event = new BacktestDataIngestedEvent({
      source: 'GOLDSKY',
      platform: 'polymarket',
      contractId: '0xabcd',
      recordCount: 200,
      dateRange: { start: new Date(), end: new Date() },
    });
    expect(event.correlationId).toBe('test-correlation-id');
  });
});

describe('BacktestDataQualityWarningEvent', () => {
  it('[P1] should construct with quality flags', () => {
    const flags = {
      hasGaps: true,
      hasSuspiciousJumps: false,
      hasSurvivorshipBias: false,
      hasStaleData: false,
      hasLowVolume: true,
      gapDetails: [
        { from: new Date('2025-02-01'), to: new Date('2025-02-02') },
      ],
      jumpDetails: [],
    };

    const event = new BacktestDataQualityWarningEvent({
      source: 'KALSHI_API',
      platform: 'kalshi',
      contractId: 'KXBTC-24DEC31',
      flags,
      message: 'Coverage gaps and low volume detected',
      correlationId: 'test-corr-id',
    });

    expect(event).toEqual(
      expect.objectContaining({
        source: 'KALSHI_API',
        platform: 'kalshi',
        contractId: 'KXBTC-24DEC31',
        message: 'Coverage gaps and low volume detected',
        correlationId: 'test-corr-id',
      }),
    );
    expect(event.flags.hasGaps).toBe(true);
    expect(event.flags.hasLowVolume).toBe(true);
    expect(event.timestamp).toBeInstanceOf(Date);
  });

  it('[P1] should inherit from BaseEvent', () => {
    const event = new BacktestDataQualityWarningEvent({
      source: 'POLY_DATA',
      platform: 'polymarket',
      contractId: '0x5678',
      flags: {
        hasGaps: false,
        hasSuspiciousJumps: true,
        hasSurvivorshipBias: false,
        hasStaleData: false,
        hasLowVolume: false,
        gapDetails: [],
        jumpDetails: [{ index: 5, priceDelta: 0.25 }],
      },
      message: 'Suspicious price jump detected',
    });
    expect(event).toBeInstanceOf(BaseEvent);
  });
});

describe('Event catalog entries', () => {
  it('[P1] should define BACKTEST_DATA_INGESTED in EVENT_NAMES', () => {
    expect(EVENT_NAMES.BACKTEST_DATA_INGESTED).toBe(
      'backtesting.data.ingested',
    );
  });

  it('[P1] should define BACKTEST_DATA_QUALITY_WARNING in EVENT_NAMES', () => {
    expect(EVENT_NAMES.BACKTEST_DATA_QUALITY_WARNING).toBe(
      'backtesting.data.quality-warning',
    );
  });

  it('[P1] should register BACKTEST_VALIDATION_COMPLETED in event catalog', () => {
    expect(EVENT_NAMES.BACKTEST_VALIDATION_COMPLETED).toBe(
      'backtesting.validation.completed',
    );
  });
});

// ============================================================
// Story 10-9-2: Match Validation Events
// ============================================================

describe('BacktestValidationCompletedEvent', () => {
  it('[P1] should construct BacktestValidationCompletedEvent with summary counts and reportId', () => {
    const event = new BacktestValidationCompletedEvent({
      reportId: 42,
      confirmedCount: 10,
      ourOnlyCount: 5,
      externalOnlyCount: 3,
      conflictCount: 2,
      correlationId: 'val-corr-id',
    });

    expect(event).toEqual(
      expect.objectContaining({
        reportId: 42,
        confirmedCount: 10,
        ourOnlyCount: 5,
        externalOnlyCount: 3,
        conflictCount: 2,
        correlationId: 'val-corr-id',
      }),
    );
    expect(event).toBeInstanceOf(BaseEvent);
    expect(event.timestamp).toBeInstanceOf(Date);
  });
});
