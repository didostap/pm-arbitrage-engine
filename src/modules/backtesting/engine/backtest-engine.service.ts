import { Inject, Injectable, Logger, forwardRef } from '@nestjs/common';
import Decimal from 'decimal.js';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../../../common/prisma.service';
import {
  // SystemHealthError,
  SYSTEM_HEALTH_ERROR_CODES,
} from '../../../common/errors/system-health-error';
import { EVENT_NAMES } from '../../../common/events/event-catalog';
import {
  BacktestRunCompletedEvent,
  BacktestWalkForwardCompletedEvent,
  BacktestPipelineChunkCompletedEvent,
} from '../../../common/events/backtesting.events';
import { FinancialMath } from '../../../common/utils/financial-math';
import { PlatformId } from '../../../common/types/platform.type';
import type { ContractId } from '../../../common/types/branded.type';
import {
  Prisma,
  type ContractMatch,
  type HistoricalPrice,
} from '@prisma/client';
import type {
  IBacktestEngine,
  IBacktestConfig,
  BacktestRunStatus,
} from '../../../common/interfaces/backtest-engine.interface';
import { createSimulatedPosition } from '../types/simulation.types';
import type {
  BacktestTimeStep,
  BacktestTimeStepPair,
  SimulatedPosition,
} from '../types/simulation.types';
import { BacktestStateMachineService } from './backtest-state-machine.service';
import {
  BacktestPortfolioService,
  type AggregateMetrics,
} from './backtest-portfolio.service';
import { FillModelService } from './fill-model.service';
import { ExitEvaluatorService } from './exit-evaluator.service';
import {
  BacktestDataLoaderService,
  findNearestDepthFromCache,
  type DepthCache,
} from './backtest-data-loader.service';
import { WalkForwardService } from '../reporting/walk-forward.service';
import { CalibrationReportService } from '../reporting/calibration-report.service';
import {
  calculateBestEdge,
  calculateNetEdge,
  calculateCurrentEdge,
  isInTradingWindow,
  inferResolutionPrice,
} from '../utils/edge-calculation.utils';
import { randomUUID } from 'crypto';

