import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ConfigService } from '@nestjs/config';
import Decimal from 'decimal.js';

import { FinancialMath, getResidualSize } from '../../common/utils';
import { PositionRepository } from '../../persistence/repositories/position.repository';
import { OrderRepository } from '../../persistence/repositories/order.repository';
import { PrismaService } from '../../common/prisma.service';
import { RISK_MANAGER_TOKEN } from '../risk-management/risk-management.constants';
import type { IRiskManager } from '../../common/interfaces/risk-manager.interface';
import {
  ThresholdEvaluatorService,
  type ThresholdEvalInput,
} from './threshold-evaluator.service';
import { EVENT_NAMES } from '../../common/events/event-catalog';
import { ShadowComparisonEvent } from '../../common/events/execution.events';
import type { DivergenceDetail } from '../../common/events/execution.events';
import { PlatformDataFallbackEvent } from '../../common/events/platform.events';
import { RiskStateDivergenceEvent } from '../../common/events/system.events';
import { PlatformId, asPairId, asPositionId } from '../../common/types';
import type { ExitMode } from '../../common/types/exit-criteria.types';
import { ExitExecutionService } from './exit-execution.service';
import {
  ExitDataSourceService,
  type DataSource,
} from './exit-data-source.service';

const EXIT_POLL_INTERVAL_MS = 30_000;
const CIRCUIT_BREAKER_THRESHOLD = 3;

@Injectable()
export class ExitMonitorService implements OnModuleInit {
  private readonly logger = new Logger(ExitMonitorService.name);
  private consecutiveFullFailures = 0;
  private skipNextCycle = false;
  /** Cleanup: .set()/.delete() on status changes, bounded by open positions */
  /** Tracks positions with stale WS data for event deduplication. */
  private readonly stalePositions = new Map<string, boolean>();
  private exitMode: string;
  private exitEdgeEvapMultiplier: number;
  private exitConfidenceDropPct: number;
  private exitTimeDecayHorizonH: number;
  private exitTimeDecaySteepness: number;
  private exitTimeDecayTrigger: number;
  private exitRiskBudgetPct: number;
  private exitRiskRankCutoff: number;
  private exitMinDepth: number;
  private exitProfitCaptureRatio: number;

  constructor(
    private readonly positionRepository: PositionRepository,
    private readonly orderRepository: OrderRepository,
    private readonly exitExecutionService: ExitExecutionService,
    private readonly exitDataSourceService: ExitDataSourceService,
    private readonly eventEmitter: EventEmitter2,
    @Inject(RISK_MANAGER_TOKEN)
    private readonly riskManager: IRiskManager,
    private readonly thresholdEvaluator: ThresholdEvaluatorService,
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
  ) {
    this.exitMode = this.configService.get<string>('EXIT_MODE', 'fixed');
    this.exitEdgeEvapMultiplier = this.configService.get<number>(
      'EXIT_EDGE_EVAP_MULTIPLIER',
      -1.0,
    );
    this.exitConfidenceDropPct = this.configService.get<number>(
      'EXIT_CONFIDENCE_DROP_PCT',
      20,
    );
    this.exitTimeDecayHorizonH = this.configService.get<number>(
      'EXIT_TIME_DECAY_HORIZON_H',
      168,
    );
    this.exitTimeDecaySteepness = this.configService.get<number>(
      'EXIT_TIME_DECAY_STEEPNESS',
      2.0,
    );
    this.exitTimeDecayTrigger = this.configService.get<number>(
      'EXIT_TIME_DECAY_TRIGGER',
      0.8,
    );
    this.exitRiskBudgetPct = this.configService.get<number>(
      'EXIT_RISK_BUDGET_PCT',
      85,
    );
    this.exitRiskRankCutoff = this.configService.get<number>(
      'EXIT_RISK_RANK_CUTOFF',
      1,
    );
    this.exitMinDepth = this.configService.get<number>('EXIT_MIN_DEPTH', 5);
    this.exitProfitCaptureRatio = this.configService.get<number>(
      'EXIT_PROFIT_CAPTURE_RATIO',
      0.5,
    );
  }

