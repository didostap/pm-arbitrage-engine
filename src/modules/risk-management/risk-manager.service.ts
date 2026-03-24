import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import Decimal from 'decimal.js';
import { IRiskManager } from '../../common/interfaces/risk-manager.interface';
import {
  BudgetReservation,
  ReservationRequest,
  RiskDecision,
  RiskExposure,
  type TriageRecommendation,
  type TriageRecommendationDto,
} from '../../common/types/risk.type';
import {
  EVENT_NAMES,
  LimitApproachedEvent,
  OverrideAppliedEvent,
  OverrideDeniedEvent,
  AggregateClusterLimitBreachedEvent,
  ClusterLimitApproachedEvent,
  ClusterLimitBreachedEvent,
} from '../../common/events';
import { FinancialDecimal } from '../../common/utils/financial-math';
import { PrismaService } from '../../common/prisma.service';
import { CorrelationTrackerService } from './correlation-tracker.service';
import {
  asClusterId,
  type OpportunityId,
  type PairId,
  type ReservationId,
} from '../../common/types/branded.type';
import { RiskStateManager, HALT_REASONS } from './risk-state-manager.service';
import { TradingHaltService } from './trading-halt.service';
import { BudgetReservationService } from './budget-reservation.service';

// Re-export for backward compatibility
export { HALT_REASONS } from './risk-state-manager.service';
export type { HaltReason, ModeRiskState } from './risk-state-manager.service';

@Injectable()
export class RiskManagerService implements IRiskManager {
  private readonly logger = new Logger(RiskManagerService.name);

  /** 6 deps: facade composing 3 sub-services + EventEmitter2 + CorrelationTrackerService + PrismaService (for override logging, replaces service-locator anti-pattern) */
  constructor(
    private readonly budgetService: BudgetReservationService,
    private readonly haltService: TradingHaltService,
    private readonly riskStateManager: RiskStateManager,
    private readonly eventEmitter: EventEmitter2,
    private readonly correlationTracker: CorrelationTrackerService,
    private readonly prisma: PrismaService,
  ) {}

  // ── Delegations to RiskStateManager ──

  async updateDailyPnl(pnlDelta: unknown, isPaper?: boolean): Promise<void> {
    return this.riskStateManager.updateDailyPnl(pnlDelta, isPaper);
  }
  async recalculateFromPositions(
    openCount: number,
    capitalDeployed: Decimal,
    mode?: 'live' | 'paper',
  ): Promise<void> {
    return this.riskStateManager.recalculateFromPositions(
      openCount,
      capitalDeployed,
      mode,
    );
  }
  getOpenPositionCount(): number {
    return this.riskStateManager.getOpenPositionCount();
  }
  getBankrollConfig() {
    return this.riskStateManager.getBankrollConfig();
  }
  getBankrollUsd(): Decimal {
    return this.riskStateManager.getBankrollUsd();
  }
  async reloadBankroll(): Promise<void> {
    return this.riskStateManager.reloadBankroll();
  }
  async reloadConfig(): Promise<void> {
    return this.riskStateManager.reloadConfig();
  }

  // ── Delegations to TradingHaltService ──

  isTradingHalted(isPaper?: boolean): boolean {
    return this.haltService.isTradingHalted(isPaper);
  }
  getActiveHaltReasons(isPaper?: boolean): string[] {
    return this.haltService.getActiveHaltReasons(isPaper);
  }
  haltTrading(reason: string): void {
    this.haltService.haltTrading(reason);
  }
  resumeTrading(reason: string): void {
    this.haltService.resumeTrading(reason);
  }

  // ── Delegations to BudgetReservationService ──

