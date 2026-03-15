import { Injectable } from '@nestjs/common';
import type { PlatformHealth } from '../common/types/platform.type';
import type { OrderFilledEvent } from '../common/events/execution.events';
import type { ExecutionFailedEvent } from '../common/events/execution.events';
import type { SingleLegExposureEvent } from '../common/events/execution.events';
import type { ExitTriggeredEvent } from '../common/events/execution.events';
import type { BatchCompleteEvent } from '../common/events/batch.events';
import type {
  LimitBreachedEvent,
  LimitApproachedEvent,
  ClusterLimitBreachedEvent,
  AggregateClusterLimitBreachedEvent,
} from '../common/events/risk.events';
import type { MatchApprovedEvent } from '../common/events/match-approved.event';
import type { MatchRejectedEvent } from '../common/events/match-rejected.event';
import type { DataDivergenceEvent } from '../common/events/platform.events';
import type {
  WsEventEnvelope,
  WsHealthChangePayload,
  WsExecutionCompletePayload,
  WsAlertNewPayload,
  WsPositionUpdatePayload,
  WsMatchPendingPayload,
  WsBatchCompletePayload,
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
        status: 'closed',
        timestamp: new Date().toISOString(),
      },
      timestamp: new Date().toISOString(),
    };
  }

  mapMatchApprovedEvent(
    event: MatchApprovedEvent,
  ): WsEventEnvelope<WsMatchPendingPayload> {
    return {
      event: WS_EVENTS.MATCH_PENDING,
      data: {
        matchId: event.matchId,
        status: 'approved',
        confidenceScore: null,
      },
      timestamp: new Date().toISOString(),
    };
  }

  mapMatchRejectedEvent(
    event: MatchRejectedEvent,
  ): WsEventEnvelope<WsMatchPendingPayload> {
    return {
      event: WS_EVENTS.MATCH_PENDING,
      data: {
        matchId: event.matchId,
        status: 'rejected',
        confidenceScore: null,
      },
      timestamp: new Date().toISOString(),
    };
  }

  mapClusterLimitBreachedAlert(
    event: ClusterLimitBreachedEvent,
  ): WsEventEnvelope<WsAlertNewPayload> {
    return {
      event: WS_EVENTS.ALERT_NEW,
      data: {
        id: `alert-cluster-breach-${event.clusterId}-${event.correlationId ?? Date.now()}`,
        type: 'cluster_limit_breached',
        severity: 'critical',
        message: `Cluster "${event.clusterName}" exposure ${(event.currentExposurePct * 100).toFixed(1)}% breached ${(event.hardLimitPct * 100).toFixed(0)}% limit`,
        timestamp: new Date().toISOString(),
      },
      timestamp: new Date().toISOString(),
    };
  }

  mapAggregateClusterLimitBreachedAlert(
    event: AggregateClusterLimitBreachedEvent,
  ): WsEventEnvelope<WsAlertNewPayload> {
    return {
      event: WS_EVENTS.ALERT_NEW,
      data: {
        id: `alert-cluster-aggregate-${event.correlationId ?? Date.now()}`,
        type: 'aggregate_cluster_limit_breached',
        severity: 'critical',
        message: `Aggregate cluster exposure ${(event.aggregateExposurePct * 100).toFixed(1)}% breached ${(event.aggregateLimitPct * 100).toFixed(0)}% limit`,
        timestamp: new Date().toISOString(),
      },
      timestamp: new Date().toISOString(),
    };
  }

  mapBatchComplete(
    event: BatchCompleteEvent,
  ): WsEventEnvelope<WsBatchCompletePayload> {
    return {
      event: WS_EVENTS.BATCH_COMPLETE,
      data: {
        batchId: event.batchId,
        results: event.results.map((r) => ({
          positionId: r.positionId,
          pairName: r.pairName,
          status: r.status,
          realizedPnl: r.realizedPnl,
          error: r.error,
        })),
      },
      timestamp: new Date().toISOString(),
    };
  }

  mapDivergenceAlert(event: DataDivergenceEvent): WsEventEnvelope<{
    platformId: string;
    contractId: string;
    priceDelta: string;
    stalenessDeltaMs: number;
  }> {
    return {
      event: WS_EVENTS.DIVERGENCE_ALERT,
      data: {
        platformId: event.platformId,
        contractId: event.contractId as string,
        priceDelta: event.priceDelta,
        stalenessDeltaMs: event.stalenessDeltaMs,
      },
      timestamp: new Date().toISOString(),
    };
  }
}
