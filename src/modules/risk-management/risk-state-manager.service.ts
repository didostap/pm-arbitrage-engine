import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Cron } from '@nestjs/schedule';
import Decimal from 'decimal.js';
import { RiskConfig } from '../../common/types/risk.type';
import {
  EVENT_NAMES,
  LimitApproachedEvent,
  LimitBreachedEvent,
  DataCorruptionDetectedEvent,
} from '../../common/events';
import { applyHalt, applyResume } from './halt.utils';
import {
  validateRiskConfigValues,
  buildEnvFallback,
} from './risk-config.utils';
import { FinancialDecimal } from '../../common/utils/financial-math';
import { PrismaService } from '../../common/prisma.service';
import { haltReasonSchema } from '../../common/schemas/prisma-json.schema';
import { CorrelationTrackerService } from './correlation-tracker.service';
import { EngineConfigRepository } from '../../persistence/repositories/engine-config.repository';

export const HALT_REASONS = {
  DAILY_LOSS_LIMIT: 'daily_loss_limit',
  RECONCILIATION_DISCREPANCY: 'reconciliation_discrepancy',
} as const;
export type HaltReason = (typeof HALT_REASONS)[keyof typeof HALT_REASONS];

export interface ModeRiskState {
  openPositionCount: number;
  totalCapitalDeployed: Decimal;
  dailyPnl: Decimal;
  /** Cleanup: .delete() on resume, .clear() on daily reset */
  activeHaltReasons: Set<HaltReason>;
  dailyLossApproachEmitted: boolean;
  lastResetTimestamp: Date | null;
}

