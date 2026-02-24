import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { EVENT_NAMES } from '../../common/events/event-catalog.js';
import type { BaseEvent } from '../../common/events/base.event.js';
import type { AlertSeverity } from './formatters/telegram-message.formatter.js';
import { TelegramAlertService } from './telegram-alert.service.js';
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

  private summarizeEvent(event: BaseEvent): Record<string, unknown> | string {
    if (!event || typeof event !== 'object') return 'unknown';
    // Return a shallow summary to avoid logging huge event payloads
    const summary: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(event)) {
      if (key === 'correlationId') continue;
      summary[key] =
        typeof value === 'object' && value !== null ? '[object]' : value;
    }
    return summary;
  }
}