  /** Story 10-5.2 AC6: reload all exit settings from DB-backed config */
  reloadConfig(settings: {
    wsStalenessThresholdMs?: number;
    exitMode?: string;
    exitEdgeEvapMultiplier?: number;
    exitConfidenceDropPct?: number;
    exitTimeDecayHorizonH?: number;
    exitTimeDecaySteepness?: number;
    exitTimeDecayTrigger?: number;
    exitRiskBudgetPct?: number;
    exitRiskRankCutoff?: number;
    exitMinDepth?: number;
    exitDepthSlippageTolerance?: number;
    exitMaxChunkSize?: number;
    exitProfitCaptureRatio?: number;
  }): void {
    if (settings.exitMode !== undefined) this.exitMode = settings.exitMode;
    if (settings.exitEdgeEvapMultiplier !== undefined)
      this.exitEdgeEvapMultiplier = settings.exitEdgeEvapMultiplier;
    if (settings.exitConfidenceDropPct !== undefined)
      this.exitConfidenceDropPct = settings.exitConfidenceDropPct;
    if (settings.exitTimeDecayHorizonH !== undefined)
      this.exitTimeDecayHorizonH = settings.exitTimeDecayHorizonH;
    if (settings.exitTimeDecaySteepness !== undefined)
      this.exitTimeDecaySteepness = settings.exitTimeDecaySteepness;
    if (settings.exitTimeDecayTrigger !== undefined)
      this.exitTimeDecayTrigger = settings.exitTimeDecayTrigger;
    if (settings.exitRiskBudgetPct !== undefined)
      this.exitRiskBudgetPct = settings.exitRiskBudgetPct;
    if (settings.exitRiskRankCutoff !== undefined)
      this.exitRiskRankCutoff = settings.exitRiskRankCutoff;
    if (settings.exitMinDepth !== undefined)
      this.exitMinDepth = settings.exitMinDepth;
    if (settings.exitProfitCaptureRatio !== undefined)
      this.exitProfitCaptureRatio = settings.exitProfitCaptureRatio;

    // Delegate to child services
    this.exitExecutionService.reloadConfig({
      exitMaxChunkSize: settings.exitMaxChunkSize,
    });
    this.exitDataSourceService.reloadConfig({
      wsStalenessThresholdMs: settings.wsStalenessThresholdMs,
      exitDepthSlippageTolerance: settings.exitDepthSlippageTolerance,
    });

    this.logger.log({
      message: 'Exit monitor config reloaded',
      data: { exitMode: this.exitMode },
    });
  }

  onModuleInit(): void {
    const exitMode = this.configService.get<string>('EXIT_MODE', 'fixed');
    if (exitMode === 'model' || exitMode === 'shadow') {
      const configDefaults: Array<[string, number]> = [
        ['EXIT_EDGE_EVAP_MULTIPLIER', -1.0],
        ['EXIT_CONFIDENCE_DROP_PCT', 20],
        ['EXIT_TIME_DECAY_HORIZON_H', 168],
        ['EXIT_PROFIT_CAPTURE_RATIO', 0.5],
        ['EXIT_MIN_DEPTH', 5],
      ];
      const atDefault = configDefaults
        .filter(
          ([key, def]) => this.configService.get<number>(key, def) === def,
        )
        .map(([key]) => key);
      if (atDefault.length > 0) {
        this.logger.warn({
          message: `EXIT_MODE=${exitMode} with ${atDefault.length} config keys at defaults — verify intentional`,
          data: { atDefault },
        });
      }
    }
  }

