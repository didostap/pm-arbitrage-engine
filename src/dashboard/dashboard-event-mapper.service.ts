import { Injectable } from '@nestjs/common';
import type { PlatformHealth } from '../common/types/platform.type';
import type { OrderFilledEvent } from '../common/events/execution.events';
import type { ExecutionFailedEvent } from '../common/events/execution.events';
import type { SingleLegExposureEvent } from '../common/events/execution.events';
import type { ExitTriggeredEvent } from '../common/events/execution.events';
import type {
  LimitBreachedEvent,
  LimitApproachedEvent,
} from '../common/events/risk.events';
import type {
  WsEventEnvelope,
  WsHealthChangePayload,
  WsExecutionCompletePayload,
  WsAlertNewPayload,
  WsPositionUpdatePayload,
} from './dto';
import { WS_EVENTS } from './dto';

@Injectable()
export class DashboardEventMapperService {
  mapHealthEvent(
    health: PlatformHealth,
  ): WsEventEnvelope<WsHealthChangePayload> {
    const isDisconnected = health.status === 'disconnected';
    const isDegraded = health.status === 'degraded';

    return {
      event: WS_EVENTS.HEALTH_CHANGE,
      data: {
        platformId: health.platformId,
        status: health.status,
        apiConnected: !isDisconnected,
        dataFresh: !isDisconnected && !isDegraded,
        lastUpdate:
          health.lastHeartbeat?.toISOString() ?? new Date().toISOString(),
        mode: health.mode ?? 'live',
      },
      timestamp: new Date().toISOString(),
    };
  }

  mapExecutionCompleteEvent(
    event: OrderFilledEvent,
    status: 'filled' | 'failed',
  ): WsEventEnvelope<WsExecutionCompletePayload> {
    return {
      event: WS_EVENTS.EXECUTION_COMPLETE,
      data: {
        orderId: event.orderId,
        platform: event.platform,
        side: event.side,
        status,
        positionId: event.positionId,
        isPaper: event.isPaper,
      },
      timestamp: new Date().toISOString(),
    };
  }

  mapExecutionFailedEvent(
    event: ExecutionFailedEvent,
  ): WsEventEnvelope<WsExecutionCompletePayload> {
    return {
      event: WS_EVENTS.EXECUTION_COMPLETE,
      data: {
        orderId: event.opportunityId,
        platform: '',
        side: '',
        status: 'failed',
        positionId: null,
        isPaper: event.isPaper,
      },
      timestamp: new Date().toISOString(),
    };
  }

  mapSingleLegAlert(
    event: SingleLegExposureEvent,
  ): WsEventEnvelope<WsAlertNewPayload> {
    return {
      event: WS_EVENTS.ALERT_NEW,
      data: {
        id: `alert-sl-${event.positionId}`,
        type: 'single_leg_exposure',
        severity: 'critical',
        message: `Single-leg exposure on position ${event.positionId}: ${event.failedLeg.platform} leg failed (${event.failedLeg.reason})`,
        timestamp: new Date().toISOString(),
      },
      timestamp: new Date().toISOString(),
    };
  }

  mapLimitBreachedAlert(
    event: LimitBreachedEvent,
  ): WsEventEnvelope<WsAlertNewPayload> {
    return {
      event: WS_EVENTS.ALERT_NEW,
      data: {
        id: `alert-risk-${event.limitType}-${event.correlationId ?? Date.now()}`,
        type: 'risk_limit_breached',
        severity: 'critical',
        message: `Risk limit breached: ${event.limitType} at ${event.currentValue} (threshold: ${event.threshold})`,
        timestamp: new Date().toISOString(),
      },
      timestamp: new Date().toISOString(),
    };
  }

  mapLimitApproachedAlert(
    event: LimitApproachedEvent,
  ): WsEventEnvelope<WsAlertNewPayload> {
    return {
      event: WS_EVENTS.ALERT_NEW,
      data: {
        id: `alert-risk-approach-${event.limitType}-${event.correlationId ?? Date.now()}`,
        type: 'risk_limit_approached',
        severity: 'warning',
        message: `Risk limit approaching: ${event.limitType} at ${(event.percentUsed * 100).toFixed(1)}% (${event.currentValue}/${event.threshold})`,
        timestamp: new Date().toISOString(),
      },
      timestamp: new Date().toISOString(),
    };
  }

  mapPositionUpdate(
    event: ExitTriggeredEvent,
  ): WsEventEnvelope<WsPositionUpdatePayload> {
    return {
      event: WS_EVENTS.POSITION_UPDATE,
      data: {
        positionId: event.positionId,
        pairName: event.pairId,
        status: 'closed',
        currentEdge: event.finalEdge,
        unrealizedPnl: event.realizedPnl,
      },
      timestamp: new Date().toISOString(),
    };
  }
}
