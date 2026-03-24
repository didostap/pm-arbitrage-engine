import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import Decimal from 'decimal.js';
import {
  BudgetReservation,
  ReservationRequest,
} from '../../common/types/risk.type';
import {
  EVENT_NAMES,
  BudgetReservedEvent,
  BudgetCommittedEvent,
  BudgetReleasedEvent,
} from '../../common/events';
import { FinancialDecimal } from '../../common/utils/financial-math';
import { PrismaService } from '../../common/prisma.service';
import {
  RiskLimitError,
  RISK_ERROR_CODES,
} from '../../common/errors/risk-limit-error';
import { randomUUID } from 'crypto';
import {
  asReservationId,
  asOpportunityId,
  type PairId,
  type ReservationId,
} from '../../common/types/branded.type';
import { RiskStateManager } from './risk-state-manager.service';
import { TradingHaltService } from './trading-halt.service';

@Injectable()
export class BudgetReservationService implements OnModuleInit {
  private readonly logger = new Logger(BudgetReservationService.name);
  /** Cleanup: .delete() on release/commit, .clear() on stale reservation sweep */
  private reservations = new Map<string, BudgetReservation>();
  /** Cleanup: .delete() on position close */
  private paperActivePairIds = new Set<string>();

  constructor(
    private readonly eventEmitter: EventEmitter2,
    private readonly prisma: PrismaService,
    private readonly riskStateManager: RiskStateManager,
    private readonly haltService: TradingHaltService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.clearStaleReservations();
    await this.restorePaperActivePairIds();
    this.riskStateManager.registerReservationDataProvider(
      (isPaper: boolean) => ({
        slots: this.getReservedPositionSlots(isPaper),
        capital: this.getReservedCapital(isPaper).toFixed(),
      }),
    );
  }

  private async clearStaleReservations(): Promise<void> {
    this.reservations.clear();
    try {
      await this.prisma.riskState.updateMany({
        where: { singletonKey: 'default' },
        data: { reservedCapital: '0', reservedPositionSlots: 0 },
      });
      this.logger.log({ message: 'Stale reservations cleared on startup' });
    } catch (error) {
      this.logger.error({
        message: 'Failed to clear stale reservations on startup',
        data: { error: error instanceof Error ? error.message : String(error) },
      });
    }
  }

