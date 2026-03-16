import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Cron } from '@nestjs/schedule';
import Decimal from 'decimal.js';
import { IRiskManager } from '../../common/interfaces/risk-manager.interface';
import {
  BudgetReservation,
  ReservationRequest,
  RiskConfig,
  RiskDecision,
  RiskExposure,
  type TriageRecommendation,
  type TriageRecommendationDto,
} from '../../common/types/risk.type';
import { ConfigValidationError } from '../../common/errors/config-validation-error';
import {
  EVENT_NAMES,
  LimitApproachedEvent,
  LimitBreachedEvent,
  OverrideAppliedEvent,
  OverrideDeniedEvent,
  BudgetReservedEvent,
  BudgetCommittedEvent,
  BudgetReleasedEvent,
  TradingHaltedEvent,
  TradingResumedEvent,
  DataCorruptionDetectedEvent,
  ClusterLimitApproachedEvent,
  ClusterLimitBreachedEvent,
  AggregateClusterLimitBreachedEvent,
} from '../../common/events';
import { FinancialDecimal } from '../../common/utils/financial-math';
import { PrismaService } from '../../common/prisma.service';
import { haltReasonSchema } from '../../common/schemas/prisma-json.schema';
import {
  RiskLimitError,
  RISK_ERROR_CODES,
} from '../../common/errors/risk-limit-error';
import { randomUUID } from 'crypto';
import { CorrelationTrackerService } from './correlation-tracker.service';
import { EngineConfigRepository } from '../../persistence/repositories/engine-config.repository';
import {
  asClusterId,
  asReservationId,
  asOpportunityId,
  type OpportunityId,
  type ReservationId,
  type PairId,
} from '../../common/types/branded.type';

export const HALT_REASONS = {
  DAILY_LOSS_LIMIT: 'daily_loss_limit',
  RECONCILIATION_DISCREPANCY: 'reconciliation_discrepancy',
} as const;
export type HaltReason = (typeof HALT_REASONS)[keyof typeof HALT_REASONS];

interface ModeRiskState {
  openPositionCount: number;
  totalCapitalDeployed: Decimal;
  dailyPnl: Decimal;
  activeHaltReasons: Set<HaltReason>;
  dailyLossApproachEmitted: boolean;
  lastResetTimestamp: Date | null;
}

function createDefaultModeRiskState(): ModeRiskState {
  return {
    openPositionCount: 0,
    totalCapitalDeployed: new FinancialDecimal(0),
    dailyPnl: new FinancialDecimal(0),
    activeHaltReasons: new Set<HaltReason>(),
    dailyLossApproachEmitted: false,
    lastResetTimestamp: null,
  };
}

@Injectable()
export class RiskManagerService implements IRiskManager, OnModuleInit {
  private readonly logger = new Logger(RiskManagerService.name);
  private config!: RiskConfig;
  private liveState: ModeRiskState = createDefaultModeRiskState();
  private paperState: ModeRiskState = createDefaultModeRiskState();
  private reservations = new Map<string, BudgetReservation>();
  private paperActivePairIds = new Set<string>();
  private bankrollUpdatedAt: Date = new Date();

  constructor(
    private readonly configService: ConfigService,
    private readonly eventEmitter: EventEmitter2,
    private readonly prisma: PrismaService,
    private readonly correlationTracker: CorrelationTrackerService,
    private readonly engineConfigRepository: EngineConfigRepository,
  ) {}

  private getState(isPaper: boolean): ModeRiskState {
    return isPaper ? this.paperState : this.liveState;
  }

  private getBankrollForMode(isPaper: boolean): Decimal {
    if (isPaper) {
      return new FinancialDecimal(
        this.config.paperBankrollUsd ?? this.config.bankrollUsd,
      );
    }
    return new FinancialDecimal(this.config.bankrollUsd);
  }

  async onModuleInit(): Promise<void> {
    await this.loadBankrollFromDb();
    this.validateConfig();
    await this.initializeStateFromDb();
    await this.clearStaleReservations();
  }

