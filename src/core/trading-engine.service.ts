import { Injectable, Logger } from '@nestjs/common';

/**
 * Main trading engine service that orchestrates the polling loop.
 * Coordinates the detection → risk → execution pipeline.
 */
@Injectable()
export class TradingEngineService {
  private readonly logger = new Logger(TradingEngineService.name);
  private readonly SHUTDOWN_CHECK_INTERVAL_MS = 100; // Check interval for in-flight operations
  private isShuttingDown = false;
  private inflightOperations = 0;

  /**
   * Execute one complete trading cycle (detection → risk → execution pipeline).
   * Tracks in-flight operations for graceful shutdown.
   */
  async executeCycle(): Promise<void> {
    // Skip if shutting down
    if (this.isShuttingDown) {
      return;
    }

    this.inflightOperations++;
    const startTime = Date.now();

    try {
      this.logger.log({
        message: 'Starting trading cycle',
        timestamp: new Date().toISOString(),
        module: 'core',
        cycle: 'start',
      });

      // Placeholder pipeline - actual implementation comes in later stories
      await this.executePipelinePlaceholder();

      const duration = Date.now() - startTime;
      this.logger.log({
        message: `Trading cycle completed in ${duration}ms`,
        timestamp: new Date().toISOString(),
        module: 'core',
        cycle: 'complete',
        durationMs: duration,
      });
    } catch (error) {
      const duration = Date.now() - startTime;
      this.logger.error({
        message: 'Trading cycle failed',
        timestamp: new Date().toISOString(),
        module: 'core',
        cycle: 'error',
        durationMs: duration,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    } finally {
      this.inflightOperations--;
    }
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
      timestamp: new Date().toISOString(),
      module: 'core',
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
          timestamp: new Date().toISOString(),
          module: 'core',
          inflightOperations: this.inflightOperations,
          timeoutMs,
        });
        break;
      }

      await new Promise((resolve) =>
        setTimeout(resolve, this.SHUTDOWN_CHECK_INTERVAL_MS),
      );
    }

    this.logger.log({
      message: 'All in-flight operations completed',
      timestamp: new Date().toISOString(),
      module: 'core',
    });
  }

  /**
   * Placeholder for the trading pipeline.
   * Future stories will implement: data ingestion → detection → risk → execution
   *
   * @private
   */
  private async executePipelinePlaceholder(): Promise<void> {
    // Simulate processing time (100ms)
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Future implementation will call:
    // - DataIngestionService.aggregateOrderBooks()
    // - ArbitrageDetectionService.findOpportunities()
    // - RiskManagementService.validatePosition()
    // - ExecutionService.submitOrders()
  }
}