  @Interval(EXIT_POLL_INTERVAL_MS)
  async evaluatePositions(): Promise<void> {
    if (this.skipNextCycle) {
      this.skipNextCycle = false;
      this.consecutiveFullFailures = 0;
      this.logger.warn({
        message: 'Skipping exit evaluation cycle (circuit breaker recovery)',
      });
      return;
    }

    // Derive paper/mixed mode from connector health
    const kalshiHealth = this.exitDataSourceService.getConnectorHealth(
      PlatformId.KALSHI,
    );
    const polymarketHealth = this.exitDataSourceService.getConnectorHealth(
      PlatformId.POLYMARKET,
    );
    const isPaper =
      kalshiHealth.mode === 'paper' || polymarketHealth.mode === 'paper';
    const mixedMode =
      (kalshiHealth.mode === 'paper') !== (polymarketHealth.mode === 'paper');

    let positions;
    try {
      positions = await this.positionRepository.findByStatusWithOrders(
        { in: ['OPEN', 'EXIT_PARTIAL'] },
        isPaper,
      );
    } catch (error) {
      this.logger.error({
        message:
          'Failed to query OPEN/EXIT_PARTIAL positions for exit evaluation',
        data: { error: error instanceof Error ? error.message : String(error) },
      });
      return;
    }

    // Clean up stale tracking map
    const activePositionIds = new Set(positions.map((p) => p.positionId));
    for (const posId of this.stalePositions.keys()) {
      if (!activePositionIds.has(posId)) this.stalePositions.delete(posId);
    }

    if (positions.length === 0) return;

    // ─── Six-criteria pre-loop computation (Story 10.2) ────────────────
    const exitMode = this.exitMode as ExitMode;
    let portfolioRiskApproaching = false;
    const edgeRanking: Map<string, { rank: number; total: number }> = new Map();

    if (exitMode === 'model' || exitMode === 'shadow') {
      try {
        const exposure = this.riskManager.getCurrentExposure(isPaper);
        if (!exposure.bankrollUsd.isZero()) {
          portfolioRiskApproaching = exposure.totalCapitalDeployed
            .div(exposure.bankrollUsd)
            .gte(new Decimal(this.exitRiskBudgetPct).div(100));
        }
      } catch {
        this.logger.warn({
          message: 'Failed to check portfolio risk budget — skipping C4',
        });
      }

      // Dense edge ranking
      const positionsWithEdge = positions
        .filter((p) => p.recalculatedEdge != null)
        .map((p) => ({
          positionId: p.positionId,
          edge: new Decimal(p.recalculatedEdge!.toString()),
        }))
        .sort((a, b) => a.edge.minus(b.edge).toNumber());
      let currentRank = 1;
      for (let i = 0; i < positionsWithEdge.length; i++) {
        const current = positionsWithEdge[i]!;
        if (i > 0 && !current.edge.eq(positionsWithEdge[i - 1]!.edge))
          currentRank++;
        edgeRanking.set(current.positionId, {
          rank: currentRank,
          total: positionsWithEdge.length,
        });
      }
    }

    this.logger.log({
      message: `Evaluating ${positions.length} OPEN/EXIT_PARTIAL positions for exit`,
      data: { count: positions.length, isPaper, mixedMode, exitMode },
    });

    let anySucceeded = false;
    for (const position of positions) {
      try {
        await this.evaluatePosition(
          position,
          isPaper,
          mixedMode,
          kalshiHealth,
          polymarketHealth,
          exitMode,
          portfolioRiskApproaching,
          edgeRanking,
        );
        anySucceeded = true;
      } catch (error) {
        this.logger.error({
          message: 'Exit evaluation failed for position',
          data: {
            positionId: position.positionId,
            error: error instanceof Error ? error.message : String(error),
          },
        });
      }
    }

    if (anySucceeded) {
      this.consecutiveFullFailures = 0;
    } else {
      this.consecutiveFullFailures++;
      if (this.consecutiveFullFailures >= CIRCUIT_BREAKER_THRESHOLD) {
        this.skipNextCycle = true;
        this.logger.error({
          message: `Circuit breaker: ${CIRCUIT_BREAKER_THRESHOLD} consecutive full failures, skipping next cycle`,
          data: { consecutiveFullFailures: this.consecutiveFullFailures },
        });
      }
    }
  }

