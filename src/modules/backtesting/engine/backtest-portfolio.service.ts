import { Injectable } from '@nestjs/common';
import Decimal from 'decimal.js';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type { BacktestExitReason } from '@prisma/client';
import { calculateLegPnl } from '../../../common/utils/financial-math';
import { EVENT_NAMES } from '../../../common/events/event-catalog';
import {
  BacktestPositionOpenedEvent,
  BacktestPositionClosedEvent,
} from '../../../common/events/backtesting.events';
import type {
  SimulatedPosition,
  BacktestPortfolioState,
} from '../types/simulation.types';

export interface ClosePositionParams {
  exitTimestamp: Date;
  exitReason: string;
  kalshiExitPrice: Decimal;
  polymarketExitPrice: Decimal;
  exitEdge: Decimal;
}

interface PositionPriceUpdate {
  kalshiCurrentPrice: Decimal;
  polymarketCurrentPrice: Decimal;
}

export interface AggregateMetrics {
  totalPositions: number;
  winCount: number;
  lossCount: number;
  totalPnl: Decimal;
  maxDrawdown: Decimal;
  sharpeRatio: Decimal | null;
  profitFactor: Decimal | null;
  avgHoldingHours: Decimal;
  capitalUtilization: Decimal;
}

interface RunningAccumulators {
  totalPositions: number;
  winCount: number;
  lossCount: number;
  grossWin: Decimal;
  grossLoss: Decimal;
  totalHoldingHours: Decimal;
  /** Cleanup: keyed by ISO date string, accumulates daily P&L for Sharpe ratio. Bounded by backtest date range (max ~365 entries/year). */
  dailyPnl: Map<string, Decimal>;
}

interface RunContext {
  state: BacktestPortfolioState;
  bankroll: Decimal;
  /** Cleanup: entry created on openPosition/closePosition, cleared on destroyRun. Bounded by position count per run. */
  capitalSnapshots: Array<{ timestamp: Date; deployed: Decimal }>;
  /** Running accumulators — updated on every closePosition, survive flushClosedPositions */
  accumulators: RunningAccumulators;
}

const CAPITAL_SNAPSHOT_INTERVAL_MS = 3_600_000; // 1 hour

@Injectable()
export class BacktestPortfolioService {
  /** Cleanup: .delete(runId) on destroyRun, .clear() on onModuleDestroy or test reset */
  private readonly runs = new Map<string, RunContext>();

  constructor(private readonly eventEmitter: EventEmitter2) {}

  private maybeAddSnapshot(
    ctx: RunContext,
    timestamp: Date,
    deployed: Decimal,
  ): void {
    if (ctx.capitalSnapshots.length === 0) {
      ctx.capitalSnapshots.push({ timestamp, deployed });
      return;
    }
    const last = ctx.capitalSnapshots[ctx.capitalSnapshots.length - 1]!;
    if (
      timestamp.getTime() - last.timestamp.getTime() >=
      CAPITAL_SNAPSHOT_INTERVAL_MS
    ) {
      ctx.capitalSnapshots.push({ timestamp, deployed });
    }
  }

  private getRunContext(runId: string): RunContext {
    const ctx = this.runs.get(runId);
    if (!ctx) {
      throw new Error(
        `BacktestPortfolioService: run ${runId} not initialized. Call initialize() first.`,
      );
    }
    return ctx;
  }

  initialize(bankroll: Decimal, runId: string): void {
    if (bankroll.lte(0)) {
      throw new Error('bankrollUsd must be positive');
    }
    this.runs.set(runId, {
      state: {
        availableCapital: bankroll,
        deployedCapital: new Decimal(0),
        /** Cleanup: .delete() on closePosition, .clear() on reset */
        openPositions: new Map<string, SimulatedPosition>(),
        closedPositions: [],
        peakEquity: bankroll,
        currentEquity: bankroll,
        realizedPnl: new Decimal(0),
        maxDrawdown: new Decimal(0),
      },
      bankroll,
      capitalSnapshots: [],
      accumulators: {
        totalPositions: 0,
        winCount: 0,
        lossCount: 0,
        grossWin: new Decimal(0),
        grossLoss: new Decimal(0),
        totalHoldingHours: new Decimal(0),
        dailyPnl: new Map(),
      },
    });
  }

