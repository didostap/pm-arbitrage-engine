import { Inject, Injectable, Logger, forwardRef } from '@nestjs/common';
import Decimal from 'decimal.js';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../../../common/prisma.service';
import {
  SystemHealthError,
  SYSTEM_HEALTH_ERROR_CODES,
} from '../../../common/errors/system-health-error';
import { EVENT_NAMES } from '../../../common/events/event-catalog';
import {
  BacktestRunCompletedEvent,
  BacktestWalkForwardCompletedEvent,
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

@Injectable()
export class BacktestEngineService implements IBacktestEngine {
  private readonly logger = new Logger(BacktestEngineService.name);

  /** 8 deps rationale: facade/orchestrator coordinating state machine, portfolio,
   *  fill model, exit evaluator, persistence, events, walk-forward analysis,
   *  and calibration report auto-generation per AC #6 and AC #9 */
  constructor(
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
    private readonly stateMachine: BacktestStateMachineService,
    private readonly portfolioService: BacktestPortfolioService,
    private readonly fillModelService: FillModelService,
    private readonly exitEvaluatorService: ExitEvaluatorService,
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
  ): Promise<AggregateMetrics> {
    const tempRunId = `headless-${randomUUID()}`;
    const bankroll = new Decimal(config.bankrollUsd);
    this.portfolioService.initialize(bankroll, tempRunId);
    try {
      await this.runSimulationLoop(tempRunId, config, timeSteps, Date.now());
      this.closeRemainingPositions(tempRunId, timeSteps);
      return this.portfolioService.getAggregateMetrics(tempRunId);
    } finally {
      this.portfolioService.destroyRun(tempRunId);
    }
  }

  private async executePipeline(
    runId: string,
    config: IBacktestConfig,
  ): Promise<void> {
    const startTime = Date.now();

    try {
      // CONFIGURING → LOADING_DATA
      this.stateMachine.transitionRun(runId, 'LOADING_DATA');

      // Load data
      const pairs = await this.loadPairs(config);
      const prices = await this.loadPrices(config);
      const timeSteps = this.alignPrices(prices, pairs);

      // Check coverage
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

      if (pairs.length > 0 && timeSteps.length === 0) {
        await this.stateMachine.failRun(
          runId,
          SYSTEM_HEALTH_ERROR_CODES.BACKTEST_INSUFFICIENT_DATA,
          'No price data found for any pairs in the date range',
        );
        return;
      }

      const coveredMs =
        timeSteps.length > 0
          ? timeSteps[timeSteps.length - 1]!.timestamp.getTime() -
            timeSteps[0]!.timestamp.getTime()
          : 0;
      if (
        pairs.length > 0 &&
        coveredMs / dateRangeMs < MINIMUM_DATA_COVERAGE_PCT
      ) {
        await this.stateMachine.failRun(
          runId,
          SYSTEM_HEALTH_ERROR_CODES.BACKTEST_INSUFFICIENT_DATA,
          'Data coverage below 50% minimum threshold',
        );
        return;
      }

      // Walk-forward analysis (AC #6): run before main simulation
      let walkForwardResults:
        | import('../types/calibration-report.types').WalkForwardResults
        | null = null;
      if (config.walkForwardEnabled) {
        this.logger.log(
          `Walk-forward enabled for run ${runId}: 3 simulation passes (~3x cost)`,
        );
        const trainPct = config.walkForwardTrainPct ?? 0.7;
        const { train, test } = this.walkForwardService.splitTimeSteps(
          timeSteps,
          trainPct,
        );

        // Headless train pass
        const trainMetrics = await this.runHeadlessSimulation(config, train);
        if (this.stateMachine.isCancelled(runId)) return;

        // Headless test pass
        const testMetrics = await this.runHeadlessSimulation(config, test);
        if (this.stateMachine.isCancelled(runId)) return;

        walkForwardResults = this.walkForwardService.buildWalkForwardResults(
          trainPct,
          train,
          test,
          trainMetrics,
          testMetrics,
        );
      }

      // LOADING_DATA → SIMULATING (full range for canonical metrics)
      this.stateMachine.transitionRun(runId, 'SIMULATING');

      // Initialize portfolio
      const bankroll = new Decimal(config.bankrollUsd);
      this.portfolioService.initialize(bankroll, runId);

      // Run simulation
      await this.runSimulationLoop(runId, config, timeSteps, startTime);

      // Check cancellation after loop
      if (this.stateMachine.isCancelled(runId)) return;

      // Close remaining open positions (SIMULATION_END)
      this.closeRemainingPositions(runId, timeSteps);

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
    startTime: number,
  ): Promise<void> {
    const gasEstimate = new Decimal(config.gasEstimateUsd);
    const edgeThreshold = new Decimal(config.edgeThresholdPct);
    const positionSizePct = new Decimal(config.positionSizePct);
    const bankroll = new Decimal(config.bankrollUsd);

    const isHeadless = runId.startsWith('headless-');

    for (const step of timeSteps) {
      if (!isHeadless && this.stateMachine.isCancelled(runId)) return;

      // Timeout check
      if (Date.now() - startTime > config.timeoutSeconds * 1000) {
        if (isHeadless) {
          throw new SystemHealthError(
            SYSTEM_HEALTH_ERROR_CODES.BACKTEST_TIMEOUT,
            `Headless simulation exceeded ${config.timeoutSeconds}s timeout`,
            'warning',
            'backtest-engine',
          );
        }
        await this.stateMachine.failRun(
          runId,
          SYSTEM_HEALTH_ERROR_CODES.BACKTEST_TIMEOUT,
          `Simulation exceeded ${config.timeoutSeconds}s timeout`,
        );
        return;
      }

      if (!isInTradingWindow(step.timestamp, config)) continue;

      // 1. Evaluate exits for open positions
      await this.evaluateExits(
        runId,
        step,
        config,
        gasEstimate,
        positionSizePct.mul(bankroll),
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
      const kalshiDepth = await this.fillModelService.findNearestDepth(
        'KALSHI',
        position.kalshiContractId,
        step.timestamp,
      );
      const polyDepth = await this.fillModelService.findNearestDepth(
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
      );
      const polyFill = await this.fillModelService.modelFill(
        'POLYMARKET',
        pairData.polymarketContractId as ContractId,
        PlatformId.POLYMARKET,
        step.timestamp,
        buySide === 'kalshi' ? 'sell' : 'buy',
        positionSizeUsd,
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
    const closedPositions =
      this.portfolioService.getState(runId).closedPositions;

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

    if (closedPositions.length > 0) {
      await this.prisma.backtestPosition.createMany({
        data: closedPositions.map((p: SimulatedPosition) => ({
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
          qualityFlags: p.qualityFlags
            ? (p.qualityFlags as Prisma.InputJsonValue)
            : Prisma.JsonNull,
        })),
      });
    }
  }

  async loadPairs(config: IBacktestConfig): Promise<ContractMatch[]> {
    return this.prisma.contractMatch.findMany({
      where: {
        operatorApproved: true,
        confidenceScore: { gte: config.minConfidenceScore },
      },
    });
  }

  async loadPrices(config: IBacktestConfig): Promise<HistoricalPrice[]> {
    return this.prisma.historicalPrice.findMany({
      where: {
        timestamp: {
          gte: new Date(config.dateRangeStart),
          lte: new Date(config.dateRangeEnd),
        },
      },
      orderBy: { timestamp: 'asc' },
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
