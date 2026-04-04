import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { EVENT_NAMES } from '../../common/events/event-catalog.js';
import { withCorrelationId } from '../../common/services/correlation-context.js';
import { MONITORING_ERROR_CODES } from './monitoring-error-codes.js';
import {
  formatOpportunityIdentified,
  formatOrderFilled,
  formatExecutionFailed,
  formatSingleLegExposure,
  formatSingleLegResolved,
  formatExitTriggered,
  formatLimitApproached,
  formatLimitBreached,
  formatPlatformDegraded,
  formatPlatformRecovered,
  formatTradingHalted,
  formatTradingResumed,
  formatReconciliationDiscrepancy,
  formatSystemHealthCritical,
  formatTestAlert,
  formatResolutionDivergence,
  formatResolutionPollCompleted,
  formatCalibrationCompleted,
  formatOrderbookStale,
  formatOrderbookRecovered,
  formatClusterLimitBreached,
  formatAggregateClusterLimitBreached,
  formatBankrollUpdated,
  formatDataDivergence,
  formatShadowDailySummary,
  formatAutoUnwind,
  formatTimescaleRetentionCompleted,
} from './formatters/index.js';
import {
  type AlertSeverity,
  SEVERITY_PRIORITY,
  classifyEventSeverity,
} from './event-severity.js';
import { TelegramCircuitBreakerService } from './telegram-circuit-breaker.service.js';
import type {
  BufferedMessage,
  CircuitState,
} from './telegram-circuit-breaker.service.js';
import type { BaseEvent } from '../../common/events/base.event.js';
import type { OpportunityIdentifiedEvent } from '../../common/events/detection.events.js';
import type {
  OrderFilledEvent,
  ExecutionFailedEvent,
  SingleLegExposureEvent,
  SingleLegResolvedEvent,
  ExitTriggeredEvent,
  ShadowDailySummaryEvent,
  AutoUnwindEvent,
} from '../../common/events/execution.events.js';
import type {
  LimitApproachedEvent,
  LimitBreachedEvent,
  ClusterLimitBreachedEvent,
  AggregateClusterLimitBreachedEvent,
} from '../../common/events/risk.events.js';
import type {
  PlatformDegradedEvent,
  PlatformRecoveredEvent,
  OrderbookStaleEvent,
  OrderbookRecoveredEvent,
  DataDivergenceEvent,
} from '../../common/events/platform.events.js';
import type {
  TradingHaltedEvent,
  TradingResumedEvent,
  ReconciliationDiscrepancyEvent,
  SystemHealthCriticalEvent,
} from '../../common/events/system.events.js';
import type { ResolutionDivergedEvent } from '../../common/events/resolution-diverged.event.js';
import type { ResolutionPollCompletedEvent } from '../../common/events/resolution-poll-completed.event.js';
import type { CalibrationCompletedEvent } from '../../common/events/calibration-completed.event.js';
import type { BankrollUpdatedEvent } from '../../common/events/config.events.js';
import type { TimescaleRetentionCompletedEvent } from '../../common/events/timescale-retention-completed.event.js';

/**
 * The 26 events that have dedicated Telegram formatters.
 * Used by TelegramAlertService.sendEventAlert() for formatter dispatch.
 * NOTE: EventConsumerService uses its own hybrid routing logic (Critical/Warning → always,
 * Info → TELEGRAM_ELIGIBLE_INFO_EVENTS allowlist) rather than this set directly.
 * Exported for testing and future dashboard integration.
 */
export const TELEGRAM_ELIGIBLE_EVENTS = new Set<string>([
  EVENT_NAMES.OPPORTUNITY_IDENTIFIED,
  EVENT_NAMES.ORDER_FILLED,
  EVENT_NAMES.EXECUTION_FAILED,
  EVENT_NAMES.SINGLE_LEG_EXPOSURE,
  EVENT_NAMES.SINGLE_LEG_RESOLVED,
  EVENT_NAMES.EXIT_TRIGGERED,
  EVENT_NAMES.LIMIT_APPROACHED,
  EVENT_NAMES.LIMIT_BREACHED,
  EVENT_NAMES.PLATFORM_HEALTH_DEGRADED,
  EVENT_NAMES.PLATFORM_HEALTH_RECOVERED,
  EVENT_NAMES.SYSTEM_TRADING_HALTED,
  EVENT_NAMES.SYSTEM_TRADING_RESUMED,
  EVENT_NAMES.RECONCILIATION_DISCREPANCY,
  EVENT_NAMES.SYSTEM_HEALTH_CRITICAL,
  EVENT_NAMES.RESOLUTION_DIVERGED,
  EVENT_NAMES.RESOLUTION_POLL_COMPLETED,
  EVENT_NAMES.CALIBRATION_COMPLETED,
  EVENT_NAMES.ORDERBOOK_STALE,
  EVENT_NAMES.ORDERBOOK_RECOVERED,
  EVENT_NAMES.CLUSTER_LIMIT_BREACHED,
  EVENT_NAMES.AGGREGATE_CLUSTER_LIMIT_BREACHED,
  EVENT_NAMES.CONFIG_BANKROLL_UPDATED,
  EVENT_NAMES.DATA_DIVERGENCE,
  EVENT_NAMES.SHADOW_DAILY_SUMMARY,
  EVENT_NAMES.AUTO_UNWIND,
  EVENT_NAMES.TIMESCALE_RETENTION_COMPLETED,
]);

