import { describe, it, expect, vi } from 'vitest';
import {
  OrderFilledEvent,
  ExecutionFailedEvent,
  ExitTriggeredEvent,
  SingleLegExposureEvent,
  SingleLegResolvedEvent,
  ComplianceBlockedEvent,
  ShadowComparisonEvent,
} from './execution.events';
import type { DivergenceDetail } from './execution.events';
import { PlatformId } from '../types/platform.type';
import { EVENT_NAMES } from './event-catalog';

vi.mock('../services/correlation-context', () => ({
  getCorrelationId: () => 'test-correlation-id',
}));

describe('OrderFilledEvent', () => {
  it('should construct with all fields including isPaper and mixedMode', () => {
    const event = new OrderFilledEvent(
      'order-1',
      PlatformId.KALSHI,
      'buy',
      0.45,
      200,
      0.45,
      200,
      'pos-1',
      'corr-1',
      true,
      true,
    );

    expect(event.orderId).toBe('order-1');
    expect(event.platform).toBe(PlatformId.KALSHI);
    expect(event.side).toBe('buy');
    expect(event.price).toBe(0.45);
    expect(event.size).toBe(200);
    expect(event.fillPrice).toBe(0.45);
    expect(event.fillSize).toBe(200);
    expect(event.positionId).toBe('pos-1');
    expect(event.correlationId).toBe('corr-1');
    expect(event.isPaper).toBe(true);
    expect(event.mixedMode).toBe(true);
  });

  it('should default isPaper and mixedMode to false', () => {
    const event = new OrderFilledEvent(
      'order-1',
      PlatformId.KALSHI,
      'buy',
      0.45,
      200,
      0.45,
      200,
      'pos-1',
    );

    expect(event.isPaper).toBe(false);
    expect(event.mixedMode).toBe(false);
  });

  it('should match EVENT_NAMES.ORDER_FILLED catalog entry', () => {
    expect(EVENT_NAMES.ORDER_FILLED).toBe('execution.order.filled');
  });
});

describe('ExecutionFailedEvent', () => {
  it('should construct with all fields including isPaper and mixedMode', () => {
    const event = new ExecutionFailedEvent(
      2001,
      'Order rejected',
      'opp-1',
      { platform: 'kalshi' },
      'corr-1',
      true,
      false,
    );

    expect(event.reasonCode).toBe(2001);
    expect(event.reason).toBe('Order rejected');
    expect(event.opportunityId).toBe('opp-1');
    expect(event.context).toEqual({ platform: 'kalshi' });
    expect(event.correlationId).toBe('corr-1');
    expect(event.isPaper).toBe(true);
    expect(event.mixedMode).toBe(false);
  });

  it('should default isPaper and mixedMode to false', () => {
    const event = new ExecutionFailedEvent(2001, 'Order rejected', 'opp-1', {});

    expect(event.isPaper).toBe(false);
    expect(event.mixedMode).toBe(false);
  });

  it('should match EVENT_NAMES.EXECUTION_FAILED catalog entry', () => {
    expect(EVENT_NAMES.EXECUTION_FAILED).toBe('execution.order.failed');
  });
});

