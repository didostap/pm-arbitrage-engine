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
} from '../../common/events';
import { FinancialDecimal } from '../../common/utils/financial-math';
import { PrismaService } from '../../common/prisma.service';
import {
  RiskLimitError,
  RISK_ERROR_CODES,
} from '../../common/errors/risk-limit-error';
import { randomUUID } from 'crypto';

export const HALT_REASONS = {
  DAILY_LOSS_LIMIT: 'daily_loss_limit',
  RECONCILIATION_DISCREPANCY: 'reconciliation_discrepancy',
} as const;
export type HaltReason = (typeof HALT_REASONS)[keyof typeof HALT_REASONS];

@Injectable()
export class RiskManagerService implements IRiskManager, OnModuleInit {
  private readonly logger = new Logger(RiskManagerService.name);
  private config!: RiskConfig;
  private openPositionCount = 0;
  private totalCapitalDeployed = new FinancialDecimal(0);
  private dailyPnl = new FinancialDecimal(0);
  private activeHaltReasons = new Set<HaltReason>();
  private dailyLossApproachEmitted = false;
  private lastResetTimestamp: Date | null = null;
  private reservations = new Map<string, BudgetReservation>();

  constructor(
    private readonly configService: ConfigService,
    private readonly eventEmitter: EventEmitter2,
    private readonly prisma: PrismaService,
  ) {}