  private async evaluatePosition(
    position: Awaited<
      ReturnType<PositionRepository['findByStatusWithOrders']>
    >[0],
    isPaper: boolean,
    mixedMode: boolean,
    kalshiHealth: ReturnType<ExitDataSourceService['getConnectorHealth']>,
    polymarketHealth: ReturnType<ExitDataSourceService['getConnectorHealth']>,
    exitMode: ExitMode = 'fixed',
    portfolioRiskApproaching: boolean = false,
    edgeRanking: Map<string, { rank: number; total: number }> = new Map(),
  ): Promise<void> {
    if (
      kalshiHealth.status === 'disconnected' ||
      polymarketHealth.status === 'disconnected'
    ) {
      this.logger.warn({
        message: 'Skipping exit evaluation — connector disconnected',
        data: {
          positionId: position.positionId,
          kalshiStatus: kalshiHealth.status,
          polymarketStatus: polymarketHealth.status,
        },
      });
      return;
    }

    const kalshiOrder = position.kalshiOrder;
    const polymarketOrder = position.polymarketOrder;
    if (
      !kalshiOrder?.fillPrice ||
      !polymarketOrder?.fillPrice ||
      !kalshiOrder?.fillSize ||
      !polymarketOrder?.fillSize
    ) {
      this.logger.warn({
        message: 'Skipping exit evaluation — missing order fill data',
        data: { positionId: position.positionId },
      });
      return;
    }
    if (!position.kalshiSide || !position.polymarketSide) {
      this.logger.warn({
        message: 'Skipping exit evaluation — missing side data',
        data: { positionId: position.positionId },
      });
      return;
    }

    // Compute effective sizes: residual for EXIT_PARTIAL, entry fill for OPEN
    let kalshiEffectiveSize = new Decimal(kalshiOrder.fillSize.toString());
    let polymarketEffectiveSize = new Decimal(
      polymarketOrder.fillSize.toString(),
    );

    if (position.status === 'EXIT_PARTIAL') {
      const allPairOrders = await this.orderRepository.findByPairId(
        position.pairId,
      );
      const residual = getResidualSize(position, allPairOrders);
      kalshiEffectiveSize = residual.kalshi;
      polymarketEffectiveSize = residual.polymarket;

      if (residual.floored) {
        this.logger.error({
          message:
            'DATA INTEGRITY: Exit orders exceed entry fill size — residual floored to zero',
          data: {
            positionId: position.positionId,
            kalshiResidual: kalshiEffectiveSize.toString(),
            polymarketResidual: polymarketEffectiveSize.toString(),
          },
        });
      }

      // Zero residual on both legs → position should already be CLOSED
      if (kalshiEffectiveSize.isZero() && polymarketEffectiveSize.isZero()) {
        this.logger.warn({
          message:
            'EXIT_PARTIAL position has zero residual on both legs — transitioning to CLOSED',
          data: { positionId: position.positionId },
        });
        const existingPnl = new Decimal(
          position.realizedPnl?.toString() ?? '0',
        );
        await this.positionRepository.closePosition(
          position.positionId,
          existingPnl,
        );
        try {
          await this.riskManager.closePosition(
            new Decimal(0),
            new Decimal(0),
            asPairId(position.pairId),
            isPaper,
          );
        } catch (riskError) {
          this.logger.error({
            message:
              'CRITICAL: Position CLOSED in DB but risk state update failed — divergence detected',
            data: {
              positionId: position.positionId,
              error:
                riskError instanceof Error
                  ? riskError.message
                  : String(riskError),
            },
          });
          this.eventEmitter.emit(
            EVENT_NAMES.RISK_STATE_DIVERGENCE,
            new RiskStateDivergenceEvent(
              asPositionId(position.positionId),
              asPairId(position.pairId),
              'close',
              riskError instanceof Error
                ? riskError.message
                : String(riskError),
            ),
          );
        }
        return;
      }

      if (kalshiEffectiveSize.isZero() || polymarketEffectiveSize.isZero()) {
        this.logger.error({
          message:
            'DATA INTEGRITY: EXIT_PARTIAL has zero residual on one leg but not the other — skipping exit evaluation',
          data: {
            positionId: position.positionId,
            kalshiResidual: kalshiEffectiveSize.toString(),
            polymarketResidual: polymarketEffectiveSize.toString(),
          },
        });
        return;
      }

      this.logger.log({
        message: 'EXIT_PARTIAL position — using residual sizes',
        data: {
          positionId: position.positionId,
          kalshiResidual: kalshiEffectiveSize.toString(),
          polymarketResidual: polymarketEffectiveSize.toString(),
        },
      });
    }

    // Fetch current close prices via ExitDataSourceService
    const kalshiClosePrice = await this.exitDataSourceService.getClosePrice(
      PlatformId.KALSHI,
      position.pair.kalshiContractId,
      position.kalshiSide,
      kalshiEffectiveSize,
    );
    const polymarketClosePrice = await this.exitDataSourceService.getClosePrice(
      PlatformId.POLYMARKET,
      position.pair.polymarketClobTokenId!,
      position.polymarketSide,
      polymarketEffectiveSize,
    );
    if (kalshiClosePrice === null || polymarketClosePrice === null) {
      this.logger.warn({
        message: 'Skipping exit evaluation — empty order book side',
        data: {
          positionId: position.positionId,
          kalshiClosePrice: kalshiClosePrice?.toString() ?? 'null',
          polymarketClosePrice: polymarketClosePrice?.toString() ?? 'null',
        },
      });
      return;
    }

    // Data source classification via ExitDataSourceService
    const now = new Date();
    const kalshiFreshness = this.exitDataSourceService.getOrderBookFreshness(
      PlatformId.KALSHI,
      position.pair.kalshiContractId,
    );
    const polymarketFreshness =
      this.exitDataSourceService.getOrderBookFreshness(
        PlatformId.POLYMARKET,
        position.pair.polymarketClobTokenId!,
      );
    const kalshiDataSource = this.exitDataSourceService.classifyDataSource(
      kalshiFreshness.lastWsUpdateAt,
      now,
    );
    const polymarketDataSource = this.exitDataSourceService.classifyDataSource(
      polymarketFreshness.lastWsUpdateAt,
      now,
    );
    const dataSource = this.exitDataSourceService.combineDataSources(
      kalshiDataSource,
      polymarketDataSource,
    );

    // Data freshness
    const freshnessDates = [
      kalshiFreshness.lastWsUpdateAt,
      polymarketFreshness.lastWsUpdateAt,
    ].filter((d): d is Date => d !== null);
    const dataFreshnessMs =
      freshnessDates.length > 0
        ? now.getTime() - Math.max(...freshnessDates.map((d) => d.getTime()))
        : 0;

    // Stale fallback event deduplication
    this.emitStaleFallbackIfNeeded(
      position.positionId,
      position.pairId,
      dataSource,
      kalshiDataSource,
      polymarketDataSource,
      kalshiFreshness.lastWsUpdateAt,
      polymarketFreshness.lastWsUpdateAt,
      now,
    );

    // Build threshold input
    const evalInput = await this.buildCriteriaInputs(
      position,
      kalshiClosePrice,
      polymarketClosePrice,
      kalshiEffectiveSize,
      polymarketEffectiveSize,
      dataSource,
      dataFreshnessMs,
      exitMode,
      portfolioRiskApproaching,
      edgeRanking,
      now,
    );
    const evalResult = this.thresholdEvaluator.evaluate(evalInput);

    // Recalculate edge and persist
    await this.recalculateAndPersistEdge(
      position,
      kalshiClosePrice,
      polymarketClosePrice,
      kalshiEffectiveSize,
      polymarketEffectiveSize,
      dataSource,
      exitMode,
      evalResult,
      now,
    );

    // Shadow comparison
    this.performShadowComparison(position, evalResult, exitMode, now);

    if (evalResult.triggered) {
      this.logger.log({
        message: `Exit threshold triggered: ${evalResult.type}`,
        data: {
          positionId: position.positionId,
          pairId: position.pairId,
          exitType: evalResult.type,
          currentPnl: evalResult.currentPnl.toFixed(8),
          currentEdge: evalResult.currentEdge.toFixed(8),
          dataSource,
        },
      });
      await this.exitExecutionService.executeExit(
        position,
        evalResult,
        kalshiClosePrice,
        polymarketClosePrice,
        isPaper,
        mixedMode,
        kalshiEffectiveSize,
        polymarketEffectiveSize,
      );
    }
  }