const MINIMUM_DATA_COVERAGE_PCT = 0.5;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class BacktestEngineService implements IBacktestEngine {
  private readonly logger = new Logger(BacktestEngineService.name);

  /** 9 deps rationale: BacktestDataLoaderService added for chunked data loading;
   *  PrismaService still needed for persistResults. Extracting further would split
   *  pipeline orchestration across 3 services, increasing coordination complexity
   *  without reducing coupling */
  constructor(
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
    private readonly stateMachine: BacktestStateMachineService,
    private readonly portfolioService: BacktestPortfolioService,
    private readonly fillModelService: FillModelService,
    private readonly exitEvaluatorService: ExitEvaluatorService,
    private readonly dataLoader: BacktestDataLoaderService,
    @Inject(forwardRef(() => WalkForwardService))
    private readonly walkForwardService: WalkForwardService,
    @Inject(forwardRef(() => CalibrationReportService))
    private readonly calibrationReportService: CalibrationReportService,
  ) {}

  async startRun(config: IBacktestConfig): Promise<string> {
    const runId = await this.stateMachine.createRun(config);

    this.executePipeline(runId, config).catch(async (err: unknown) => {
      const error = err instanceof Error ? err : new Error(String(err));
      const code =
        'code' in (err as object) ? (err as { code: number }).code : undefined;
      this.logger.error(`Pipeline failed for run ${runId}: ${error.message}`);
      if (!this.stateMachine.isCancelled(runId)) {
        await this.stateMachine.failRun(
          runId,
          code ?? SYSTEM_HEALTH_ERROR_CODES.BACKTEST_STATE_ERROR,
          error.message,
        );
      }
      this.stateMachine.cleanupRun(runId);
      this.portfolioService.destroyRun(runId);
    });

    return runId;
  }

  async cancelRun(runId: string): Promise<void> {
    await this.stateMachine.cancelRun(runId);
  }

  getRunStatus(runId: string): BacktestRunStatus | null {
    return this.stateMachine.getRunStatus(runId);
  }

  /**
   * Run simulation without state machine, persistence, or events.
   * Used by walk-forward and sensitivity analysis for lightweight sub-runs.
   */
  async runHeadlessSimulation(
    config: IBacktestConfig,
    timeSteps: BacktestTimeStep[],
    depthCache?: DepthCache,
  ): Promise<AggregateMetrics> {
    const tempRunId = `headless-${randomUUID()}`;
    const bankroll = new Decimal(config.bankrollUsd);
    this.portfolioService.initialize(bankroll, tempRunId);
    try {
      await this.runSimulationLoop(
        tempRunId,
        config,
        timeSteps,
        Date.now(),
        depthCache,
      );
      this.closeRemainingPositions(tempRunId, timeSteps);
      const lastTs =
        timeSteps.length > 0
          ? timeSteps[timeSteps.length - 1]!.timestamp
          : new Date();
      this.portfolioService.addFinalSnapshot(tempRunId, lastTs);
      return this.portfolioService.getAggregateMetrics(tempRunId);
    } finally {
      this.portfolioService.destroyRun(tempRunId);
    }
  }

  private async executePipeline(
    runId: string,
    config: IBacktestConfig,
  ): Promise<void> {
    const pipelineStartTime = Date.now();

    try {
      // CONFIGURING → LOADING_DATA
      this.stateMachine.transitionRun(runId, 'LOADING_DATA');

      // Load pairs (small, single query)
      const pairs = await this.dataLoader.loadPairs(config);

      // Validate date range
      const dateRangeMs =
        new Date(config.dateRangeEnd).getTime() -
        new Date(config.dateRangeStart).getTime();

      if (dateRangeMs <= 0) {
        await this.stateMachine.failRun(
          runId,
          SYSTEM_HEALTH_ERROR_CODES.BACKTEST_INVALID_CONFIGURATION,
          'dateRangeEnd must be after dateRangeStart',
        );
        return;
      }

      // Coverage check across full date range (works for single-chunk and multi-chunk)
      if (pairs.length > 0) {
        const coverage = await this.dataLoader.checkDataCoverage(
          new Date(config.dateRangeStart),
          new Date(config.dateRangeEnd),
        );
        if (!coverage.hasData) {
          await this.stateMachine.failRun(
            runId,
            SYSTEM_HEALTH_ERROR_CODES.BACKTEST_INSUFFICIENT_DATA,
            'No price data found for any pairs in the date range',
          );
          return;
        }
        if (coverage.coveragePct < MINIMUM_DATA_COVERAGE_PCT) {
          await this.stateMachine.failRun(
            runId,
            SYSTEM_HEALTH_ERROR_CODES.BACKTEST_INSUFFICIENT_DATA,
            'Data coverage below 50% minimum threshold',
          );
          return;
        }
      }

      // Generate chunk ranges
      const chunkRanges = this.dataLoader.generateChunkRanges(
        new Date(config.dateRangeStart),
        new Date(config.dateRangeEnd),
        config.chunkWindowDays,
      );
      const totalChunks = chunkRanges.length;

      // Walk-forward setup: compute boundary, initialize headless portfolios
      let walkForwardResults:
        | import('../types/calibration-report.types').WalkForwardResults
        | null = null;
      let trainEndDate: Date | null = null;
      let headlessTrainRunId: string | null = null;
      let headlessTestRunId: string | null = null;

      if (config.walkForwardEnabled) {
        this.logger.log(
          `Walk-forward enabled for run ${runId}: chunked routing to train/test`,
        );
        const trainPct = config.walkForwardTrainPct ?? 0.7;
        const rangeMs = dateRangeMs;
        const trainEndMs =
          new Date(config.dateRangeStart).getTime() + rangeMs * trainPct;
        trainEndDate = new Date(trainEndMs);
        trainEndDate.setUTCHours(0, 0, 0, 0);

        // Guard: truncation may collapse train window for short ranges
        const rangeStartMs = new Date(config.dateRangeStart).getTime();
        const rangeEndMs = new Date(config.dateRangeEnd).getTime();
        if (trainEndDate.getTime() <= rangeStartMs) {
          trainEndDate = new Date(rangeStartMs + ONE_DAY_MS);
          trainEndDate.setUTCHours(0, 0, 0, 0);
        }
        if (trainEndDate.getTime() >= rangeEndMs) {
          await this.stateMachine.failRun(
            runId,
            SYSTEM_HEALTH_ERROR_CODES.BACKTEST_INVALID_CONFIGURATION,
            'Date range too short for walk-forward analysis (minimum 2 days required)',
          );
          return;
        }

        headlessTrainRunId = `${runId}-wf-train`;
        headlessTestRunId = `${runId}-wf-test`;
        const bankroll = new Decimal(config.bankrollUsd);
        this.portfolioService.initialize(bankroll, headlessTrainRunId);
        this.portfolioService.initialize(bankroll, headlessTestRunId);
      }

      // LOADING_DATA → SIMULATING
      this.stateMachine.transitionRun(runId, 'SIMULATING');

      // Initialize main portfolio
      const bankroll = new Decimal(config.bankrollUsd);
      this.portfolioService.initialize(bankroll, runId);

      // Track last timeSteps per run for closeRemainingPositions
      let lastTimeSteps: BacktestTimeStep[] = [];
      let lastTrainTimeSteps: BacktestTimeStep[] = [];
      let lastTestTimeSteps: BacktestTimeStep[] = [];

      // Walk-forward metrics — extracted inside try, before finally destroys portfolios
      let trainMetrics: AggregateMetrics | null = null;
      let testMetrics: AggregateMetrics | null = null;

      try {
        // === CHUNK LOOP ===
        for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex++) {
          try {
            if (this.stateMachine.isCancelled(runId)) return;

            const chunkRange = chunkRanges[chunkIndex]!;
            const isLastChunk = chunkIndex === totalChunks - 1;

            // Load aligned prices via database-side JOIN (bypasses Prisma napi bridge)
            const chunkTimeSteps =
              await this.dataLoader.loadAlignedPricesForChunk(
                chunkRange.start,
                chunkRange.end,
                config.minConfidenceScore,
                isLastChunk,
              );

            // Derive contract IDs from chunk-active data only (not all approved pairs)
            const chunkContractIds = [
              ...new Set(
                chunkTimeSteps.flatMap((ts) =>
                  ts.pairs
                    .flatMap((p) => [
                      p.kalshiContractId,
                      p.polymarketContractId,
                    ])
                    .filter((id): id is string => !!id),
                ),
              ),
            ];

            // Pre-load depth cache for this chunk
            const depthCache = await this.dataLoader.preloadDepthsForChunk(
              chunkContractIds,
              chunkRange.start,
              chunkRange.end,
              isLastChunk,
            );

            // Empty chunk: emit progress, check timeout, skip simulation
            if (chunkTimeSteps.length === 0) {
              this.eventEmitter.emit(
                EVENT_NAMES.BACKTEST_PIPELINE_CHUNK_COMPLETED,
                new BacktestPipelineChunkCompletedEvent({
                  runId,
                  chunkIndex,
                  totalChunks,
                  chunkDateStart: chunkRange.start,
                  chunkDateEnd: chunkRange.end,
                  elapsedMs: Date.now() - pipelineStartTime,
                  positionsOpenedInChunk: 0,
                  positionsClosedInChunk: 0,
                }),
              );
              // Timeout check for empty chunks too
              // if (
              //   Date.now() - pipelineStartTime >
              //   config.timeoutSeconds * 1000
              // ) {
              //   await this.stateMachine.failRun(
              //     runId,
              //     SYSTEM_HEALTH_ERROR_CODES.BACKTEST_TIMEOUT,
              //     `Pipeline exceeded ${config.timeoutSeconds}s timeout at chunk ${chunkIndex + 1}/${totalChunks}`,
              //   );
              //   return;
              // }
              continue;
            }

            lastTimeSteps = chunkTimeSteps;

            // Snapshot position counts before simulation
            const mainState = this.portfolioService.getState(runId);
            const openBefore = mainState.openPositions.size;
            const closedBefore = mainState.closedPositions.length;

            // Run main simulation for this chunk
            await this.runSimulationLoop(
              runId,
              config,
              chunkTimeSteps,
              pipelineStartTime,
              depthCache,
            );

            // Walk-forward: route chunk to train or test headless sim
            if (
              config.walkForwardEnabled &&
              trainEndDate &&
              headlessTrainRunId &&
              headlessTestRunId
            ) {
              if (chunkRange.end <= trainEndDate) {
                await this.runSimulationLoop(
                  headlessTrainRunId,
                  config,
                  chunkTimeSteps,
                  pipelineStartTime,
                  depthCache,
                );
                lastTrainTimeSteps = chunkTimeSteps;
              } else if (chunkRange.start >= trainEndDate) {
                await this.runSimulationLoop(
                  headlessTestRunId,
                  config,
                  chunkTimeSteps,
                  pipelineStartTime,
                  depthCache,
                );
                lastTestTimeSteps = chunkTimeSteps;
              } else {
                // Chunk spans boundary — split timeSteps
                const trainSteps = chunkTimeSteps.filter(
                  (ts) => ts.timestamp < trainEndDate,
                );
                const testSteps = chunkTimeSteps.filter(
                  (ts) => ts.timestamp >= trainEndDate,
                );
                if (trainSteps.length > 0) {
                  await this.runSimulationLoop(
                    headlessTrainRunId,
                    config,
                    trainSteps,
                    pipelineStartTime,
                    depthCache,
                  );
                  lastTrainTimeSteps = trainSteps;
                }
                if (testSteps.length > 0) {
                  await this.runSimulationLoop(
                    headlessTestRunId,
                    config,
                    testSteps,
                    pipelineStartTime,
                    depthCache,
                  );
                  lastTestTimeSteps = testSteps;
                }
              }
            }

            // Compute per-chunk position deltas
            const mainStateAfter = this.portfolioService.getState(runId);
            const positionsOpenedInChunk =
              mainStateAfter.openPositions.size -
              openBefore +
              (mainStateAfter.closedPositions.length - closedBefore);
            const positionsClosedInChunk =
              mainStateAfter.closedPositions.length - closedBefore;

            // Emit chunk progress event
            this.eventEmitter.emit(
              EVENT_NAMES.BACKTEST_PIPELINE_CHUNK_COMPLETED,
              new BacktestPipelineChunkCompletedEvent({
                runId,
                chunkIndex,
                totalChunks,
                chunkDateStart: chunkRange.start,
                chunkDateEnd: chunkRange.end,
                elapsedMs: Date.now() - pipelineStartTime,
                positionsOpenedInChunk,
                positionsClosedInChunk,
              }),
            );

            // Flush closed positions to DB at chunk boundaries to bound memory
            // Isolated try/catch: DB failure retains positions for next chunk's flush
            const flushedPositions =
              this.portfolioService.flushClosedPositions(runId);
            if (flushedPositions.length > 0) {
              try {
                await this.batchWritePositions(runId, flushedPositions);
                this.portfolioService.clearFlushedPositions(runId);
              } catch (flushErr: unknown) {
                const msg =
                  flushErr instanceof Error
                    ? flushErr.message
                    : String(flushErr);
                this.logger.error(
                  `Chunk ${chunkIndex + 1}: position flush failed (${flushedPositions.length} positions retained for next flush): ${msg}`,
                );
              }
            }

            // Timeout check at end of each chunk (cumulative, not per-chunk)
            // if (Date.now() - pipelineStartTime > config.timeoutSeconds * 1000) {
            //   await this.stateMachine.failRun(
            //     runId,
            //     SYSTEM_HEALTH_ERROR_CODES.BACKTEST_TIMEOUT,
            //     `Pipeline exceeded ${config.timeoutSeconds}s timeout at chunk ${chunkIndex + 1}/${totalChunks}`,
            //   );
            //   return;
            // }

            // prices, depthCache, chunkTimeSteps go out of scope → GC
          } catch (err: unknown) {
            const error = err instanceof Error ? err : new Error(String(err));
            this.logger.error(
              `Chunk ${chunkIndex + 1} failed: ${error.message}`,
            );
          }
        }

        // Check cancellation after chunk loop
        if (this.stateMachine.isCancelled(runId)) return;

        // Close remaining open positions (SIMULATION_END) — AFTER the chunk loop
        this.closeRemainingPositions(runId, lastTimeSteps);

        // Push final capital snapshot to close the last utilization period
        const mainLastTs =
          lastTimeSteps.length > 0
            ? lastTimeSteps[lastTimeSteps.length - 1]!.timestamp
            : new Date();
        this.portfolioService.addFinalSnapshot(runId, mainLastTs);

        // Walk-forward: close remaining + extract metrics BEFORE finally destroys portfolios
        if (
          config.walkForwardEnabled &&
          headlessTrainRunId &&
          headlessTestRunId
        ) {
          this.closeRemainingPositions(headlessTrainRunId, lastTrainTimeSteps);
          this.closeRemainingPositions(headlessTestRunId, lastTestTimeSteps);
          const trainLastTs =
            lastTrainTimeSteps.length > 0
              ? lastTrainTimeSteps[lastTrainTimeSteps.length - 1]!.timestamp
              : new Date();
          const testLastTs =
            lastTestTimeSteps.length > 0
              ? lastTestTimeSteps[lastTestTimeSteps.length - 1]!.timestamp
              : new Date();
          this.portfolioService.addFinalSnapshot(
            headlessTrainRunId,
            trainLastTs,
          );
          this.portfolioService.addFinalSnapshot(headlessTestRunId, testLastTs);
          trainMetrics =
            this.portfolioService.getAggregateMetrics(headlessTrainRunId);
          testMetrics =
            this.portfolioService.getAggregateMetrics(headlessTestRunId);
        }
      } finally {
        // Destroy headless portfolios in finally block (even on error)
        if (headlessTrainRunId)
          this.portfolioService.destroyRun(headlessTrainRunId);
        if (headlessTestRunId)
          this.portfolioService.destroyRun(headlessTestRunId);
      }

      // Build walk-forward results from extracted metrics
      if (
        config.walkForwardEnabled &&
        trainMetrics &&
        testMetrics &&
        trainEndDate
      ) {
        const trainPct = config.walkForwardTrainPct ?? 0.7;

        // Construct date-range placeholders from known boundaries
        const rangeStart = new Date(config.dateRangeStart);
        const rangeEnd = new Date(config.dateRangeEnd);
        const trainPlaceholder: BacktestTimeStep[] = [
          { timestamp: rangeStart, pairs: [] },
          { timestamp: trainEndDate, pairs: [] },
        ];
        const testPlaceholder: BacktestTimeStep[] = [
          { timestamp: trainEndDate, pairs: [] },
          { timestamp: rangeEnd, pairs: [] },
        ];
        walkForwardResults = this.walkForwardService.buildWalkForwardResults(
          trainPct,
          trainPlaceholder,
          testPlaceholder,
          trainMetrics,
          testMetrics,
        );
      }

      // Check cancellation before report generation
      if (this.stateMachine.isCancelled(runId)) return;

      // Transition in-memory FIRST, then persist
      this.stateMachine.transitionRun(runId, 'GENERATING_REPORT');

      // Persist results
      await this.persistResults(runId);

      // Persist walk-forward results if enabled
      if (walkForwardResults) {
        await this.prisma.backtestRun.update({
          where: { id: runId },
          data: {
            walkForwardResults:
              walkForwardResults as unknown as Prisma.InputJsonValue,
          },
        });

        this.eventEmitter.emit(
          EVENT_NAMES.BACKTEST_WALKFORWARD_COMPLETED,
          new BacktestWalkForwardCompletedEvent({
            runId,
            overfitFlags: walkForwardResults.overfitFlags,
            trainPct: walkForwardResults.trainPct,
            testPct: walkForwardResults.testPct,
          }),
        );
      }

      // Auto-generate calibration report (AC #9) — non-blocking
      try {
        await this.calibrationReportService.generateReport(runId);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.warn(`Report generation failed for run ${runId}: ${msg}`);
      }

      this.stateMachine.transitionRun(runId, 'COMPLETE');

      const metrics = this.portfolioService.getAggregateMetrics(runId);
      this.eventEmitter.emit(
        EVENT_NAMES.BACKTEST_RUN_COMPLETED,
        new BacktestRunCompletedEvent({
          runId,
          metrics: {
            totalPositions: metrics.totalPositions,
            totalPnl: metrics.totalPnl.toString(),
            sharpeRatio: metrics.sharpeRatio?.toString() ?? null,
          },
        }),
      );
    } catch (err: unknown) {
      if (!this.stateMachine.isCancelled(runId)) {
        const error = err instanceof Error ? err : new Error(String(err));
        const code =
          err !== null &&
          typeof err === 'object' &&
          'code' in err &&
          typeof (err as { code: unknown }).code === 'number'
            ? (err as { code: number }).code
            : SYSTEM_HEALTH_ERROR_CODES.BACKTEST_STATE_ERROR;
        await this.stateMachine.failRun(runId, code, error.message);
      }
    } finally {
      this.stateMachine.cleanupRun(runId);
      this.portfolioService.destroyRun(runId);
    }
  }

  private async runSimulationLoop(
    runId: string,
    config: IBacktestConfig,
    timeSteps: BacktestTimeStep[],
    _startTime: number,
    depthCache?: DepthCache,
  ): Promise<void> {
    const gasEstimate = new Decimal(config.gasEstimateUsd);
    const edgeThreshold = new Decimal(config.edgeThresholdPct);
    const positionSizePct = new Decimal(config.positionSizePct);
    const bankroll = new Decimal(config.bankrollUsd);

    const isHeadless =
      runId.startsWith('headless-') ||
      runId.endsWith('-wf-train') ||
      runId.endsWith('-wf-test');

    for (const step of timeSteps) {
      if (!isHeadless && this.stateMachine.isCancelled(runId)) return;

      // Timeout check
      // if (Date.now() - startTime > config.timeoutSeconds * 1000) {
      //   if (isHeadless) {
      //     throw new SystemHealthError(
      //       SYSTEM_HEALTH_ERROR_CODES.BACKTEST_TIMEOUT,
      //       `Headless simulation exceeded ${config.timeoutSeconds}s timeout`,
      //       'warning',
      //       'backtest-engine',
      //     );
      //   }
      //   await this.stateMachine.failRun(
      //     runId,
      //     SYSTEM_HEALTH_ERROR_CODES.BACKTEST_TIMEOUT,
      //     `Simulation exceeded ${config.timeoutSeconds}s timeout`,
      //   );
      //   return;
      // }

      if (!isInTradingWindow(step.timestamp, config)) continue;

      // 1. Evaluate exits for open positions
      await this.evaluateExits(
        runId,
        step,
        config,
        gasEstimate,
        positionSizePct.mul(bankroll),
        depthCache,
      );

      // 2. Detect new opportunities
      await this.detectOpportunities(
        runId,
        step,
        config,
        gasEstimate,
        edgeThreshold,
        positionSizePct,
        bankroll,
        depthCache,
      );

      // 3. Update equity (mark-to-market)
      this.updateEquity(runId, step);
    }
  }

  private async evaluateExits(
    runId: string,
    step: BacktestTimeStep,
    config: IBacktestConfig,
    gasEstimate: Decimal,
    positionSizeUsd: Decimal,
    depthCache?: DepthCache,
  ): Promise<void> {
    const state = this.portfolioService.getState(runId);
    for (const [positionId, position] of [...state.openPositions]) {
      const pairData = step.pairs.find((p) => p.pairId === position.pairId);
      if (!pairData) continue;

      const currentNetEdge = calculateCurrentEdge(
        pairData,
        gasEstimate,
        positionSizeUsd,
      );

      // Check depth on BOTH platforms (P-8 fix)
      // When depthCache is provided, use cache lookup; otherwise fall back to DB
      const kalshiDepth = depthCache
        ? await findNearestDepthFromCache(
            depthCache,
            'KALSHI',
            position.kalshiContractId,
            step.timestamp,
          )
        : await this.fillModelService.findNearestDepth(
            'KALSHI',
            position.kalshiContractId,
            step.timestamp,
          );
      const polyDepth = depthCache
        ? await findNearestDepthFromCache(
            depthCache,
            'POLYMARKET',
            position.polymarketContractId,
            step.timestamp,
          )
        : await this.fillModelService.findNearestDepth(
            'POLYMARKET',
            position.polymarketContractId,
            step.timestamp,
          );
      const hasDepth = kalshiDepth !== null && polyDepth !== null;

      const exitResult = this.exitEvaluatorService.evaluateExits({
        position,
        currentNetEdge,
        currentTimestamp: step.timestamp,
        exitEdgeEvaporationPct: new Decimal(config.exitEdgeEvaporationPct),
        exitTimeLimitHours: config.exitTimeLimitHours,
        exitProfitCapturePct: new Decimal(config.exitProfitCapturePct),
        resolutionTimestamp: pairData.resolutionTimestamp,
        resolutionPrice: pairData.resolutionTimestamp
          ? inferResolutionPrice(pairData)
          : null,
        hasDepth,
      });

      if (exitResult) {
        // P-3 fix: use resolution prices for RESOLUTION_FORCE_CLOSE
        let kalshiExitPrice = pairData.kalshiClose;
        let polymarketExitPrice = pairData.polymarketClose;
        if (exitResult.reason === 'RESOLUTION_FORCE_CLOSE') {
          const resPrice = inferResolutionPrice(pairData);
          if (resPrice) {
            kalshiExitPrice = resPrice;
            polymarketExitPrice = new Decimal(1).minus(resPrice);
          }
        }

        this.portfolioService.closePosition(runId, positionId, {
          exitTimestamp: step.timestamp,
          exitReason: exitResult.reason,
          kalshiExitPrice,
          polymarketExitPrice,
          exitEdge: currentNetEdge,
        });
      }
    }
  }

  private async detectOpportunities(
    runId: string,
    step: BacktestTimeStep,
    config: IBacktestConfig,
    gasEstimate: Decimal,
    edgeThreshold: Decimal,
    positionSizePct: Decimal,
    bankroll: Decimal,
    depthCache?: DepthCache,
  ): Promise<void> {
    for (const pairData of step.pairs) {
      const currentState = this.portfolioService.getState(runId);
      if (currentState.openPositions.size >= config.maxConcurrentPairs) break;

      const hasPosition = [...currentState.openPositions.values()].some(
        (p) => p.pairId === pairData.pairId,
      );
      if (hasPosition) continue;

      const positionSizeUsd = positionSizePct.mul(bankroll);
      const { bestEdge, buySide } = calculateBestEdge(pairData);
      const netEdge = calculateNetEdge(
        bestEdge,
        pairData,
        buySide,
        gasEstimate,
        positionSizeUsd,
      );

      if (!FinancialMath.isAboveThreshold(netEdge, edgeThreshold)) continue;

      const kalshiFill = await this.fillModelService.modelFill(
        'KALSHI',
        pairData.kalshiContractId as ContractId,
        PlatformId.KALSHI,
        step.timestamp,
        buySide === 'kalshi' ? 'buy' : 'sell',
        positionSizeUsd,
        depthCache,
        pairData.kalshiClose,
      );
      const polyFill = await this.fillModelService.modelFill(
        'POLYMARKET',
        pairData.polymarketContractId as ContractId,
        PlatformId.POLYMARKET,
        step.timestamp,
        buySide === 'kalshi' ? 'sell' : 'buy',
        positionSizeUsd,
        depthCache,
        pairData.polymarketClose,
      );

      // Both legs must fill (AC#8)
      if (!kalshiFill || !polyFill) continue;
      if (currentState.availableCapital.lt(positionSizeUsd)) continue;

      const position = createSimulatedPosition({
        positionId: `${runId}-${pairData.pairId}-${step.timestamp.getTime()}`,
        pairId: pairData.pairId,
        kalshiContractId: pairData.kalshiContractId,
        polymarketContractId: pairData.polymarketContractId,
        kalshiSide: buySide === 'kalshi' ? 'BUY' : 'SELL',
        polymarketSide: buySide === 'kalshi' ? 'SELL' : 'BUY',
        kalshiEntryPrice: pairData.kalshiClose,
        polymarketEntryPrice: pairData.polymarketClose,
        positionSizeUsd,
        entryEdge: netEdge,
        entryTimestamp: step.timestamp,
      });

      this.portfolioService.openPosition(runId, position);
    }
  }

  private updateEquity(runId: string, step: BacktestTimeStep): void {
    const priceUpdates = new Map<
      string,
      { kalshiCurrentPrice: Decimal; polymarketCurrentPrice: Decimal }
    >();
    for (const [posId, pos] of this.portfolioService.getState(runId)
      .openPositions) {
      const pd = step.pairs.find((p) => p.pairId === pos.pairId);
      if (pd) {
        priceUpdates.set(posId, {
          kalshiCurrentPrice: pd.kalshiClose,
          polymarketCurrentPrice: pd.polymarketClose,
        });
      }
    }
    this.portfolioService.updateEquity(runId, priceUpdates);
  }

  private closeRemainingPositions(
    runId: string,
    timeSteps: BacktestTimeStep[],
  ): void {
    const finalState = this.portfolioService.getState(runId);
    const lastStep =
      timeSteps.length > 0 ? timeSteps[timeSteps.length - 1] : undefined;
    const lastTimestamp = lastStep?.timestamp ?? new Date();
    for (const [positionId, position] of [...finalState.openPositions]) {
      const lastPair = lastStep?.pairs.find(
        (p) => p.pairId === position.pairId,
      );
      this.portfolioService.closePosition(runId, positionId, {
        exitTimestamp: lastTimestamp,
        exitReason: 'SIMULATION_END',
        kalshiExitPrice: lastPair?.kalshiClose ?? position.kalshiEntryPrice,
        polymarketExitPrice:
          lastPair?.polymarketClose ?? position.polymarketEntryPrice,
        exitEdge: new Decimal('0'),
      });
    }
  }

  private async persistResults(runId: string): Promise<void> {
    const metrics = this.portfolioService.getAggregateMetrics(runId);

    await this.prisma.backtestRun.update({
      where: { id: runId },
      data: {
        status: 'COMPLETE',
        completedAt: new Date(),
        totalPositions: metrics.totalPositions,
        winCount: metrics.winCount,
        lossCount: metrics.lossCount,
        totalPnl: metrics.totalPnl.toFixed(10),
        maxDrawdown: metrics.maxDrawdown.toFixed(10),
        sharpeRatio: metrics.sharpeRatio?.toFixed(10) ?? null,
        profitFactor: metrics.profitFactor?.toFixed(10) ?? null,
        avgHoldingHours: metrics.avgHoldingHours.toFixed(6),
        capitalUtilization: metrics.capitalUtilization.toFixed(10),
      },
    });

    // Write any remaining unflushed positions (positions closed after last chunk boundary)
    const remainingPositions =
      this.portfolioService.getState(runId).closedPositions;
    if (remainingPositions.length > 0) {
      await this.batchWritePositions(runId, remainingPositions);
    }
  }

  private async batchWritePositions(
    runId: string,
    positions: SimulatedPosition[],
  ): Promise<void> {
    await this.prisma.backtestPosition.createMany({
      data: positions.map((p) => ({
        runId,
        pairId: p.pairId,
        kalshiContractId: p.kalshiContractId,
        polymarketContractId: p.polymarketContractId,
        kalshiSide: p.kalshiSide,
        polymarketSide: p.polymarketSide,
        entryTimestamp: p.entryTimestamp,
        exitTimestamp: p.exitTimestamp,
        kalshiEntryPrice: p.kalshiEntryPrice.toFixed(10),
        polymarketEntryPrice: p.polymarketEntryPrice.toFixed(10),
        kalshiExitPrice: p.kalshiExitPrice?.toFixed(10) ?? null,
        polymarketExitPrice: p.polymarketExitPrice?.toFixed(10) ?? null,
        positionSizeUsd: p.positionSizeUsd.toFixed(6),
        entryEdge: p.entryEdge.toFixed(10),
        exitEdge: p.exitEdge?.toFixed(10) ?? null,
        realizedPnl: p.realizedPnl?.toFixed(10) ?? null,
        fees: p.fees?.toFixed(6) ?? null,
        exitReason: p.exitReason,
        holdingHours: p.holdingHours?.toFixed(6) ?? null,
      })),
    });
  }

  alignPrices(
    prices: HistoricalPrice[],
    pairs: ContractMatch[],
  ): BacktestTimeStep[] {
    // Group prices by minute-truncated timestamp (P-31 fix)
    const byTimestamp = new Map<string, Map<string, HistoricalPrice>>();
    for (const price of prices) {
      const tsKey = price.timestamp.toISOString().slice(0, 16) + ':00.000Z';
      if (!byTimestamp.has(tsKey)) byTimestamp.set(tsKey, new Map());
      byTimestamp
        .get(tsKey)!
        .set(`${price.platform}:${price.contractId}`, price);
    }

    const timeSteps: BacktestTimeStep[] = [];

    for (const [tsKey, priceMap] of byTimestamp) {
      const timestamp = new Date(tsKey);
      const stepPairs: BacktestTimeStepPair[] = [];

      for (const pair of pairs) {
        if (!pair.polymarketClobTokenId) continue;
        const clobTokenId = pair.polymarketClobTokenId;

        const kalshiPrice = priceMap.get(`KALSHI:${pair.kalshiContractId}`);
        const polyPrice = priceMap.get(`POLYMARKET:${clobTokenId}`);

        if (!kalshiPrice || !polyPrice) continue;

        stepPairs.push({
          pairId: `${pair.kalshiContractId}:${clobTokenId}`,
          kalshiContractId: pair.kalshiContractId,
          polymarketContractId: clobTokenId,
          kalshiClose: new Decimal(String(kalshiPrice.close)),
          polymarketClose: new Decimal(String(polyPrice.close)),
          resolutionTimestamp: pair.resolutionTimestamp ?? null,
        });
      }

      if (stepPairs.length > 0) {
        timeSteps.push({ timestamp, pairs: stepPairs });
      }
    }

    timeSteps.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
    return timeSteps;
  }
}