  async reserveBudget(request: ReservationRequest): Promise<BudgetReservation> {
    return this.budgetService.reserveBudget(request);
  }
  async commitReservation(reservationId: ReservationId): Promise<void> {
    return this.budgetService.commitReservation(reservationId);
  }
  async releaseReservation(reservationId: ReservationId): Promise<void> {
    return this.budgetService.releaseReservation(reservationId);
  }
  async adjustReservation(
    reservationId: ReservationId,
    newCapitalUsd: Decimal,
  ): Promise<void> {
    return this.budgetService.adjustReservation(reservationId, newCapitalUsd);
  }
  async closePosition(
    capitalReturned: unknown,
    pnlDelta: unknown,
    pairId?: PairId,
    isPaper?: boolean,
  ): Promise<void> {
    return this.budgetService.closePosition(
      capitalReturned,
      pnlDelta,
      pairId,
      isPaper,
    );
  }
  async releasePartialCapital(
    capitalReleased: unknown,
    realizedPnl: unknown,
    pairId?: PairId,
    isPaper?: boolean,
  ): Promise<void> {
    return this.budgetService.releasePartialCapital(
      capitalReleased,
      realizedPnl,
      pairId,
      isPaper,
    );
  }

  // ── getCurrentExposure: Facade composition (NOT a thin delegation) ──

  getCurrentExposure(isPaper: boolean = false): RiskExposure {
    const data = this.riskStateManager.getExposureData(isPaper);
    const reserved = this.budgetService.getReservedCapital(isPaper);
    const reservedSlots = this.budgetService.getReservedPositionSlots(isPaper);
    return {
      openPairCount: data.openPositionCount + reservedSlots,
      totalCapitalDeployed: new FinancialDecimal(
        data.totalCapitalDeployed.add(reserved),
      ),
      bankrollUsd: data.bankrollUsd,
      availableCapital: new FinancialDecimal(
        data.bankrollUsd.minus(data.totalCapitalDeployed).minus(reserved),
      ),
      dailyPnl: data.dailyPnl,
      dailyLossLimitUsd: data.dailyLossLimitUsd,
      clusterExposures: data.clusterExposures,
      aggregateClusterExposurePct: data.aggregateClusterExposurePct,
    };
  }

  // ── validatePosition: Retained directly ──

