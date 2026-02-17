import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Cron } from '@nestjs/schedule';
import Decimal from 'decimal.js';
import { IRiskManager } from '../../common/interfaces/risk-manager.interface';
import {
  RiskConfig,
  RiskDecision,
  RiskExposure,
} from '../../common/types/risk.type';
import { ConfigValidationError } from '../../common/errors/config-validation-error';
import {
  EVENT_NAMES,
  LimitApproachedEvent,
  LimitBreachedEvent,
} from '../../common/events';
import { FinancialDecimal } from '../../common/utils/financial-math';
import { PrismaService } from '../../common/prisma.service';

const HALT_REASONS = {
  DAILY_LOSS_LIMIT: 'daily_loss_limit',
} as const;
type HaltReason = (typeof HALT_REASONS)[keyof typeof HALT_REASONS] | null;

@Injectable()
export class RiskManagerService implements IRiskManager, OnModuleInit {
  private readonly logger = new Logger(RiskManagerService.name);
  private config!: RiskConfig;
  private openPositionCount = 0;
  private totalCapitalDeployed = new FinancialDecimal(0);
  private dailyPnl = new FinancialDecimal(0);
  private tradingHalted = false;
  private haltReason: HaltReason = null;
  private dailyLossApproachEmitted = false;
  private lastResetTimestamp: Date | null = null;

  constructor(
    private readonly configService: ConfigService,
    private readonly eventEmitter: EventEmitter2,
    private readonly prisma: PrismaService,
  ) {}

  async onModuleInit(): Promise<void> {
    this.validateConfig();
    await this.initializeStateFromDb();
  }

  private validateConfig(): void {
    const bankrollRaw = this.configService.get<string | number>(
      'RISK_BANKROLL_USD',
    );
    const bankroll =
      bankrollRaw !== undefined ? Number(bankrollRaw) : undefined;
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
    const state = await this.prisma.riskState.findFirst({
      where: { singletonKey: 'default' },
    });

    if (state) {
      this.openPositionCount = state.openPositionCount;
      this.totalCapitalDeployed = new FinancialDecimal(
        state.totalCapitalDeployed.toString(),
      );
      this.dailyPnl = new FinancialDecimal(state.dailyPnl.toString());
      this.tradingHalted = state.tradingHalted;
      this.haltReason = (state.haltReason as HaltReason) ?? null;

      // Stale-day detection
      if (state.lastResetTimestamp) {
        const todayMidnight = new Date();
        todayMidnight.setUTCHours(0, 0, 0, 0);

        if (state.lastResetTimestamp < todayMidnight) {
          this.logger.log({
            message: 'Stale-day detected on startup, daily P&L reset',
            data: { previousDailyPnl: this.dailyPnl.toString() },
          });
          this.dailyPnl = new FinancialDecimal(0);
          this.tradingHalted = false;
          this.haltReason = null;
          this.lastResetTimestamp = todayMidnight;
          this.dailyLossApproachEmitted = false;
          await this.persistState();
        } else {
          this.lastResetTimestamp = state.lastResetTimestamp;
          // Re-evaluate halt if same day and loss exceeds limit
          const dailyLossLimitUsd = new FinancialDecimal(
            this.config.bankrollUsd,
          ).mul(new FinancialDecimal(this.config.dailyLossPct));
          const absLoss = this.dailyPnl.isNegative()
            ? this.dailyPnl.abs()
            : new FinancialDecimal(0);
          if (absLoss.gte(dailyLossLimitUsd)) {
            this.tradingHalted = true;
            this.haltReason = HALT_REASONS.DAILY_LOSS_LIMIT;
          }
        }
      } else {
        // No lastResetTimestamp — first run or corrupted state
        const todayMidnight = new Date();
        todayMidnight.setUTCHours(0, 0, 0, 0);
        this.lastResetTimestamp = todayMidnight;

        if (!this.dailyPnl.isZero()) {
          this.logger.warn({
            message:
              'Corrupted state: non-zero dailyPnl with null lastResetTimestamp, resetting',
            data: { dailyPnl: this.dailyPnl.toString() },
          });
          this.dailyPnl = new FinancialDecimal(0);
          this.tradingHalted = false;
          this.haltReason = null;
          await this.persistState();
        }
      }

      this.logger.log({
        message: 'Risk state restored from database',
        data: {
          openPositionCount: this.openPositionCount,
          totalCapitalDeployed: this.totalCapitalDeployed.toString(),
          dailyPnl: this.dailyPnl.toString(),
          tradingHalted: this.tradingHalted,
        },
      });
    } else {
      const todayMidnight = new Date();
      todayMidnight.setUTCHours(0, 0, 0, 0);
      this.lastResetTimestamp = todayMidnight;
      await this.persistState();
      this.logger.log({
        message: 'Risk state initialized (new singleton row created)',
      });
    }
  }