  private async clearStaleReservations(): Promise<void> {
    this.reservations.clear();
    try {
      await this.prisma.riskState.updateMany({
        where: { singletonKey: 'default' },
        data: {
          reservedCapital: '0',
          reservedPositionSlots: 0,
        },
      });
      this.logger.log({
        message: 'Stale reservations cleared on startup',
      });
    } catch (error) {
      this.logger.error({
        message: 'Failed to clear stale reservations on startup',
        data: {
          error: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }

  private async loadBankrollFromDb(): Promise<void> {
    const engineConfig = await this.engineConfigRepository.get();
    if (engineConfig) {
      const bankroll = Number(engineConfig.bankrollUsd.toString());
      const paperBankroll = engineConfig.paperBankrollUsd
        ? Number(engineConfig.paperBankrollUsd.toString())
        : undefined;
      // Set partial config — validateConfig() will fill the rest
      this.config = {
        bankrollUsd: bankroll,
        paperBankrollUsd: paperBankroll,
      } as RiskConfig;
      this.bankrollUpdatedAt = engineConfig.updatedAt;
      this.correlationTracker.updateBankroll(new FinancialDecimal(bankroll));
      this.logger.log({
        message: 'Bankroll loaded from database',
        data: {
          bankrollUsd: bankroll,
          paperBankrollUsd: paperBankroll ?? null,
        },
      });
    } else {
      const seedValue =
        this.configService.get<string>('RISK_BANKROLL_USD') ?? '10000';
      const row = await this.engineConfigRepository.upsertBankroll(seedValue);
      const bankroll = Number(row.bankrollUsd.toString());
      const paperBankroll = row.paperBankrollUsd
        ? Number(row.paperBankrollUsd.toString())
        : undefined;
      this.config = {
        bankrollUsd: bankroll,
        paperBankrollUsd: paperBankroll,
      } as RiskConfig;
      this.bankrollUpdatedAt = row.updatedAt;
      this.correlationTracker.updateBankroll(new FinancialDecimal(bankroll));
      this.logger.log({
        message: 'Bankroll seeded to database from env var',
        data: { bankrollUsd: bankroll, source: 'RISK_BANKROLL_USD' },
      });
    }
  }

  async reloadBankroll(): Promise<void> {
    const engineConfig = await this.engineConfigRepository.get();
    if (!engineConfig) {
      this.logger.warn({
        message: 'reloadBankroll called but no EngineConfig row exists',
      });
      return;
    }
    const bankroll = Number(engineConfig.bankrollUsd.toString());
    const paperBankroll = engineConfig.paperBankrollUsd
      ? Number(engineConfig.paperBankrollUsd.toString())
      : undefined;
    this.config = {
      ...this.config,
      bankrollUsd: bankroll,
      paperBankrollUsd: paperBankroll,
    };
    this.bankrollUpdatedAt = engineConfig.updatedAt;
    this.correlationTracker.updateBankroll(new FinancialDecimal(bankroll));
    this.logger.log({
      message: 'Bankroll reloaded from database',
      data: {
        bankrollUsd: bankroll,
        maxPositionSizeUsd: new FinancialDecimal(bankroll)
          .mul(new FinancialDecimal(this.config.maxPositionPct))
          .toString(),
        dailyLossLimitUsd: new FinancialDecimal(bankroll)
          .mul(new FinancialDecimal(this.config.dailyLossPct))
          .toString(),
      },
    });
  }

  getBankrollConfig(): Promise<{
    bankrollUsd: string;
    paperBankrollUsd: string | null;
    updatedAt: string;
  }> {
    return Promise.resolve({
      bankrollUsd: String(this.config.bankrollUsd),
      paperBankrollUsd:
        this.config.paperBankrollUsd != null
          ? String(this.config.paperBankrollUsd)
          : null,
      updatedAt: this.bankrollUpdatedAt.toISOString(),
    });
  }

  getBankrollUsd(): Decimal {
    return new FinancialDecimal(this.config.bankrollUsd);
  }

  private validateConfig(): void {
    // bankrollUsd is already set by loadBankrollFromDb() — validate it
    const bankroll = this.config?.bankrollUsd;
    const maxPctRaw = this.configService.get<string | number>(
      'RISK_MAX_POSITION_PCT',
      0.03,
    );
    const maxPct = Number(maxPctRaw);
    const maxPairsRaw = this.configService.get<string | number>(
      'RISK_MAX_OPEN_PAIRS',
      10,
    );
    const maxPairs = Number(maxPairsRaw);
    const dailyLossPctRaw = this.configService.get<string | number>(
      'RISK_DAILY_LOSS_PCT',
      0.05,
    );
    const dailyLossPct = Number(dailyLossPctRaw);

    if (!bankroll || bankroll <= 0) {
      throw new ConfigValidationError(
        'RISK_BANKROLL_USD must be a positive number',
        ['RISK_BANKROLL_USD is invalid or missing'],
      );
    }
    if (maxPct <= 0 || maxPct > 1) {
      throw new ConfigValidationError(
        'RISK_MAX_POSITION_PCT must be between 0 and 1',
        ['RISK_MAX_POSITION_PCT is out of range'],
      );
    }
    if (maxPairs <= 0 || !Number.isInteger(maxPairs)) {
      throw new ConfigValidationError(
        'RISK_MAX_OPEN_PAIRS must be a positive integer',
        ['RISK_MAX_OPEN_PAIRS is invalid'],
      );
    }
    if (dailyLossPct <= 0 || dailyLossPct > 1) {
      throw new ConfigValidationError(
        'RISK_DAILY_LOSS_PCT must be between 0 (exclusive) and 1 (inclusive)',
        ['RISK_DAILY_LOSS_PCT is out of range'],
      );
    }

    this.config = {
      bankrollUsd: bankroll,
      paperBankrollUsd: this.config?.paperBankrollUsd,
      maxPositionPct: maxPct,
      maxOpenPairs: maxPairs,
      dailyLossPct,
    };
    this.logger.log({
      message: 'Risk manager configuration validated',
      data: {
        bankrollMagnitude: `$${Math.pow(10, Math.floor(Math.log10(bankroll)))}+`,
        maxPositionPct: maxPct,
        maxOpenPairs: maxPairs,
        dailyLossPct,
      },
    });
  }

  private async initializeStateFromDb(): Promise<void> {
    const liveRow = await this.prisma.riskState.findFirst({
      where: { singletonKey: 'default', mode: 'live' },
    });
    const paperRow = await this.prisma.riskState.findFirst({
      where: { singletonKey: 'default', mode: 'paper' },
    });

    // Initialize each mode independently
    for (const { row, mode } of [
      { row: liveRow, mode: 'live' as const },
      { row: paperRow, mode: 'paper' as const },
    ]) {
      const isPaper = mode === 'paper';
      const state = this.getState(isPaper);

      if (row) {
        state.openPositionCount = row.openPositionCount;
        state.totalCapitalDeployed = new FinancialDecimal(
          row.totalCapitalDeployed.toString(),
        );
        state.dailyPnl = new FinancialDecimal(row.dailyPnl.toString());

        // Restore halt reasons from DB
        state.activeHaltReasons = new Set<HaltReason>();
        if (row.haltReason) {
          try {
            const parsed: unknown = JSON.parse(row.haltReason);
            const validated = haltReasonSchema.safeParse(parsed);
            if (validated.success) {
              for (const r of validated.data) {
                state.activeHaltReasons.add(r as HaltReason);
              }
            } else if (typeof parsed === 'string' && parsed.length > 0) {
              // Legacy single-string JSON format
              state.activeHaltReasons.add(parsed as HaltReason);
            } else {
              this.eventEmitter.emit(
                EVENT_NAMES.DATA_CORRUPTION_DETECTED,
                new DataCorruptionDetectedEvent(
                  'RiskState',
                  'haltReason',
                  `default:${mode}`,
                  parsed,
                  validated.error?.issues ?? [],
                ),
              );
            }
          } catch {
            // Legacy single-string format (not JSON)
            if (
              typeof row.haltReason === 'string' &&
              row.haltReason.length > 0
            ) {
              state.activeHaltReasons.add(row.haltReason as HaltReason);
            }
          }
        }

        // Stale-day detection (per-mode)
        const bankroll = this.getBankrollForMode(isPaper);
        if (row.lastResetTimestamp) {
          const todayMidnight = new Date();
          todayMidnight.setUTCHours(0, 0, 0, 0);

          if (row.lastResetTimestamp < todayMidnight) {
            this.logger.log({
              message: `Stale-day detected on startup for ${mode} mode, daily P&L reset`,
              data: { previousDailyPnl: state.dailyPnl.toString(), mode },
            });
            state.dailyPnl = new FinancialDecimal(0);
            state.activeHaltReasons.delete(HALT_REASONS.DAILY_LOSS_LIMIT);
            state.lastResetTimestamp = todayMidnight;
            state.dailyLossApproachEmitted = false;
            await this.persistState(mode);
          } else {
            state.lastResetTimestamp = row.lastResetTimestamp;
            // Re-evaluate halt if same day and loss exceeds limit
            const dailyLossLimitUsd = bankroll.mul(
              new FinancialDecimal(this.config.dailyLossPct),
            );
            const absLoss = state.dailyPnl.isNegative()
              ? state.dailyPnl.abs()
              : new FinancialDecimal(0);
            if (absLoss.gte(dailyLossLimitUsd)) {
              state.activeHaltReasons.add(HALT_REASONS.DAILY_LOSS_LIMIT);
            }
          }
        } else {
          // No lastResetTimestamp — first run or corrupted state
          const todayMidnight = new Date();
          todayMidnight.setUTCHours(0, 0, 0, 0);
          state.lastResetTimestamp = todayMidnight;

          if (!state.dailyPnl.isZero()) {
            this.logger.warn({
              message:
                'Corrupted state: non-zero dailyPnl with null lastResetTimestamp, resetting',
              data: { dailyPnl: state.dailyPnl.toString(), mode },
            });
            state.dailyPnl = new FinancialDecimal(0);
            state.activeHaltReasons.delete(HALT_REASONS.DAILY_LOSS_LIMIT);
            await this.persistState(mode);
          }
        }

        this.logger.log({
          message: `Risk state restored from database (${mode})`,
          data: {
            mode,
            openPositionCount: state.openPositionCount,
            totalCapitalDeployed: state.totalCapitalDeployed.toString(),
            dailyPnl: state.dailyPnl.toString(),
            tradingHalted: state.activeHaltReasons.size > 0,
          },
        });
      } else {
        const todayMidnight = new Date();
        todayMidnight.setUTCHours(0, 0, 0, 0);
        state.lastResetTimestamp = todayMidnight;
        await this.persistState(mode);
        this.logger.log({
          message: `Risk state initialized for ${mode} mode (new row created)`,
        });
      }
    }

    // Restore paper active pair IDs from open positions
    const openPaperPositions = await this.prisma.openPosition.findMany({
      where: {
        isPaper: true,
        status: { not: 'CLOSED' },
      },
      select: { pairId: true },
    });

    this.paperActivePairIds = new Set(openPaperPositions.map((p) => p.pairId));

    if (this.paperActivePairIds.size > 0) {
      this.logger.log({
        message: `Restored ${this.paperActivePairIds.size} paper active pair(s) from DB`,
        module: 'risk-management',
        data: { pairIds: [...this.paperActivePairIds] },
      });
    }
  }

  private async persistState(mode: 'live' | 'paper' = 'live'): Promise<void> {
    try {
      const isPaper = mode === 'paper';
      const state = this.getState(isPaper);
      const reservedPositionSlots = this.getReservedPositionSlots(isPaper);
      const reservedCapital = this.getReservedCapital(isPaper).toFixed();
      const tradingHalted = state.activeHaltReasons.size > 0;
      const haltReason = JSON.stringify([...state.activeHaltReasons]);
      await this.prisma.riskState.upsert({
        where: {
          singletonKey_mode: { singletonKey: 'default', mode },
        },
        update: {
          openPositionCount: state.openPositionCount,
          totalCapitalDeployed: state.totalCapitalDeployed.toFixed(),
          dailyPnl: state.dailyPnl.toFixed(),
          lastResetTimestamp: state.lastResetTimestamp,
          tradingHalted,
          haltReason,
          reservedCapital,
          reservedPositionSlots,
        },
        create: {
          singletonKey: 'default',
          mode,
          openPositionCount: state.openPositionCount,
          totalCapitalDeployed: state.totalCapitalDeployed.toFixed(),
          dailyPnl: state.dailyPnl.toFixed(),
          lastResetTimestamp: state.lastResetTimestamp,
          tradingHalted,
          haltReason,
          reservedCapital,
          reservedPositionSlots,
        },
      });
    } catch (error) {
      const state = this.getState(mode === 'paper');
      this.logger.error({
        message: 'Failed to persist risk state to database',
        data: {
          operation: 'persistState',
          mode,
          dailyPnl: state.dailyPnl.toString(),
          tradingHalted: state.activeHaltReasons.size > 0,
          error: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }

  async validatePosition(
    opportunity: unknown,
    isPaper: boolean = false,
  ): Promise<RiskDecision> {
    const state = this.getState(isPaper);
    const bankrollUsd = this.getBankrollForMode(isPaper);

    // FIRST: Check daily loss halt (Story 4.2) — before any other computation
    if (this.isTradingHalted(isPaper)) {
      return {
        approved: false,
        reason: 'Trading halted: daily loss limit breached',
        maxPositionSizeUsd: new FinancialDecimal(0),
        currentOpenPairs: state.openPositionCount,
        dailyPnl: state.dailyPnl,
      };
    }

    let maxPositionSizeUsd = new FinancialDecimal(bankrollUsd).mul(
      new FinancialDecimal(this.config.maxPositionPct),
    );

    // [Story 9.3] Confidence-adjusted position sizing
    const pairContext = this.extractPairContext(opportunity);
    let rawConfidence = pairContext?.confidenceScore ?? null;

    // Validate range — treat out-of-bounds as null (fail-open)
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

    // Check max open pairs limit (including reserved slots)
    const effectiveOpenPairs =
      state.openPositionCount + this.getReservedPositionSlots(isPaper);
    if (effectiveOpenPairs >= this.config.maxOpenPairs) {
      this.logger.warn({
        message: 'Opportunity rejected: max open pairs exceeded',
        data: {
          currentOpenPairs: state.openPositionCount,
          reservedSlots: this.getReservedPositionSlots(isPaper),
          maxOpenPairs: this.config.maxOpenPairs,
        },
      });
      return {
        approved: false,
        reason: `Max open pairs limit reached (${effectiveOpenPairs}/${this.config.maxOpenPairs})`,
        maxPositionSizeUsd,
        currentOpenPairs: state.openPositionCount,
        ...(rawConfidence != null && { confidenceScore: rawConfidence }),
        ...(confidenceAdjustedSizeUsd !== undefined && {
          confidenceAdjustedSizeUsd,
        }),
      };
    }

    // Check available capital (including reserved capital) — cheap pre-screen
    const reservedCapital = this.getReservedCapital(isPaper);
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
        ...(rawConfidence != null && { confidenceScore: rawConfidence }),
        ...(confidenceAdjustedSizeUsd !== undefined && {
          confidenceAdjustedSizeUsd,
        }),
      };
    }

    // === [Story 9.2] Cluster limit enforcement ===
    let adjustedMaxPositionSizeUsd: Decimal | undefined;
    let clusterExposurePctResult: Decimal | undefined;

    if (pairContext) {
      const hardLimitPct = new FinancialDecimal(
        this.configService.get<string>('RISK_CLUSTER_HARD_LIMIT_PCT', '0.15'),
      );
      const softLimitPct = new FinancialDecimal(
        this.configService.get<string>('RISK_CLUSTER_SOFT_LIMIT_PCT', '0.12'),
      );
      const aggregateLimitPct = new FinancialDecimal(
        this.configService.get<string>(
          'RISK_AGGREGATE_CLUSTER_LIMIT_PCT',
          '0.50',
        ),
      );

      // Step A: Aggregate limit check (50%)
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
          approved: false,
          reason: `Rejected: aggregate cluster exposure ${aggregateExposurePct.mul(100).toFixed(1)}% >= ${aggregateLimitPct.mul(100).toFixed(0)}% limit`,
          maxPositionSizeUsd,
          currentOpenPairs: state.openPositionCount,
          ...(rawConfidence != null && { confidenceScore: rawConfidence }),
          ...(confidenceAdjustedSizeUsd !== undefined && {
            confidenceAdjustedSizeUsd,
          }),
        };
      }

      // Find cluster exposure for this opportunity's cluster
      const clusterId = pairContext.clusterId;
      const clusterExposures = this.correlationTracker.getClusterExposures();
      let clusterExposurePct: Decimal;

      if (clusterId) {
        const clusterEntry = clusterExposures.find(
          (e) => (e.clusterId as string) === clusterId,
        );
        clusterExposurePct = clusterEntry
          ? clusterEntry.exposurePct
          : new Decimal(0);
      } else {
        // Uncategorized fallback: look for cluster named "Uncategorized"
        const uncategorized = clusterExposures.find(
          (e) => e.clusterName === 'Uncategorized',
        );
        clusterExposurePct = uncategorized
          ? uncategorized.exposurePct
          : new Decimal(0);
      }

      // Effective cluster ID for triage queries and events
      // When clusterId is null (Uncategorized fallback), use actual DB cluster ID
      const uncategorizedClusterId = clusterExposures.find(
        (e) => e.clusterName === 'Uncategorized',
      )?.clusterId as string | undefined;
      const effectiveClusterId: string | null = clusterId
        ? clusterId
        : (uncategorizedClusterId ?? null);

      // Helper to resolve cluster name from exposures
      const resolveClusterName = (): string =>
        clusterExposures.find(
          (e) => (e.clusterId as string) === effectiveClusterId,
        )?.clusterName ?? 'Unknown';

      // Step B: Soft-limit size adjustment (12–15%)
      if (clusterExposurePct.gte(hardLimitPct)) {
        // Already over hard limit — skip to rejection
        const { triage, triageDtos } =
          await this.fetchTriageWithDtos(effectiveClusterId);

        const clusterName = resolveClusterName();

        this.logger.warn({
          message:
            'Opportunity rejected: cluster already at or above hard limit',
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
              clusterName,
              asClusterId(effectiveClusterId),
              clusterExposurePct.toNumber(),
              hardLimitPct.toNumber(),
              triageDtos,
            ),
          );
        }

        return {
          approved: false,
          reason: `Rejected: cluster hard limit — exposure ${clusterExposurePct.mul(100).toFixed(1)}% >= ${hardLimitPct.mul(100).toFixed(0)}% limit`,
          maxPositionSizeUsd,
          currentOpenPairs: state.openPositionCount,
          clusterExposurePct,
          triageRecommendations: triage,
          ...(rawConfidence != null && { confidenceScore: rawConfidence }),
          ...(confidenceAdjustedSizeUsd !== undefined && {
            confidenceAdjustedSizeUsd,
          }),
        };
      }

      if (
        clusterExposurePct.gte(softLimitPct) &&
        clusterExposurePct.lt(hardLimitPct)
      ) {
        // In soft-limit zone — taper position size
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

      // Step C: Hard limit projection check (15%)
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
          approved: false,
          reason: `Rejected: cluster hard limit — projected ${projectedExposurePct.mul(100).toFixed(1)}% >= ${hardLimitPct.mul(100).toFixed(0)}% limit`,
          maxPositionSizeUsd,
          currentOpenPairs: state.openPositionCount,
          clusterExposurePct,
          triageRecommendations: triage,
          ...(rawConfidence != null && { confidenceScore: rawConfidence }),
          ...(confidenceAdjustedSizeUsd !== undefined && {
            confidenceAdjustedSizeUsd,
          }),
        };
      }
    }

    // Check if approaching limit (80% threshold)
    const approachThreshold = Math.floor(this.config.maxOpenPairs * 0.8);
    if (effectiveOpenPairs >= approachThreshold) {
      const percentUsed = (effectiveOpenPairs / this.config.maxOpenPairs) * 100;
      this.eventEmitter.emit(
        EVENT_NAMES.LIMIT_APPROACHED,
        new LimitApproachedEvent(
          'max_open_pairs',
          state.openPositionCount,
          this.config.maxOpenPairs,
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
      ...(rawConfidence != null && { confidenceScore: rawConfidence }),
      ...(confidenceAdjustedSizeUsd !== undefined && {
        confidenceAdjustedSizeUsd,
      }),
    };
  }

  private determineRejectionReason(): string | null {
    const effectiveOpenPairs =
      this.liveState.openPositionCount + this.getReservedPositionSlots();
    if (effectiveOpenPairs >= this.config.maxOpenPairs) {
      return `Max open pairs limit reached (${effectiveOpenPairs}/${this.config.maxOpenPairs})`;
    }
    // Position sizing is always a potential rejection for override context
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
    if (!effectiveClusterId) {
      return { triage: [], triageDtos: [] };
    }
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

  async processOverride(
    opportunityId: OpportunityId,
    rationale: string,
  ): Promise<RiskDecision> {
    // FIRST: Check if daily loss halt is active — cannot be overridden
    if (
      this.isTradingHalted() &&
      this.liveState.activeHaltReasons.has(HALT_REASONS.DAILY_LOSS_LIMIT)
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
        currentOpenPairs: this.liveState.openPositionCount,
        dailyPnl: this.liveState.dailyPnl,
      };
    }

    // Determine what would have rejected this opportunity
    const originalRejectionReason =
      this.determineRejectionReason() ?? 'Position sizing limit';

    // Calculate full position cap (ignoring current capital deployed and open pairs)
    const maxPositionSizeUsd = new FinancialDecimal(
      this.config.bankrollUsd,
    ).mul(new FinancialDecimal(this.config.maxPositionPct));

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
      currentOpenPairs: this.liveState.openPositionCount,
      dailyPnl: this.liveState.dailyPnl,
      overrideApplied: true,
      overrideRationale: rationale,
    };
  }

  async updateDailyPnl(pnlDelta: unknown, isPaper = false): Promise<void> {
    const delta = new FinancialDecimal(pnlDelta as Decimal);
    const state = this.getState(isPaper);
    state.dailyPnl = state.dailyPnl.add(delta);

    const bankroll = this.getBankrollForMode(isPaper);
    const dailyLossLimitUsd = bankroll.mul(
      new FinancialDecimal(this.config.dailyLossPct),
    );

    const absLoss = state.dailyPnl.isNegative()
      ? state.dailyPnl.abs()
      : new FinancialDecimal(0);
    const percentUsed = absLoss.div(dailyLossLimitUsd).toNumber();

    if (
      percentUsed >= 1.0 &&
      !state.activeHaltReasons.has(HALT_REASONS.DAILY_LOSS_LIMIT)
    ) {
      if (!isPaper) {
        this.haltTrading(HALT_REASONS.DAILY_LOSS_LIMIT);
      } else {
        state.activeHaltReasons.add(HALT_REASONS.DAILY_LOSS_LIMIT);
      }
      this.eventEmitter.emit(
        EVENT_NAMES.LIMIT_BREACHED,
        new LimitBreachedEvent(
          'dailyLoss',
          absLoss.toNumber(),
          dailyLossLimitUsd.toNumber(),
        ),
      );
      this.logger.log({
        message: `TRADING HALTED: Daily loss limit breached (${isPaper ? 'paper' : 'live'})`,
        data: {
          dailyPnl: state.dailyPnl.toString(),
          limit: dailyLossLimitUsd.toString(),
          percentUsed,
          mode: isPaper ? 'paper' : 'live',
        },
      });
    } else if (
      percentUsed >= 0.8 &&
      percentUsed < 1.0 &&
      !state.dailyLossApproachEmitted
    ) {
      state.dailyLossApproachEmitted = true;
      this.eventEmitter.emit(
        EVENT_NAMES.LIMIT_APPROACHED,
        new LimitApproachedEvent(
          'dailyLoss',
          absLoss.toNumber(),
          dailyLossLimitUsd.toNumber(),
          percentUsed,
        ),
      );
    }

    await this.persistState(isPaper ? 'paper' : 'live');
  }

  isTradingHalted(isPaper: boolean = false): boolean {
    return this.getState(isPaper).activeHaltReasons.size > 0;
  }

  getActiveHaltReasons(isPaper: boolean = false): string[] {
    return [...this.getState(isPaper).activeHaltReasons];
  }

  haltTrading(reason: string): void {
    const haltReason = reason as HaltReason;
    if (this.liveState.activeHaltReasons.has(haltReason)) {
      return; // Already halted for this reason
    }
    this.liveState.activeHaltReasons.add(haltReason);
    this.eventEmitter.emit(
      EVENT_NAMES.SYSTEM_TRADING_HALTED,
      new TradingHaltedEvent(
        reason,
        { activeReasons: [...this.liveState.activeHaltReasons] },
        new Date(),
        'critical',
      ),
    );
    this.logger.log({
      message: `Trading halted: ${reason}`,
      data: { reason, activeReasons: [...this.liveState.activeHaltReasons] },
    });
    void this.persistState('live');
  }

  resumeTrading(reason: string): void {
    const haltReason = reason as HaltReason;
    if (!this.liveState.activeHaltReasons.has(haltReason)) {
      return; // Not halted for this reason
    }
    this.liveState.activeHaltReasons.delete(haltReason);
    const remaining = [...this.liveState.activeHaltReasons];
    this.eventEmitter.emit(
      EVENT_NAMES.SYSTEM_TRADING_RESUMED,
      new TradingResumedEvent(reason, remaining, new Date()),
    );
    this.logger.log({
      message: `Halt reason removed: ${reason}`,
      data: {
        removedReason: reason,
        remainingReasons: remaining,
        tradingResumed: this.liveState.activeHaltReasons.size === 0,
      },
    });
    void this.persistState('live');
  }

  async recalculateFromPositions(
    openCount: number,
    capitalDeployed: Decimal,
    mode: 'live' | 'paper' = 'live',
  ): Promise<void> {
    const isPaper = mode === 'paper';
    const state = this.getState(isPaper);
    const previousCount = state.openPositionCount;
    const previousCapital = state.totalCapitalDeployed.toString();

    state.openPositionCount = openCount;
    state.totalCapitalDeployed = new FinancialDecimal(capitalDeployed);

    this.logger.log({
      message: 'Risk state recalculated from reconciliation',
      data: {
        mode,
        previousOpenCount: previousCount,
        newOpenCount: openCount,
        previousCapitalDeployed: previousCapital,
        newCapitalDeployed: state.totalCapitalDeployed.toString(),
      },
    });

    await this.persistState(mode);
  }

  @Cron('0 0 0 * * *', { timeZone: 'UTC' })
  async handleMidnightReset(): Promise<void> {
    const todayMidnight = new Date();
    todayMidnight.setUTCHours(0, 0, 0, 0);

    // Reset both modes independently
    for (const { state, mode } of [
      { state: this.liveState, mode: 'live' as const },
      { state: this.paperState, mode: 'paper' as const },
    ]) {
      const previousPnl = state.dailyPnl.toString();
      state.dailyPnl = new FinancialDecimal(0);
      state.lastResetTimestamp = todayMidnight;
      state.dailyLossApproachEmitted = false;

      if (state.activeHaltReasons.has(HALT_REASONS.DAILY_LOSS_LIMIT)) {
        if (mode === 'live') {
          this.resumeTrading(HALT_REASONS.DAILY_LOSS_LIMIT);
        } else {
          state.activeHaltReasons.delete(HALT_REASONS.DAILY_LOSS_LIMIT);
        }
        this.logger.log({
          message: `Trading halt cleared by midnight reset (${mode})`,
        });
      }

      this.logger.log({
        message: `Daily P&L reset at UTC midnight (${mode})`,
        data: { previousDayPnl: previousPnl, newDailyPnl: '0', mode },
      });
    }

    await this.persistState('live');
    await this.persistState('paper');
  }

  getCurrentExposure(isPaper: boolean = false): RiskExposure {
    const state = this.getState(isPaper);
    const bankrollUsd = this.getBankrollForMode(isPaper);
    const dailyLossLimitUsd = new FinancialDecimal(bankrollUsd).mul(
      new FinancialDecimal(this.config.dailyLossPct),
    );
    const reserved: Decimal = this.getReservedCapital(isPaper);
    return {
      openPairCount:
        state.openPositionCount + this.getReservedPositionSlots(isPaper),
      totalCapitalDeployed: new FinancialDecimal(
        state.totalCapitalDeployed.add(reserved),
      ),
      bankrollUsd,
      availableCapital: new FinancialDecimal(
        bankrollUsd.minus(state.totalCapitalDeployed).minus(reserved),
      ),
      dailyPnl: state.dailyPnl,
      dailyLossLimitUsd,
      clusterExposures: this.correlationTracker.getClusterExposures(),
      aggregateClusterExposurePct:
        this.correlationTracker.getAggregateExposurePct(),
    };
  }

  getOpenPositionCount(): number {
    return this.liveState.openPositionCount;
  }

  async reserveBudget(request: ReservationRequest): Promise<BudgetReservation> {
    const state = this.getState(request.isPaper);
    const bankroll = this.getBankrollForMode(request.isPaper);

    // Check halt (live only — paper mode doesn't halt live trading)
    if (!request.isPaper && this.isTradingHalted()) {
      throw new RiskLimitError(
        RISK_ERROR_CODES.BUDGET_RESERVATION_FAILED,
        'Budget reservation failed: trading halted',
        'error',
        'budget_reservation',
        0,
        0,
      );
    }

    // Paper mode dedup: reject if pair already active
    if (request.isPaper && this.paperActivePairIds.has(request.pairId)) {
      this.logger.warn({
        message: 'Paper mode duplicate opportunity blocked',
        module: 'risk-management',
        data: {
          pairId: request.pairId,
          opportunityId: request.opportunityId,
          reason: 'paper_position_already_active',
        },
      });
      throw new RiskLimitError(
        RISK_ERROR_CODES.BUDGET_RESERVATION_FAILED,
        `Budget reservation failed: paper position already open or reserved for pair ${request.pairId}`,
        'warning',
        'budget_reservation',
        0,
        0,
      );
    }

    const maxPositionSizeUsd = bankroll.mul(
      new FinancialDecimal(this.config.maxPositionPct),
    );

    // Use the lesser of recommended size and config max — avoid over-reserving
    const reserveAmount = request.recommendedPositionSizeUsd.lte(
      maxPositionSizeUsd,
    )
      ? new FinancialDecimal(request.recommendedPositionSizeUsd)
      : maxPositionSizeUsd;

    // Check max open pairs (including mode-filtered reserved slots)
    const effectiveOpenPairs =
      state.openPositionCount + this.getReservedPositionSlots(request.isPaper);
    if (effectiveOpenPairs >= this.config.maxOpenPairs) {
      throw new RiskLimitError(
        RISK_ERROR_CODES.BUDGET_RESERVATION_FAILED,
        `Budget reservation failed: max open pairs reached (${effectiveOpenPairs}/${this.config.maxOpenPairs})`,
        'error',
        'budget_reservation',
        effectiveOpenPairs,
        this.config.maxOpenPairs,
      );
    }

    // Check available capital (including mode-filtered reserved capital)
    const modeReservedCapital = this.getReservedCapital(request.isPaper);
    const availableCapital = new FinancialDecimal(
      bankroll.minus(state.totalCapitalDeployed).minus(modeReservedCapital),
    );
    if (availableCapital.lt(reserveAmount)) {
      throw new RiskLimitError(
        RISK_ERROR_CODES.BUDGET_RESERVATION_FAILED,
        'Budget reservation failed: insufficient available capital',
        'error',
        'budget_reservation',
        availableCapital.toNumber(),
        reserveAmount.toNumber(),
      );
    }

    const reservation: BudgetReservation = {
      reservationId: asReservationId(randomUUID()),
      opportunityId: request.opportunityId,
      pairId: request.pairId,
      isPaper: request.isPaper,
      reservedPositionSlots: 1,
      reservedCapitalUsd: reserveAmount,
      correlationExposure: new FinancialDecimal(0),
      createdAt: new Date(),
    };

    this.reservations.set(reservation.reservationId, reservation);

    if (request.isPaper) {
      this.paperActivePairIds.add(request.pairId);
    }

    this.eventEmitter.emit(
      EVENT_NAMES.BUDGET_RESERVED,
      new BudgetReservedEvent(
        reservation.reservationId,
        reservation.opportunityId,
        reservation.reservedCapitalUsd.toString(),
      ),
    );

    this.logger.log({
      message: 'Budget reserved for opportunity',
      data: {
        reservationId: reservation.reservationId,
        opportunityId: request.opportunityId,
        reservedCapitalUsd: reservation.reservedCapitalUsd.toString(),
      },
    });

    await this.persistState(request.isPaper ? 'paper' : 'live');
    return reservation;
  }

  async commitReservation(reservationId: ReservationId): Promise<void> {
    const reservation = this.reservations.get(reservationId);
    if (!reservation) {
      throw new RiskLimitError(
        RISK_ERROR_CODES.BUDGET_RESERVATION_FAILED,
        `Cannot commit reservation: ${reservationId} not found`,
        'error',
        'budget_reservation',
        0,
        0,
      );
    }

    // Move reservation to permanent state (mode-aware)
    const state = this.getState(reservation.isPaper);
    state.openPositionCount += reservation.reservedPositionSlots;
    state.totalCapitalDeployed = new FinancialDecimal(
      state.totalCapitalDeployed.add(
        new FinancialDecimal(reservation.reservedCapitalUsd),
      ),
    );
    this.reservations.delete(reservationId);

    this.eventEmitter.emit(
      EVENT_NAMES.BUDGET_COMMITTED,
      new BudgetCommittedEvent(
        reservationId,
        reservation.opportunityId,
        reservation.reservedCapitalUsd.toString(),
      ),
    );

    this.logger.log({
      message: 'Budget reservation committed',
      data: {
        reservationId,
        opportunityId: reservation.opportunityId,
        newOpenPositionCount: state.openPositionCount,
        newTotalCapitalDeployed: state.totalCapitalDeployed.toString(),
      },
    });

    await this.persistState(reservation.isPaper ? 'paper' : 'live');
  }

  async releaseReservation(reservationId: ReservationId): Promise<void> {
    const reservation = this.reservations.get(reservationId);
    if (!reservation) {
      throw new RiskLimitError(
        RISK_ERROR_CODES.BUDGET_RESERVATION_FAILED,
        `Cannot release reservation: ${reservationId} not found`,
        'error',
        'budget_reservation',
        0,
        0,
      );
    }

    if (reservation.isPaper) {
      this.paperActivePairIds.delete(reservation.pairId);
    }

    this.reservations.delete(reservationId);

    this.eventEmitter.emit(
      EVENT_NAMES.BUDGET_RELEASED,
      new BudgetReleasedEvent(
        reservationId,
        reservation.opportunityId,
        reservation.reservedCapitalUsd.toString(),
      ),
    );

    this.logger.log({
      message: 'Budget reservation released',
      data: {
        reservationId,
        opportunityId: reservation.opportunityId,
        releasedCapitalUsd: reservation.reservedCapitalUsd.toString(),
      },
    });

    await this.persistState(reservation.isPaper ? 'paper' : 'live');
  }

  async adjustReservation(
    reservationId: ReservationId,
    newCapitalUsd: Decimal,
  ): Promise<void> {
    const reservation = this.reservations.get(reservationId);
    if (!reservation) {
      throw new RiskLimitError(
        RISK_ERROR_CODES.BUDGET_RESERVATION_FAILED,
        `Cannot adjust reservation: ${reservationId} not found`,
        'error',
        'budget_reservation',
        0,
        0,
      );
    }
    const oldCapital = new FinancialDecimal(reservation.reservedCapitalUsd);
    const newCapital = new FinancialDecimal(newCapitalUsd);
    if (newCapital.gte(oldCapital)) return; // No-op if new >= old

    reservation.reservedCapitalUsd = newCapital;

    this.logger.log({
      message: 'Reservation adjusted — excess capital released',
      data: {
        reservationId,
        oldCapitalUsd: oldCapital.toString(),
        newCapitalUsd: newCapital.toString(),
        releasedUsd: oldCapital.minus(newCapital).toString(),
      },
    });

    await this.persistState(reservation.isPaper ? 'paper' : 'live');
  }

  async closePosition(
    capitalReturned: unknown,
    pnlDelta: unknown,
    pairId?: PairId,
    isPaper = false,
  ): Promise<void> {
    if (pairId) {
      this.paperActivePairIds.delete(pairId);
    } else if (isPaper && this.paperActivePairIds.size > 0) {
      this.logger.warn({
        message:
          'closePosition called without pairId while paper pairs are tracked — potential Set leak if closing a paper position',
        module: 'risk-management',
        data: { trackedPairCount: this.paperActivePairIds.size },
      });
    }

    const state = this.getState(isPaper);
    const capital = new FinancialDecimal(capitalReturned as Decimal);
    const pnl = new FinancialDecimal(pnlDelta as Decimal);

    state.openPositionCount = Math.max(0, state.openPositionCount - 1);
    state.totalCapitalDeployed = new FinancialDecimal(
      state.totalCapitalDeployed.minus(capital),
    );
    if (state.totalCapitalDeployed.isNegative()) {
      state.totalCapitalDeployed = new FinancialDecimal(0);
    }

    this.eventEmitter.emit(
      EVENT_NAMES.BUDGET_RELEASED,
      new BudgetReleasedEvent(
        asReservationId('position-close'),
        asOpportunityId('position-close'),
        capital.toString(),
      ),
    );

    this.logger.log({
      message: 'Position closed — budget released',
      data: {
        capitalReturned: capital.toString(),
        pnlDelta: pnl.toString(),
        newOpenPositionCount: state.openPositionCount,
        newTotalCapitalDeployed: state.totalCapitalDeployed.toString(),
      },
    });

    await this.updateDailyPnl(pnl, isPaper);
    await this.persistState(isPaper ? 'paper' : 'live');
  }

  async releasePartialCapital(
    capitalReleased: unknown,
    realizedPnl: unknown,
    _pairId?: string,
    isPaper = false,
  ): Promise<void> {
    // NOTE: pairId is intentionally ignored — position is still EXIT_PARTIAL,
    // so it must NOT be removed from paperActivePairIds and openPositionCount
    // must NOT be decremented.
    const state = this.getState(isPaper);
    const capital = new FinancialDecimal(capitalReleased as Decimal);
    const pnl = new FinancialDecimal(realizedPnl as Decimal);

    state.totalCapitalDeployed = new FinancialDecimal(
      state.totalCapitalDeployed.minus(capital),
    );
    if (state.totalCapitalDeployed.isNegative()) {
      state.totalCapitalDeployed = new FinancialDecimal(0);
    }

    this.eventEmitter.emit(
      EVENT_NAMES.BUDGET_RELEASED,
      new BudgetReleasedEvent(
        asReservationId('partial-exit'),
        asOpportunityId('partial-exit'),
        capital.toString(),
      ),
    );

    this.logger.log({
      message: 'Partial exit — capital released for exited contracts',
      data: {
        capitalReleased: capital.toString(),
        realizedPnl: pnl.toString(),
        openPositionCount: state.openPositionCount,
        newTotalCapitalDeployed: state.totalCapitalDeployed.toString(),
      },
    });

    await this.updateDailyPnl(pnl, isPaper);
    await this.persistState(isPaper ? 'paper' : 'live');
  }

  private getReservedPositionSlots(isPaper?: boolean): number {
    let total = 0;
    for (const reservation of this.reservations.values()) {
      if (isPaper === undefined || reservation.isPaper === isPaper) {
        total += reservation.reservedPositionSlots;
      }
    }
    return total;
  }

  private getReservedCapital(isPaper?: boolean): Decimal {
    let total: Decimal = new FinancialDecimal(0);
    for (const reservation of this.reservations.values()) {
      if (isPaper === undefined || reservation.isPaper === isPaper) {
        total = total.add(new FinancialDecimal(reservation.reservedCapitalUsd));
      }
    }
    return total;
  }
}