  async validatePosition(
    opportunity: unknown,
    isPaper: boolean = false,
  ): Promise<RiskDecision> {
    const state = this.riskStateManager.getState(isPaper);
    const bankrollUsd = this.riskStateManager.getBankrollForMode(isPaper);
    const config = this.riskStateManager.getConfig();

    // FIRST: Check daily loss halt (Story 4.2)
    if (this.haltService.isTradingHalted(isPaper)) {
      return {
        approved: false,
        reason: 'Trading halted: daily loss limit breached',
        maxPositionSizeUsd: new FinancialDecimal(0),
        currentOpenPairs: state.openPositionCount,
        dailyPnl: state.dailyPnl,
      };
    }

    let maxPositionSizeUsd = new FinancialDecimal(bankrollUsd).mul(
      new FinancialDecimal(config.maxPositionPct),
    );

    // [Story 9.3] Confidence-adjusted position sizing
    const pairContext = this.extractPairContext(opportunity);
    let rawConfidence = pairContext?.confidenceScore ?? null;
    if (rawConfidence != null && (rawConfidence < 0 || rawConfidence > 100)) {
      this.logger.warn({
        message:
          'Invalid confidence score out of [0,100] range, treating as null',
        data: { rawConfidence },
      });
      rawConfidence = null;
    }
    const confidenceMultiplier =
      rawConfidence != null
        ? new FinancialDecimal(rawConfidence).div(100)
        : new FinancialDecimal(1);
    const confidenceAdjustedSizeUsd =
      rawConfidence != null && rawConfidence < 100
        ? maxPositionSizeUsd.mul(confidenceMultiplier)
        : undefined;
    maxPositionSizeUsd = maxPositionSizeUsd.mul(confidenceMultiplier);
    if (rawConfidence != null && rawConfidence < 100) {
      this.logger.log({
        message: 'Confidence-adjusted position sizing applied',
        data: {
          confidenceScore: rawConfidence,
          multiplier: confidenceMultiplier.toFixed(4),
          adjustedSizeUsd: maxPositionSizeUsd.toFixed(2),
        },
      });
    }
    const confFields = {
      ...(rawConfidence != null && { confidenceScore: rawConfidence }),
      ...(confidenceAdjustedSizeUsd !== undefined && {
        confidenceAdjustedSizeUsd,
      }),
    };

    // Check max open pairs limit (including reserved slots)
    const effectiveOpenPairs =
      state.openPositionCount +
      this.budgetService.getReservedPositionSlots(isPaper);
    if (effectiveOpenPairs >= config.maxOpenPairs) {
      this.logger.warn({
        message: 'Opportunity rejected: max open pairs exceeded',
        data: {
          currentOpenPairs: state.openPositionCount,
          reservedSlots: this.budgetService.getReservedPositionSlots(isPaper),
          maxOpenPairs: config.maxOpenPairs,
        },
      });
      return {
        approved: false,
        reason: `Max open pairs limit reached (${effectiveOpenPairs}/${config.maxOpenPairs})`,
        maxPositionSizeUsd,
        currentOpenPairs: state.openPositionCount,
        ...confFields,
      };
    }

    // Check available capital (including reserved capital)
    const reservedCapital = this.budgetService.getReservedCapital(isPaper);
    const availableCapital = new FinancialDecimal(
      bankrollUsd.minus(state.totalCapitalDeployed).minus(reservedCapital),
    );
    if (availableCapital.lt(maxPositionSizeUsd)) {
      this.logger.warn({
        message: 'Opportunity rejected: insufficient available capital',
        data: {
          availableCapital: availableCapital.toString(),
          requiredCapital: maxPositionSizeUsd.toString(),
          reservedCapital: reservedCapital.toString(),
        },
      });
      return {
        approved: false,
        reason: `Insufficient available capital (${availableCapital.toFixed(2)} < ${maxPositionSizeUsd.toFixed(2)})`,
        maxPositionSizeUsd,
        currentOpenPairs: state.openPositionCount,
        ...confFields,
      };
    }

    // === [Story 9.2] Cluster limit enforcement ===
    let adjustedMaxPositionSizeUsd: Decimal | undefined;
    let clusterExposurePctResult: Decimal | undefined;

    if (pairContext) {
      const clusterResult = await this.validateClusterLimits(
        pairContext,
        bankrollUsd,
        maxPositionSizeUsd,
        state.openPositionCount,
        confFields,
      );
      if (clusterResult.rejected) return clusterResult.decision;
      maxPositionSizeUsd = clusterResult.maxPositionSizeUsd;
      adjustedMaxPositionSizeUsd = clusterResult.adjustedMaxPositionSizeUsd;
      clusterExposurePctResult = clusterResult.clusterExposurePct;
    }

    // Check if approaching limit (80% threshold)
    const approachThreshold = Math.floor(config.maxOpenPairs * 0.8);
    if (effectiveOpenPairs >= approachThreshold) {
      const percentUsed = (effectiveOpenPairs / config.maxOpenPairs) * 100;
      this.eventEmitter.emit(
        EVENT_NAMES.LIMIT_APPROACHED,
        new LimitApproachedEvent(
          'max_open_pairs',
          state.openPositionCount,
          config.maxOpenPairs,
          percentUsed,
        ),
      );
    }

    return {
      approved: true,
      reason: 'Position within risk limits',
      maxPositionSizeUsd,
      currentOpenPairs: state.openPositionCount,
      ...(adjustedMaxPositionSizeUsd !== undefined && {
        adjustedMaxPositionSizeUsd,
      }),
      ...(clusterExposurePctResult !== undefined && {
        clusterExposurePct: clusterExposurePctResult,
      }),
      ...confFields,
    };
  }

  // ── Private cluster validation (extracted for line-count reduction) ──

