import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  telegramResponseSchema,
  telegramRateLimitSchema,
} from '../../common/schemas/telegram-response.schema.js';
import { SystemHealthError } from '../../common/errors/system-health-error.js';
import { withRetry } from '../../common/utils/with-retry.js';
import { MONITORING_ERROR_CODES } from './monitoring-error-codes.js';
import { type AlertSeverity, SEVERITY_PRIORITY } from './event-severity.js';

export interface BufferedMessage {
  text: string;
  severity: AlertSeverity;
  timestamp: number;
}

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

@Injectable()
export class TelegramCircuitBreakerService {
  private readonly logger = new Logger(TelegramCircuitBreakerService.name);

  private botToken: string;
  private chatId: string;
  private sendTimeoutMs: number;
  private maxRetries: number;
  private bufferMaxSize: number;
  private circuitBreakMs: number;

  private consecutiveFailures = 0;
  private circuitOpenUntil = 0;
  private lastRetryAfterMs = 0;
  /** Cleanup: .length = 0 on drain completion, evictLowestPriority() caps at bufferMaxSize */
  private buffer: BufferedMessage[] = [];
  private draining = false;

  constructor(private readonly configService: ConfigService) {
    this.botToken = this.configService.get<string>('TELEGRAM_BOT_TOKEN', '');
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

  /** Story 10-5.2 AC6: reload timeout/retry/buffer/circuit settings from DB-backed config */
  reloadConfig(settings: {
    sendTimeoutMs?: number;
    maxRetries?: number;
    bufferMaxSize?: number;
    circuitBreakMs?: number;
  }): void {
    if (settings.sendTimeoutMs !== undefined)
      this.sendTimeoutMs = settings.sendTimeoutMs;
    if (settings.maxRetries !== undefined)
      this.maxRetries = settings.maxRetries;
    if (settings.bufferMaxSize !== undefined)
      this.bufferMaxSize = settings.bufferMaxSize;
    if (settings.circuitBreakMs !== undefined)
      this.circuitBreakMs = settings.circuitBreakMs;
    this.logger.log({
      message: 'Circuit breaker config reloaded',
      data: {
        sendTimeoutMs: this.sendTimeoutMs,
        maxRetries: this.maxRetries,
        bufferMaxSize: this.bufferMaxSize,
        circuitBreakMs: this.circuitBreakMs,
      },
    });
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

  getBufferSize(): number {
    return this.buffer.length;
  }

  getBufferContents(): readonly BufferedMessage[] {
    return this.buffer;
  }

  /**
   * Single HTTP send attempt to Telegram. No retries.
   * Returns true on success, false on failure.
   */
  async sendMessage(text: string): Promise<boolean> {
    try {
      const response = await fetch(
        `https://api.telegram.org/bot${this.botToken}/sendMessage`,
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
          const parsed = telegramRateLimitSchema.safeParse(
            await response.json(),
          );
          if (parsed.success) {
            const retryAfter = parsed.data.parameters?.retry_after;
            if (retryAfter && retryAfter > 0) {
              this.lastRetryAfterMs = retryAfter * 1000;
            }
          }
        }
        return false;
      }

      const parsed = telegramResponseSchema.safeParse(await response.json());
      return parsed.success ? parsed.data.ok : false;
    } catch {
      return false;
    }
  }

  /**
   * Main entry point: check circuit breaker, attempt send, buffer on failure.
   */
  async enqueueAndSend(text: string, severity: AlertSeverity): Promise<void> {
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