describe('SingleLegExposureEvent', () => {
  const filledLeg = {
    platform: PlatformId.KALSHI,
    orderId: 'order-kalshi-1',
    side: 'buy',
    price: 0.45,
    size: 200,
    fillPrice: 0.45,
    fillSize: 200,
  };

  const failedLeg = {
    platform: PlatformId.POLYMARKET,
    reason: 'Order rejected: insufficient liquidity',
    reasonCode: 2004,
    attemptedPrice: 0.55,
    attemptedSize: 182,
  };

  const currentPrices = {
    kalshi: { bestBid: 0.44, bestAsk: 0.46 },
    polymarket: { bestBid: 0.54, bestAsk: 0.56 },
  };

  const pnlScenarios = {
    closeNowEstimate: '-0.02',
    retryAtCurrentPrice: '0.06',
    holdRiskAssessment:
      'EXPOSED: $90.00 on kalshi (buy 200@0.45). No hedge. Immediate operator action recommended.',
  };

  const recommendedActions = [
    'Retry secondary leg at current sell price (0.54) — estimated 6% edge',
    'Monitor position via `GET /api/positions/pos-1` — Story 5.3 will add retry/close endpoints',
  ];

  it('should construct with all required fields', () => {
    const event = new SingleLegExposureEvent(
      'pos-1',
      'pair-1',
      0.08,
      filledLeg,
      failedLeg,
      currentPrices,
      pnlScenarios,
      recommendedActions,
      undefined,
      undefined,
      false,
      false,
    );

    expect(event.positionId).toBe('pos-1');
    expect(event.pairId).toBe('pair-1');
    expect(event.expectedEdge).toBe(0.08);
    expect(event.filledLeg).toEqual(filledLeg);
    expect(event.failedLeg).toEqual(failedLeg);
    expect(event.currentPrices).toEqual(currentPrices);
    expect(event.pnlScenarios).toEqual(pnlScenarios);
    expect(event.recommendedActions).toEqual(recommendedActions);
    expect(event.origin).toBeUndefined();
    expect(event.isPaper).toBe(false);
    expect(event.mixedMode).toBe(false);
  });

  it('should store isPaper and mixedMode when provided', () => {
    const event = new SingleLegExposureEvent(
      'pos-1',
      'pair-1',
      0.08,
      filledLeg,
      failedLeg,
      currentPrices,
      pnlScenarios,
      recommendedActions,
      undefined,
      undefined,
      true,
      true,
    );

    expect(event.isPaper).toBe(true);
    expect(event.mixedMode).toBe(true);
  });

  it('should store origin when provided', () => {
    const event = new SingleLegExposureEvent(
      'pos-1',
      'pair-1',
      0.08,
      filledLeg,
      failedLeg,
      currentPrices,
      pnlScenarios,
      recommendedActions,
      undefined,
      'manual_close',
      false,
      false,
    );

    expect(event.origin).toBe('manual_close');
  });

  it('should default isPaper and mixedMode to false', () => {
    const event = new SingleLegExposureEvent(
      'pos-1',
      'pair-1',
      0.08,
      filledLeg,
      failedLeg,
      currentPrices,
      pnlScenarios,
      recommendedActions,
    );

    expect(event.isPaper).toBe(false);
    expect(event.mixedMode).toBe(false);
  });

  it('should inherit BaseEvent timestamp and correlationId', () => {
    const event = new SingleLegExposureEvent(
      'pos-1',
      'pair-1',
      0.08,
      filledLeg,
      failedLeg,
      currentPrices,
      pnlScenarios,
      recommendedActions,
    );

    expect(event.timestamp).toBeInstanceOf(Date);
    expect(event.correlationId).toBe('test-correlation-id');
  });

  it('should use provided correlationId when given', () => {
    const event = new SingleLegExposureEvent(
      'pos-1',
      'pair-1',
      0.08,
      filledLeg,
      failedLeg,
      currentPrices,
      pnlScenarios,
      recommendedActions,
      'custom-correlation-id',
      undefined,
      false,
      false,
    );

    expect(event.correlationId).toBe('custom-correlation-id');
  });

  it('should support null prices in currentPrices', () => {
    const nullPrices = {
      kalshi: { bestBid: null, bestAsk: null },
      polymarket: { bestBid: null, bestAsk: null },
    };

    const event = new SingleLegExposureEvent(
      'pos-1',
      'pair-1',
      0.08,
      filledLeg,
      failedLeg,
      nullPrices,
      pnlScenarios,
      recommendedActions,
    );

    expect(event.currentPrices.kalshi.bestBid).toBeNull();
    expect(event.currentPrices.kalshi.bestAsk).toBeNull();
    expect(event.currentPrices.polymarket.bestBid).toBeNull();
    expect(event.currentPrices.polymarket.bestAsk).toBeNull();
  });

  it('should match EVENT_NAMES.SINGLE_LEG_EXPOSURE catalog entry', () => {
    expect(EVENT_NAMES.SINGLE_LEG_EXPOSURE).toBe(
      'execution.single_leg.exposure',
    );
  });
});