  private async validateClusterLimits(
    pairContext: { clusterId?: string },
    bankrollUsd: Decimal,
    inputMaxPositionSizeUsd: Decimal,
    openPositionCount: number,
    confFields: Record<string, unknown>,
  ): Promise<
    | { rejected: true; decision: RiskDecision }
    | {
        rejected: false;
        maxPositionSizeUsd: Decimal;
        adjustedMaxPositionSizeUsd?: Decimal;
        clusterExposurePct?: Decimal;
      }
  > {
    let maxPositionSizeUsd = inputMaxPositionSizeUsd;
    const { hardLimitPct, softLimitPct, aggregateLimitPct } =
      this.riskStateManager.getClusterLimits();

    // Step A: Aggregate limit check
    const aggregateExposurePct =
      this.correlationTracker.getAggregateExposurePct();
    if (aggregateExposurePct.gte(aggregateLimitPct)) {
      this.logger.warn({
        message: 'Opportunity rejected: aggregate cluster limit exceeded',
        data: {
          aggregateExposurePct: aggregateExposurePct.toString(),
          aggregateLimitPct: aggregateLimitPct.toString(),
        },
      });
      this.eventEmitter.emit(
        EVENT_NAMES.AGGREGATE_CLUSTER_LIMIT_BREACHED,
        new AggregateClusterLimitBreachedEvent(
          aggregateExposurePct.toNumber(),
          aggregateLimitPct.toNumber(),
        ),
      );
      return {
        rejected: true,
        decision: {
          approved: false,
          reason: `Rejected: aggregate cluster exposure ${aggregateExposurePct.mul(100).toFixed(1)}% >= ${aggregateLimitPct.mul(100).toFixed(0)}% limit`,
          maxPositionSizeUsd,
          currentOpenPairs: openPositionCount,
          ...confFields,
        },
      };
    }

    // Find cluster exposure for this opportunity's cluster
    const clusterId = pairContext.clusterId;
    const clusterExposures = this.correlationTracker.getClusterExposures();
    let clusterExposurePct: Decimal;
    if (clusterId) {
      const entry = clusterExposures.find(
        (e) => (e.clusterId as string) === clusterId,
      );
      clusterExposurePct = entry ? entry.exposurePct : new Decimal(0);
    } else {
      const unc = clusterExposures.find(
        (e) => e.clusterName === 'Uncategorized',
      );
      clusterExposurePct = unc ? unc.exposurePct : new Decimal(0);
    }

    const uncategorizedClusterId = clusterExposures.find(
      (e) => e.clusterName === 'Uncategorized',
    )?.clusterId as string | undefined;
    const effectiveClusterId: string | null = clusterId
      ? clusterId
      : (uncategorizedClusterId ?? null);
    const resolveClusterName = (): string =>
      clusterExposures.find(
        (e) => (e.clusterId as string) === effectiveClusterId,
      )?.clusterName ?? 'Unknown';

    // Step B: Hard limit rejection
    if (clusterExposurePct.gte(hardLimitPct)) {
      const { triage, triageDtos } =
        await this.fetchTriageWithDtos(effectiveClusterId);
      this.logger.warn({
        message: 'Opportunity rejected: cluster already at or above hard limit',
        data: {
          clusterId: effectiveClusterId,
          clusterExposurePct: clusterExposurePct.toString(),
          hardLimitPct: hardLimitPct.toString(),
        },
      });
      if (effectiveClusterId) {
        this.eventEmitter.emit(
          EVENT_NAMES.CLUSTER_LIMIT_BREACHED,
          new ClusterLimitBreachedEvent(
            resolveClusterName(),
            asClusterId(effectiveClusterId),
            clusterExposurePct.toNumber(),
            hardLimitPct.toNumber(),
            triageDtos,
          ),
        );
      }
      return {
        rejected: true,
        decision: {
          approved: false,
          reason: `Rejected: cluster hard limit — exposure ${clusterExposurePct.mul(100).toFixed(1)}% >= ${hardLimitPct.mul(100).toFixed(0)}% limit`,
          maxPositionSizeUsd,
          currentOpenPairs: openPositionCount,
          clusterExposurePct,
          triageRecommendations: triage,
          ...confFields,
        },
      };
    }

    // Soft-limit size tapering
    let adjustedMaxPositionSizeUsd: Decimal | undefined;
    let clusterExposurePctResult: Decimal | undefined;
    if (
      clusterExposurePct.gte(softLimitPct) &&
      clusterExposurePct.lt(hardLimitPct)
    ) {
      const adjustmentFactor = new Decimal(1).minus(
        clusterExposurePct.div(hardLimitPct),
      );
      maxPositionSizeUsd = maxPositionSizeUsd.mul(adjustmentFactor);
      adjustedMaxPositionSizeUsd = maxPositionSizeUsd;
      clusterExposurePctResult = clusterExposurePct;
      if (effectiveClusterId) {
        this.eventEmitter.emit(
          EVENT_NAMES.CLUSTER_LIMIT_APPROACHED,
          new ClusterLimitApproachedEvent(
            resolveClusterName(),
            asClusterId(effectiveClusterId),
            clusterExposurePct.toNumber(),
            softLimitPct.toNumber(),
          ),
        );
      }
    }

    // Step C: Hard limit projection check
    const projectedExposurePct = clusterExposurePct.plus(
      maxPositionSizeUsd.div(bankrollUsd),
    );
    if (projectedExposurePct.gte(hardLimitPct)) {
      const { triage, triageDtos } =
        await this.fetchTriageWithDtos(effectiveClusterId);
      this.logger.warn({
        message:
          'Opportunity rejected: projected cluster exposure breaches hard limit',
        data: {
          clusterId: effectiveClusterId,
          currentPct: clusterExposurePct.toString(),
          projectedPct: projectedExposurePct.toString(),
          hardLimitPct: hardLimitPct.toString(),
        },
      });
      if (effectiveClusterId) {
        this.eventEmitter.emit(
          EVENT_NAMES.CLUSTER_LIMIT_BREACHED,
          new ClusterLimitBreachedEvent(
            resolveClusterName(),
            asClusterId(effectiveClusterId),
            clusterExposurePct.toNumber(),
            hardLimitPct.toNumber(),
            triageDtos,
          ),
        );
      }
      return {
        rejected: true,
        decision: {
          approved: false,
          reason: `Rejected: cluster hard limit — projected ${projectedExposurePct.mul(100).toFixed(1)}% >= ${hardLimitPct.mul(100).toFixed(0)}% limit`,
          maxPositionSizeUsd,
          currentOpenPairs: openPositionCount,
          clusterExposurePct,
          triageRecommendations: triage,
          ...confFields,
        },
      };
    }

    return {
      rejected: false,
      maxPositionSizeUsd,
      adjustedMaxPositionSizeUsd,
      clusterExposurePct: clusterExposurePctResult,
    };
  }