  private async restorePaperActivePairIds(): Promise<void> {
    const openPaperPositions = await this.prisma.openPosition.findMany({
      where: { isPaper: true, status: { not: 'CLOSED' } },
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

  getReservedPositionSlots(isPaper?: boolean): number {
    let total = 0;
    for (const r of this.reservations.values()) {
      if (isPaper === undefined || r.isPaper === isPaper)
        total += r.reservedPositionSlots;
    }
    return total;
  }

  getReservedCapital(isPaper?: boolean): Decimal {
    let total: Decimal = new FinancialDecimal(0);
    for (const r of this.reservations.values()) {
      if (isPaper === undefined || r.isPaper === isPaper)
        total = total.add(new FinancialDecimal(r.reservedCapitalUsd));
    }
    return total;
  }

  async reserveBudget(request: ReservationRequest): Promise<BudgetReservation> {
    const state = this.riskStateManager.getState(request.isPaper);
    const bankroll = this.riskStateManager.getBankrollForMode(request.isPaper);
    const config = this.riskStateManager.getConfig();
    // Check halt (live only)
    if (!request.isPaper && this.haltService.isTradingHalted(false)) {
      throw new RiskLimitError(
        RISK_ERROR_CODES.BUDGET_RESERVATION_FAILED,
        'Budget reservation failed: trading halted',
        'error',
        'budget_reservation',
        0,
        0,
      );
    }
    // Paper mode dedup
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
      new FinancialDecimal(config.maxPositionPct),
    );
    const reserveAmount = request.recommendedPositionSizeUsd.lte(
      maxPositionSizeUsd,
    )
      ? new FinancialDecimal(request.recommendedPositionSizeUsd)
      : maxPositionSizeUsd;
    // Check max open pairs (including mode-filtered reserved slots)
    const effectiveOpenPairs =
      state.openPositionCount + this.getReservedPositionSlots(request.isPaper);
    if (effectiveOpenPairs >= config.maxOpenPairs) {
      throw new RiskLimitError(
        RISK_ERROR_CODES.BUDGET_RESERVATION_FAILED,
        `Budget reservation failed: max open pairs reached (${effectiveOpenPairs}/${config.maxOpenPairs})`,
        'error',
        'budget_reservation',
        effectiveOpenPairs,
        config.maxOpenPairs,
      );
    }
    // Check available capital
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
    if (request.isPaper) this.paperActivePairIds.add(request.pairId);
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
    await this.riskStateManager.persistState(
      request.isPaper ? 'paper' : 'live',
    );
    return reservation;
  }

  async commitReservation(reservationId: ReservationId): Promise<void> {
    const reservation = this.reservations.get(reservationId);
    if (!reservation)
      throw new RiskLimitError(
        RISK_ERROR_CODES.BUDGET_RESERVATION_FAILED,
        `Cannot commit reservation: ${reservationId} not found`,
        'error',
        'budget_reservation',
        0,
        0,
      );
    this.riskStateManager.incrementOpenPositions(
      reservation.reservedPositionSlots,
      new FinancialDecimal(reservation.reservedCapitalUsd),
      reservation.isPaper,
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
    const state = this.riskStateManager.getState(reservation.isPaper);
    this.logger.log({
      message: 'Budget reservation committed',
      data: {
        reservationId,
        opportunityId: reservation.opportunityId,
        newOpenPositionCount: state.openPositionCount,
        newTotalCapitalDeployed: state.totalCapitalDeployed.toString(),
      },
    });
    await this.riskStateManager.persistState(
      reservation.isPaper ? 'paper' : 'live',
    );
  }

  async releaseReservation(reservationId: ReservationId): Promise<void> {
    const reservation = this.reservations.get(reservationId);
    if (!reservation)
      throw new RiskLimitError(
        RISK_ERROR_CODES.BUDGET_RESERVATION_FAILED,
        `Cannot release reservation: ${reservationId} not found`,
        'error',
        'budget_reservation',
        0,
        0,
      );
    if (reservation.isPaper) this.paperActivePairIds.delete(reservation.pairId);
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
    await this.riskStateManager.persistState(
      reservation.isPaper ? 'paper' : 'live',
    );
  }

  async adjustReservation(
    reservationId: ReservationId,
    newCapitalUsd: Decimal,
  ): Promise<void> {
    const reservation = this.reservations.get(reservationId);
    if (!reservation)
      throw new RiskLimitError(
        RISK_ERROR_CODES.BUDGET_RESERVATION_FAILED,
        `Cannot adjust reservation: ${reservationId} not found`,
        'error',
        'budget_reservation',
        0,
        0,
      );
    const oldCapital = new FinancialDecimal(reservation.reservedCapitalUsd);
    const newCapital = new FinancialDecimal(newCapitalUsd);
    if (newCapital.gte(oldCapital)) return;
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
    await this.riskStateManager.persistState(
      reservation.isPaper ? 'paper' : 'live',
    );
  }

  async closePosition(
    capitalReturned: unknown,
    pnlDelta: unknown,
    pairId?: PairId,
    isPaper = false,
  ): Promise<void> {
    if (isPaper && pairId) {
      this.paperActivePairIds.delete(pairId);
    } else if (isPaper && this.paperActivePairIds.size > 0) {
      this.logger.warn({
        message:
          'closePosition called without pairId while paper pairs are tracked — potential Set leak if closing a paper position',
        module: 'risk-management',
        data: { trackedPairCount: this.paperActivePairIds.size },
      });
    }
    const capital = new FinancialDecimal(capitalReturned as Decimal);
    const pnl = new FinancialDecimal(pnlDelta as Decimal);
    this.riskStateManager.decrementOpenPositions(capital, isPaper);
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
        newOpenPositionCount:
          this.riskStateManager.getState(isPaper).openPositionCount,
        newTotalCapitalDeployed: this.riskStateManager
          .getState(isPaper)
          .totalCapitalDeployed.toString(),
      },
    });
    await this.riskStateManager.updateDailyPnl(pnl, isPaper, true);
    await this.riskStateManager.persistState(isPaper ? 'paper' : 'live');
  }

  async releasePartialCapital(
    capitalReleased: unknown,
    realizedPnl: unknown,
    _pairId?: string,
    isPaper = false,
  ): Promise<void> {
    const capital = new FinancialDecimal(capitalReleased as Decimal);
    const pnl = new FinancialDecimal(realizedPnl as Decimal);
    this.riskStateManager.adjustCapitalDeployed(capital, isPaper);
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
        openPositionCount:
          this.riskStateManager.getState(isPaper).openPositionCount,
        newTotalCapitalDeployed: this.riskStateManager
          .getState(isPaper)
          .totalCapitalDeployed.toString(),
      },
    });
    await this.riskStateManager.updateDailyPnl(pnl, isPaper, true);
    await this.riskStateManager.persistState(isPaper ? 'paper' : 'live');
  }
}
