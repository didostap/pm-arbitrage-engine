import {
  WebSocketGateway,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { OnModuleDestroy, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { ConfigService } from '@nestjs/config';
import type { IncomingMessage } from 'http';
import WebSocket from 'ws';
import type { PlatformHealth } from '../common/types/platform.type';
import type {
  OrderFilledEvent,
  ExecutionFailedEvent,
  SingleLegExposureEvent,
  ExitTriggeredEvent,
  ShadowComparisonEvent,
  ShadowDailySummaryEvent,
} from '../common/events/execution.events';
import type { BatchCompleteEvent } from '../common/events/batch.events';
import type {
  LimitBreachedEvent,
  LimitApproachedEvent,
  ClusterLimitBreachedEvent,
  AggregateClusterLimitBreachedEvent,
} from '../common/events/risk.events';
import type { MatchApprovedEvent } from '../common/events/match-approved.event';
import type { MatchRejectedEvent } from '../common/events/match-rejected.event';
import { EVENT_NAMES } from '../common/events/event-catalog';
import type { BankrollUpdatedEvent } from '../common/events/config.events';
import type { DataDivergenceEvent } from '../common/events/platform.events';
import type {
  TradingHaltedEvent,
  TradingResumedEvent,
} from '../common/events/system.events';
import { WS_EVENTS } from './dto/ws-events.dto';
import { DashboardEventMapperService } from './dashboard-event-mapper.service';

@WebSocketGateway({ path: '/ws' })
export class DashboardGateway
  implements OnGatewayConnection, OnGatewayDisconnect, OnModuleDestroy
{
  private readonly logger = new Logger(DashboardGateway.name);
  private readonly clients = new Set<WebSocket>();

  constructor(
    private readonly configService: ConfigService,
    private readonly mapper: DashboardEventMapperService,
  ) {}

  handleConnection(client: WebSocket, request: IncomingMessage): void {
    const token = this.extractToken(request);
    const expectedToken = this.configService.get<string>('OPERATOR_API_TOKEN');

    if (!token || token !== expectedToken) {
      this.logger.warn('WebSocket auth rejected');
      client.close(4001, 'Unauthorized');
      return;
    }

    this.clients.add(client);
    this.logger.log(`Dashboard client connected (total: ${this.clients.size})`);
  }

  handleDisconnect(client: WebSocket): void {
    this.clients.delete(client);
    this.logger.log(
      `Dashboard client disconnected (total: ${this.clients.size})`,
    );
  }

  onModuleDestroy(): void {
    this.clients.clear();
    this.logger.log('Dashboard gateway destroyed, all clients cleared');
  }

  getConnectedClientCount(): number {
    return this.clients.size;
  }

  // --- Event handlers (fan-out from EventEmitter2) ---

  @OnEvent(EVENT_NAMES.PLATFORM_HEALTH_UPDATED)
  @OnEvent(EVENT_NAMES.PLATFORM_HEALTH_DEGRADED)
  @OnEvent(EVENT_NAMES.PLATFORM_HEALTH_RECOVERED)
  broadcastHealthChange(payload: PlatformHealth): void {
    const envelope = this.mapper.mapHealthEvent(payload);
    this.broadcast(envelope);
  }

  @OnEvent(EVENT_NAMES.ORDER_FILLED)
  handleOrderFilled(event: OrderFilledEvent): void {
    const envelope = this.mapper.mapExecutionCompleteEvent(event, 'filled');
    this.broadcast(envelope);
  }

  @OnEvent(EVENT_NAMES.EXECUTION_FAILED)
  handleExecutionFailed(event: ExecutionFailedEvent): void {
    const envelope = this.mapper.mapExecutionFailedEvent(event);
    this.broadcast(envelope);
  }

  @OnEvent(EVENT_NAMES.SINGLE_LEG_EXPOSURE)
  handleSingleLegExposure(event: SingleLegExposureEvent): void {
    const envelope = this.mapper.mapSingleLegAlert(event);
    this.broadcast(envelope);
  }

  @OnEvent(EVENT_NAMES.LIMIT_BREACHED)
  handleLimitBreached(event: LimitBreachedEvent): void {
    const envelope = this.mapper.mapLimitBreachedAlert(event);
    this.broadcast(envelope);
  }

  @OnEvent(EVENT_NAMES.LIMIT_APPROACHED)
  handleLimitApproached(event: LimitApproachedEvent): void {
    const envelope = this.mapper.mapLimitApproachedAlert(event);
    this.broadcast(envelope);
  }

  @OnEvent(EVENT_NAMES.EXIT_TRIGGERED)
  handleExitTriggered(event: ExitTriggeredEvent): void {
    const envelope = this.mapper.mapPositionUpdate(event);
    this.broadcast(envelope);
  }

  @OnEvent(EVENT_NAMES.BATCH_COMPLETE)
  handleBatchComplete(event: BatchCompleteEvent): void {
    const envelope = this.mapper.mapBatchComplete(event);
    this.broadcast(envelope);
  }

  @OnEvent(EVENT_NAMES.MATCH_APPROVED)
  handleMatchApproved(event: MatchApprovedEvent): void {
    const envelope = this.mapper.mapMatchApprovedEvent(event);
    this.broadcast(envelope);
  }

  @OnEvent(EVENT_NAMES.MATCH_REJECTED)
  handleMatchRejected(event: MatchRejectedEvent): void {
    const envelope = this.mapper.mapMatchRejectedEvent(event);
    this.broadcast(envelope);
  }

  @OnEvent(EVENT_NAMES.CLUSTER_LIMIT_BREACHED)
  handleClusterLimitBreached(event: ClusterLimitBreachedEvent): void {
    const envelope = this.mapper.mapClusterLimitBreachedAlert(event);
    this.broadcast(envelope);
  }

  @OnEvent(EVENT_NAMES.AGGREGATE_CLUSTER_LIMIT_BREACHED)
  handleAggregateClusterLimitBreached(
    event: AggregateClusterLimitBreachedEvent,
  ): void {
    const envelope = this.mapper.mapAggregateClusterLimitBreachedAlert(event);
    this.broadcast(envelope);
  }

  @OnEvent(EVENT_NAMES.CONFIG_BANKROLL_UPDATED)
  handleBankrollUpdated(event: BankrollUpdatedEvent): void {
    this.broadcast({
      event: WS_EVENTS.CONFIG_BANKROLL_UPDATED,
      data: {
        previousValue: event.previousValue,
        newValue: event.newValue,
        updatedBy: event.updatedBy,
      },
      timestamp: new Date().toISOString(),
    });
  }

  @OnEvent(EVENT_NAMES.DATA_DIVERGENCE)
  handleDataDivergence(event: DataDivergenceEvent): void {
    const envelope = this.mapper.mapDivergenceAlert(event);
    this.broadcast(envelope);
  }

  @OnEvent(EVENT_NAMES.SYSTEM_TRADING_HALTED)
  handleTradingHalted(event: TradingHaltedEvent): void {
    // Extract all active reasons from event details when available (emitted by RiskManagerService),
    // fall back to single triggering reason (e.g., time_drift from TradingEngineService)
    const details =
      typeof event.details === 'object' && event.details !== null
        ? (event.details as Record<string, unknown>)
        : null;
    const reasons = Array.isArray(details?.activeReasons)
      ? (details.activeReasons as string[])
      : [event.reason];
    this.broadcast({
      event: WS_EVENTS.TRADING_HALT,
      data: {
        halted: true,
        reasons,
      },
      timestamp: event.haltTimestamp.toISOString(),
    });
  }

  @OnEvent(EVENT_NAMES.SYSTEM_TRADING_RESUMED)
  handleTradingResumed(event: TradingResumedEvent): void {
    this.broadcast({
      event: WS_EVENTS.TRADING_HALT,
      data: {
        halted: event.remainingReasons.length > 0,
        reasons: event.remainingReasons,
      },
      timestamp: event.resumeTimestamp.toISOString(),
    });
  }

  @OnEvent(EVENT_NAMES.SHADOW_COMPARISON)
  handleShadowComparison(event: ShadowComparisonEvent): void {
    this.broadcast({
      event: WS_EVENTS.SHADOW_COMPARISON,
      data: {
        positionId: event.positionId,
        pairId: event.pairId,
        modelTriggered: event.modelResult.triggered,
        fixedTriggered: event.fixedResult.triggered,
        modelPnl: event.modelResult.currentPnl,
        fixedPnl: event.fixedResult.currentPnl,
      },
      timestamp: new Date().toISOString(),
    });
  }

  @OnEvent(EVENT_NAMES.SHADOW_DAILY_SUMMARY)
  handleShadowDailySummary(event: ShadowDailySummaryEvent): void {
    this.broadcast({
      event: WS_EVENTS.SHADOW_DAILY_SUMMARY,
      data: {
        date: event.date,
        totalComparisons: event.totalComparisons,
        fixedTriggerCount: event.fixedTriggerCount,
        modelTriggerCount: event.modelTriggerCount,
        cumulativePnlDelta: event.cumulativePnlDelta,
      },
      timestamp: new Date().toISOString(),
    });
  }

  // --- Private helpers ---

  private broadcast(data: unknown): void {
    const message = JSON.stringify(data);
    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) {
        try {
          client.send(message);
        } catch (error) {
          this.logger.warn({
            message: 'Failed to send WebSocket message, removing dead client',
            data: {
              error: error instanceof Error ? error.message : String(error),
            },
          });
          this.clients.delete(client);
        }
      }
    }
  }

  private extractToken(request: IncomingMessage): string | null {
    try {
      const url = request.url;
      if (!url) return null;
      const parsed = new URL(url, 'http://localhost');
      return parsed.searchParams.get('token');
    } catch {
      return null;
    }
  }
}
