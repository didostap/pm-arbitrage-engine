import { describe, it, expect, vi } from 'vitest';

vi.mock('../services/correlation-context', () => ({
  getCorrelationId: vi.fn(() => 'test-correlation-id'),
}));

import {
  BacktestDataIngestedEvent,
  BacktestDataQualityWarningEvent,
  BacktestValidationCompletedEvent,
  BacktestRunStartedEvent,
  BacktestRunCompletedEvent,
  BacktestRunFailedEvent,
  BacktestRunCancelledEvent,
  BacktestPositionOpenedEvent,
  BacktestPositionClosedEvent,
  BacktestEngineStateChangedEvent,
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

// ============================================================
// Story 10-9-3: Backtest Simulation Engine Events
// ============================================================

describe('BacktestRunStartedEvent', () => {
  it('[P1] should construct with runId and config snapshot', () => {
    const config = { edgeThresholdPct: 0.008, positionSizePct: 0.03 };
    const event = new BacktestRunStartedEvent({
      runId: 'run-1',
      config,
      correlationId: 'corr-1',
    });

    expect(event).toEqual(
      expect.objectContaining({
        runId: 'run-1',
        config,
        correlationId: 'corr-1',
      }),
    );
    expect(event).toBeInstanceOf(BaseEvent);
    expect(event.timestamp).toBeInstanceOf(Date);
  });
});

describe('BacktestRunCompletedEvent', () => {
  it('[P1] should construct with runId and aggregate metrics', () => {
    const metrics = {
      totalPositions: 10,
      winCount: 7,
      totalPnl: '150.50',
      sharpeRatio: '1.85',
    };
    const event = new BacktestRunCompletedEvent({
      runId: 'run-2',
      metrics,
      correlationId: 'corr-2',
    });

    expect(event).toEqual(
      expect.objectContaining({
        runId: 'run-2',
        metrics,
        correlationId: 'corr-2',
      }),
    );
    expect(event).toBeInstanceOf(BaseEvent);
  });
});

describe('BacktestRunFailedEvent', () => {
  it('[P1] should construct with runId, error code, and message', () => {
    const event = new BacktestRunFailedEvent({
      runId: 'run-3',
      errorCode: 4210,
      message: 'Simulation exceeded timeout',
      correlationId: 'corr-3',
    });

    expect(event).toEqual(
      expect.objectContaining({
        runId: 'run-3',
        errorCode: 4210,
        message: 'Simulation exceeded timeout',
        correlationId: 'corr-3',
      }),
    );
    expect(event).toBeInstanceOf(BaseEvent);
  });
});

describe('BacktestRunCancelledEvent', () => {
  it('[P2] should construct with runId', () => {
    const event = new BacktestRunCancelledEvent({
      runId: 'run-4',
      correlationId: 'corr-4',
    });

    expect(event).toEqual(
      expect.objectContaining({
        runId: 'run-4',
        correlationId: 'corr-4',
      }),
    );
    expect(event).toBeInstanceOf(BaseEvent);
  });
});

describe('BacktestPositionOpenedEvent', () => {
  it('[P1] should construct with position details and entry edge', () => {
    const event = new BacktestPositionOpenedEvent({
      runId: 'run-1',
      positionId: 'pos-1',
      pairId: 'pair-1',
      entryEdge: '0.015',
      positionSizeUsd: '300',
      correlationId: 'corr-5',
    });

    expect(event).toEqual(
      expect.objectContaining({
        runId: 'run-1',
        positionId: 'pos-1',
        pairId: 'pair-1',
        entryEdge: '0.015',
        positionSizeUsd: '300',
        correlationId: 'corr-5',
      }),
    );
    expect(event).toBeInstanceOf(BaseEvent);
  });
});

describe('BacktestPositionClosedEvent', () => {
  it('[P1] should construct with exit reason, realized P&L, and holding hours', () => {
    const event = new BacktestPositionClosedEvent({
      runId: 'run-1',
      positionId: 'pos-1',
      pairId: 'pair-1',
      exitReason: 'PROFIT_CAPTURE',
      realizedPnl: '25.00',
      holdingHours: '12.5',
      correlationId: 'corr-6',
    });

    expect(event).toEqual(
      expect.objectContaining({
        runId: 'run-1',
        positionId: 'pos-1',
        exitReason: 'PROFIT_CAPTURE',
        realizedPnl: '25.00',
        holdingHours: '12.5',
        correlationId: 'corr-6',
      }),
    );
    expect(event).toBeInstanceOf(BaseEvent);
  });
});

describe('BacktestEngineStateChangedEvent', () => {
  it('[P1] should construct with runId, fromState, and toState', () => {
    const event = new BacktestEngineStateChangedEvent({
      runId: 'run-1',
      fromState: 'IDLE',
      toState: 'CONFIGURING',
      correlationId: 'corr-7',
    });

    expect(event).toEqual(
      expect.objectContaining({
        runId: 'run-1',
        fromState: 'IDLE',
        toState: 'CONFIGURING',
        correlationId: 'corr-7',
      }),
    );
    expect(event).toBeInstanceOf(BaseEvent);
  });
});

describe('Event catalog entries (Story 10-9-3)', () => {
  it('[P1] should register all 7 backtesting engine events in EVENT_NAMES catalog', () => {
    expect(EVENT_NAMES.BACKTEST_RUN_STARTED).toBe('backtesting.run.started');
    expect(EVENT_NAMES.BACKTEST_RUN_COMPLETED).toBe(
      'backtesting.run.completed',
    );
    expect(EVENT_NAMES.BACKTEST_RUN_FAILED).toBe('backtesting.run.failed');
    expect(EVENT_NAMES.BACKTEST_RUN_CANCELLED).toBe(
      'backtesting.run.cancelled',
    );
    expect(EVENT_NAMES.BACKTEST_POSITION_OPENED).toBe(
      'backtesting.position.opened',
    );
    expect(EVENT_NAMES.BACKTEST_POSITION_CLOSED).toBe(
      'backtesting.position.closed',
    );
    expect(EVENT_NAMES.BACKTEST_ENGINE_STATE_CHANGED).toBe(
      'backtesting.engine.state-changed',
    );
  });
});
