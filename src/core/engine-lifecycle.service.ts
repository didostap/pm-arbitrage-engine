import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../common/prisma.service';
import { TradingEngineService } from './trading-engine.service';
import { syncAndMeasureDrift } from '../common/utils';
import { EVENT_NAMES, TimeHaltEvent } from '../common/events';
import { getCorrelationId } from '../common/services/correlation-context';
import { StartupReconciliationService } from '../reconciliation/startup-reconciliation.service';
import { RISK_MANAGER_TOKEN } from '../modules/risk-management/risk-management.constants';
import type { IRiskManager } from '../common/interfaces/risk-manager.interface';

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
    private readonly eventEmitter: EventEmitter2,
    private readonly reconciliationService: StartupReconciliationService,
    @Inject(RISK_MANAGER_TOKEN)
    private readonly riskManager: IRiskManager,
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

      // Startup NTP validation
      try {
        const driftResult = await syncAndMeasureDrift();

        this.logger.log({
          message: 'Startup NTP validation complete',
          timestamp: new Date().toISOString(),
          module: 'core',
          correlationId: getCorrelationId(),
          data: {
            driftMs: driftResult.driftMs,
            serverUsed: driftResult.serverUsed,
          },
        });

        if (driftResult.driftMs >= 1000) {
          // Severe drift - halt trading
          this.logger.error({
            message:
              'Severe clock drift detected at startup - trading will not start',
            timestamp: new Date().toISOString(),
            module: 'core',
            correlationId: getCorrelationId(),
            data: { driftMs: driftResult.driftMs, threshold: 1000 },
          });
          this.eventEmitter.emit(
            EVENT_NAMES.TIME_DRIFT_HALT,
            new TimeHaltEvent(
              driftResult.driftMs,
              driftResult.serverUsed,
              new Date(),
              'Startup drift >1000ms',
            ),
          );
        } else if (driftResult.driftMs >= 500) {
          // Critical warning but allow startup (operator intervention required)
          this.logger.warn({
            message:
              'Critical clock drift detected at startup - operator intervention recommended',
            timestamp: new Date().toISOString(),
            module: 'core',
            correlationId: getCorrelationId(),
            data: { driftMs: driftResult.driftMs, threshold: 500 },
          });
        }
      } catch (error) {
        // Log error but don't block startup - NTP issues shouldn't prevent application from starting
        this.logger.error({
          message: 'Startup NTP validation failed',
          timestamp: new Date().toISOString(),
          module: 'core',
          correlationId: getCorrelationId(),
          data: {
            error: error instanceof Error ? error.message : 'Unknown error',
          },
        });
      }

      // Startup Reconciliation — verify positions against platform state
      try {
        const reconResult = await this.reconciliationService.reconcile();

        if (reconResult.discrepanciesFound > 0) {
          this.logger.error({
            message:
              'Reconciliation found discrepancies — trading halted until resolved',
            timestamp: new Date().toISOString(),
            module: 'core',
            correlationId: getCorrelationId(),
            data: {
              discrepanciesFound: reconResult.discrepanciesFound,
              positionsChecked: reconResult.positionsChecked,
            },
          });
        }
      } catch (error) {
        // Check if active positions exist
        const activeCount = await this.prisma.$queryRaw<
          { count: bigint }[]
        >`SELECT COUNT(*) as count FROM open_positions WHERE status IN ('OPEN', 'SINGLE_LEG_EXPOSED', 'EXIT_PARTIAL')`;
        const count = Number(activeCount[0]?.count ?? 0);

        if (count > 0) {
          this.logger.error({
            message:
              'Reconciliation failed with active positions — halting trading',
            timestamp: new Date().toISOString(),
            module: 'core',
            correlationId: getCorrelationId(),
            data: {
              error: error instanceof Error ? error.message : 'Unknown error',
              activePositions: count,
            },
          });
          this.logger.warn({
            message:
              'Risk state may be stale — reconciliation could not verify positions against platforms',
            timestamp: new Date().toISOString(),
            module: 'core',
            correlationId: getCorrelationId(),
          });
          this.riskManager.haltTrading('reconciliation_discrepancy');
        } else {
          this.logger.warn({
            message:
              'Reconciliation failed but no active positions — skipping halt',
            timestamp: new Date().toISOString(),
            module: 'core',
            correlationId: getCorrelationId(),
            data: {
              error: error instanceof Error ? error.message : 'Unknown error',
            },
          });
        }
      }

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