  async onModuleInit(): Promise<void> {
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

      // Restore halt reasons from DB
      this.activeHaltReasons = new Set<HaltReason>();
      if (state.haltReason) {
        try {
          const parsed: unknown = JSON.parse(state.haltReason);
          if (Array.isArray(parsed)) {
            for (const r of parsed) {
              if (typeof r === 'string') {
                this.activeHaltReasons.add(r as HaltReason);
              }
            }
          } else if (typeof parsed === 'string' && parsed.length > 0) {
            // Legacy single-string format
            this.activeHaltReasons.add(parsed as HaltReason);
          }
        } catch {
          // Legacy single-string format (not JSON)
          if (
            typeof state.haltReason === 'string' &&
            state.haltReason.length > 0
          ) {
            this.activeHaltReasons.add(state.haltReason as HaltReason);
          }
        }
      }

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
          this.activeHaltReasons.delete(HALT_REASONS.DAILY_LOSS_LIMIT);
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
            this.activeHaltReasons.add(HALT_REASONS.DAILY_LOSS_LIMIT);
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
          this.activeHaltReasons.delete(HALT_REASONS.DAILY_LOSS_LIMIT);
          await this.persistState();
        }
      }

      this.logger.log({
        message: 'Risk state restored from database',
        data: {
          openPositionCount: this.openPositionCount,
          totalCapitalDeployed: this.totalCapitalDeployed.toString(),
          dailyPnl: this.dailyPnl.toString(),
          tradingHalted: this.isTradingHalted(),
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
      const reservedPositionSlots = this.getReservedPositionSlots();
      const reservedCapital = this.getReservedCapital().toFixed();
      const tradingHalted = this.isTradingHalted();
      const haltReason = JSON.stringify([...this.activeHaltReasons]);
      await this.prisma.riskState.upsert({
        where: { singletonKey: 'default' },
        update: {
          openPositionCount: this.openPositionCount,
          totalCapitalDeployed: this.totalCapitalDeployed.toFixed(),
          dailyPnl: this.dailyPnl.toFixed(),
          lastResetTimestamp: this.lastResetTimestamp,
          tradingHalted,
          haltReason,
          reservedCapital,
          reservedPositionSlots,
        },
        create: {
          singletonKey: 'default',
          openPositionCount: this.openPositionCount,
          totalCapitalDeployed: this.totalCapitalDeployed.toFixed(),
          dailyPnl: this.dailyPnl.toFixed(),
          lastResetTimestamp: this.lastResetTimestamp,
          tradingHalted,
          haltReason,
          reservedCapital,
          reservedPositionSlots,
        },
      });
    } catch (error) {
      this.logger.error({
        message: 'Failed to persist risk state to database',
        data: {
          operation: 'persistState',
          dailyPnl: this.dailyPnl.toString(),
          tradingHalted: this.isTradingHalted(),
          error: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }

  validatePosition(_opportunity: unknown): Promise<RiskDecision> {
    // FIRST: Check daily loss halt (Story 4.2) — before any other computation
    if (this.isTradingHalted()) {
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

    // Check max open pairs limit (including reserved slots)
    const effectiveOpenPairs =
      this.openPositionCount + this.getReservedPositionSlots();
    if (effectiveOpenPairs >= this.config.maxOpenPairs) {
      this.logger.warn({
        message: 'Opportunity rejected: max open pairs exceeded',
        data: {
          currentOpenPairs: this.openPositionCount,
          reservedSlots: this.getReservedPositionSlots(),
          maxOpenPairs: this.config.maxOpenPairs,
        },
      });
      return Promise.resolve({
        approved: false,
        reason: `Max open pairs limit reached (${effectiveOpenPairs}/${this.config.maxOpenPairs})`,
        maxPositionSizeUsd,
        currentOpenPairs: this.openPositionCount,
      });
    }

    // Check available capital (including reserved capital) — cheap pre-screen
    const bankrollUsd = new FinancialDecimal(this.config.bankrollUsd);
    const reservedCapital = this.getReservedCapital();
    const availableCapital = new FinancialDecimal(
      bankrollUsd.minus(this.totalCapitalDeployed).minus(reservedCapital),
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
      return Promise.resolve({
        approved: false,
        reason: `Insufficient available capital (${availableCapital.toFixed(2)} < ${maxPositionSizeUsd.toFixed(2)})`,
        maxPositionSizeUsd,
        currentOpenPairs: this.openPositionCount,
      });
    }

    // Check if approaching limit (80% threshold)
    const approachThreshold = Math.floor(this.config.maxOpenPairs * 0.8);
    if (effectiveOpenPairs >= approachThreshold) {
      const percentUsed = (effectiveOpenPairs / this.config.maxOpenPairs) * 100;
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

  private determineRejectionReason(): string | null {
    const effectiveOpenPairs =
      this.openPositionCount + this.getReservedPositionSlots();
    if (effectiveOpenPairs >= this.config.maxOpenPairs) {
      return `Max open pairs limit reached (${effectiveOpenPairs}/${this.config.maxOpenPairs})`;
    }
    // Position sizing is always a potential rejection for override context
    return 'Position sizing limit';
  }

  async processOverride(
    opportunityId: string,
    rationale: string,
  ): Promise<RiskDecision> {
    // FIRST: Check if daily loss halt is active — cannot be overridden
    if (
      this.isTradingHalted() &&
      this.activeHaltReasons.has(HALT_REASONS.DAILY_LOSS_LIMIT)
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
        currentOpenPairs: this.openPositionCount,
        dailyPnl: this.dailyPnl,
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
      currentOpenPairs: this.openPositionCount,
      dailyPnl: this.dailyPnl,
      overrideApplied: true,
      overrideRationale: rationale,
    };
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

    if (
      percentUsed >= 1.0 &&
      !this.activeHaltReasons.has(HALT_REASONS.DAILY_LOSS_LIMIT)
    ) {
      this.haltTrading(HALT_REASONS.DAILY_LOSS_LIMIT);
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
    return this.activeHaltReasons.size > 0;
  }

  haltTrading(reason: string): void {
    const haltReason = reason as HaltReason;
    if (this.activeHaltReasons.has(haltReason)) {
      return; // Already halted for this reason
    }
    this.activeHaltReasons.add(haltReason);
    this.eventEmitter.emit(
      EVENT_NAMES.SYSTEM_TRADING_HALTED,
      new TradingHaltedEvent(
        reason,
        { activeReasons: [...this.activeHaltReasons] },
        new Date(),
        'critical',
      ),
    );
    this.logger.log({
      message: `Trading halted: ${reason}`,
      data: { reason, activeReasons: [...this.activeHaltReasons] },
    });
    void this.persistState();
  }

  resumeTrading(reason: string): void {
    const haltReason = reason as HaltReason;
    if (!this.activeHaltReasons.has(haltReason)) {
      return; // Not halted for this reason
    }
    this.activeHaltReasons.delete(haltReason);
    const remaining = [...this.activeHaltReasons];
    this.eventEmitter.emit(
      EVENT_NAMES.SYSTEM_TRADING_RESUMED,
      new TradingResumedEvent(reason, remaining, new Date()),
    );
    this.logger.log({
      message: `Halt reason removed: ${reason}`,
      data: {
        removedReason: reason,
        remainingReasons: remaining,
        tradingResumed: this.activeHaltReasons.size === 0,
      },
    });
    void this.persistState();
  }

  async recalculateFromPositions(
    openCount: number,
    capitalDeployed: Decimal,
  ): Promise<void> {
    const previousCount = this.openPositionCount;
    const previousCapital = this.totalCapitalDeployed.toString();

    this.openPositionCount = openCount;
    this.totalCapitalDeployed = new FinancialDecimal(capitalDeployed);

    this.logger.log({
      message: 'Risk state recalculated from reconciliation',
      data: {
        previousOpenCount: previousCount,
        newOpenCount: openCount,
        previousCapitalDeployed: previousCapital,
        newCapitalDeployed: this.totalCapitalDeployed.toString(),
      },
    });

    await this.persistState();
  }

  @Cron('0 0 0 * * *', { timeZone: 'UTC' })
  async handleMidnightReset(): Promise<void> {
    const previousPnl = this.dailyPnl.toString();
    this.dailyPnl = new FinancialDecimal(0);
    const todayMidnight = new Date();
    todayMidnight.setUTCHours(0, 0, 0, 0);
    this.lastResetTimestamp = todayMidnight;
    this.dailyLossApproachEmitted = false;

    if (this.activeHaltReasons.has(HALT_REASONS.DAILY_LOSS_LIMIT)) {
      this.resumeTrading(HALT_REASONS.DAILY_LOSS_LIMIT);
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
    const reserved: Decimal = this.getReservedCapital();
    return {
      openPairCount: this.openPositionCount + this.getReservedPositionSlots(),
      totalCapitalDeployed: new FinancialDecimal(
        this.totalCapitalDeployed.add(reserved),
      ),
      bankrollUsd,
      availableCapital: new FinancialDecimal(
        bankrollUsd.minus(this.totalCapitalDeployed).minus(reserved),
      ),
      dailyPnl: this.dailyPnl,
      dailyLossLimitUsd,
    };
  }

  getOpenPositionCount(): number {
    return this.openPositionCount;
  }

  async reserveBudget(request: ReservationRequest): Promise<BudgetReservation> {
    // Check halt
    if (this.isTradingHalted()) {
      throw new RiskLimitError(
        RISK_ERROR_CODES.BUDGET_RESERVATION_FAILED,
        'Budget reservation failed: trading halted',
        'error',
        'budget_reservation',
        0,
        0,
      );
    }

    const maxPositionSizeUsd = new FinancialDecimal(
      this.config.bankrollUsd,
    ).mul(new FinancialDecimal(this.config.maxPositionPct));

    // Use the lesser of recommended size and config max — avoid over-reserving
    const reserveAmount = request.recommendedPositionSizeUsd.lte(
      maxPositionSizeUsd,
    )
      ? new FinancialDecimal(request.recommendedPositionSizeUsd)
      : maxPositionSizeUsd;

    // Check max open pairs (including reserved slots)
    const effectiveOpenPairs =
      this.openPositionCount + this.getReservedPositionSlots();
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

    // Check available capital (including reserved capital)
    const bankrollUsd = new FinancialDecimal(this.config.bankrollUsd);
    const availableCapital = new FinancialDecimal(
      bankrollUsd
        .minus(this.totalCapitalDeployed)
        .minus(this.getReservedCapital()),
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
      reservationId: randomUUID(),
      opportunityId: request.opportunityId,
      reservedPositionSlots: 1,
      reservedCapitalUsd: reserveAmount,
      correlationExposure: new FinancialDecimal(0),
      createdAt: new Date(),
    };

    this.reservations.set(reservation.reservationId, reservation);

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
        reservedCapitalUsd: maxPositionSizeUsd.toString(),
      },
    });

    await this.persistState();
    return reservation;
  }

  async commitReservation(reservationId: string): Promise<void> {
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

    // Move reservation to permanent state
    this.openPositionCount += reservation.reservedPositionSlots;
    this.totalCapitalDeployed = new FinancialDecimal(
      this.totalCapitalDeployed.add(
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
        newOpenPositionCount: this.openPositionCount,
        newTotalCapitalDeployed: this.totalCapitalDeployed.toString(),
      },
    });

    await this.persistState();
  }

  async releaseReservation(reservationId: string): Promise<void> {
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

    await this.persistState();
  }

  async closePosition(
    capitalReturned: unknown,
    pnlDelta: unknown,
  ): Promise<void> {
    const capital = new FinancialDecimal(capitalReturned as Decimal);
    const pnl = new FinancialDecimal(pnlDelta as Decimal);

    this.openPositionCount = Math.max(0, this.openPositionCount - 1);
    this.totalCapitalDeployed = new FinancialDecimal(
      this.totalCapitalDeployed.minus(capital),
    );
    if (this.totalCapitalDeployed.isNegative()) {
      this.totalCapitalDeployed = new FinancialDecimal(0);
    }

    this.eventEmitter.emit(
      EVENT_NAMES.BUDGET_RELEASED,
      new BudgetReleasedEvent(
        'position-close',
        'position-close',
        capital.toString(),
      ),
    );

    this.logger.log({
      message: 'Position closed — budget released',
      data: {
        capitalReturned: capital.toString(),
        pnlDelta: pnl.toString(),
        newOpenPositionCount: this.openPositionCount,
        newTotalCapitalDeployed: this.totalCapitalDeployed.toString(),
      },
    });

    await this.updateDailyPnl(pnl);
    await this.persistState();
  }

  private getReservedPositionSlots(): number {
    let total = 0;
    for (const reservation of this.reservations.values()) {
      total += reservation.reservedPositionSlots;
    }
    return total;
  }

  private getReservedCapital(): Decimal {
    let total: Decimal = new FinancialDecimal(0);
    for (const reservation of this.reservations.values()) {
      total = total.add(new FinancialDecimal(reservation.reservedCapitalUsd));
    }
    return total;
  }
}
