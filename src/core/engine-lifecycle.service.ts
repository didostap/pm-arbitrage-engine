import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../common/prisma.service';
import { TradingEngineService } from './trading-engine.service';

/**
 * Manages engine lifecycle hooks for startup and graceful shutdown.
 * Coordinates database verification and trading engine termination.
 */
@Injectable()
export class EngineLifecycleService
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(EngineLifecycleService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tradingEngine: TradingEngineService,
    private readonly configService: ConfigService,
  ) {}

  /**
   * Lifecycle hook called after all modules are initialized.
   * Verifies database connectivity and logs startup configuration.
   */
  async onApplicationBootstrap() {
    try {
      // Verify database connectivity (Prisma manages its own lifecycle)
      await this.prisma.$queryRaw`SELECT 1`;

      // Validate configuration
      const pollingInterval = this.configService.get<number>(
        'POLLING_INTERVAL_MS',
        30000,
      );
      this.validateConfiguration(pollingInterval);

      const nodeEnv = process.env.NODE_ENV || 'development';

      this.logger.log({
        message: 'Engine startup complete',
        timestamp: new Date().toISOString(),
        module: 'core',
        configSummary: {
          pollingIntervalMs: pollingInterval,
          environment: nodeEnv,
          port: 8080,
        },
      });
    } catch (error) {
      this.logger.error({
        message: 'Database connection failed',
        timestamp: new Date().toISOString(),
        module: 'core',
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      throw error;
    }
  }

  /**
   * Validate startup configuration values.
   * Throws error if configuration is invalid.
   *
   * @param pollingIntervalMs - Polling interval in milliseconds
   */
  private validateConfiguration(pollingIntervalMs: number): void {
    const MIN_POLLING_INTERVAL = 1000; // 1 second minimum
    const MAX_POLLING_INTERVAL = 300000; // 5 minutes maximum

    if (
      pollingIntervalMs < MIN_POLLING_INTERVAL ||
      pollingIntervalMs > MAX_POLLING_INTERVAL
    ) {
      throw new Error(
        `POLLING_INTERVAL_MS must be between ${MIN_POLLING_INTERVAL} and ${MAX_POLLING_INTERVAL}ms, got ${pollingIntervalMs}ms`,
      );
    }
  }

  /**
   * Lifecycle hook called when shutdown signal (SIGTERM/SIGINT) received.
   * Initiates graceful shutdown and waits for in-flight operations to complete.
   *
   * @param signal - The shutdown signal received (SIGTERM, SIGINT, etc.)
   */
  async onApplicationShutdown(signal?: string) {
    this.logger.log({
      message: 'Graceful shutdown initiated',
      timestamp: new Date().toISOString(),
      signal: signal || 'UNKNOWN',
    });

    try {
      // Initiate trading engine shutdown
      this.tradingEngine.initiateShutdown();

      // Wait for in-flight operations to complete (12s timeout)
      // 15s Docker grace period - 3s buffer = 12s for shutdown
      await this.tradingEngine.waitForShutdown(12000);

      this.logger.log({
        message: 'Shutdown complete',
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      // Log error but complete shutdown gracefully
      this.logger.error('Error during shutdown', error);
    }
  }
}