  // ── processOverride: Retained directly ──

  async processOverride(
    opportunityId: OpportunityId,
    rationale: string,
  ): Promise<RiskDecision> {
    const liveState = this.riskStateManager.getState(false);

    // FIRST: Check if daily loss halt is active — cannot be overridden
    if (
      this.haltService.isTradingHalted() &&
      liveState.activeHaltReasons.has(HALT_REASONS.DAILY_LOSS_LIMIT)
    ) {
      const denialReason = 'Override denied: daily loss halt active';
      this.eventEmitter.emit(
        EVENT_NAMES.OVERRIDE_DENIED,
        new OverrideDeniedEvent(opportunityId, rationale, denialReason),
      );
      try {
        await this.prisma.riskOverrideLog.create({
          data: {
            opportunityId,
            rationale,
            approved: false,
            originalRejectionReason:
              'Trading halted: daily loss limit breached',
            denialReason,
          },
        });
      } catch (error) {
        this.logger.error({
          message: 'Failed to persist override denial log',
          data: {
            opportunityId,
            error: error instanceof Error ? error.message : String(error),
          },
        });
      }
      this.logger.log({
        message: 'Override denied: daily loss halt active',
        data: { opportunityId, rationale },
      });
      return {
        approved: false,
        reason: denialReason,
        maxPositionSizeUsd: new FinancialDecimal(0),
        currentOpenPairs: liveState.openPositionCount,
        dailyPnl: liveState.dailyPnl,
      };
    }

    const originalRejectionReason =
      this.determineRejectionReason() ?? 'Position sizing limit';
    const config = this.riskStateManager.getConfig();
    const maxPositionSizeUsd = new FinancialDecimal(config.bankrollUsd).mul(
      new FinancialDecimal(config.maxPositionPct),
    );

    this.eventEmitter.emit(
      EVENT_NAMES.OVERRIDE_APPLIED,
      new OverrideAppliedEvent(
        opportunityId,
        rationale,
        originalRejectionReason,
        maxPositionSizeUsd.toNumber(),
      ),
    );
    try {
      await this.prisma.riskOverrideLog.create({
        data: {
          opportunityId,
          rationale,
          approved: true,
          originalRejectionReason,
          overrideAmountUsd: maxPositionSizeUsd.toFixed(),
        },
      });
    } catch (error) {
      this.logger.error({
        message: 'Failed to persist override approval log',
        data: {
          opportunityId,
          error: error instanceof Error ? error.message : String(error),
        },
      });
    }
    this.logger.log({
      message: 'Override approved',
      data: {
        opportunityId,
        rationale,
        originalRejectionReason,
        overrideAmountUsd: maxPositionSizeUsd.toString(),
      },
    });

    return {
      approved: true,
      reason: 'Override approved by operator',
      maxPositionSizeUsd,
      currentOpenPairs: liveState.openPositionCount,
      dailyPnl: liveState.dailyPnl,
      overrideApplied: true,
      overrideRationale: rationale,
    };
  }

