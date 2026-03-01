import { describe, it, expect } from 'vitest';
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
import { WS_EVENTS } from './dto';

describe('DashboardEventMapperService', () => {
  let mapper: DashboardEventMapperService;

  beforeEach(() => {
    mapper = new DashboardEventMapperService();
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
    it('should map ExitTriggeredEvent to position update', () => {
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
    });
  });
});