describe('SingleLegResolvedEvent', () => {
  const resolvedOrder = {
    orderId: 'order-retry-1',
    platform: PlatformId.POLYMARKET,
    status: 'filled',
    filledPrice: 0.55,
    filledQuantity: 182,
  };

  it('should construct with resolutionType "retried"', () => {
    const event = new SingleLegResolvedEvent(
      'pos-1',
      'pair-1',
      'retried',
      resolvedOrder,
      0.08,
      0.06,
      0.55,
      null,
      undefined,
      false,
      false,
    );

    expect(event.positionId).toBe('pos-1');
    expect(event.pairId).toBe('pair-1');
    expect(event.resolutionType).toBe('retried');
    expect(event.resolvedOrder).toEqual(resolvedOrder);
    expect(event.originalEdge).toBe(0.08);
    expect(event.newEdge).toBe(0.06);
    expect(event.retryPrice).toBe(0.55);
    expect(event.realizedPnl).toBeNull();
    expect(event.isPaper).toBe(false);
    expect(event.mixedMode).toBe(false);
  });

  it('should construct with resolutionType "closed"', () => {
    const event = new SingleLegResolvedEvent(
      'pos-2',
      'pair-1',
      'closed',
      { ...resolvedOrder, orderId: 'order-close-1' },
      0.08,
      null,
      null,
      '-5.50',
      undefined,
      false,
      false,
    );

    expect(event.resolutionType).toBe('closed');
    expect(event.newEdge).toBeNull();
    expect(event.retryPrice).toBeNull();
    expect(event.realizedPnl).toBe('-5.50');
  });

  it('should store isPaper and mixedMode when provided', () => {
    const event = new SingleLegResolvedEvent(
      'pos-1',
      'pair-1',
      'retried',
      resolvedOrder,
      0.08,
      0.06,
      0.55,
      null,
      undefined,
      true,
      true,
    );

    expect(event.isPaper).toBe(true);
    expect(event.mixedMode).toBe(true);
  });

  it('should default isPaper and mixedMode to false', () => {
    const event = new SingleLegResolvedEvent(
      'pos-1',
      'pair-1',
      'retried',
      resolvedOrder,
      0.08,
      0.06,
      0.55,
      null,
    );

    expect(event.isPaper).toBe(false);
    expect(event.mixedMode).toBe(false);
  });

  it('should inherit BaseEvent timestamp and correlationId', () => {
    const event = new SingleLegResolvedEvent(
      'pos-1',
      'pair-1',
      'retried',
      resolvedOrder,
      0.08,
      0.06,
      0.55,
      null,
    );

    expect(event.timestamp).toBeInstanceOf(Date);
    expect(event.correlationId).toBe('test-correlation-id');
  });

  it('should use provided correlationId when given', () => {
    const event = new SingleLegResolvedEvent(
      'pos-1',
      'pair-1',
      'retried',
      resolvedOrder,
      0.08,
      0.06,
      0.55,
      null,
      'custom-correlation-id',
      false,
      false,
    );

    expect(event.correlationId).toBe('custom-correlation-id');
  });

  it('should match EVENT_NAMES.SINGLE_LEG_RESOLVED catalog entry', () => {
    expect(EVENT_NAMES.SINGLE_LEG_RESOLVED).toBe(
      'execution.single_leg.resolved',
    );
  });

  it('should match EVENT_NAMES.SINGLE_LEG_EXPOSURE_REMINDER catalog entry', () => {
    expect(EVENT_NAMES.SINGLE_LEG_EXPOSURE_REMINDER).toBe(
      'execution.single_leg.exposure_reminder',
    );
  });
});

