import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OnEvent } from '@nestjs/event-emitter';
import { Cron } from '@nestjs/schedule';
import { EVENT_NAMES } from '../../common/events/event-catalog.js';
import { SystemHealthError } from '../../common/errors/system-health-error.js';
import { withCorrelationId } from '../../common/services/correlation-context.js';
import { withRetry } from '../../common/utils/with-retry.js';
import { MONITORING_ERROR_CODES } from './monitoring-error-codes.js';
import {
  type AlertSeverity,
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
  getEventSeverity,
} from './formatters/telegram-message.formatter.js';
import type { OpportunityIdentifiedEvent } from '../../common/events/detection.events.js';
import type {
  OrderFilledEvent,
  ExecutionFailedEvent,
  SingleLegExposureEvent,
  SingleLegResolvedEvent,
  ExitTriggeredEvent,
} from '../../common/events/execution.events.js';
import type {
  LimitApproachedEvent,
  LimitBreachedEvent,
} from '../../common/events/risk.events.js';
import type {
  PlatformDegradedEvent,
  PlatformRecoveredEvent,
} from '../../common/events/platform.events.js';
import type {
  TradingHaltedEvent,
  TradingResumedEvent,
  ReconciliationDiscrepancyEvent,
  SystemHealthCriticalEvent,
} from '../../common/events/system.events.js';

interface BufferedMessage {
  text: string;
  severity: AlertSeverity;
  timestamp: number;
}

type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

const SEVERITY_PRIORITY: Record<AlertSeverity, number> = {
  critical: 3,
  warning: 2,
  info: 1,
};

@Injectable()
export class TelegramAlertService implements OnModuleInit {
  private readonly logger = new Logger(TelegramAlertService.name);

  private readonly token: string;
  private readonly chatId: string;
  private readonly sendTimeoutMs: number;
  private readonly maxRetries: number;
  private readonly bufferMaxSize: number;
  private readonly circuitBreakMs: number;

  private enabled = false;
  private consecutiveFailures = 0;
  private circuitOpenUntil = 0;
  private lastRetryAfterMs = 0;
  private buffer: BufferedMessage[] = [];
  private draining = false;

  constructor(private readonly configService: ConfigService) {
    this.token = this.configService.get<string>('TELEGRAM_BOT_TOKEN', '');
    this.chatId = this.configService.get<string>('TELEGRAM_CHAT_ID', '');
    this.sendTimeoutMs = Number(
      this.configService.get<string>('TELEGRAM_SEND_TIMEOUT_MS', '2000'),
    );
    this.maxRetries = Number(
      this.configService.get<string>('TELEGRAM_MAX_RETRIES', '3'),
    );
    this.bufferMaxSize = Number(
      this.configService.get<string>('TELEGRAM_BUFFER_MAX_SIZE', '100'),
    );
    this.circuitBreakMs = Number(
      this.configService.get<string>('TELEGRAM_CIRCUIT_BREAK_MS', '60000'),
    );
  }