  /** Emit stale fallback event with deduplication. */
  private emitStaleFallbackIfNeeded(
    positionId: string,
    pairId: string,
    dataSource: DataSource,
    kalshiDataSource: DataSource,
    polymarketDataSource: DataSource,
    kalshiLastWs: Date | null,
    polymarketLastWs: Date | null,
    now: Date,
  ): void {
    if (dataSource === 'stale_fallback') {
      const wasStale = this.stalePositions.get(positionId) ?? false;
      if (!wasStale) {
        const kalshiAge = kalshiLastWs
          ? now.getTime() - kalshiLastWs.getTime()
          : 0;
        const polyAge = polymarketLastWs
          ? now.getTime() - polymarketLastWs.getTime()
          : 0;
        const stalePlatform =
          kalshiDataSource === 'stale_fallback' &&
          polymarketDataSource === 'stale_fallback'
            ? kalshiAge >= polyAge
              ? PlatformId.KALSHI
              : PlatformId.POLYMARKET
            : kalshiDataSource === 'stale_fallback'
              ? PlatformId.KALSHI
              : PlatformId.POLYMARKET;
        this.eventEmitter.emit(
          EVENT_NAMES.DATA_FALLBACK,
          new PlatformDataFallbackEvent(
            asPositionId(positionId),
            asPairId(pairId),
            stalePlatform,
            Math.max(kalshiAge, polyAge),
            'polling',
          ),
        );
      }
      this.stalePositions.set(positionId, true);
    } else {
      this.stalePositions.set(positionId, false);
    }
  }