describe('ExitTriggeredEvent', () => {
  it('should construct with all required fields', () => {
    const event = new ExitTriggeredEvent(
      'pos-1',
      'pair-1',
      'take_profit',
      '0.03000000',
      '0.02500000',
      '0.02100000',
      'kalshi-close-order-1',
      'poly-close-order-1',
      undefined,
      false,
      false,
    );

    expect(event.positionId).toBe('pos-1');
    expect(event.pairId).toBe('pair-1');
    expect(event.exitType).toBe('take_profit');
    expect(event.initialEdge).toBe('0.03000000');
    expect(event.finalEdge).toBe('0.02500000');
    expect(event.realizedPnl).toBe('0.02100000');
    expect(event.kalshiCloseOrderId).toBe('kalshi-close-order-1');
    expect(event.polymarketCloseOrderId).toBe('poly-close-order-1');
    expect(event.isPaper).toBe(false);
    expect(event.mixedMode).toBe(false);
  });

  it('should store isPaper and mixedMode when provided', () => {
    const event = new ExitTriggeredEvent(
      'pos-1',
      'pair-1',
      'take_profit',
      '0.03',
      '0.02',
      '0.01',
      'k',
      'p',
      undefined,
      true,
      true,
    );

    expect(event.isPaper).toBe(true);
    expect(event.mixedMode).toBe(true);
  });

  it('should default isPaper and mixedMode to false', () => {
    const event = new ExitTriggeredEvent(
      'pos-1',
      'pair-1',
      'take_profit',
      '0.03',
      '0.02',
      '0.01',
      'k',
      'p',
    );

    expect(event.isPaper).toBe(false);
    expect(event.mixedMode).toBe(false);
  });

  it('should inherit BaseEvent timestamp and correlationId', () => {
    const event = new ExitTriggeredEvent(
      'pos-1',
      'pair-1',
      'stop_loss',
      '0.03',
      '-0.06',
      '-0.05500000',
      'k-order',
      'p-order',
    );

    expect(event.timestamp).toBeInstanceOf(Date);
    expect(event.correlationId).toBe('test-correlation-id');
  });

  it('should use provided correlationId when given', () => {
    const event = new ExitTriggeredEvent(
      'pos-1',
      'pair-1',
      'time_based',
      '0.03',
      '0.01',
      '0.00800000',
      'k-order',
      'p-order',
      'custom-corr-id',
      false,
      false,
    );

    expect(event.correlationId).toBe('custom-corr-id');
  });

  it('should match EVENT_NAMES.EXIT_TRIGGERED catalog entry', () => {
    expect(EVENT_NAMES.EXIT_TRIGGERED).toBe('execution.exit.triggered');
  });

  it('should accept all four exit types', () => {
    const types = ['take_profit', 'stop_loss', 'time_based', 'manual'] as const;
    for (const exitType of types) {
      const event = new ExitTriggeredEvent(
        'pos-1',
        'pair-1',
        exitType,
        '0.03',
        '0.02',
        '0.01',
        'k',
        'p',
        undefined,
        false,
        false,
      );
      expect(event.exitType).toBe(exitType);
    }
  });

  it('should default chunksCompleted and isPartial to undefined when not provided', () => {
    const event = new ExitTriggeredEvent(
      'pos-1',
      'pair-1',
      'take_profit',
      '0.03',
      '0.02',
      '0.01',
      'k',
      'p',
      undefined,
      false,
      false,
    );

    expect(event.chunksCompleted).toBeUndefined();
    expect(event.isPartial).toBeUndefined();
  });

  it('should store chunksCompleted and isPartial when provided', () => {
    const event = new ExitTriggeredEvent(
      'pos-1',
      'pair-1',
      'edge_evaporation',
      '0.03',
      '0.005',
      '0.02',
      'k-order',
      'p-order',
      undefined,
      false,
      false,
      3,
      true,
    );

    expect(event.chunksCompleted).toBe(3);
    expect(event.isPartial).toBe(true);
  });

  it('should match EVENT_NAMES.EXIT_PARTIAL_CHUNKED catalog entry', () => {
    expect(EVENT_NAMES.EXIT_PARTIAL_CHUNKED).toBe(
      'execution.exit.partial_chunked',
    );
  });
});

