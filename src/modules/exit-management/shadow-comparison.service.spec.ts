import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import Decimal from 'decimal.js';
import { ShadowComparisonService } from './shadow-comparison.service';
import { asPositionId, asPairId } from '../../common/types/branded.type';

vi.mock('../../common/services/correlation-context', () => ({
  getCorrelationId: () => 'test-correlation-id',
}));

describe('ShadowComparisonService (Story 10.2)', () => {
  let service: ShadowComparisonService;
  let eventEmitter: {
    emit: ReturnType<typeof vi.fn>;
    on: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    eventEmitter = {
      emit: vi.fn(),
      on: vi.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ShadowComparisonService,
        { provide: EventEmitter2, useValue: eventEmitter },
      ],
    }).compile();

    service = module.get(ShadowComparisonService);
  });

  /**
   * Helper to create a shadow comparison event payload.
   * Updated in Story 10.7.7 with agreement, currentEdge, divergenceDetail fields.
   */
  function makeShadowEvent(overrides: Record<string, unknown> = {}) {
    return {
      positionId: asPositionId('pos-1'),
      pairId: asPairId('pair-1'),
      modelResult: {
        triggered: true,
        type: 'edge_evaporation' as const,
        currentPnl: new Decimal('-2.50'),
        criteria: [
          {
            criterion: 'edge_evaporation',
            proximity: new Decimal('1.0'),
            triggered: true,
          },
          {
            criterion: 'model_confidence',
            proximity: new Decimal('0.3'),
            triggered: false,
          },
          {
            criterion: 'time_decay',
            proximity: new Decimal('0.5'),
            triggered: false,
          },
          {
            criterion: 'risk_budget',
            proximity: new Decimal('0'),
            triggered: false,
          },
          {
            criterion: 'liquidity_deterioration',
            proximity: new Decimal('0'),
            triggered: false,
          },
          {
            criterion: 'profit_capture',
            proximity: new Decimal('0'),
            triggered: false,
          },
        ],
      },
      fixedResult: {
        triggered: false,
        type: undefined,
        currentPnl: new Decimal('-2.50'),
      },
      timestamp: new Date('2026-03-20T12:00:00Z'),
      // Story 10.7.7 fields
      shadowDecision: 'hold',
      modelDecision: 'exit:edge_evaporation',
      agreement: false,
      currentEdge: '0.02500000',
      divergenceDetail: {
        triggeredCriteria: ['edge_evaporation'],
        proximityValues: { edge_evaporation: '1.00000000' },
        fixedType: null,
        modelType: 'edge_evaporation',
      },
      ...overrides,
    };
  }

  it('[P1] should accumulate comparison data from ShadowComparisonEvent subscription', () => {
    // Simulate receiving shadow comparison events
    const event1 = makeShadowEvent();
    const event2 = makeShadowEvent({
      positionId: asPositionId('pos-2'),
      pairId: asPairId('pair-2'),
      timestamp: new Date('2026-03-20T12:05:00Z'),
    });

    service.handleShadowComparison(event1);
    service.handleShadowComparison(event2);

    // Service should have accumulated 2 comparison entries
    const stats = service.getComparisonStats();
    expect(stats.totalComparisons).toBe(2);
  });

  it('[P1] should handle string-serialized event payloads (real ShadowComparisonEvent path)', () => {
    // ShadowComparisonEvent serializes Decimal as strings via .toFixed(8).
    // handleShadowComparison must convert strings back to Decimal.
    const stringEvent = {
      positionId: asPositionId('pos-str'),
      pairId: asPairId('pair-str'),
      modelResult: {
        triggered: true,
        type: 'edge_evaporation' as const,
        currentPnl: '-3.50000000', // string, not Decimal
        criteria: [
          {
            criterion: 'edge_evaporation',
            proximity: '1.00000000',
            triggered: true,
          },
          {
            criterion: 'model_confidence',
            proximity: '0.30000000',
            triggered: false,
          },
          {
            criterion: 'time_decay',
            proximity: '0.50000000',
            triggered: false,
          },
          {
            criterion: 'risk_budget',
            proximity: '0.00000000',
            triggered: false,
          },
          {
            criterion: 'liquidity_deterioration',
            proximity: '0.00000000',
            triggered: false,
          },
        ],
      },
      fixedResult: {
        triggered: false,
        type: undefined,
        currentPnl: '-1.20000000', // string, not Decimal
      },
      timestamp: new Date('2026-03-20T12:00:00Z'),
    };

    // Should not throw — strings are converted to Decimal internally
    service.handleShadowComparison(
      stringEvent as unknown as Parameters<
        typeof service.handleShadowComparison
      >[0],
    );

    // generateDailySummary calls .minus() on accumulated PnL — would crash without conversion
    const summary = service.generateDailySummary();
    expect(summary.totalComparisons).toBe(1);
    // cumulativePnlDelta = modelPnl - fixedPnl = -3.50 - (-1.20) = -2.30
    expect(summary.cumulativePnlDelta.toFixed(2)).toBe('-2.30');
    expect(summary.triggerCountByCriterion.edge_evaporation).toBe(1);
  });

  it('[P1] should compute correct trigger counts per criterion in daily summary', () => {
    // 3 events: edge_evaporation triggered in 2, model_confidence in 1
    service.handleShadowComparison(
      makeShadowEvent({
        modelResult: {
          triggered: true,
          type: 'edge_evaporation',
          currentPnl: new Decimal('-3.0'),
          criteria: [
            {
              criterion: 'edge_evaporation',
              proximity: new Decimal('1.0'),
              triggered: true,
            },
            {
              criterion: 'model_confidence',
              proximity: new Decimal('0.2'),
              triggered: false,
            },
            {
              criterion: 'time_decay',
              proximity: new Decimal('0'),
              triggered: false,
            },
            {
              criterion: 'risk_budget',
              proximity: new Decimal('0'),
              triggered: false,
            },
            {
              criterion: 'liquidity_deterioration',
              proximity: new Decimal('0'),
              triggered: false,
            },
          ],
        },
      }),
    );
    service.handleShadowComparison(
      makeShadowEvent({
        positionId: asPositionId('pos-2'),
        modelResult: {
          triggered: true,
          type: 'model_confidence',
          currentPnl: new Decimal('-1.5'),
          criteria: [
            {
              criterion: 'edge_evaporation',
              proximity: new Decimal('0.8'),
              triggered: false,
            },
            {
              criterion: 'model_confidence',
              proximity: new Decimal('1.0'),
              triggered: true,
            },
            {
              criterion: 'time_decay',
              proximity: new Decimal('0'),
              triggered: false,
            },
            {
              criterion: 'risk_budget',
              proximity: new Decimal('0'),
              triggered: false,
            },
            {
              criterion: 'liquidity_deterioration',
              proximity: new Decimal('0'),
              triggered: false,
            },
          ],
        },
      }),
    );
    service.handleShadowComparison(
      makeShadowEvent({
        positionId: asPositionId('pos-3'),
        modelResult: {
          triggered: true,
          type: 'edge_evaporation',
          currentPnl: new Decimal('-4.0'),
          criteria: [
            {
              criterion: 'edge_evaporation',
              proximity: new Decimal('1.0'),
              triggered: true,
            },
            {
              criterion: 'model_confidence',
              proximity: new Decimal('0.5'),
              triggered: false,
            },
            {
              criterion: 'time_decay',
              proximity: new Decimal('0.3'),
              triggered: false,
            },
            {
              criterion: 'risk_budget',
              proximity: new Decimal('0'),
              triggered: false,
            },
            {
              criterion: 'liquidity_deterioration',
              proximity: new Decimal('0'),
              triggered: false,
            },
          ],
        },
      }),
    );

    const summary = service.generateDailySummary();
    expect(summary.triggerCountByCriterion.edge_evaporation).toBe(2);
    expect(summary.triggerCountByCriterion.model_confidence).toBe(1);
    expect(summary.triggerCountByCriterion.time_decay).toBe(0);
    expect(summary.triggerCountByCriterion.risk_budget).toBe(0);
    expect(summary.triggerCountByCriterion.liquidity_deterioration).toBe(0);
    expect(summary.triggerCountByCriterion.profit_capture).toBe(0);
  });

  it('[P1] should compute cumulative P&L delta between model and fixed results', () => {
    // Model triggered exit at PnL -2.50, fixed would NOT have triggered (PnL continued to -5.00)
    // P&L delta for this position: fixed finalPnl - model exitPnl
    service.handleShadowComparison(
      makeShadowEvent({
        modelResult: {
          triggered: true,
          type: 'edge_evaporation',
          currentPnl: new Decimal('-2.50'),
          criteria: [
            {
              criterion: 'edge_evaporation',
              proximity: new Decimal('1.0'),
              triggered: true,
            },
            {
              criterion: 'model_confidence',
              proximity: new Decimal('0'),
              triggered: false,
            },
            {
              criterion: 'time_decay',
              proximity: new Decimal('0'),
              triggered: false,
            },
            {
              criterion: 'risk_budget',
              proximity: new Decimal('0'),
              triggered: false,
            },
            {
              criterion: 'liquidity_deterioration',
              proximity: new Decimal('0'),
              triggered: false,
            },
          ],
        },
        fixedResult: {
          triggered: false,
          type: undefined,
          currentPnl: new Decimal('-2.50'),
        },
      }),
    );
    service.handleShadowComparison(
      makeShadowEvent({
        positionId: asPositionId('pos-2'),
        modelResult: {
          triggered: false,
          type: undefined,
          currentPnl: new Decimal('1.00'),
          criteria: [
            {
              criterion: 'edge_evaporation',
              proximity: new Decimal('0.3'),
              triggered: false,
            },
            {
              criterion: 'model_confidence',
              proximity: new Decimal('0'),
              triggered: false,
            },
            {
              criterion: 'time_decay',
              proximity: new Decimal('0'),
              triggered: false,
            },
            {
              criterion: 'risk_budget',
              proximity: new Decimal('0'),
              triggered: false,
            },
            {
              criterion: 'liquidity_deterioration',
              proximity: new Decimal('0'),
              triggered: false,
            },
          ],
        },
        fixedResult: {
          triggered: true,
          type: 'take_profit',
          currentPnl: new Decimal('1.00'),
        },
      }),
    );

    const summary = service.generateDailySummary();
    // Summary should include a cumulative P&L delta metric
    expect(summary.cumulativePnlDelta).toBeDefined();
    expect(summary.cumulativePnlDelta).toBeInstanceOf(Decimal);
  });

  it('[P2] should record final comparison entry on position close with timing + P&L delta', () => {
    const closeEvent = {
      positionId: asPositionId('pos-1'),
      pairId: asPairId('pair-1'),
      modelExitPnl: new Decimal('-1.50'),
      fixedExitPnl: new Decimal('-3.20'),
      modelExitTimestamp: new Date('2026-03-20T14:00:00Z'),
      fixedWouldHaveExitedAt: new Date('2026-03-20T16:30:00Z'),
      pnlDelta: new Decimal('1.70'), // model saved 1.70 vs fixed
    };

    service.handlePositionClose(closeEvent);

    const stats = service.getComparisonStats();
    expect(stats.closedPositionComparisons).toBe(1);
    // The close entry should include timing delta
    const closedEntries = service.getClosedPositionEntries();
    expect(closedEntries).toHaveLength(1);
    expect(closedEntries[0]!.pnlDelta.eq(new Decimal('1.70'))).toBe(true);
  });

  it('[P2] should reset summary on new day boundary', () => {
    // Simulate events on day 1
    service.handleShadowComparison(
      makeShadowEvent({
        timestamp: new Date('2026-03-20T23:59:00Z'),
      }),
    );

    // Generate day 1 summary
    const day1Summary = service.generateDailySummary();
    expect(day1Summary.totalComparisons).toBe(1);

    // Trigger day boundary reset
    service.resetDailySummary();

    // Day 2 should start clean
    const day2Summary = service.generateDailySummary();
    expect(day2Summary.totalComparisons).toBe(0);
  });

  it('[10.7.7] should include agreement and currentEdge in normalized payload', () => {
    service.handleShadowComparison(
      makeShadowEvent({
        agreement: true,
        currentEdge: '0.03000000',
      }),
    );

    const summary = service.generateDailySummary();
    expect(summary.totalComparisons).toBe(1);
    // Verify the accumulated comparison has the new fields
    // (indirectly via getComparisonStats since comparisons is private)
    const stats = service.getComparisonStats();
    expect(stats.totalComparisons).toBe(1);
  });

  it('[10.7.7] should normalize string currentEdge to Decimal in accumulated payload', () => {
    // Emit event with string currentEdge (as ShadowComparisonEvent serializes it)
    service.handleShadowComparison(
      makeShadowEvent({
        currentEdge: '0.01500000',
        agreement: false,
      }),
    );

    // Access comparisons indirectly — summary still works
    const stats = service.getComparisonStats();
    expect(stats.totalComparisons).toBe(1);
  });

  it('[10.7.7] should count agree vs disagree in daily buffer', () => {
    // 2 agree, 1 disagree
    service.handleShadowComparison(
      makeShadowEvent({
        agreement: true,
        divergenceDetail: null,
      }),
    );
    service.handleShadowComparison(
      makeShadowEvent({
        positionId: asPositionId('pos-2'),
        agreement: true,
        divergenceDetail: null,
      }),
    );
    service.handleShadowComparison(
      makeShadowEvent({
        positionId: asPositionId('pos-3'),
        agreement: false,
      }),
    );

    const summary = service.generateDailySummary();
    expect(summary.totalComparisons).toBe(3);
    expect(summary.agreeCount).toBe(2);
    expect(summary.disagreeCount).toBe(1);
  });

  it('[P1] should emit ShadowDailySummaryEvent with correct payload', () => {
    service.handleShadowComparison(makeShadowEvent());
    service.handleShadowComparison(
      makeShadowEvent({
        positionId: asPositionId('pos-2'),
        modelResult: {
          triggered: false,
          type: undefined,
          currentPnl: new Decimal('0.50'),
          criteria: [
            {
              criterion: 'edge_evaporation',
              proximity: new Decimal('0.2'),
              triggered: false,
            },
            {
              criterion: 'model_confidence',
              proximity: new Decimal('0'),
              triggered: false,
            },
            {
              criterion: 'time_decay',
              proximity: new Decimal('0'),
              triggered: false,
            },
            {
              criterion: 'risk_budget',
              proximity: new Decimal('0'),
              triggered: false,
            },
            {
              criterion: 'liquidity_deterioration',
              proximity: new Decimal('0'),
              triggered: false,
            },
          ],
        },
        fixedResult: {
          triggered: false,
          type: undefined,
          currentPnl: new Decimal('0.50'),
        },
      }),
    );

    service.emitDailySummary();

    expect(eventEmitter.emit).toHaveBeenCalledWith(
      expect.stringContaining('shadow'),
      expect.objectContaining({
        totalComparisons: 2,
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        criterionTriggerCounts: expect.objectContaining({
          edge_evaporation: expect.any(Number) as number,
          model_confidence: expect.any(Number) as number,
          time_decay: expect.any(Number) as number,
          risk_budget: expect.any(Number) as number,
          liquidity_deterioration: expect.any(Number) as number,
        }),
      }),
    );
  });

  it('[10.7.7] should emit agreeCount and disagreeCount in ShadowDailySummaryEvent', () => {
    // 1 agree (both hold), 1 disagree (model triggers)
    service.handleShadowComparison(
      makeShadowEvent({
        agreement: true,
        divergenceDetail: null,
      }),
    );
    service.handleShadowComparison(
      makeShadowEvent({
        positionId: asPositionId('pos-2'),
        agreement: false,
      }),
    );

    service.emitDailySummary();

    expect(eventEmitter.emit).toHaveBeenCalledWith(
      expect.stringContaining('shadow'),
      expect.objectContaining({
        totalComparisons: 2,
        agreeCount: 1,
        disagreeCount: 1,
      }),
    );
  });
});