/**
 * Event-name-to-formatter registry.
 * Each entry maps an event name to a function that formats the event for Telegram.
 */
const FORMATTER_REGISTRY = new Map<string, (event: BaseEvent) => string>([
  [
    EVENT_NAMES.OPPORTUNITY_IDENTIFIED,
    (e) => formatOpportunityIdentified(e as OpportunityIdentifiedEvent),
  ],
  [EVENT_NAMES.ORDER_FILLED, (e) => formatOrderFilled(e as OrderFilledEvent)],
  [
    EVENT_NAMES.EXECUTION_FAILED,
    (e) => formatExecutionFailed(e as ExecutionFailedEvent),
  ],
  [
    EVENT_NAMES.SINGLE_LEG_EXPOSURE,
    (e) => formatSingleLegExposure(e as SingleLegExposureEvent),
  ],
  [
    EVENT_NAMES.SINGLE_LEG_RESOLVED,
    (e) => formatSingleLegResolved(e as SingleLegResolvedEvent),
  ],
  [
    EVENT_NAMES.EXIT_TRIGGERED,
    (e) => formatExitTriggered(e as ExitTriggeredEvent),
  ],
  [
    EVENT_NAMES.LIMIT_APPROACHED,
    (e) => formatLimitApproached(e as LimitApproachedEvent),
  ],
  [
    EVENT_NAMES.LIMIT_BREACHED,
    (e) => formatLimitBreached(e as LimitBreachedEvent),
  ],
  [
    EVENT_NAMES.PLATFORM_HEALTH_DEGRADED,
    (e) => formatPlatformDegraded(e as PlatformDegradedEvent),
  ],
  [
    EVENT_NAMES.PLATFORM_HEALTH_RECOVERED,
    (e) => formatPlatformRecovered(e as PlatformRecoveredEvent),
  ],
  [
    EVENT_NAMES.SYSTEM_TRADING_HALTED,
    (e) => formatTradingHalted(e as TradingHaltedEvent),
  ],
  [
    EVENT_NAMES.SYSTEM_TRADING_RESUMED,
    (e) => formatTradingResumed(e as TradingResumedEvent),
  ],
  [
    EVENT_NAMES.RECONCILIATION_DISCREPANCY,
    (e) => formatReconciliationDiscrepancy(e as ReconciliationDiscrepancyEvent),
  ],
  [
    EVENT_NAMES.SYSTEM_HEALTH_CRITICAL,
    (e) => formatSystemHealthCritical(e as SystemHealthCriticalEvent),
  ],
  [
    EVENT_NAMES.RESOLUTION_DIVERGED,
    (e) => formatResolutionDivergence(e as ResolutionDivergedEvent),
  ],
  [
    EVENT_NAMES.RESOLUTION_POLL_COMPLETED,
    (e) => formatResolutionPollCompleted(e as ResolutionPollCompletedEvent),
  ],
  [
    EVENT_NAMES.CALIBRATION_COMPLETED,
    (e) => formatCalibrationCompleted(e as CalibrationCompletedEvent),
  ],
  [
    EVENT_NAMES.ORDERBOOK_STALE,
    (e) => formatOrderbookStale(e as OrderbookStaleEvent),
  ],
  [
    EVENT_NAMES.ORDERBOOK_RECOVERED,
    (e) => formatOrderbookRecovered(e as OrderbookRecoveredEvent),
  ],
  [
    EVENT_NAMES.CLUSTER_LIMIT_BREACHED,
    (e) => formatClusterLimitBreached(e as ClusterLimitBreachedEvent),
  ],
  [
    EVENT_NAMES.AGGREGATE_CLUSTER_LIMIT_BREACHED,
    (e) =>
      formatAggregateClusterLimitBreached(
        e as AggregateClusterLimitBreachedEvent,
      ),
  ],
  [
    EVENT_NAMES.CONFIG_BANKROLL_UPDATED,
    (e) => formatBankrollUpdated(e as BankrollUpdatedEvent),
  ],
  [
    EVENT_NAMES.DATA_DIVERGENCE,
    (e) => formatDataDivergence(e as DataDivergenceEvent),
  ],
  [
    EVENT_NAMES.SHADOW_DAILY_SUMMARY,
    (e) => formatShadowDailySummary(e as ShadowDailySummaryEvent),
  ],
  [EVENT_NAMES.AUTO_UNWIND, (e) => formatAutoUnwind(e as AutoUnwindEvent)],
  [
    EVENT_NAMES.TIMESCALE_RETENTION_COMPLETED,
    (e) =>
      formatTimescaleRetentionCompleted(e as TimescaleRetentionCompletedEvent),
  ],
]);

