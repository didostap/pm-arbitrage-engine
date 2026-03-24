import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry, Cron } from '@nestjs/schedule';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { TradingEngineService } from './trading-engine.service';
import { syncAndMeasureDrift } from '../common/utils';
import {
  EVENT_NAMES,
  TimeWarningEvent,
  TimeCriticalEvent,
  TimeHaltEvent,
} from '../common/events';
import {
  withCorrelationId,
  getCorrelationId,
} from '../common/services/correlation-context';
import { ConfigValidationError } from '../common/errors';

/**
 * Manages polling intervals and triggers trading cycles.
 * Prevents overlapping cycles using in-progress checks.
 */
@Injectable()
export class SchedulerService implements OnModuleInit {
  private readonly logger = new Logger(SchedulerService.name);

  private tradingWindowStartUtc = 0;
  private tradingWindowEndUtc = 24;

  constructor(
    private readonly configService: ConfigService,
    private readonly tradingEngine: TradingEngineService,
    private readonly schedulerRegistry: SchedulerRegistry,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  /**
   * Initialize polling interval when module starts.
   * Uses dynamic config value via SchedulerRegistry (decorator doesn't support runtime values).
   */
  onModuleInit() {
    const intervalMs = this.configService.get<number>(
      'POLLING_INTERVAL_MS',
      30000,
    );

    this.tradingWindowStartUtc = this.configService.get<number>(
      'TRADING_WINDOW_START_UTC',
      0,
    );
    this.tradingWindowEndUtc = this.configService.get<number>(
      'TRADING_WINDOW_END_UTC',
      24,
    );
    this.validateTradingWindow(
      this.tradingWindowStartUtc,
      this.tradingWindowEndUtc,
    );

    const interval = setInterval(() => {
      void this.handlePollingCycle();
    }, intervalMs);
    this.schedulerRegistry.addInterval('pollingCycle', interval);

    this.logger.log({
      message: 'Scheduler initialized',
      timestamp: new Date().toISOString(),
      module: 'core',
      pollingIntervalMs: intervalMs,
      tradingWindowStartUtc: this.tradingWindowStartUtc,
      tradingWindowEndUtc: this.tradingWindowEndUtc,
    });
  }

  /** Story 10-5.2 AC6: hot-reload polling interval */
  reloadPollingInterval(ms: number): void {
    if (!Number.isInteger(ms) || ms < 1000) {
      this.logger.error({
        message: `Invalid polling interval: ${ms}ms (must be integer >= 1000), keeping existing interval`,
      });
      return;
    }

    // Create new interval before deleting old — prevents gap if addInterval fails
    const newInterval = setInterval(() => {
      void this.handlePollingCycle();
    }, ms);

    try {
      this.schedulerRegistry.deleteInterval('pollingCycle');
    } catch {
      this.logger.warn({
        message: 'pollingCycle interval not found for deletion',
      });
    }

    try {
      this.schedulerRegistry.addInterval('pollingCycle', newInterval);
    } catch (error) {
      clearInterval(newInterval);
      this.logger.error({
        message: 'Failed to register new polling interval',
        data: { error: error instanceof Error ? error.message : String(error) },
      });
      return;
    }

    this.logger.log({
      message: 'Polling interval reloaded',
      data: { pollingIntervalMs: ms },
    });
  }

  /** Hot-reload trading window values from dashboard settings. */
  reloadTradingWindow(cfg: {
    tradingWindowStartUtc?: number;
    tradingWindowEndUtc?: number;
  }): void {
    const start = cfg.tradingWindowStartUtc ?? this.tradingWindowStartUtc;
    const end = cfg.tradingWindowEndUtc ?? this.tradingWindowEndUtc;

    const errors = this.getTradingWindowErrors(start, end);
    if (errors.length > 0) {
      this.logger.warn({
        message: `Invalid trading window values (${errors.join('; ')}), keeping current window [${this.tradingWindowStartUtc}, ${this.tradingWindowEndUtc})`,
      });
      return;
    }

    this.tradingWindowStartUtc = start;
    this.tradingWindowEndUtc = end;
    this.logger.log({
      message: 'Trading window reloaded',
      data: {
        tradingWindowStartUtc: this.tradingWindowStartUtc,
        tradingWindowEndUtc: this.tradingWindowEndUtc,
      },
    });
  }

  /**
   * Handle each polling cycle trigger.
   * Skips if outside trading window or previous cycle still in progress.
   */
  private async handlePollingCycle(): Promise<void> {
    const currentHour = new Date().getUTCHours();
    if (!this.isWithinTradingWindow(currentHour)) {
      this.logger.log({
        message: 'Skipping trading cycle — outside configured trading window',
        data: {
          currentHour,
          windowStart: this.tradingWindowStartUtc,
          windowEnd: this.tradingWindowEndUtc,
        },
      });
      return;
    }

    if (this.tradingEngine.isCycleInProgress()) {
      this.logger.debug({
        message: 'Skipping polling interval - cycle already in progress',
        timestamp: new Date().toISOString(),
        module: 'core',
        reason: 'cycle_in_progress',
      });
      return;
    }

    try {
      await this.tradingEngine.executeCycle();
    } catch (error) {
      // Error already logged by TradingEngineService
      // Scheduler continues running despite cycle failures
      this.logger.error({
        message: 'Polling cycle error',
        timestamp: new Date().toISOString(),
        module: 'core',
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  private isWithinTradingWindow(currentHour: number): boolean {
    if (this.tradingWindowStartUtc === 0 && this.tradingWindowEndUtc === 24) {
      return true;
    }
    if (this.tradingWindowStartUtc < this.tradingWindowEndUtc) {
      return (
        currentHour >= this.tradingWindowStartUtc &&
        currentHour < this.tradingWindowEndUtc
      );
    }
    // Midnight-spanning window (e.g., 22/6)
    return (
      currentHour >= this.tradingWindowStartUtc ||
      currentHour < this.tradingWindowEndUtc
    );
  }

  private validateTradingWindow(start: number, end: number): void {
    const errors = this.getTradingWindowErrors(start, end);
    if (errors.length > 0) {
      throw new ConfigValidationError(
        `Invalid trading window configuration: ${errors.join('; ')}`,
        errors,
      );
    }
  }

  private getTradingWindowErrors(start: number, end: number): string[] {
    const errors: string[] = [];
    if (!Number.isInteger(start) || start < 0 || start > 23) {
      errors.push(`start must be integer 0–23 (got ${start})`);
    }
    if (!Number.isInteger(end) || end < 1 || end > 24) {
      errors.push(`end must be integer 1–24 (got ${end})`);
    }
    if (start === end) {
      errors.push(`start and end must differ (both are ${start})`);
    }
    return errors;
  }

  /**
   * NTP drift check every 6 hours (at :00 minutes).
   * Measures clock drift and emits events based on severity thresholds.
   */
  @Cron('0 */6 * * *')
  async handleNtpCheck(): Promise<void> {
    await withCorrelationId(async () => {
      this.logger.log({
        message: 'NTP drift check started',
        correlationId: getCorrelationId(),
        timestamp: new Date().toISOString(),
        module: 'core',
      });

      try {
        const result = await syncAndMeasureDrift();

        // Evaluate drift against thresholds
        if (result.driftMs < 100) {
          // No action - within acceptable range
          this.logger.log({
            message: 'Clock drift within acceptable range',
            correlationId: getCorrelationId(),
            timestamp: new Date().toISOString(),
            module: 'core',
            data: { driftMs: result.driftMs, serverUsed: result.serverUsed },
          });
        } else if (result.driftMs < 500) {
          // Warning
          this.logger.warn({
            message: 'Clock drift warning threshold exceeded',
            correlationId: getCorrelationId(),
            timestamp: new Date().toISOString(),
            module: 'core',
            data: { driftMs: result.driftMs, threshold: 100 },
          });
          this.eventEmitter.emit(
            EVENT_NAMES.TIME_DRIFT_WARNING,
            new TimeWarningEvent(
              result.driftMs,
              result.serverUsed,
              result.timestamp,
            ),
          );
        } else if (result.driftMs < 1000) {
          // Critical
          this.logger.error({
            message: 'Clock drift critical threshold exceeded',
            correlationId: getCorrelationId(),
            timestamp: new Date().toISOString(),
            module: 'core',
            data: { driftMs: result.driftMs, threshold: 500 },
          });
          this.eventEmitter.emit(
            EVENT_NAMES.TIME_DRIFT_CRITICAL,
            new TimeCriticalEvent(
              result.driftMs,
              result.serverUsed,
              result.timestamp,
            ),
          );
        } else {
          // Halt trading
          this.logger.error({
            message: 'Severe clock drift detected - trading halt initiated',
            correlationId: getCorrelationId(),
            timestamp: new Date().toISOString(),
            module: 'core',
            data: { driftMs: result.driftMs, threshold: 1000 },
          });
          this.eventEmitter.emit(
            EVENT_NAMES.TIME_DRIFT_HALT,
            new TimeHaltEvent(
              result.driftMs,
              result.serverUsed,
              result.timestamp,
              'Clock drift >1000ms',
            ),
          );
        }
      } catch (error) {
        this.logger.error({
          message: 'NTP drift check failed',
          correlationId: getCorrelationId(),
          timestamp: new Date().toISOString(),
          module: 'core',
          data: {
            error: error instanceof Error ? error.message : 'Unknown error',
          },
        });
      }
    });
  }
}