export function createDefaultModeRiskState(): ModeRiskState {
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
export class RiskStateManager implements OnModuleInit {
  private readonly logger = new Logger(RiskStateManager.name);
  private config!: RiskConfig;
  private liveState: ModeRiskState = createDefaultModeRiskState();
  private paperState: ModeRiskState = createDefaultModeRiskState();
  private bankrollUpdatedAt: Date = new Date();
  /** Callback providing current reservation data for DB persistence. Registered by BudgetReservationService. */
  private reservationDataProvider: (isPaper: boolean) => {
    slots: number;
    capital: string;
  } = () => ({
    slots: 0,
    capital: '0',
  });

  constructor(
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
    private readonly engineConfigRepository: EngineConfigRepository,
    private readonly correlationTracker: CorrelationTrackerService,
  ) {}

  registerReservationDataProvider(
    provider: (isPaper: boolean) => { slots: number; capital: string },
  ): void {
    this.reservationDataProvider = provider;
  }

  getState(isPaper: boolean): ModeRiskState {
    return isPaper ? this.paperState : this.liveState;
  }
  getBankrollForMode(isPaper: boolean): Decimal {
    return new FinancialDecimal(
      isPaper
        ? (this.config.paperBankrollUsd ?? this.config.bankrollUsd)
        : this.config.bankrollUsd,
    );
  }
  getConfig(): RiskConfig {
    return this.config;
  }
  getClusterLimits(): {
    hardLimitPct: Decimal;
    softLimitPct: Decimal;
    aggregateLimitPct: Decimal;
  } {
    return {
      hardLimitPct: new FinancialDecimal(
        this.configService.get<string>('RISK_CLUSTER_HARD_LIMIT_PCT', '0.15'),
      ),
      softLimitPct: new FinancialDecimal(
        this.configService.get<string>('RISK_CLUSTER_SOFT_LIMIT_PCT', '0.12'),
      ),
      aggregateLimitPct: new FinancialDecimal(
        this.configService.get<string>(
          'RISK_AGGREGATE_CLUSTER_LIMIT_PCT',
          '0.50',
        ),
      ),
    };
  }

  async onModuleInit(): Promise<void> {
    await this.loadBankrollFromDb();
    this.validateConfig();
    await this.initializeStateFromDb();
  }

  private async loadBankrollFromDb(): Promise<void> {
    const engineConfig = await this.engineConfigRepository.get();
    if (engineConfig) {
      const bankroll = Number(engineConfig.bankrollUsd.toString());
      const paperBankroll = engineConfig.paperBankrollUsd
        ? Number(engineConfig.paperBankrollUsd.toString())
        : undefined;
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

  async reloadConfig(): Promise<void> {
    const envFallback = this.buildReloadEnvFallback();
    const effective =
      await this.engineConfigRepository.getEffectiveConfig(envFallback);
    const bankroll = new FinancialDecimal(effective.bankrollUsd);
    const paperBankroll = effective.paperBankrollUsd
      ? new FinancialDecimal(effective.paperBankrollUsd)
      : undefined;
    const maxPositionPct = new FinancialDecimal(effective.riskMaxPositionPct);
    const maxOpenPairs = Number(effective.riskMaxOpenPairs);
    const dailyLossPct = new FinancialDecimal(effective.riskDailyLossPct);
    if (bankroll.lte(0)) {
      this.logger.error({
        message:
          'reloadConfig: bankrollUsd must be positive, keeping existing config',
      });
      return;
    }
    if (maxPositionPct.lte(0) || maxPositionPct.gt(1)) {
      this.logger.error({
        message:
          'reloadConfig: riskMaxPositionPct must be in (0, 1], keeping existing config',
      });
      return;
    }
    if (!Number.isInteger(maxOpenPairs) || maxOpenPairs <= 0) {
      this.logger.error({
        message:
          'reloadConfig: riskMaxOpenPairs must be a positive integer, keeping existing config',
      });
      return;
    }
    if (dailyLossPct.lte(0) || dailyLossPct.gt(1)) {
      this.logger.error({
        message:
          'reloadConfig: riskDailyLossPct must be in (0, 1], keeping existing config',
      });
      return;
    }
    this.config = {
      ...this.config,
      bankrollUsd: bankroll.toNumber(),
      paperBankrollUsd: paperBankroll?.toNumber(),
      maxPositionPct: maxPositionPct.toNumber(),
      maxOpenPairs,
      dailyLossPct: dailyLossPct.toNumber(),
    };
    this.correlationTracker.updateBankroll(bankroll);
    this.logger.log({
      message: 'Risk manager config reloaded from DB',
      data: {
        bankrollUsd: bankroll.toString(),
        maxPositionPct: maxPositionPct.toString(),
        maxOpenPairs,
        dailyLossPct: dailyLossPct.toString(),
      },
    });
  }

  private buildReloadEnvFallback() {
    return buildEnvFallback(this.configService);
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

  validateConfig(): void {
    this.config = validateRiskConfigValues(this.config, this.configService);
    this.logger.log({
      message: 'Risk manager configuration validated',
      data: {
        bankrollMagnitude: `$${Math.pow(10, Math.floor(Math.log10(this.config.bankrollUsd)))}+`,
        maxPositionPct: this.config.maxPositionPct,
        maxOpenPairs: this.config.maxOpenPairs,
        dailyLossPct: this.config.dailyLossPct,
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
        state.activeHaltReasons = new Set<HaltReason>();
        if (row.haltReason) {
          try {
            const parsed: unknown = JSON.parse(row.haltReason);
            const validated = haltReasonSchema.safeParse(parsed);
            if (validated.success) {
              for (const r of validated.data)
                state.activeHaltReasons.add(r as HaltReason);
            } else if (typeof parsed === 'string' && parsed.length > 0) {
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
            if (typeof row.haltReason === 'string' && row.haltReason.length > 0)
              state.activeHaltReasons.add(row.haltReason as HaltReason);
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
            const dailyLossLimitUsd = bankroll.mul(
              new FinancialDecimal(this.config.dailyLossPct),
            );
            const absLoss = state.dailyPnl.isNegative()
              ? state.dailyPnl.abs()
              : new FinancialDecimal(0);
            if (absLoss.gte(dailyLossLimitUsd))
              state.activeHaltReasons.add(HALT_REASONS.DAILY_LOSS_LIMIT);
          }
        } else {
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
  }

  async persistState(mode: 'live' | 'paper' = 'live'): Promise<void> {
    try {
      const isPaper = mode === 'paper';
      const state = this.getState(isPaper);
      const tradingHalted = state.activeHaltReasons.size > 0;
      const haltReason = JSON.stringify([...state.activeHaltReasons]);
      const { slots, capital } = this.reservationDataProvider(isPaper);
      const data = {
        openPositionCount: state.openPositionCount,
        totalCapitalDeployed: state.totalCapitalDeployed.toFixed(),
        dailyPnl: state.dailyPnl.toFixed(),
        lastResetTimestamp: state.lastResetTimestamp,
        tradingHalted,
        haltReason,
        reservedCapital: capital,
        reservedPositionSlots: slots,
      };
      await this.prisma.riskState.upsert({
        where: { singletonKey_mode: { singletonKey: 'default', mode } },
        update: data,
        create: { singletonKey: 'default', mode, ...data },
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

  async updateDailyPnl(
    pnlDelta: unknown,
    isPaper = false,
    skipPersist = false,
  ): Promise<void> {
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

    if (percentUsed >= 1.0) {
      const halted = applyHalt(
        state,
        HALT_REASONS.DAILY_LOSS_LIMIT,
        this.eventEmitter,
        isPaper,
      );
      if (halted) {
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
      }
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
    if (!skipPersist) {
      await this.persistState(isPaper ? 'paper' : 'live');
    }
  }

  @Cron('0 0 0 * * *', { timeZone: 'UTC' })
  async handleMidnightReset(): Promise<void> {
    const todayMidnight = new Date();
    todayMidnight.setUTCHours(0, 0, 0, 0);
    for (const { state, mode } of [
      { state: this.liveState, mode: 'live' as const },
      { state: this.paperState, mode: 'paper' as const },
    ]) {
      const previousPnl = state.dailyPnl.toString();
      state.dailyPnl = new FinancialDecimal(0);
      state.lastResetTimestamp = todayMidnight;
      state.dailyLossApproachEmitted = false;
      if (
        applyResume(
          state,
          HALT_REASONS.DAILY_LOSS_LIMIT,
          this.eventEmitter,
          mode === 'live',
        )
      ) {
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

  getExposureData(isPaper: boolean = false) {
    const state = this.getState(isPaper);
    const bankrollUsd = this.getBankrollForMode(isPaper);
    const dailyLossLimitUsd = new FinancialDecimal(bankrollUsd).mul(
      new FinancialDecimal(this.config.dailyLossPct),
    );
    return {
      openPositionCount: state.openPositionCount,
      totalCapitalDeployed: state.totalCapitalDeployed,
      bankrollUsd,
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

  decrementOpenPositions(capitalReturned: Decimal, isPaper: boolean): void {
    const state = this.getState(isPaper);
    state.openPositionCount = Math.max(0, state.openPositionCount - 1);
    state.totalCapitalDeployed = new FinancialDecimal(
      state.totalCapitalDeployed.minus(new FinancialDecimal(capitalReturned)),
    );
    if (state.totalCapitalDeployed.isNegative())
      state.totalCapitalDeployed = new FinancialDecimal(0);
  }

  adjustCapitalDeployed(capitalDelta: Decimal, isPaper: boolean): void {
    const state = this.getState(isPaper);
    state.totalCapitalDeployed = new FinancialDecimal(
      state.totalCapitalDeployed.minus(new FinancialDecimal(capitalDelta)),
    );
    if (state.totalCapitalDeployed.isNegative())
      state.totalCapitalDeployed = new FinancialDecimal(0);
  }

  incrementOpenPositions(
    slots: number,
    capitalAdded: Decimal,
    isPaper: boolean,
  ): void {
    const state = this.getState(isPaper);
    state.openPositionCount += slots;
    state.totalCapitalDeployed = new FinancialDecimal(
      state.totalCapitalDeployed.add(new FinancialDecimal(capitalAdded)),
    );
  }
}
