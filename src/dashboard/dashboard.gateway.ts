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
  AutoUnwindEvent,
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
import type {
  BankrollUpdatedEvent,
  ConfigSettingsUpdatedEvent,
} from '../common/events/config.events';
import type { DataDivergenceEvent } from '../common/events/platform.events';
import type {
  TradingHaltedEvent,
  TradingResumedEvent,
} from '../common/events/system.events';
import type {
  BacktestRunCompletedEvent,
  BacktestRunFailedEvent,
  BacktestEngineStateChangedEvent,
  BacktestSensitivityCompletedEvent,
  BacktestSensitivityProgressEvent,
  IncrementalDataFreshnessUpdatedEvent,
  IncrementalDataStaleEvent,
} from '../common/events/backtesting.events';
import type { ExternalPairIngestionRunCompletedEvent } from '../common/events/external-pair-ingestion-run-completed.event';
import { WS_EVENTS } from './dto/ws-events.dto';
import { DashboardEventMapperService } from './dashboard-event-mapper.service';

@WebSocketGateway({ path: '/ws' })
export class DashboardGateway
  implements OnGatewayConnection, OnGatewayDisconnect, OnModuleDestroy
{
  private readonly logger = new Logger(DashboardGateway.name);
  /** Cleanup: .add() on connect, .delete() on disconnect, .clear() on onModuleDestroy */
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
        // Story 10.7.7 — decision summary fields
        shadowDecision: event.shadowDecision,
        modelDecision: event.modelDecision,
        agreement: event.agreement,
        currentEdge: event.currentEdge,
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
        // Story 10.7.7 — agreement aggregation
        agreeCount: event.agreeCount,
        disagreeCount: event.disagreeCount,
      },
      timestamp: new Date().toISOString(),
    });
  }

  @OnEvent(EVENT_NAMES.AUTO_UNWIND)
  handleAutoUnwind(event: AutoUnwindEvent): void {
    const envelope = this.mapper.mapAutoUnwindAlert(event);
    this.broadcast(envelope);
  }

  @OnEvent(EVENT_NAMES.CONFIG_SETTINGS_UPDATED)
  handleConfigSettingsUpdated(event: ConfigSettingsUpdatedEvent): void {
    const changedKeys = Object.keys(event.changedFields);
    const newValues: Record<string, unknown> = {};
    for (const key of changedKeys) {
      const entry = event.changedFields[key];
      if (entry) {
        newValues[key] = entry.current;
      }
    }
    this.broadcast({
      event: WS_EVENTS.CONFIG_SETTINGS_UPDATED,
      data: {
        changedFields: changedKeys,
        newValues,
        updatedBy: event.updatedBy,
      },
      timestamp: event.timestamp.toISOString(),
    });
  }

  // --- Backtesting event handlers ---

  @OnEvent(EVENT_NAMES.BACKTEST_RUN_COMPLETED)
  handleBacktestRunCompleted(event: BacktestRunCompletedEvent): void {
    this.broadcast({
      event: WS_EVENTS.BACKTEST_RUN_COMPLETED,
      data: { runId: event.runId, metrics: event.metrics },
      timestamp: new Date().toISOString(),
    });
  }

  @OnEvent(EVENT_NAMES.BACKTEST_RUN_FAILED)
  handleBacktestRunFailed(event: BacktestRunFailedEvent): void {
    this.broadcast({
      event: WS_EVENTS.BACKTEST_RUN_FAILED,
      data: {
        runId: event.runId,
        errorCode: event.errorCode,
        message: event.message,
      },
      timestamp: new Date().toISOString(),
    });
  }

  @OnEvent(EVENT_NAMES.BACKTEST_ENGINE_STATE_CHANGED)
  handleBacktestStateChanged(event: BacktestEngineStateChangedEvent): void {
    this.broadcast({
      event: WS_EVENTS.BACKTEST_ENGINE_STATE_CHANGED,
      data: {
        runId: event.runId,
        fromState: event.fromState,
        toState: event.toState,
      },
      timestamp: new Date().toISOString(),
    });
  }

  @OnEvent(EVENT_NAMES.BACKTEST_SENSITIVITY_COMPLETED)
  handleBacktestSensitivityCompleted(
    event: BacktestSensitivityCompletedEvent,
  ): void {
    this.broadcast({
      event: WS_EVENTS.BACKTEST_SENSITIVITY_COMPLETED,
      data: {
        runId: event.runId,
        sweepCount: event.sweepCount,
      },
      timestamp: new Date().toISOString(),
    });
  }

  @OnEvent(EVENT_NAMES.BACKTEST_SENSITIVITY_PROGRESS)
  handleBacktestSensitivityProgress(
    event: BacktestSensitivityProgressEvent,
  ): void {
    this.broadcast({
      event: WS_EVENTS.BACKTEST_SENSITIVITY_PROGRESS,
      data: {
        runId: event.runId,
        completedSweeps: event.completedSweeps,
        totalPlannedSweeps: event.totalPlannedSweeps,
      },
      timestamp: new Date().toISOString(),
    });
  }

  // --- Incremental freshness event handlers (Story 10-9-6) ---

  @OnEvent(EVENT_NAMES.INCREMENTAL_DATA_FRESHNESS_UPDATED)
  broadcastFreshnessUpdate(event: IncrementalDataFreshnessUpdatedEvent): void {
    this.broadcast({
      event: WS_EVENTS.INCREMENTAL_FRESHNESS_UPDATED,
      data: { sources: event.sources },
      timestamp: new Date().toISOString(),
    });
  }

  @OnEvent(EVENT_NAMES.INCREMENTAL_DATA_STALE)
  broadcastStalenessWarning(event: IncrementalDataStaleEvent): void {
    this.broadcast({
      event: WS_EVENTS.INCREMENTAL_DATA_STALE,
      data: {
        source: event.source,
        lastSuccessfulAt: event.lastSuccessfulAt?.toISOString() ?? null,
        thresholdMs: event.thresholdMs,
        ageMs: event.ageMs,
        severity: event.severity,
      },
      timestamp: new Date().toISOString(),
    });
  }

  // --- External pair ingestion event handlers (Story 10-9-7) ---

  @OnEvent(EVENT_NAMES.EXTERNAL_PAIR_INGESTION_RUN_COMPLETED)
  broadcastExternalPairIngestionCompleted(
    event: ExternalPairIngestionRunCompletedEvent,
  ): void {
    this.broadcast({
      event: WS_EVENTS.EXTERNAL_PAIR_INGESTION_RUN_COMPLETED,
      data: { sources: event.sources, durationMs: event.durationMs },
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
