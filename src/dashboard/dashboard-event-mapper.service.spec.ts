import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DashboardEventMapperService } from './dashboard-event-mapper.service';
import { PlatformId } from '../common/types/platform.type';
import type { PlatformHealth } from '../common/types/platform.type';
import { OrderFilledEvent } from '../common/events/execution.events';
import { ExecutionFailedEvent } from '../common/events/execution.events';
import { SingleLegExposureEvent } from '../common/events/execution.events';
import {
  LimitBreachedEvent,
  LimitApproachedEvent,
} from '../common/events/risk.events';
import { ExitTriggeredEvent } from '../common/events/execution.events';
import { BatchCompleteEvent } from '../common/events/batch.events';
import { MatchApprovedEvent } from '../common/events/match-approved.event';
import { MatchRejectedEvent } from '../common/events/match-rejected.event';
import { DataDivergenceEvent } from '../common/events/platform.events';
import { asContractId } from '../common/types/branded.type';
import { WS_EVENTS } from './dto';

vi.mock('../common/services/correlation-context', () => ({
  getCorrelationId: () => 'test-correlation-id',
}));

describe('DashboardEventMapperService', () => {
  let mapper: DashboardEventMapperService;

  const mockConfigService = {
    get: vi.fn((key: string) => {
      if (key === 'AUTO_UNWIND_ENABLED') return false;
      return undefined;
    }),
  };

  beforeEach(() => {
    mapper = new DashboardEventMapperService(mockConfigService as never);
  });

  describe('mapHealthEvent', () => {
    it('should map PlatformHealth to WsHealthChangePayload', () => {
      const health: PlatformHealth = {
        platformId: PlatformId.KALSHI,
        status: 'healthy',
        lastHeartbeat: new Date('2026-03-01T12:00:00Z'),
        latencyMs: 50,
        mode: 'live',
      };

      const result = mapper.mapHealthEvent(health);

      expect(result.event).toBe(WS_EVENTS.HEALTH_CHANGE);
      expect(result.data.platformId).toBe('kalshi');
      expect(result.data.status).toBe('healthy');
      expect(result.data.apiConnected).toBe(true);
      expect(result.data.dataFresh).toBe(true);
      expect(result.data.lastUpdate).toBe('2026-03-01T12:00:00.000Z');
      expect(result.data.mode).toBe('live');
      expect(result.timestamp).toBeDefined();
    });

    it('should set apiConnected=false when disconnected', () => {
      const health: PlatformHealth = {
        platformId: PlatformId.POLYMARKET,
        status: 'disconnected',
        lastHeartbeat: null,
        latencyMs: null,
        mode: 'paper',
      };

      const result = mapper.mapHealthEvent(health);

      expect(result.data.apiConnected).toBe(false);
      expect(result.data.dataFresh).toBe(false);
      expect(result.data.mode).toBe('paper');
    });

    it('should set dataFresh=false when degraded', () => {
      const health: PlatformHealth = {
        platformId: PlatformId.KALSHI,
        status: 'degraded',
        lastHeartbeat: new Date(),
        latencyMs: 500,
        mode: 'live',
      };

      const result = mapper.mapHealthEvent(health);

      expect(result.data.apiConnected).toBe(true);
      expect(result.data.dataFresh).toBe(false);
    });
  });

  describe('mapOrderFilledEvent', () => {
    it('should map OrderFilledEvent to WsExecutionCompletePayload with status filled', () => {
      const event = new OrderFilledEvent(
        'order-1',
        PlatformId.KALSHI,
        'buy',
        0.55,
        100,
        0.55,
        100,
        'pos-1',
        'corr-1',
        false,
        false,
      );

      const result = mapper.mapExecutionCompleteEvent(event, 'filled');

      expect(result.event).toBe(WS_EVENTS.EXECUTION_COMPLETE);
      expect(result.data.orderId).toBe('order-1');
      expect(result.data.platform).toBe('kalshi');
      expect(result.data.side).toBe('buy');
      expect(result.data.status).toBe('filled');
      expect(result.data.positionId).toBe('pos-1');
      expect(result.data.isPaper).toBe(false);
    });
  });

  describe('mapExecutionFailedEvent', () => {
    it('should map ExecutionFailedEvent to WsExecutionCompletePayload with status failed', () => {
      const event = new ExecutionFailedEvent(
        2001,
        'Insufficient depth',
        'opp-1',
        { pairId: 'pair-1' },
        'corr-1',
        true,
        false,
      );

      const result = mapper.mapExecutionFailedEvent(event);

      expect(result.event).toBe(WS_EVENTS.EXECUTION_COMPLETE);
      expect(result.data.status).toBe('failed');
      expect(result.data.positionId).toBeNull();
      expect(result.data.isPaper).toBe(true);
    });
  });

  describe('mapAlertEvent', () => {
    it('should map SingleLegExposureEvent to alert', () => {
      const event = new SingleLegExposureEvent(
        'pos-1',
        'pair-1',
        0.012,
        {
          platform: PlatformId.KALSHI,
          orderId: 'o1',
          side: 'buy',
          price: 0.55,
          size: 100,
          fillPrice: 0.55,
          fillSize: 100,
        },
        {
          platform: PlatformId.POLYMARKET,
          reason: 'rejected',
          reasonCode: 2001,
          attemptedPrice: 0.45,
          attemptedSize: 100,
        },
        {
          kalshi: { bestBid: 0.54, bestAsk: 0.56 },
          polymarket: { bestBid: 0.44, bestAsk: 0.46 },
        },
        {
          closeNowEstimate: '-5.00',
          retryAtCurrentPrice: '2.00',
          holdRiskAssessment: 'moderate',
        },
        ['Retry second leg', 'Close position'],
        'corr-1',
        undefined,
        false,
        false,
      );

      const result = mapper.mapSingleLegAlert(event);

      expect(result.event).toBe(WS_EVENTS.ALERT_NEW);
      expect(result.data.type).toBe('single_leg_exposure');
      expect(result.data.severity).toBe('critical');
      expect(result.data.message).toContain('pos-1');
      expect(result.data.id).toBeDefined();
    });

    it('should map LimitBreachedEvent to alert', () => {
      const event = new LimitBreachedEvent('daily_loss', 500, 400);

      const result = mapper.mapLimitBreachedAlert(event);

      expect(result.event).toBe(WS_EVENTS.ALERT_NEW);
      expect(result.data.type).toBe('risk_limit_breached');
      expect(result.data.severity).toBe('critical');
    });

    it('should map LimitApproachedEvent to alert', () => {
      const event = new LimitApproachedEvent('daily_loss', 350, 400, 0.875);

      const result = mapper.mapLimitApproachedAlert(event);

      expect(result.event).toBe(WS_EVENTS.ALERT_NEW);
      expect(result.data.type).toBe('risk_limit_approached');
      expect(result.data.severity).toBe('warning');
    });
  });

  describe('mapPositionUpdateEvent', () => {
    it('should map ExitTriggeredEvent to lightweight position update', () => {
      const event = new ExitTriggeredEvent(
        'pos-1',
        'pair-1',
        'take_profit',
        '0.012',
        '0.002',
        '15.50',
        'ko-1',
        'po-1',
      );

      const result = mapper.mapPositionUpdate(event);

      expect(result.event).toBe(WS_EVENTS.POSITION_UPDATE);
      expect(result.data.positionId).toBe('pos-1');
      expect(result.data.status).toBe('closed');
      expect(result.data.timestamp).toBeDefined();
      // Verify lightweight — no P&L or price fields
      expect(result.data).not.toHaveProperty('currentEdge');
      expect(result.data).not.toHaveProperty('unrealizedPnl');
      expect(result.data).not.toHaveProperty('pairName');
    });
  });

  describe('mapMatchApprovedEvent', () => {
    it('should map MatchApprovedEvent to WsMatchPendingPayload with status approved', () => {
      const event = new MatchApprovedEvent(
        'match-1',
        'poly-123',
        'kalshi-456',
        'Looks correct',
      );

      const result = mapper.mapMatchApprovedEvent(event);

      expect(result.event).toBe(WS_EVENTS.MATCH_PENDING);
      expect(result.data.matchId).toBe('match-1');
      expect(result.data.status).toBe('approved');
      expect(result.data.confidenceScore).toBeNull();
      expect(result.timestamp).toBeDefined();
    });
  });

  describe('mapMatchRejectedEvent', () => {
    it('should map MatchRejectedEvent to WsMatchPendingPayload with status rejected', () => {
      const event = new MatchRejectedEvent(
        'match-2',
        'poly-789',
        'kalshi-012',
        'Not matching criteria',
      );

      const result = mapper.mapMatchRejectedEvent(event);

      expect(result.event).toBe(WS_EVENTS.MATCH_PENDING);
      expect(result.data.matchId).toBe('match-2');
      expect(result.data.status).toBe('rejected');
      expect(result.data.confidenceScore).toBeNull();
      expect(result.timestamp).toBeDefined();
    });
  });

  describe('mapBatchComplete', () => {
    it('should map BatchCompleteEvent to WsBatchCompletePayload', () => {
      const event = new BatchCompleteEvent('batch-abc', [
        {
          positionId: 'pos-1',
          pairName: 'BTC > 50k',
          status: 'success',
          realizedPnl: '0.01500000',
        },
        {
          positionId: 'pos-2',
          pairName: 'ETH > 3k',
          status: 'failure',
          error: 'Order book empty',
        },
        {
          positionId: 'pos-3',
          pairName: 'SOL > 100',
          status: 'rate_limited',
          error: 'Rate limit exceeded',
        },
      ]);

      const result = mapper.mapBatchComplete(event);

      expect(result.event).toBe(WS_EVENTS.BATCH_COMPLETE);
      expect(result.data.batchId).toBe('batch-abc');
      expect(result.data.results).toHaveLength(3);
      expect(result.data.results[0]).toEqual({
        positionId: 'pos-1',
        pairName: 'BTC > 50k',
        status: 'success',
        realizedPnl: '0.01500000',
        error: undefined,
      });
      expect(result.data.results[1].status).toBe('failure');
      expect(result.data.results[2].status).toBe('rate_limited');
      expect(result.timestamp).toBeDefined();
    });

    it('should handle empty results', () => {
      const event = new BatchCompleteEvent('batch-empty', []);

      const result = mapper.mapBatchComplete(event);

      expect(result.data.batchId).toBe('batch-empty');
      expect(result.data.results).toEqual([]);
    });
  });

  describe('mapDivergenceAlert', () => {
    it('should map DataDivergenceEvent to divergence.alert WS envelope (AC #12)', () => {
      const event = new DataDivergenceEvent(
        PlatformId.KALSHI,
        asContractId('TEST-DIV'),
        '0.50',
        '0.55',
        '2026-03-15T00:00:00Z',
        '0.47',
        '0.52',
        '2026-03-15T00:01:30Z',
        '0.03',
        90000,
      );

      const result = mapper.mapDivergenceAlert(event);

      expect(result.event).toBe('divergence.alert');
      expect(result.data.platformId).toBe(PlatformId.KALSHI);
      expect(result.data.contractId).toBe('TEST-DIV');
      expect(result.data.priceDelta).toBe('0.03');
      expect(result.data.stalenessDeltaMs).toBe(90000);
      expect(result.timestamp).toBeDefined();
    });
  });

  describe('execution sequencing in WS events (Story 10.4)', () => {
    it('[P0] should include sequencing metadata in execution.complete WS payload', () => {
      // AC#5: WS events must surface sequencing info
      const event = new OrderFilledEvent(
        'order-1' as any,
        PlatformId.KALSHI,
        'buy',
        0.45,
        100,
        0.45,
        100,
        'pos-1' as any,
        'corr-1',
        false,
        false,
        '0.0175',
        '0.003',
        {
          primaryLeg: 'kalshi',
          reason: 'latency_override',
          kalshiLatencyMs: 100,
          polymarketLatencyMs: 400,
        },
      );

      const result = mapper.mapExecutionCompleteEvent(event, 'filled');

      expect(result.event).toBe(WS_EVENTS.EXECUTION_COMPLETE);
      expect(result.data.orderId).toBe('order-1');
      expect(result.data.sequencingReason).toBe('latency_override');
      expect(result.data.primaryLeg).toBe('kalshi');
    });

    it('[P1] should map OrderFilledEvent with full metadata to WS payload without throwing', () => {
      // Verifies backward compatibility when sequencingDecision is absent
      const event = new OrderFilledEvent(
        'order-2' as any,
        PlatformId.POLYMARKET,
        'sell',
        0.55,
        200,
        0.54,
        200,
        'pos-2' as any,
        'corr-2',
        true,
        false,
        '0.02',
        null,
      );

      const result = mapper.mapExecutionCompleteEvent(event, 'filled');

      expect(result.event).toBe(WS_EVENTS.EXECUTION_COMPLETE);
      expect(result.data.platform).toBe('polymarket');
      expect(result.data.isPaper).toBe(true);
      expect(result.data.status).toBe('filled');
      // No sequencingDecision → fields absent
      expect(result.data.sequencingReason).toBeUndefined();
      expect(result.data.primaryLeg).toBeUndefined();
    });
  });
});
