import { Inject, Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DataIngestionService } from '../modules/data-ingestion/data-ingestion.service';
import { DetectionService } from '../modules/arbitrage-detection/detection.service';
import { EdgeCalculatorService } from '../modules/arbitrage-detection/edge-calculator.service';
import {
  withCorrelationId,
  getCorrelationId,
} from '../common/services/correlation-context';
import {
  EVENT_NAMES,
  TimeHaltEvent,
  TradingHaltedEvent,
} from '../common/events';
import { type IRiskManager } from '../common/interfaces/risk-manager.interface';
import { type IExecutionQueue } from '../common/interfaces/execution-queue.interface';
import { RankedOpportunity } from '../common/types/risk.type';
import { FinancialDecimal } from '../common/utils/financial-math';
import { EXECUTION_QUEUE_TOKEN } from '../modules/execution/execution.constants';

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
    private readonly detectionService: DetectionService,
    private readonly edgeCalculator: EdgeCalculatorService,
    private readonly eventEmitter: EventEmitter2,
    @Inject('IRiskManager') private readonly riskManager: IRiskManager,
    @Inject(EXECUTION_QUEUE_TOKEN)
    private readonly executionQueue: IExecutionQueue,
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
        const detectionResult =
          await this.detectionService.detectDislocations();
        this.logger.log({
          message: `Detection: ${detectionResult.dislocations.length} dislocations found`,
          correlationId: getCorrelationId(),
          data: {
            dislocations: detectionResult.dislocations.length,
            evaluated: detectionResult.pairsEvaluated,
            skipped: detectionResult.pairsSkipped,
            durationMs: detectionResult.cycleDurationMs,
          },
        });

        // STEP 2b: Edge Calculation & Opportunity Filtering (Story 3.3)
        const edgeResult = this.edgeCalculator.processDislocations(
          detectionResult.dislocations,
        );
        this.logger.log({
          message: `Edge calculation: ${edgeResult.summary.totalActionable} actionable opportunities`,
          correlationId: getCorrelationId(),
          data: {
            totalInput: edgeResult.summary.totalInput,
            filtered: edgeResult.summary.totalFiltered,
            actionable: edgeResult.summary.totalActionable,
            durationMs: edgeResult.summary.processingDurationMs,
          },
        });

        // STEP 3: Risk Pre-filter (cheap pre-screen before execution queue)
        const approvedOpportunities: RankedOpportunity[] = [];
        for (const opportunity of edgeResult.opportunities) {
          const decision = await this.riskManager.validatePosition(opportunity);
          this.logger.log({
            message: decision.approved
              ? 'Opportunity approved by risk manager'
              : `Opportunity rejected: ${decision.reason}`,
            correlationId: getCorrelationId(),
            data: {
              pair: `${opportunity.dislocation.pairConfig.polymarketContractId}:${opportunity.dislocation.pairConfig.kalshiContractId}`,
              netEdge: opportunity.netEdge.toString(),
              approved: decision.approved,
              maxPositionSizeUsd: decision.maxPositionSizeUsd.toString(),
              currentOpenPairs: decision.currentOpenPairs,
            },
          });

          if (decision.approved) {
            approvedOpportunities.push({
              opportunity,
              netEdge: opportunity.netEdge,
              reservationRequest: {
                opportunityId: `${opportunity.dislocation.pairConfig.polymarketContractId}:${opportunity.dislocation.pairConfig.kalshiContractId}:${Date.now()}`,
                recommendedPositionSizeUsd: new FinancialDecimal(
                  decision.maxPositionSizeUsd,
                ),
                pairId: `${opportunity.dislocation.pairConfig.polymarketContractId}:${opportunity.dislocation.pairConfig.kalshiContractId}`,
              },
            });
          }
        }

        // STEP 4: Sequential Execution via Queue (Story 4.4)
        if (approvedOpportunities.length > 0) {
          // Sort by netEdge descending (highest edge first)
          approvedOpportunities.sort((a, b) =>
            b.netEdge.minus(a.netEdge).toNumber(),
          );

          const queueResults = await this.executionQueue.processOpportunities(
            approvedOpportunities,
          );
          this.logger.log({
            message: `Execution queue processed ${queueResults.length} opportunities`,
            correlationId: getCorrelationId(),
            data: {
              total: queueResults.length,
              committed: queueResults.filter((r) => r.committed).length,
              failed: queueResults.filter((r) => !r.committed).length,
            },
          });
        }

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