  /** Build ThresholdEvalInput from position and current market data. */
  private async buildCriteriaInputs(
    position: Awaited<
      ReturnType<PositionRepository['findByStatusWithOrders']>
    >[0],
    kalshiClosePrice: Decimal,
    polymarketClosePrice: Decimal,
    kalshiEffectiveSize: Decimal,
    polymarketEffectiveSize: Decimal,
    dataSource: DataSource,
    dataFreshnessMs: number,
    exitMode: ExitMode,
    portfolioRiskApproaching: boolean,
    edgeRanking: Map<string, { rank: number; total: number }>,
    now: Date,
  ): Promise<ThresholdEvalInput> {
    const kalshiOrder = position.kalshiOrder!;
    const polymarketOrder = position.polymarketOrder!;
    const kalshiFeeSchedule = this.exitDataSourceService.getFeeSchedule(
      PlatformId.KALSHI,
    );
    const polymarketFeeSchedule = this.exitDataSourceService.getFeeSchedule(
      PlatformId.POLYMARKET,
    );
    const kalshiFeeDecimal = FinancialMath.calculateTakerFeeRate(
      kalshiClosePrice,
      kalshiFeeSchedule,
    );
    const polymarketFeeDecimal = FinancialMath.calculateTakerFeeRate(
      polymarketClosePrice,
      polymarketFeeSchedule,
    );

    let entryConfidenceScore: number | null = null;
    let currentConfidenceScore: number | null = null;
    let kalshiExitDepth: Decimal | null = null;
    let polymarketExitDepth: Decimal | null = null;

    if (exitMode === 'model' || exitMode === 'shadow') {
      entryConfidenceScore = position.entryConfidenceScore ?? null;
      try {
        const match = await this.prisma.contractMatch.findUnique({
          where: { matchId: position.pairId },
          select: { confidenceScore: true },
        });
        currentConfidenceScore = match?.confidenceScore ?? null;
      } catch {
        this.logger.warn({
          message: 'Failed to lookup current confidence score',
          data: { positionId: position.positionId },
        });
      }

      const kalshiCloseSide = position.kalshiSide === 'buy' ? 'sell' : 'buy';
      const polymarketCloseSide =
        position.polymarketSide === 'buy' ? 'sell' : 'buy';
      try {
        [kalshiExitDepth, polymarketExitDepth] = await Promise.all([
          this.exitDataSourceService.getAvailableExitDepth(
            PlatformId.KALSHI,
            position.pair.kalshiContractId,
            kalshiCloseSide,
            kalshiClosePrice,
          ),
          this.exitDataSourceService.getAvailableExitDepth(
            PlatformId.POLYMARKET,
            position.pair.polymarketClobTokenId!,
            polymarketCloseSide,
            polymarketClosePrice,
          ),
        ]);
      } catch {
        this.logger.warn({
          message: 'Failed to fetch exit depth for criteria evaluation',
          data: { positionId: position.positionId },
        });
      }
    }

    const ranking = edgeRanking.get(position.positionId);
    return {
      initialEdge: new Decimal(position.expectedEdge.toString()),
      kalshiEntryPrice: new Decimal(kalshiOrder.fillPrice!.toString()),
      polymarketEntryPrice: new Decimal(polymarketOrder.fillPrice!.toString()),
      currentKalshiPrice: kalshiClosePrice,
      currentPolymarketPrice: polymarketClosePrice,
      kalshiSide: position.kalshiSide!,
      polymarketSide: position.polymarketSide!,
      kalshiSize: kalshiEffectiveSize,
      polymarketSize: polymarketEffectiveSize,
      kalshiFeeDecimal,
      polymarketFeeDecimal,
      resolutionDate: position.pair.resolutionDate,
      now,
      entryClosePriceKalshi: position.entryClosePriceKalshi
        ? new Decimal(position.entryClosePriceKalshi.toString())
        : null,
      entryClosePricePolymarket: position.entryClosePricePolymarket
        ? new Decimal(position.entryClosePricePolymarket.toString())
        : null,
      entryKalshiFeeRate: position.entryKalshiFeeRate
        ? new Decimal(position.entryKalshiFeeRate.toString())
        : null,
      entryPolymarketFeeRate: position.entryPolymarketFeeRate
        ? new Decimal(position.entryPolymarketFeeRate.toString())
        : null,
      dataSource,
      dataFreshnessMs,
      exitMode,
      entryConfidenceScore,
      currentConfidenceScore,
      kalshiExitDepth,
      polymarketExitDepth,
      portfolioRiskApproaching,
      edgeRankAmongOpen: ranking?.rank,
      totalOpenPositions: ranking?.total,
      edgeEvapMultiplier: this.exitEdgeEvapMultiplier,
      confidenceDropPct: this.exitConfidenceDropPct,
      timeDecayHorizonH: this.exitTimeDecayHorizonH,
      timeDecaySteepness: this.exitTimeDecaySteepness,
      timeDecayTrigger: this.exitTimeDecayTrigger,
      riskRankCutoff: this.exitRiskRankCutoff,
      minDepth: this.exitMinDepth,
      profitCaptureRatio: this.exitProfitCaptureRatio,
    };
  }

