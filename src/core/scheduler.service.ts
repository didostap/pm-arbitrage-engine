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

/**
 * Manages polling intervals and triggers trading cycles.
 * Prevents overlapping cycles using in-progress checks.
 */
@Injectable()
export class SchedulerService implements OnModuleInit {
  private readonly logger = new Logger(SchedulerService.name);

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

    const interval = setInterval(() => {
      void this.handlePollingCycle();
    }, intervalMs);
    this.schedulerRegistry.addInterval('pollingCycle', interval);

    this.logger.log({
      message: 'Scheduler initialized',
      timestamp: new Date().toISOString(),
      module: 'core',
      pollingIntervalMs: intervalMs,
    });
  }

  /**
   * Handle each polling cycle trigger.
   * Skips if previous cycle still in progress (prevents overlaps).
   */
  private async handlePollingCycle(): Promise<void> {
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
