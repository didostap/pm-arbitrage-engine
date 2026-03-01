import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
  Optional,
  Inject,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { EVENT_NAMES } from '../../common/events/event-catalog.js';
import type { BaseEvent } from '../../common/events/base.event.js';
import type { AlertSeverity } from './formatters/telegram-message.formatter.js';
import { TelegramAlertService } from './telegram-alert.service.js';
import {
  CsvTradeLogService,
  type TradeLogRecord,
} from './csv-trade-log.service.js';
import { AuditLogService } from './audit-log.service.js';
import Decimal from 'decimal.js';
import { MONITORING_ERROR_CODES } from './monitoring-error-codes.js';

/**
 * Centralized severity mapping for ALL domain events.
 * Source of truth — replaces getEventSeverity() in telegram-message.formatter.ts.
 */
const CRITICAL_EVENTS = new Set<string>([
  EVENT_NAMES.SINGLE_LEG_EXPOSURE,
  EVENT_NAMES.LIMIT_BREACHED,
  EVENT_NAMES.SYSTEM_TRADING_HALTED,
  EVENT_NAMES.SYSTEM_HEALTH_CRITICAL,
  EVENT_NAMES.RECONCILIATION_DISCREPANCY,
  EVENT_NAMES.TIME_DRIFT_HALT,
]);

const WARNING_EVENTS = new Set<string>([
  EVENT_NAMES.EXECUTION_FAILED,
  EVENT_NAMES.LIMIT_APPROACHED,
  EVENT_NAMES.PLATFORM_HEALTH_DEGRADED,
  EVENT_NAMES.TIME_DRIFT_CRITICAL,
  EVENT_NAMES.TIME_DRIFT_WARNING,
  EVENT_NAMES.DEGRADATION_PROTOCOL_ACTIVATED,
]);

/**
 * Info-level events that have Telegram formatters and are operationally important.
 * Critical/Warning events ALWAYS get Telegram alerts.
 * Info events only get Telegram alerts if in this set.
 */
const TELEGRAM_ELIGIBLE_INFO_EVENTS = new Set<string>([
  EVENT_NAMES.ORDER_FILLED,
  EVENT_NAMES.EXIT_TRIGGERED,
  EVENT_NAMES.SINGLE_LEG_RESOLVED,
  EVENT_NAMES.OPPORTUNITY_IDENTIFIED,
  EVENT_NAMES.PLATFORM_HEALTH_RECOVERED,
  EVENT_NAMES.SYSTEM_TRADING_RESUMED,
]);

export interface EventConsumerMetrics {
  totalEventsProcessed: number;
  eventCounts: Record<string, number>;
  severityCounts: Record<AlertSeverity, number>;
  lastEventTimestamp: Date | null;
  errorsCount: number;
}