  openPosition(runId: string, position: SimulatedPosition): boolean {
    const ctx = this.getRunContext(runId);
    if (ctx.state.availableCapital.lt(position.positionSizeUsd)) {
      return false;
    }

    ctx.state.availableCapital = ctx.state.availableCapital.minus(
      position.positionSizeUsd,
    );
    ctx.state.deployedCapital = ctx.state.deployedCapital.plus(
      position.positionSizeUsd,
    );
    ctx.state.openPositions.set(position.positionId, position);

    this.maybeAddSnapshot(
      ctx,
      position.entryTimestamp,
      ctx.state.deployedCapital,
    );

    this.eventEmitter.emit(
      EVENT_NAMES.BACKTEST_POSITION_OPENED,
      new BacktestPositionOpenedEvent({
        runId,
        positionId: position.positionId,
        pairId: position.pairId,
        entryEdge: position.entryEdge.toString(),
        positionSizeUsd: position.positionSizeUsd.toString(),
      }),
    );

    return true;
  }

  closePosition(
    runId: string,
    positionId: string,
    params: ClosePositionParams,
  ): void {
    const ctx = this.getRunContext(runId);
    const position = ctx.state.openPositions.get(positionId);
    if (!position) return;

    // Calculate realized P&L for both legs
    const kalshiPnl = calculateLegPnl(
      position.kalshiSide.toLowerCase(),
      position.kalshiEntryPrice,
      params.kalshiExitPrice,
      position.positionSizeUsd,
    );
    const polyPnl = calculateLegPnl(
      position.polymarketSide.toLowerCase(),
      position.polymarketEntryPrice,
      params.polymarketExitPrice,
      position.positionSizeUsd,
    );
    const realizedPnl = kalshiPnl.plus(polyPnl);

    const holdingMs =
      params.exitTimestamp.getTime() - position.entryTimestamp.getTime();
    const holdingHours = new Decimal(Math.max(0, holdingMs)).div(
      1000 * 60 * 60,
    );

    // Update position with exit data
    const closedPosition: SimulatedPosition = {
      ...position,
      exitTimestamp: params.exitTimestamp,
      exitReason: params.exitReason as BacktestExitReason,
      kalshiExitPrice: params.kalshiExitPrice,
      polymarketExitPrice: params.polymarketExitPrice,
      exitEdge: params.exitEdge,
      realizedPnl,
      holdingHours,
      fees: null,
    };

    // Release capital
    ctx.state.openPositions.delete(positionId);
    ctx.state.deployedCapital = ctx.state.deployedCapital.minus(
      position.positionSizeUsd,
    );
    ctx.state.availableCapital = ctx.state.availableCapital
      .plus(position.positionSizeUsd)
      .plus(realizedPnl);
    ctx.state.realizedPnl = ctx.state.realizedPnl.plus(realizedPnl);
    ctx.state.closedPositions.push(closedPosition);

    // Update running accumulators (survive flush)
    ctx.accumulators.totalPositions++;
    if (realizedPnl.gt(0)) {
      ctx.accumulators.winCount++;
      ctx.accumulators.grossWin = ctx.accumulators.grossWin.plus(realizedPnl);
    } else if (realizedPnl.lt(0)) {
      ctx.accumulators.lossCount++;
      ctx.accumulators.grossLoss = ctx.accumulators.grossLoss.plus(
        realizedPnl.abs(),
      );
    }
    ctx.accumulators.totalHoldingHours =
      ctx.accumulators.totalHoldingHours.plus(holdingHours);
    // Track daily P&L for Sharpe ratio (survives flush)
    const exitDay = params.exitTimestamp.toISOString().slice(0, 10);
    const existing = ctx.accumulators.dailyPnl.get(exitDay) ?? new Decimal(0);
    ctx.accumulators.dailyPnl.set(exitDay, existing.plus(realizedPnl));

    this.maybeAddSnapshot(ctx, params.exitTimestamp, ctx.state.deployedCapital);

    // Update equity and drawdown
    this.updateDrawdown(ctx);

    this.eventEmitter.emit(
      EVENT_NAMES.BACKTEST_POSITION_CLOSED,
      new BacktestPositionClosedEvent({
        runId,
        positionId,
        pairId: position.pairId,
        exitReason: String(params.exitReason),
        realizedPnl: realizedPnl.toString(),
        holdingHours: holdingHours.toFixed(2),
      }),
    );
  }

