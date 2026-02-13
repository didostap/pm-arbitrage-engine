import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DataIngestionService } from '../modules/data-ingestion/data-ingestion.service';
import {
  withCorrelationId,
  getCorrelationId,
} from '../common/services/correlation-context';
import {
  EVENT_NAMES,
  TimeHaltEvent,
  TradingHaltedEvent,
} from '../common/events';

/**
 * Main trading engine service that orchestrates the polling loop.
 * Coordinates the detection → risk → execution pipeline.
 */
@Injectable()
export class TradingEngineService {
  private readonly logger = new Logger(TradingEngineService.name);
  private readonly SHUTDOWN_CHECK_INTERVAL_MS = 100; // Check interval for in-flight operations
  private isShuttingDown = false;
  private isHalted = false;
  private inflightOperations = 0;

  constructor(
    private readonly dataIngestionService: DataIngestionService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  /**
   * Execute one complete trading cycle (detection → risk → execution pipeline).
   * Tracks in-flight operations for graceful shutdown.
   */
  async executeCycle(): Promise<void> {
    // Skip if shutting down
    if (this.isShuttingDown) {
      return;
    }

    // Skip if halted due to time drift or other critical issue
    if (this.isHalted) {
      this.logger.warn({
        message: 'Trading halted, skipping execution cycle',
        correlationId: getCorrelationId(),
      });
      return;
    }

    // Wrap cycle in correlation context
    await withCorrelationId(async () => {
      this.inflightOperations++;
      const startTime = Date.now();

      try {
        // IMPORTANT: For polling cycles (@Cron triggers), manually include correlationId
        // customProps only works for HTTP-triggered code paths
        this.logger.log({
          message: 'Starting trading cycle',
          correlationId: getCorrelationId(),
          data: {
            cycle: 'start',
          },
        });

        // STEP 1: Data Ingestion (Story 1.4)
        // NOTE: WebSocket updates run in parallel to this polling path for real-time data
        await this.dataIngestionService.ingestCurrentOrderBooks();

        // STEP 2: Arbitrage Detection (Epic 3)
        // await this.detectionService.detectOpportunities();

        // STEP 3: Risk Validation (Epic 4)
        // STEP 4: Execution (Epic 5)

        const duration = Date.now() - startTime;
        this.logger.log({
          message: `Trading cycle completed in ${duration}ms`,
          correlationId: getCorrelationId(),
          data: {
            cycle: 'complete',
            durationMs: duration,
          },
        });
      } catch (error) {
        const duration = Date.now() - startTime;
        this.logger.error({
          message: 'Trading cycle failed',
          correlationId: getCorrelationId(),
          data: {
            cycle: 'error',
            durationMs: duration,
            error: error instanceof Error ? error.message : 'Unknown error',
          },
        });
      } finally {
        this.inflightOperations--;
      }
    });
  }

  /**
   * Check if a trading cycle is currently in progress.
   * Used by scheduler to prevent overlapping cycles.
   */
  isCycleInProgress(): boolean {
    return this.inflightOperations > 0;
  }

  /**
   * Initiate graceful shutdown - stop accepting new cycles.
   */
  initiateShutdown(): void {
    this.logger.log({
      message: 'Trading engine shutdown initiated',
      correlationId: getCorrelationId(),
    });
    this.isShuttingDown = true;
  }

  /**
   * Wait for all in-flight operations to complete with timeout.
   *
   * @param timeoutMs - Maximum time to wait in milliseconds
   */
  async waitForShutdown(timeoutMs: number): Promise<void> {
    const startTime = Date.now();

    while (this.inflightOperations > 0) {
      const elapsed = Date.now() - startTime;
      if (elapsed >= timeoutMs) {
        this.logger.warn({
          message: 'Shutdown timeout - forcing shutdown',
          correlationId: getCorrelationId(),
          data: {
            inflightOperations: this.inflightOperations,
            timeoutMs,
          },
        });
        break;
      }

      await new Promise((resolve) =>
        setTimeout(resolve, this.SHUTDOWN_CHECK_INTERVAL_MS),
      );
    }

    this.logger.log({
      message: 'All in-flight operations completed',
      correlationId: getCorrelationId(),
    });
  }

  /**
   * Handle time drift halt event.
   * Sets halt flag and emits system-level trading halted event.
   */
  @OnEvent(EVENT_NAMES.TIME_DRIFT_HALT)
  handleTimeHalt(event: TimeHaltEvent): void {
    this.isHalted = true;

    this.logger.error({
      message: 'Trading halted due to severe clock drift',
      correlationId: getCorrelationId(),
      data: {
        driftMs: event.driftMs,
        haltReason: event.haltReason,
        timestamp: event.timestamp,
      },
    });

    // Emit system-level halt event for monitoring
    this.eventEmitter.emit(
      EVENT_NAMES.SYSTEM_TRADING_HALTED,
      new TradingHaltedEvent(
        'time_drift',
        event.driftMs,
        event.timestamp,
        'critical',
      ),
    );
  }

  /**
   * Resume trading after halt.
   * Requires operator intervention via dashboard API endpoint (Epic 7).
   */
  resume(): void {
    this.isHalted = false;
    this.logger.log({
      message: 'Trading resumed by operator',
      correlationId: getCorrelationId(),
    });
  }
}