@Injectable()
export class EventConsumerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(EventConsumerService.name);

  private totalEventsProcessed = 0;
  private eventCounts: Record<string, number> = {};
  private severityCounts: Record<AlertSeverity, number> = {
    critical: 0,
    warning: 0,
    info: 0,
  };
  private lastEventTimestamp: Date | null = null;
  private errorsCount = 0;
  private processingDepth = 0;

  private onAnyListener:
    | ((eventName: string | string[], event: unknown) => void)
    | null = null;

  constructor(
    private readonly eventEmitter: EventEmitter2,
    private readonly telegramAlertService: TelegramAlertService,
    @Optional()
    @Inject(CsvTradeLogService)
    private readonly csvTradeLogService?: CsvTradeLogService,
    @Optional()
    @Inject(AuditLogService)
    private readonly auditLogService?: AuditLogService,
  ) {}

  onModuleInit(): void {
    this.onAnyListener = (
      eventName: string | string[],
      event: unknown,
    ): void => {
      const name =
        typeof eventName === 'string' ? eventName : eventName.join('.');
      void this.handleEvent(name, event as BaseEvent);
    };

    this.eventEmitter.onAny(this.onAnyListener);

    this.logger.log({
      message: 'EventConsumerService initialized — listening to all events',
      module: 'monitoring',
    });
  }

  onModuleDestroy(): void {
    if (this.onAnyListener) {
      this.eventEmitter.offAny(this.onAnyListener);
      this.onAnyListener = null;
    }
  }

  /** @internal Called by onAny listener. Public only for unit test access. */
  async handleEvent(eventName: string, event: BaseEvent): Promise<void> {
    try {
      const severity = this.classifyEventSeverity(eventName);

      // Increment metrics
      this.totalEventsProcessed++;
      this.eventCounts[eventName] = (this.eventCounts[eventName] ?? 0) + 1;
      this.severityCounts[severity]++;
      this.lastEventTimestamp = new Date();

      // Structured log by severity
      const logData = {
        eventName,
        severity,
        correlationId: event?.correlationId,
        module: 'monitoring',
        data: this.summarizeEvent(event),
      };

      switch (severity) {
        case 'critical':
          this.logger.error(logData);
          break;
        case 'warning':
          this.logger.warn(logData);
          break;
        default:
          this.logger.log(logData);
          break;
      }

      // Telegram delegation: hybrid approach
      // Critical/Warning → ALWAYS send (generic alert if no formatter)
      // Info → only if in eligible set
      const shouldSendTelegram =
        severity === 'critical' ||
        severity === 'warning' ||
        TELEGRAM_ELIGIBLE_INFO_EVENTS.has(eventName);

      if (shouldSendTelegram) {
        // Re-entrancy guard: prevent recursive Telegram delegation
        // (e.g., Telegram failure emitting another event → onAny → handleEvent → sendEventAlert again)
        if (this.processingDepth > 0) return;
        this.processingDepth++;
        try {
          await this.telegramAlertService.sendEventAlert(eventName, event);
        } finally {
          this.processingDepth--;
        }
      }

      // CSV trade logging — fire-and-forget for trade-related events
      if (this.csvTradeLogService) {
        const record = this.buildTradeLogRecord(eventName, event);
        if (record) {
          void this.csvTradeLogService.logTrade(record);
        }
      }

      // Audit trail — log ALL events for tamper-evident persistence
      // Skip monitoring.audit.* events to prevent infinite recursion
      if (this.auditLogService && !eventName.startsWith('monitoring.audit.')) {
        void this.auditLogService
          .append({
            eventType: eventName,
            module: this.extractModule(eventName),
            correlationId: event?.correlationId,
            details: this.sanitizeEventForAudit(event),
          })
          .catch(() => {}); // Error already handled internally by AuditLogService
      }
    } catch (error) {
      this.errorsCount++;
      this.logger.error({
        message: 'Event consumer handler error',
        eventName,
        correlationId: event?.correlationId,
        error: String(error),
        module: 'monitoring',
        code: MONITORING_ERROR_CODES.EVENT_CONSUMER_HANDLER_FAILED,
      });
      // NEVER re-throw — error isolation is mandatory
    }
  }

  classifyEventSeverity(eventName: string): AlertSeverity {
    if (CRITICAL_EVENTS.has(eventName)) return 'critical';
    if (WARNING_EVENTS.has(eventName)) return 'warning';
    return 'info';
  }

  getMetrics(): EventConsumerMetrics {
    return {
      totalEventsProcessed: this.totalEventsProcessed,
      eventCounts: { ...this.eventCounts },
      severityCounts: { ...this.severityCounts },
      lastEventTimestamp: this.lastEventTimestamp,
      errorsCount: this.errorsCount,
    };
  }

  resetMetrics(): void {
    this.totalEventsProcessed = 0;
    this.eventCounts = {};
    this.severityCounts = { critical: 0, warning: 0, info: 0 };
    this.lastEventTimestamp = null;
    this.errorsCount = 0;
  }

  /** Safely coerce unknown event field to string. */
  private str(value: unknown, fallback: string = 'N/A'): string {
    if (value === null || value === undefined) return fallback;
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean')
      return value.toString();
    return fallback;
  }

  /**
   * Builds a TradeLogRecord from trade-related events.
   * Returns null for non-trade events.
   */
  private buildTradeLogRecord(
    eventName: string,
    event: BaseEvent,
  ): TradeLogRecord | null {
    const e = event as unknown as Record<string, unknown>;

    if (eventName === EVENT_NAMES.ORDER_FILLED) {
      return {
        timestamp: event.timestamp.toISOString(),
        platform: this.str(e['platform']),
        contractId: 'N/A', // Not available in OrderFilledEvent
        side: this.str(e['side']),
        price: this.str(e['price'], '0'),
        size: this.str(e['size'], '0'),
        fillPrice: this.str(e['fillPrice'], '0'),
        fees: 'N/A', // Not available in event payload
        gas: 'N/A', // Not available in event payload
        edge: 'N/A', // Not available in event payload
        pnl: '0', // P&L is realized on exit
        positionId: this.str(e['positionId']),
        pairId: 'N/A', // Not available in OrderFilledEvent
        isPaper: Boolean(e['isPaper']),
        correlationId: event.correlationId ?? '',
      };
    }

    if (eventName === EVENT_NAMES.EXIT_TRIGGERED) {
      return {
        timestamp: event.timestamp.toISOString(),
        platform: 'N/A', // Exit spans both platforms
        contractId: 'N/A',
        side: this.str(e['exitType'], 'exit'),
        price: '0',
        size: '0',
        fillPrice: '0',
        fees: 'N/A',
        gas: 'N/A',
        edge: this.str(e['finalEdge']),
        pnl: this.str(e['realizedPnl'], '0'),
        positionId: this.str(e['positionId']),
        pairId: this.str(e['pairId']),
        isPaper: Boolean(e['isPaper']),
        correlationId: event.correlationId ?? '',
      };
    }

    return null;
  }

  /** Extracts module name from dot-notation event name (e.g., 'execution' from 'execution.order.filled'). */
  extractModule(eventName: string): string {
    return eventName.split('.')[0] ?? 'unknown';
  }

  /** Safely converts event to a plain object for JSON storage in audit trail. */
  sanitizeEventForAudit(event: unknown): Record<string, unknown> {
    try {
      return JSON.parse(JSON.stringify(event)) as Record<string, unknown>;
    } catch {
      return { raw: String(event) };
    }
  }

  private summarizeEvent(event: BaseEvent): Record<string, unknown> | string {
    try {
      if (!event || typeof event !== 'object') return 'unknown';
      const summary: Record<string, unknown> = {};
      const seen = new WeakSet();
      for (const [key, value] of Object.entries(event)) {
        if (key === 'correlationId') continue;
        summary[key] = this.serializeValue(value, seen, 0);
      }
      return summary;
    } catch (error) {
      this.logger.warn(
        { error, eventType: event?.constructor?.name },
        'Event serialization failed',
      );
      return {
        error: 'serialization_failed',
        eventType: event?.constructor?.name ?? 'unknown',
      };
    }
  }

  private static readonly MAX_SERIALIZE_DEPTH = 10;

  private serializeValue(
    value: unknown,
    seen: WeakSet<object>,
    depth: number,
  ): unknown {
    if (value === null || value === undefined) return value;
    if (typeof value !== 'object') return value; // primitives passthrough
    if (depth > EventConsumerService.MAX_SERIALIZE_DEPTH) return '[MaxDepth]';
    if (seen.has(value)) return '[Circular]';
    seen.add(value);
    if (value instanceof Date) return value.toISOString();
    if (value instanceof Decimal) return value.toString();
    if (Array.isArray(value))
      return value.map((v) => this.serializeValue(v, seen, depth + 1));
    const serialized: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      serialized[k] = this.serializeValue(v, seen, depth + 1);
    }
    return serialized;
  }
}