  onModuleInit(): void {
    if (!this.token || !this.chatId) {
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

  isEnabled(): boolean {
    return this.enabled;
  }

  getBufferSize(): number {
    return this.buffer.length;
  }

  getBufferContents(): readonly BufferedMessage[] {
    return this.buffer;
  }

  getCircuitState(): CircuitState {
    if (this.consecutiveFailures >= this.maxRetries) {
      const now = Date.now();
      if (now >= this.circuitOpenUntil) {
        return 'HALF_OPEN';
      }
      return 'OPEN';
    }
    return 'CLOSED';
  }

  /**
   * Single HTTP send attempt to Telegram. No retries.
   * Returns true on success, false on failure.
   */
  async sendMessage(text: string): Promise<boolean> {
    try {
      const response = await fetch(
        `https://api.telegram.org/bot${this.token}/sendMessage`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: this.chatId,
            text,
            parse_mode: 'HTML',
            disable_web_page_preview: true,
          }),
          signal: AbortSignal.timeout(this.sendTimeoutMs),
        },
      );

      if (!response.ok) {
        if (response.status === 429) {
          const body = (await response.json()) as {
            parameters?: { retry_after?: number };
          };
          const retryAfter = body.parameters?.retry_after;
          if (retryAfter && retryAfter > 0) {
            this.lastRetryAfterMs = retryAfter * 1000;
          }
        }
        return false;
      }

      const body = (await response.json()) as { ok: boolean };
      return body.ok;
    } catch {
      return false;
    }
  }

  /**
   * Main entry point: check circuit breaker, attempt send, buffer on failure.
   */
  async enqueueAndSend(text: string, severity: AlertSeverity): Promise<void> {
    if (!this.enabled) return;

    const circuitState = this.getCircuitState();

    if (circuitState === 'OPEN') {
      this.bufferMessage(text, severity);
      return;
    }

    const success = await this.sendMessage(text);

    if (success) {
      this.consecutiveFailures = 0;
      this.lastRetryAfterMs = 0;
      if (circuitState === 'HALF_OPEN') {
        this.logger.log({
          message: 'Circuit breaker closed after successful probe',
          module: 'monitoring',
          component: 'telegram-alerting',
        });
      }
      this.triggerBufferDrain();
    } else {
      this.consecutiveFailures++;
      this.bufferMessage(text, severity);

      const error = new SystemHealthError(
        MONITORING_ERROR_CODES.TELEGRAM_SEND_FAILED,
        `Telegram send failed (consecutive failures: ${this.consecutiveFailures})`,
        'warning',
        'telegram-alerting',
      );
      this.logger.warn({
        message: error.message,
        code: error.code,
        severity: error.severity,
        component: 'telegram-alerting',
        consecutiveFailures: this.consecutiveFailures,
      });

      if (this.consecutiveFailures >= this.maxRetries) {
        const breakDuration = Math.max(
          this.circuitBreakMs,
          this.lastRetryAfterMs,
        );
        this.circuitOpenUntil = Date.now() + breakDuration;
        this.logger.log({
          message: `Circuit breaker OPEN for ${breakDuration}ms`,
          module: 'monitoring',
          component: 'telegram-alerting',
        });
      }
    }
  }

  // ─── Event Handlers ─────────────────────────────────────────────────────────
  // All handlers use { async: true } to never block the emitter's call chain.
  // All handlers wrap in try-catch to ensure errors never propagate.
  // On formatter error, a fallback plain-text alert is sent to prevent silent loss.

  private async handleEvent(
    eventName: string,
    formatFn: () => string,
    severity: AlertSeverity,
    correlationId?: string,
  ): Promise<void> {
    if (!this.enabled) return;
    try {
      const msg = formatFn();
      await this.enqueueAndSend(msg, severity);
    } catch (error) {
      this.logger.error({
        message: `Event handler error: ${eventName}`,
        error: String(error),
        module: 'monitoring',
      });
      // Fallback: send unformatted alert so critical events are not silently lost
      const fallback = `\u{1F534} <b>Alert format error</b>\n\nEvent: <code>${eventName}</code>\nError: ${String(error).slice(0, 200)}${correlationId ? `\nCorrelation: <code>${correlationId}</code>` : ''}`;
      try {
        await this.enqueueAndSend(fallback, severity);
      } catch {
        // Truly nothing we can do — already logged above
      }
    }
  }

  @OnEvent(EVENT_NAMES.OPPORTUNITY_IDENTIFIED, { async: true })
  async handleOpportunityIdentified(
    event: OpportunityIdentifiedEvent,
  ): Promise<void> {
    await this.handleEvent(
      'OPPORTUNITY_IDENTIFIED',
      () => formatOpportunityIdentified(event),
      getEventSeverity(EVENT_NAMES.OPPORTUNITY_IDENTIFIED),
      event.correlationId,
    );
  }

  @OnEvent(EVENT_NAMES.ORDER_FILLED, { async: true })
  async handleOrderFilled(event: OrderFilledEvent): Promise<void> {
    await this.handleEvent(
      'ORDER_FILLED',
      () => formatOrderFilled(event),
      getEventSeverity(EVENT_NAMES.ORDER_FILLED),
      event.correlationId,
    );
  }

  @OnEvent(EVENT_NAMES.EXECUTION_FAILED, { async: true })
  async handleExecutionFailed(event: ExecutionFailedEvent): Promise<void> {
    await this.handleEvent(
      'EXECUTION_FAILED',
      () => formatExecutionFailed(event),
      getEventSeverity(EVENT_NAMES.EXECUTION_FAILED),
      event.correlationId,
    );
  }

  @OnEvent(EVENT_NAMES.SINGLE_LEG_EXPOSURE, { async: true })
  async handleSingleLegExposure(event: SingleLegExposureEvent): Promise<void> {
    await this.handleEvent(
      'SINGLE_LEG_EXPOSURE',
      () => formatSingleLegExposure(event),
      getEventSeverity(EVENT_NAMES.SINGLE_LEG_EXPOSURE),
      event.correlationId,
    );
  }

  @OnEvent(EVENT_NAMES.SINGLE_LEG_RESOLVED, { async: true })
  async handleSingleLegResolved(event: SingleLegResolvedEvent): Promise<void> {
    await this.handleEvent(
      'SINGLE_LEG_RESOLVED',
      () => formatSingleLegResolved(event),
      getEventSeverity(EVENT_NAMES.SINGLE_LEG_RESOLVED),
      event.correlationId,
    );
  }

  @OnEvent(EVENT_NAMES.EXIT_TRIGGERED, { async: true })
  async handleExitTriggered(event: ExitTriggeredEvent): Promise<void> {
    await this.handleEvent(
      'EXIT_TRIGGERED',
      () => formatExitTriggered(event),
      getEventSeverity(EVENT_NAMES.EXIT_TRIGGERED),
      event.correlationId,
    );
  }

  @OnEvent(EVENT_NAMES.LIMIT_APPROACHED, { async: true })
  async handleLimitApproached(event: LimitApproachedEvent): Promise<void> {
    await this.handleEvent(
      'LIMIT_APPROACHED',
      () => formatLimitApproached(event),
      getEventSeverity(EVENT_NAMES.LIMIT_APPROACHED),
      event.correlationId,
    );
  }

  @OnEvent(EVENT_NAMES.LIMIT_BREACHED, { async: true })
  async handleLimitBreached(event: LimitBreachedEvent): Promise<void> {
    await this.handleEvent(
      'LIMIT_BREACHED',
      () => formatLimitBreached(event),
      getEventSeverity(EVENT_NAMES.LIMIT_BREACHED),
      event.correlationId,
    );
  }

  @OnEvent(EVENT_NAMES.PLATFORM_HEALTH_DEGRADED, { async: true })
  async handlePlatformDegraded(event: PlatformDegradedEvent): Promise<void> {
    await this.handleEvent(
      'PLATFORM_HEALTH_DEGRADED',
      () => formatPlatformDegraded(event),
      getEventSeverity(EVENT_NAMES.PLATFORM_HEALTH_DEGRADED),
      event.correlationId,
    );
  }

  @OnEvent(EVENT_NAMES.PLATFORM_HEALTH_RECOVERED, { async: true })
  async handlePlatformRecovered(event: PlatformRecoveredEvent): Promise<void> {
    await this.handleEvent(
      'PLATFORM_HEALTH_RECOVERED',
      () => formatPlatformRecovered(event),
      getEventSeverity(EVENT_NAMES.PLATFORM_HEALTH_RECOVERED),
      event.correlationId,
    );
  }

  @OnEvent(EVENT_NAMES.SYSTEM_TRADING_HALTED, { async: true })
  async handleTradingHalted(event: TradingHaltedEvent): Promise<void> {
    await this.handleEvent(
      'SYSTEM_TRADING_HALTED',
      () => formatTradingHalted(event),
      getEventSeverity(EVENT_NAMES.SYSTEM_TRADING_HALTED),
      event.correlationId,
    );
  }

  @OnEvent(EVENT_NAMES.SYSTEM_TRADING_RESUMED, { async: true })
  async handleTradingResumed(event: TradingResumedEvent): Promise<void> {
    await this.handleEvent(
      'SYSTEM_TRADING_RESUMED',
      () => formatTradingResumed(event),
      getEventSeverity(EVENT_NAMES.SYSTEM_TRADING_RESUMED),
      event.correlationId,
    );
  }

  @OnEvent(EVENT_NAMES.RECONCILIATION_DISCREPANCY, { async: true })
  async handleReconciliationDiscrepancy(
    event: ReconciliationDiscrepancyEvent,
  ): Promise<void> {
    await this.handleEvent(
      'RECONCILIATION_DISCREPANCY',
      () => formatReconciliationDiscrepancy(event),
      getEventSeverity(EVENT_NAMES.RECONCILIATION_DISCREPANCY),
      event.correlationId,
    );
  }

  @OnEvent(EVENT_NAMES.SYSTEM_HEALTH_CRITICAL, { async: true })
  async handleSystemHealthCritical(
    event: SystemHealthCriticalEvent,
  ): Promise<void> {
    await this.handleEvent(
      'SYSTEM_HEALTH_CRITICAL',
      () => formatSystemHealthCritical(event),
      getEventSeverity(EVENT_NAMES.SYSTEM_HEALTH_CRITICAL),
      event.correlationId,
    );
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

  // ─── Private Methods ────────────────────────────────────────────────────────

  private bufferMessage(text: string, severity: AlertSeverity): void {
    const msg: BufferedMessage = { text, severity, timestamp: Date.now() };

    if (this.buffer.length >= this.bufferMaxSize) {
      this.evictLowestPriority();
    }

    this.buffer.push(msg);
  }

  private evictLowestPriority(): void {
    let lowestPriority = Infinity;
    for (const msg of this.buffer) {
      const p = SEVERITY_PRIORITY[msg.severity];
      if (p < lowestPriority) {
        lowestPriority = p;
      }
    }

    let oldestIdx = -1;
    let oldestTimestamp = Infinity;
    for (let i = 0; i < this.buffer.length; i++) {
      const msg = this.buffer[i]!;
      if (
        SEVERITY_PRIORITY[msg.severity] === lowestPriority &&
        msg.timestamp < oldestTimestamp
      ) {
        oldestTimestamp = msg.timestamp;
        oldestIdx = i;
      }
    }

    if (oldestIdx >= 0) {
      this.buffer.splice(oldestIdx, 1);
    }
  }

  private triggerBufferDrain(): void {
    if (this.draining || this.buffer.length === 0) return;

    this.draining = true;
    setImmediate(() => {
      void this.drainBuffer();
    });
  }

  private async drainBuffer(): Promise<void> {
    try {
      // Sort once before draining — highest priority first (M4 fix)
      this.buffer.sort(
        (a, b) => SEVERITY_PRIORITY[b.severity] - SEVERITY_PRIORITY[a.severity],
      );

      while (this.buffer.length > 0) {
        const msg = this.buffer.shift();
        if (!msg) break;

        try {
          await withRetry(
            async () => {
              const success = await this.sendMessage(msg.text);
              if (!success) throw new Error('Telegram send failed');
            },
            {
              maxRetries: 2,
              initialDelayMs: 1000,
              maxDelayMs: 3000,
              backoffMultiplier: 2,
            },
          );
        } catch {
          // All retries exhausted — put message back and stop drain
          this.buffer.unshift(msg);
          break;
        }

        if (this.buffer.length > 0) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      }
    } finally {
      this.draining = false;
    }
  }
}