@Injectable()
export class TelegramAlertService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TelegramAlertService.name);

  private readonly batchWindowMs: number;

  private enabled = false;

  /** Cleanup: .clear() on send, bounded by batch interval */
  private batchBuffer = new Map<
    string,
    {
      messages: string[];
      timer: ReturnType<typeof setTimeout>;
      severity: AlertSeverity;
    }
  >();

  private readonly MAX_MESSAGES_PER_BATCH = 10;

  constructor(
    private readonly circuitBreaker: TelegramCircuitBreakerService,
    private readonly configService: ConfigService,
  ) {
    this.batchWindowMs = Number(
      this.configService.get<string>('TELEGRAM_BATCH_WINDOW_MS', '3000'),
    );
  }

  onModuleInit(): void {
    const token = this.configService.get<string>('TELEGRAM_BOT_TOKEN', '');
    const chatId = this.configService.get<string>('TELEGRAM_CHAT_ID', '');
    if (!token || !chatId) {
      this.logger.warn({
        message:
          'Telegram alerting disabled: missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID',
        module: 'monitoring',
      });
      this.enabled = false;
      return;
    }
    this.enabled = true;
    this.logger.log({
      message: 'Telegram alerting enabled',
      module: 'monitoring',
    });
  }

  /** Story 10-5.2 AC6: reload timeout/retry/buffer/circuit settings from DB-backed config */
  reloadConfig(settings: {
    sendTimeoutMs?: number;
    maxRetries?: number;
    bufferMaxSize?: number;
    circuitBreakMs?: number;
  }): void {
    this.circuitBreaker.reloadConfig(settings);
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  getBufferSize(): number {
    return this.circuitBreaker.getBufferSize();
  }

  getBufferContents(): readonly BufferedMessage[] {
    return this.circuitBreaker.getBufferContents();
  }

  getCircuitState(): CircuitState {
    return this.circuitBreaker.getCircuitState();
  }

  async sendMessage(text: string): Promise<boolean> {
    if (!this.enabled) return false;
    return this.circuitBreaker.sendMessage(text);
  }

  async enqueueAndSend(text: string, severity: AlertSeverity): Promise<void> {
    if (!this.enabled) return;
    return this.circuitBreaker.enqueueAndSend(text, severity);
  }

  // ─── Public Event Dispatch ─────────────────────────────────────────────────
  // Called by EventConsumerService. Replaces the removed @OnEvent handlers.

  /**
   * Dispatch an event to the appropriate Telegram formatter and send.
   * For events with dedicated formatters, uses the formatter registry.
   * For events without formatters (new critical/warning events), sends a generic alert.
   */
  sendEventAlert(eventName: string, event: BaseEvent): void {
    const formatter = FORMATTER_REGISTRY.get(eventName);

    if (formatter) {
      this.handleEvent(
        eventName,
        () => formatter(event),
        classifyEventSeverity(eventName),
        event?.correlationId,
      );
    } else {
      // Generic alert for events without formatters (e.g., new critical/warning events)
      const severity = classifyEventSeverity(eventName);
      const emoji =
        severity === 'critical'
          ? '\u{1F534}'
          : severity === 'warning'
            ? '\u{1F7E1}'
            : '\u{1F535}';
      const genericMsg = `${emoji} <b>${severity.toUpperCase()} Event</b>\n\nEvent: <code>${eventName}</code>${event?.correlationId ? `\nCorrelation: <code>${event.correlationId}</code>` : ''}\nTimestamp: ${event?.timestamp ? new Date(event.timestamp).toISOString() : new Date().toISOString()}`;
      this.handleEvent(
        eventName,
        () => genericMsg,
        severity,
        event?.correlationId,
      );
    }
  }

  // ─── Private Event Helper ──────────────────────────────────────────────────

  private handleEvent(
    eventName: string,
    formatFn: () => string,
    severity: AlertSeverity,
    correlationId?: string,
  ): void {
    if (!this.enabled) return;
    try {
      const msg = formatFn();
      this.addToBatch(eventName, msg, severity);
    } catch (error) {
      this.logger.error({
        message: `Event handler error: ${eventName}`,
        error: String(error),
        module: 'monitoring',
      });
      // Fallback: send unformatted alert so critical events are not silently lost
      const fallback = `\u{1F534} <b>Alert format error</b>\n\nEvent: <code>${eventName}</code>\nError: ${String(error).slice(0, 200)}${correlationId ? `\nCorrelation: <code>${correlationId}</code>` : ''}`;
      try {
        this.addToBatch(eventName, fallback, severity);
      } catch {
        // Truly nothing we can do — already logged above
      }
    }
  }

  // ─── Batching ─────────────────────────────────────────────────────────────

  private addToBatch(
    eventName: string,
    text: string,
    severity: AlertSeverity,
  ): void {
    // Critical events bypass batching entirely
    if (severity === 'critical') {
      void this.circuitBreaker.enqueueAndSend(text, severity);
      return;
    }

    const existing = this.batchBuffer.get(eventName);
    if (existing) {
      existing.messages.push(text);
      // Escalate severity if needed
      if (SEVERITY_PRIORITY[severity] > SEVERITY_PRIORITY[existing.severity]) {
        existing.severity = severity;
      }
    } else {
      const timer = setTimeout(() => {
        this.flushBatch(eventName);
      }, this.batchWindowMs);
      this.batchBuffer.set(eventName, {
        messages: [text],
        timer,
        severity,
      });
    }
  }

  private flushBatch(eventName: string): void {
    const entry = this.batchBuffer.get(eventName);
    if (!entry) return;
    this.batchBuffer.delete(eventName);

    if (entry.messages.length === 1) {
      void this.circuitBreaker.enqueueAndSend(
        entry.messages[0]!,
        entry.severity,
      );
    } else {
      const consolidated = this.consolidateMessages(eventName, entry.messages);
      void this.circuitBreaker.enqueueAndSend(consolidated, entry.severity);
    }
  }

  private consolidateMessages(eventName: string, messages: string[]): string {
    const MAX_TELEGRAM_LENGTH = 4096;
    const displayCount = Math.min(messages.length, this.MAX_MESSAGES_PER_BATCH);
    const overflow = messages.length - displayCount;
    const overflowNote = overflow > 0 ? `\n\n...and ${overflow} more` : '';

    const header = `\u{1F4E6} <b>${messages.length}x ${eventName}</b>\n`;
    let result = header;
    const maxPerMessage = Math.max(
      50,
      Math.floor(
        (MAX_TELEGRAM_LENGTH - header.length - overflowNote.length) /
          displayCount,
      ) - 10, // 10 chars for separator/numbering
    );

    for (let i = 0; i < displayCount; i++) {
      const truncated =
        messages[i]!.length > maxPerMessage
          ? this.truncateHtmlSafe(messages[i]!, maxPerMessage)
          : messages[i]!;
      result += `\n${i + 1}/${messages.length}:\n${truncated}`;
    }

    return (result + overflowNote).slice(0, MAX_TELEGRAM_LENGTH);
  }

  private truncateHtmlSafe(text: string, maxLength: number): string {
    const sliced = text.slice(0, maxLength);
    // Strip any partial HTML tag at the end (e.g., "<b>tex" or "<co")
    const cleaned = sliced.replace(/<[^>]*$/, '');
    return cleaned + '\u2026';
  }

  async onModuleDestroy(): Promise<void> {
    const entries = [...this.batchBuffer.entries()];
    this.batchBuffer.clear();
    const flushPromises: Promise<void>[] = [];
    for (const [eventName, entry] of entries) {
      clearTimeout(entry.timer);
      if (entry.messages.length === 1) {
        flushPromises.push(
          this.circuitBreaker.enqueueAndSend(
            entry.messages[0]!,
            entry.severity,
          ),
        );
      } else if (entry.messages.length > 1) {
        const consolidated = this.consolidateMessages(
          eventName,
          entry.messages,
        );
        flushPromises.push(
          this.circuitBreaker.enqueueAndSend(consolidated, entry.severity),
        );
      }
    }
    await Promise.allSettled(flushPromises);
  }

  // ─── Daily Test Alert ───────────────────────────────────────────────────────

  @Cron(process.env['TELEGRAM_TEST_ALERT_CRON'] || '0 8 * * *', {
    timeZone: process.env['TELEGRAM_TEST_ALERT_TIMEZONE'] || 'UTC',
  })
  async handleTestAlert(): Promise<void> {
    if (!this.enabled) return;

    await withCorrelationId(async () => {
      const message = formatTestAlert();
      const success = await this.sendMessage(message);

      if (success) {
        this.logger.log({
          message: 'Daily test alert sent successfully',
          module: 'monitoring',
          component: 'telegram-alerting',
        });
      } else {
        this.logger.warn({
          message: 'Daily test alert send failed',
          module: 'monitoring',
          component: 'telegram-alerting',
          code: MONITORING_ERROR_CODES.TELEGRAM_SEND_FAILED,
        });
      }
    });
  }
}