  updateEquity(
    runId: string,
    priceUpdates: Map<string, PositionPriceUpdate>,
  ): void {
    const ctx = this.getRunContext(runId);
    let unrealizedPnl = new Decimal(0);

    for (const [positionId, position] of ctx.state.openPositions) {
      const update = priceUpdates.get(positionId);
      if (!update) continue;

      const kalshiUnrealized = calculateLegPnl(
        position.kalshiSide.toLowerCase(),
        position.kalshiEntryPrice,
        update.kalshiCurrentPrice,
        position.positionSizeUsd,
      );
      const polyUnrealized = calculateLegPnl(
        position.polymarketSide.toLowerCase(),
        position.polymarketEntryPrice,
        update.polymarketCurrentPrice,
        position.positionSizeUsd,
      );
      unrealizedPnl = unrealizedPnl.plus(kalshiUnrealized).plus(polyUnrealized);
    }

    ctx.state.currentEquity = ctx.state.availableCapital
      .plus(ctx.state.deployedCapital)
      .plus(unrealizedPnl);

    if (ctx.state.currentEquity.gt(ctx.state.peakEquity)) {
      ctx.state.peakEquity = ctx.state.currentEquity;
    }
    if (ctx.state.peakEquity.gt(0)) {
      const drawdown = ctx.state.peakEquity
        .minus(ctx.state.currentEquity)
        .div(ctx.state.peakEquity);
      if (drawdown.gt(ctx.state.maxDrawdown)) {
        ctx.state.maxDrawdown = drawdown;
      }
    }
  }

  /**
   * Force-push a final capital snapshot (ignores interval check).
   * Must be called before getAggregateMetrics to close the last utilization period.
   */
  addFinalSnapshot(runId: string, endTimestamp: Date): void {
    const ctx = this.getRunContext(runId);
    ctx.capitalSnapshots.push({
      timestamp: endTimestamp,
      deployed: ctx.state.deployedCapital,
    });
  }

  getAggregateMetrics(runId: string): AggregateMetrics {
    const ctx = this.getRunContext(runId);
    const {
      totalPositions,
      winCount,
      lossCount,
      grossWin,
      grossLoss,
      totalHoldingHours,
    } = ctx.accumulators;

    const totalPnl = grossWin.minus(grossLoss);
    const avgHoldingHours =
      totalPositions > 0
        ? totalHoldingHours.div(totalPositions)
        : new Decimal(0);

    // Profit factor
    const profitFactor = grossLoss.gt(0) ? grossWin.div(grossLoss) : null;

    // Sharpe ratio: mean(dailyReturns) / stddev(dailyReturns) * sqrt(252)
    const sharpeRatio = this.calculateSharpeRatioFromAccumulators(ctx);

    // Capital utilization: time-weighted average deployed / bankroll
    const capitalUtilization = this.calculateCapitalUtilization(ctx);

    return {
      totalPositions,
      winCount,
      lossCount,
      totalPnl,
      maxDrawdown: ctx.state.maxDrawdown,
      sharpeRatio,
      profitFactor,
      avgHoldingHours,
      capitalUtilization,
    };
  }

