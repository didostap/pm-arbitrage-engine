import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { TradingEngineService } from './trading-engine.service';

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
}