describe('ShadowComparisonEvent', () => {
  const baseFixedResult = { triggered: false, currentPnl: '0.01000000' };
  const baseModelResult = {
    triggered: false,
    currentPnl: '0.01000000',
    criteria: [
      {
        criterion: 'edge_evaporation',
        proximity: '0.75000000',
        triggered: false,
      },
      {
        criterion: 'model_confidence',
        proximity: '0.50000000',
        triggered: false,
      },
      { criterion: 'time_decay', proximity: '0.30000000', triggered: false },
      { criterion: 'risk_budget', proximity: '0.10000000', triggered: false },
      {
        criterion: 'liquidity_deterioration',
        proximity: '0.05000000',
        triggered: false,
      },
      {
        criterion: 'profit_capture',
        proximity: '0.60000000',
        triggered: false,
      },
    ],
  };

  it('should serialize all new fields via JSON round-trip', () => {
    const event = new ShadowComparisonEvent(
      'pos-1',
      'pair-1',
      baseFixedResult,
      baseModelResult,
      new Date('2026-03-24T12:00:00Z'),
      'hold',
      'hold',
      true,
      '0.02500000',
      null,
    );

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const serialized = JSON.parse(JSON.stringify(event));
    expect(serialized).toEqual(
      expect.objectContaining({
        positionId: 'pos-1',
        pairId: 'pair-1',
        shadowDecision: 'hold',
        modelDecision: 'hold',
        agreement: true,
        currentEdge: '0.02500000',
        divergenceDetail: null,
      }),
    );
  });

  it('should have divergenceDetail null when agreement is true', () => {
    const event = new ShadowComparisonEvent(
      'pos-1',
      'pair-1',
      baseFixedResult,
      baseModelResult,
      new Date('2026-03-24T12:00:00Z'),
      'hold',
      'hold',
      true,
      '0.02500000',
      null,
    );

    expect(event.agreement).toBe(true);
    expect(event.divergenceDetail).toBeNull();
  });

  it('should have divergenceDetail populated when agreement is false', () => {
    const divergence: DivergenceDetail = {
      triggeredCriteria: ['edge_evaporation'],
      proximityValues: {
        edge_evaporation: '1.00000000',
        model_confidence: '0.50000000',
        time_decay: '0.30000000',
        risk_budget: '0.10000000',
        liquidity_deterioration: '0.05000000',
        profit_capture: '0.60000000',
      },
      fixedType: null,
      modelType: 'edge_evaporation',
    };

    const event = new ShadowComparisonEvent(
      'pos-1',
      'pair-1',
      baseFixedResult,
      { ...baseModelResult, triggered: true, type: 'edge_evaporation' },
      new Date('2026-03-24T12:00:00Z'),
      'hold',
      'exit:edge_evaporation',
      false,
      '0.00300000',
      divergence,
    );

    expect(event.agreement).toBe(false);
    expect(event.divergenceDetail).toEqual(
      expect.objectContaining({
        triggeredCriteria: ['edge_evaporation'],
        fixedType: null,
        modelType: 'edge_evaporation',
      }),
    );
    expect(event.divergenceDetail!.proximityValues).toHaveProperty(
      'edge_evaporation',
      '1.00000000',
    );
  });

  it('should format decision as "hold" when not triggered', () => {
    const event = new ShadowComparisonEvent(
      'pos-1',
      'pair-1',
      baseFixedResult,
      baseModelResult,
      new Date('2026-03-24T12:00:00Z'),
      'hold',
      'hold',
      true,
      '0.02500000',
      null,
    );

    expect(event.shadowDecision).toBe('hold');
    expect(event.modelDecision).toBe('hold');
  });

  it('should format decision as "exit:<type>" when triggered', () => {
    const event = new ShadowComparisonEvent(
      'pos-1',
      'pair-1',
      { ...baseFixedResult, triggered: true, type: 'stop_loss' },
      { ...baseModelResult, triggered: true, type: 'edge_evaporation' },
      new Date('2026-03-24T12:00:00Z'),
      'exit:stop_loss',
      'exit:edge_evaporation',
      true,
      '0.00100000',
      null,
    );

    expect(event.shadowDecision).toBe('exit:stop_loss');
    expect(event.modelDecision).toBe('exit:edge_evaporation');
    // Both triggered → agreement is true even with different types
    expect(event.agreement).toBe(true);
  });

  it('should format decision as "exit:unknown" when triggered but type is undefined', () => {
    const event = new ShadowComparisonEvent(
      'pos-1',
      'pair-1',
      { triggered: true, currentPnl: '-0.05000000' },
      { ...baseModelResult, triggered: true },
      new Date('2026-03-24T12:00:00Z'),
      'exit:unknown',
      'exit:unknown',
      true,
      '0.00100000',
      null,
    );

    expect(event.shadowDecision).toBe('exit:unknown');
    expect(event.modelDecision).toBe('exit:unknown');
  });

  it('should preserve existing fields unchanged (backward-compatible)', () => {
    const ts = new Date('2026-03-24T12:00:00Z');
    const event = new ShadowComparisonEvent(
      'pos-1',
      'pair-1',
      baseFixedResult,
      baseModelResult,
      ts,
      'hold',
      'hold',
      true,
      '0.02500000',
      null,
      'corr-123',
    );

    expect(event.positionId).toBe('pos-1');
    expect(event.pairId).toBe('pair-1');
    expect(event.fixedResult).toEqual(baseFixedResult);
    expect(event.modelResult).toEqual(baseModelResult);
    expect(event.timestamp).toBe(ts);
    expect(event.correlationId).toBe('corr-123');
  });

  it('should match EVENT_NAMES.SHADOW_COMPARISON catalog entry', () => {
    expect(EVENT_NAMES.SHADOW_COMPARISON).toBe(
      'execution.exit.shadow_comparison',
    );
  });
});

describe('ComplianceBlockedEvent', () => {
  const violations = [
    {
      platform: 'KALSHI',
      category: 'assassination',
      rule: 'Blocked category: assassination',
    },
  ];

  it('should construct with all fields', () => {
    const event = new ComplianceBlockedEvent(
      'opp-1',
      'pair-1',
      violations,
      'corr-1',
      true,
      false,
    );

    expect(event.opportunityId).toBe('opp-1');
    expect(event.pairId).toBe('pair-1');
    expect(event.violations).toEqual(violations);
    expect(event.isPaper).toBe(true);
    expect(event.mixedMode).toBe(false);
    expect(event.correlationId).toBe('corr-1');
    expect(event.timestamp).toBeInstanceOf(Date);
  });

  it('should default isPaper and mixedMode to false', () => {
    const event = new ComplianceBlockedEvent('opp-1', 'pair-1', violations);

    expect(event.isPaper).toBe(false);
    expect(event.mixedMode).toBe(false);
  });

  it('should match EVENT_NAMES.COMPLIANCE_BLOCKED catalog entry', () => {
    expect(EVENT_NAMES.COMPLIANCE_BLOCKED).toBe('execution.compliance.blocked');
  });
});