  /**
   * Returns a shallow copy of closedPositions for batch DB persistence at chunk boundaries.
   * Does NOT clear — call clearFlushedPositions after successful DB write.
   * Running accumulators (winCount, lossCount, etc.) are NOT affected.
   */
  flushClosedPositions(runId: string): SimulatedPosition[] {
    const ctx = this.getRunContext(runId);
    return [...ctx.state.closedPositions];
  }

  /**
   * Clears closedPositions after successful DB persistence.
   * Must be called after batchWritePositions succeeds.
   */
  clearFlushedPositions(runId: string): void {
    const ctx = this.getRunContext(runId);
    ctx.state.closedPositions = [];
  }

  getState(runId: string): BacktestPortfolioState {
    return this.getRunContext(runId).state;
  }

  destroyRun(runId: string): void {
    this.runs.delete(runId);
  }

  reset(runId: string): void {
    const ctx = this.getRunContext(runId);
    ctx.state.openPositions.clear();
    ctx.state.closedPositions = [];
    ctx.state.availableCapital = ctx.bankroll;
    ctx.state.deployedCapital = new Decimal(0);
    ctx.state.peakEquity = ctx.bankroll;
    ctx.state.currentEquity = ctx.bankroll;
    ctx.state.realizedPnl = new Decimal(0);
    ctx.state.maxDrawdown = new Decimal(0);
    ctx.capitalSnapshots = [];
    ctx.accumulators = {
      totalPositions: 0,
      winCount: 0,
      lossCount: 0,
      grossWin: new Decimal(0),
      grossLoss: new Decimal(0),
      totalHoldingHours: new Decimal(0),
      dailyPnl: new Map(),
    };
  }

  private updateDrawdown(ctx: RunContext): void {
    ctx.state.currentEquity = ctx.state.availableCapital.plus(
      ctx.state.deployedCapital,
    );
    if (ctx.state.currentEquity.gt(ctx.state.peakEquity)) {
      ctx.state.peakEquity = ctx.state.currentEquity;
    }
    if (ctx.state.peakEquity.gt(0)) {
      const drawdown = ctx.state.peakEquity
        .minus(ctx.state.currentEquity)
        .div(ctx.state.peakEquity);
      if (drawdown.gt(ctx.state.maxDrawdown)) {
        ctx.state.maxDrawdown = drawdown;
      }
    }
  }

  private calculateSharpeRatioFromAccumulators(
    ctx: RunContext,
  ): Decimal | null {
    if (ctx.accumulators.totalPositions === 0 || ctx.bankroll.isZero())
      return null;

    const returns = [...ctx.accumulators.dailyPnl.values()].map((r) =>
      r.div(ctx.bankroll),
    );
    if (returns.length <= 1) return null;

    const mean = returns
      .reduce((acc, r) => acc.plus(r), new Decimal(0))
      .div(returns.length);

    const variance = returns
      .reduce((acc, r) => acc.plus(r.minus(mean).pow(2)), new Decimal(0))
      .div(returns.length - 1);

    const stddev = variance.sqrt();
    if (stddev.isZero()) return null;

    return mean.div(stddev).mul(new Decimal(252).sqrt());
  }

  private calculateCapitalUtilization(ctx: RunContext): Decimal {
    if (ctx.bankroll.isZero()) return new Decimal(0);

    if (ctx.capitalSnapshots.length < 2) {
      return ctx.state.deployedCapital.div(ctx.bankroll);
    }

    let weightedSum = new Decimal(0);
    let totalDuration = new Decimal(0);

    for (let i = 0; i < ctx.capitalSnapshots.length - 1; i++) {
      const current = ctx.capitalSnapshots[i];
      const next = ctx.capitalSnapshots[i + 1];
      if (!current || !next) continue;
      const duration = new Decimal(
        next.timestamp.getTime() - current.timestamp.getTime(),
      );
      weightedSum = weightedSum.plus(current.deployed.mul(duration));
      totalDuration = totalDuration.plus(duration);
    }

    if (totalDuration.isZero()) return new Decimal(0);
    return weightedSum.div(totalDuration).div(ctx.bankroll);
  }
}