  // ── Private helpers ──

  private determineRejectionReason(): string | null {
    const liveState = this.riskStateManager.getState(false);
    const config = this.riskStateManager.getConfig();
    const effectiveOpenPairs =
      liveState.openPositionCount +
      this.budgetService.getReservedPositionSlots();
    if (effectiveOpenPairs >= config.maxOpenPairs) {
      return `Max open pairs limit reached (${effectiveOpenPairs}/${config.maxOpenPairs})`;
    }
    return 'Position sizing limit';
  }

  private extractPairContext(
    opportunity: unknown,
  ): { matchId?: string; clusterId?: string; confidenceScore?: number } | null {
    if (!opportunity || typeof opportunity !== 'object') {
      this.logger.warn({
        message:
          'Skipping pair context extraction: opportunity is not an object',
      });
      return null;
    }
    const opp = opportunity as Record<string, unknown>;
    const dislocation = opp.dislocation as Record<string, unknown> | undefined;
    const pairConfig = dislocation?.pairConfig as
      | Record<string, unknown>
      | undefined;
    if (!pairConfig) {
      this.logger.warn({
        message: 'Skipping pair context extraction: no pairConfig found',
      });
      return null;
    }
    return {
      matchId:
        typeof pairConfig.matchId === 'string' ? pairConfig.matchId : undefined,
      clusterId:
        typeof pairConfig.clusterId === 'string'
          ? pairConfig.clusterId
          : undefined,
      confidenceScore:
        typeof pairConfig.confidenceScore === 'number'
          ? pairConfig.confidenceScore
          : undefined,
    };
  }

  private async fetchTriageWithDtos(
    effectiveClusterId: string | null,
  ): Promise<{
    triage: TriageRecommendation[];
    triageDtos: TriageRecommendationDto[];
  }> {
    if (!effectiveClusterId) return { triage: [], triageDtos: [] };
    const triage =
      await this.correlationTracker.getTriageRecommendations(
        effectiveClusterId,
      );
    const triageDtos: TriageRecommendationDto[] = triage.map((t) => ({
      positionId: t.positionId as string,
      pairId: t.pairId as string,
      expectedEdge: t.expectedEdge.toString(),
      capitalDeployed: t.capitalDeployed.toString(),
      suggestedAction: t.suggestedAction,
      reason: t.reason,
    }));
    return { triage, triageDtos };
  }
}