  private async persistState(): Promise<void> {
    try {
      await this.prisma.riskState.upsert({
        where: { singletonKey: 'default' },
        update: {
          openPositionCount: this.openPositionCount,
          totalCapitalDeployed: this.totalCapitalDeployed.toFixed(),
          dailyPnl: this.dailyPnl.toFixed(),
          lastResetTimestamp: this.lastResetTimestamp,
          tradingHalted: this.tradingHalted,
          haltReason: this.haltReason,
        },
        create: {
          singletonKey: 'default',
          openPositionCount: this.openPositionCount,
          totalCapitalDeployed: this.totalCapitalDeployed.toFixed(),
          dailyPnl: this.dailyPnl.toFixed(),
          lastResetTimestamp: this.lastResetTimestamp,
          tradingHalted: this.tradingHalted,
          haltReason: this.haltReason,
        },
      });
    } catch (error) {
      this.logger.error({
        message: 'Failed to persist risk state to database',
        data: {
          operation: 'persistState',
          dailyPnl: this.dailyPnl.toString(),
          tradingHalted: this.tradingHalted,
          error: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  validatePosition(_opportunity: unknown): Promise<RiskDecision> {
    // FIRST: Check daily loss halt (Story 4.2) — before any other computation
    if (this.tradingHalted) {
      return Promise.resolve({
        approved: false,
        reason: 'Trading halted: daily loss limit breached',
        maxPositionSizeUsd: new FinancialDecimal(0),
        currentOpenPairs: this.openPositionCount,
        dailyPnl: this.dailyPnl,
      });
    }

    const maxPositionSizeUsd = new FinancialDecimal(
      this.config.bankrollUsd,
    ).mul(new FinancialDecimal(this.config.maxPositionPct));

    // Check max open pairs limit
    if (this.openPositionCount >= this.config.maxOpenPairs) {
      this.logger.warn({
        message: 'Opportunity rejected: max open pairs exceeded',
        data: {
          currentOpenPairs: this.openPositionCount,
          maxOpenPairs: this.config.maxOpenPairs,
        },
      });
      return Promise.resolve({
        approved: false,
        reason: `Max open pairs limit reached (${this.openPositionCount}/${this.config.maxOpenPairs})`,
        maxPositionSizeUsd,
        currentOpenPairs: this.openPositionCount,
      });
    }

    // Check if approaching limit (80% threshold)
    const approachThreshold = Math.floor(this.config.maxOpenPairs * 0.8);
    if (this.openPositionCount >= approachThreshold) {
      const percentUsed =
        (this.openPositionCount / this.config.maxOpenPairs) * 100;
      this.eventEmitter.emit(
        EVENT_NAMES.LIMIT_APPROACHED,
        new LimitApproachedEvent(
          'max_open_pairs',
          this.openPositionCount,
          this.config.maxOpenPairs,
          percentUsed,
        ),
      );
    }

    return Promise.resolve({
      approved: true,
      reason: 'Position within risk limits',
      maxPositionSizeUsd,
      currentOpenPairs: this.openPositionCount,
    });
  }

  async updateDailyPnl(pnlDelta: unknown): Promise<void> {
    const delta = new FinancialDecimal(pnlDelta as Decimal);
    this.dailyPnl = this.dailyPnl.add(delta);

    const dailyLossLimitUsd = new FinancialDecimal(this.config.bankrollUsd).mul(
      new FinancialDecimal(this.config.dailyLossPct),
    );

    const absLoss = this.dailyPnl.isNegative()
      ? this.dailyPnl.abs()
      : new FinancialDecimal(0);
    const percentUsed = absLoss.div(dailyLossLimitUsd).toNumber();

    if (percentUsed >= 1.0 && !this.tradingHalted) {
      this.tradingHalted = true;
      this.haltReason = HALT_REASONS.DAILY_LOSS_LIMIT;
      this.eventEmitter.emit(
        EVENT_NAMES.LIMIT_BREACHED,
        new LimitBreachedEvent(
          'dailyLoss',
          absLoss.toNumber(),
          dailyLossLimitUsd.toNumber(),
        ),
      );
      this.logger.log({
        message: 'TRADING HALTED: Daily loss limit breached',
        data: {
          dailyPnl: this.dailyPnl.toString(),
          limit: dailyLossLimitUsd.toString(),
          percentUsed,
        },
      });
    } else if (
      percentUsed >= 0.8 &&
      percentUsed < 1.0 &&
      !this.dailyLossApproachEmitted
    ) {
      this.dailyLossApproachEmitted = true;
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

    await this.persistState();
  }

  isTradingHalted(): boolean {
    return this.tradingHalted;
  }

  @Cron('0 0 0 * * *', { timeZone: 'UTC' })
  async handleMidnightReset(): Promise<void> {
    const previousPnl = this.dailyPnl.toString();
    this.dailyPnl = new FinancialDecimal(0);
    const todayMidnight = new Date();
    todayMidnight.setUTCHours(0, 0, 0, 0);
    this.lastResetTimestamp = todayMidnight;
    this.dailyLossApproachEmitted = false;

    if (this.haltReason === HALT_REASONS.DAILY_LOSS_LIMIT) {
      this.tradingHalted = false;
      this.haltReason = null;
      this.logger.log({ message: 'Trading halt cleared by midnight reset' });
    }

    this.logger.log({
      message: 'Daily P&L reset at UTC midnight',
      data: { previousDayPnl: previousPnl, newDailyPnl: '0' },
    });

    await this.persistState();
  }

  getCurrentExposure(): RiskExposure {
    const bankrollUsd = new FinancialDecimal(this.config.bankrollUsd);
    const dailyLossLimitUsd = new FinancialDecimal(this.config.bankrollUsd).mul(
      new FinancialDecimal(this.config.dailyLossPct),
    );
    return {
      openPairCount: this.openPositionCount,
      totalCapitalDeployed: this.totalCapitalDeployed,
      bankrollUsd,
      availableCapital: bankrollUsd.minus(this.totalCapitalDeployed),
      dailyPnl: this.dailyPnl,
      dailyLossLimitUsd,
    };
  }

  getOpenPositionCount(): number {
    return this.openPositionCount;
  }
}