  /** Recalculate edge from current market data and persist to DB. */
  private async recalculateAndPersistEdge(
    position: Awaited<
      ReturnType<PositionRepository['findByStatusWithOrders']>
    >[0],
    kalshiClosePrice: Decimal,
    polymarketClosePrice: Decimal,
    kalshiEffectiveSize: Decimal,
    polymarketEffectiveSize: Decimal,
    dataSource: DataSource,
    exitMode: ExitMode,
    evalResult: {
      criteria?: Array<{
        criterion: string;
        proximity: Decimal;
        triggered: boolean;
        detail?: string;
      }>;
    },
    now: Date,
  ): Promise<void> {
    const kalshiFeeSchedule = this.exitDataSourceService.getFeeSchedule(
      PlatformId.KALSHI,
    );
    const polymarketFeeSchedule = this.exitDataSourceService.getFeeSchedule(
      PlatformId.POLYMARKET,
    );
    const kalshiFeeDecimal = FinancialMath.calculateTakerFeeRate(
      kalshiClosePrice,
      kalshiFeeSchedule,
    );
    const polymarketFeeDecimal = FinancialMath.calculateTakerFeeRate(
      polymarketClosePrice,
      polymarketFeeSchedule,
    );

    const grossEdge = FinancialMath.calculateGrossEdge(
      kalshiClosePrice,
      polymarketClosePrice,
    );
    const kalshiFee = kalshiClosePrice.mul(kalshiFeeDecimal);
    const polymarketFee = polymarketClosePrice.mul(polymarketFeeDecimal);
    const gasEstimateUsd = new Decimal(
      this.configService.get<string>('DETECTION_GAS_ESTIMATE_USD', '0'),
    );
    const positionValueUsd = kalshiClosePrice
      .mul(kalshiEffectiveSize)
      .plus(polymarketClosePrice.mul(polymarketEffectiveSize));
    const gasFraction = positionValueUsd.isZero()
      ? new Decimal(0)
      : gasEstimateUsd.div(positionValueUsd);
    const recalculatedEdge = grossEdge
      .minus(kalshiFee)
      .minus(polymarketFee)
      .minus(gasFraction);

    const updateData: Record<string, unknown> = {
      recalculatedEdge: recalculatedEdge.toFixed(8),
      lastRecalculatedAt: now,
      recalculationDataSource: dataSource,
    };

    if (
      (exitMode === 'model' || exitMode === 'shadow') &&
      evalResult.criteria
    ) {
      updateData.lastEvalCriteria = evalResult.criteria.map((c) => ({
        criterion: c.criterion,
        proximity: c.proximity.toString(),
        triggered: c.triggered,
        detail: c.detail,
      }));
    }

    try {
      await this.prisma.openPosition.update({
        where: { positionId: position.positionId },
        data: updateData,
      });
    } catch (error) {
      this.logger.error({
        message: 'Failed to persist recalculated edge',
        data: {
          positionId: position.positionId,
          error: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }

  /** Shadow comparison event emission (Story 10.2 Task 5, enhanced Story 10.7.7). */
  private performShadowComparison(
    position: Awaited<
      ReturnType<PositionRepository['findByStatusWithOrders']>
    >[0],
    evalResult: ReturnType<ThresholdEvaluatorService['evaluate']>,
    exitMode: ExitMode,
    now: Date,
  ): void {
    if (
      exitMode !== 'shadow' ||
      !evalResult.shadowModelResult ||
      !evalResult.criteria
    )
      return;

    const shadowDecision = evalResult.triggered
      ? `exit:${evalResult.type ?? 'unknown'}`
      : 'hold';
    const modelDecision = evalResult.shadowModelResult.triggered
      ? `exit:${evalResult.shadowModelResult.type ?? 'unknown'}`
      : 'hold';
    const agreement =
      evalResult.triggered === evalResult.shadowModelResult.triggered;
    const currentEdgeStr = evalResult.currentEdge.toFixed(8);

    let divergenceDetail: DivergenceDetail | null = null;
    if (!agreement) {
      const criteria = evalResult.criteria ?? [];
      divergenceDetail = {
        triggeredCriteria: criteria
          .filter((c) => c.triggered)
          .map((c) => c.criterion),
        proximityValues: Object.fromEntries(
          criteria.map((c) => [c.criterion, c.proximity.toFixed(8)]),
        ),
        fixedType: evalResult.triggered ? (evalResult.type ?? null) : null,
        modelType: evalResult.shadowModelResult.triggered
          ? (evalResult.shadowModelResult.type ?? null)
          : null,
      };
    }

    this.eventEmitter.emit(
      EVENT_NAMES.SHADOW_COMPARISON,
      new ShadowComparisonEvent(
        asPositionId(position.positionId),
        asPairId(position.pairId),
        {
          triggered: evalResult.triggered,
          type: evalResult.type,
          currentPnl: evalResult.currentPnl.toFixed(8),
        },
        {
          triggered: evalResult.shadowModelResult.triggered,
          type: evalResult.shadowModelResult.type,
          currentPnl: evalResult.shadowModelResult.currentPnl.toFixed(8),
          criteria: evalResult.criteria.map((c) => ({
            criterion: c.criterion,
            proximity: c.proximity.toFixed(8),
            triggered: c.triggered,
            detail: c.detail,
          })),
        },
        now,
        shadowDecision,
        modelDecision,
        agreement,
        currentEdgeStr,
        divergenceDetail,
      ),
    );
  }
}
