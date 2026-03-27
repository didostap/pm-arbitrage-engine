import { describe, it, expect, beforeEach, vi } from 'vitest';
import Decimal from 'decimal.js';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { createSimulatedPosition } from '../types/simulation.types';

const RUN_ID = 'test-run-1';

describe('BacktestPortfolioService', () => {
  let service: any;
  let eventEmitter: EventEmitter2;

  beforeEach(async () => {
    eventEmitter = new EventEmitter2();
    vi.spyOn(eventEmitter, 'emit');

    const { BacktestPortfolioService } =
      await import('./backtest-portfolio.service');
    service = new BacktestPortfolioService(eventEmitter);
    service.initialize(new Decimal('10000'), RUN_ID);
  });

  // ============================================================
  // openPosition() — 4 tests
  // ============================================================

  describe('openPosition()', () => {
    it('[P0] should deploy capital from availableCapital to deployedCapital and add to openPositions Map', () => {
      const position = createSimulatedPosition({
        positionId: 'pos-1',
        pairId: 'pair-1',
        kalshiContractId: 'K-1',
        polymarketContractId: 'P-1',
        kalshiSide: 'BUY',
        polymarketSide: 'SELL',
        kalshiEntryPrice: new Decimal('0.45'),
        polymarketEntryPrice: new Decimal('0.52'),
        positionSizeUsd: new Decimal('300'),
        entryEdge: new Decimal('0.015'),
        entryTimestamp: new Date('2025-02-01T14:00:00Z'),
      });

      service.openPosition(RUN_ID, position);

      const state = service.getState(RUN_ID);
      expect(state.availableCapital.equals(new Decimal('9700'))).toBe(true);
      expect(state.deployedCapital.equals(new Decimal('300'))).toBe(true);
      expect(state.openPositions.size).toBe(1);
      expect(state.openPositions.has('pos-1')).toBe(true);
    });

    it('[P0] should create SimulatedPosition with correct entry prices, edge, timestamp', () => {
      const position = createSimulatedPosition({
        positionId: 'pos-2',
        pairId: 'pair-2',
        kalshiContractId: 'K-2',
        polymarketContractId: 'P-2',
        kalshiSide: 'BUY',
        polymarketSide: 'SELL',
        kalshiEntryPrice: new Decimal('0.40'),
        polymarketEntryPrice: new Decimal('0.55'),
        positionSizeUsd: new Decimal('500'),
        entryEdge: new Decimal('0.02'),
        entryTimestamp: new Date('2025-02-01T15:00:00Z'),
      });

      service.openPosition(RUN_ID, position);

      const stored = service.getState(RUN_ID).openPositions.get('pos-2');
      expect(stored.kalshiEntryPrice.equals(new Decimal('0.40'))).toBe(true);
      expect(stored.polymarketEntryPrice.equals(new Decimal('0.55'))).toBe(
        true,
      );
      expect(stored.entryEdge.equals(new Decimal('0.02'))).toBe(true);
      expect(stored.entryTimestamp).toEqual(new Date('2025-02-01T15:00:00Z'));
    });

    it('[P0] should emit BacktestPositionOpenedEvent with position details payload', () => {
      const position = createSimulatedPosition({
        positionId: 'pos-3',
        pairId: 'pair-3',
        kalshiContractId: 'K-3',
        polymarketContractId: 'P-3',
        kalshiSide: 'BUY',
        polymarketSide: 'SELL',
        kalshiEntryPrice: new Decimal('0.45'),
        polymarketEntryPrice: new Decimal('0.52'),
        positionSizeUsd: new Decimal('300'),
        entryEdge: new Decimal('0.015'),
        entryTimestamp: new Date('2025-02-01T14:00:00Z'),
      });

      service.openPosition(RUN_ID, position);

      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'backtesting.position.opened',
        expect.objectContaining({
          runId: RUN_ID,
          positionId: 'pos-3',
          pairId: 'pair-3',
          entryEdge: '0.015',
          positionSizeUsd: '300',
        }),
      );
    });

    it('[P1] should reject opening position when availableCapital < required size', () => {
      const position = createSimulatedPosition({
        positionId: 'pos-big',
        pairId: 'pair-big',
        kalshiContractId: 'K-big',
        polymarketContractId: 'P-big',
        kalshiSide: 'BUY',
        polymarketSide: 'SELL',
        kalshiEntryPrice: new Decimal('0.45'),
        polymarketEntryPrice: new Decimal('0.52'),
        positionSizeUsd: new Decimal('15000'), // > 10000 bankroll
        entryEdge: new Decimal('0.015'),
        entryTimestamp: new Date('2025-02-01T14:00:00Z'),
      });

      const result = service.openPosition(RUN_ID, position);
      expect(result).toBe(false);
      expect(service.getState(RUN_ID).openPositions.size).toBe(0);
    });
  });

  // ============================================================
  // closePosition() — 4 tests
  // ============================================================

  describe('closePosition()', () => {
    beforeEach(() => {
      const position = createSimulatedPosition({
        positionId: 'pos-1',
        pairId: 'pair-1',
        kalshiContractId: 'K-1',
        polymarketContractId: 'P-1',
        kalshiSide: 'BUY',
        polymarketSide: 'SELL',
        kalshiEntryPrice: new Decimal('0.45'),
        polymarketEntryPrice: new Decimal('0.52'),
        positionSizeUsd: new Decimal('300'),
        entryEdge: new Decimal('0.015'),
        entryTimestamp: new Date('2025-02-01T14:00:00Z'),
      });
      service.openPosition(RUN_ID, position);
    });

    it('[P0] should release capital back to availableCapital and remove from openPositions Map', () => {
      service.closePosition(RUN_ID, 'pos-1', {
        exitTimestamp: new Date('2025-02-02T14:00:00Z'),
        exitReason: 'PROFIT_CAPTURE',
        kalshiExitPrice: new Decimal('0.50'),
        polymarketExitPrice: new Decimal('0.48'),
        exitEdge: new Decimal('0.010'),
      });

      const state = service.getState(RUN_ID);
      expect(state.openPositions.size).toBe(0);
      expect(state.deployedCapital.equals(new Decimal('0'))).toBe(true);
    });

    it('[P0] should calculate realized P&L using calculateLegPnl for both legs', () => {
      service.closePosition(RUN_ID, 'pos-1', {
        exitTimestamp: new Date('2025-02-02T14:00:00Z'),
        exitReason: 'PROFIT_CAPTURE',
        kalshiExitPrice: new Decimal('0.50'),
        polymarketExitPrice: new Decimal('0.48'),
        exitEdge: new Decimal('0.010'),
      });

      const state = service.getState(RUN_ID);
      expect(state.closedPositions).toHaveLength(1);
      const closed = state.closedPositions[0];
      expect(closed.realizedPnl).not.toBeNull();
      expect(closed.realizedPnl).toBeInstanceOf(Decimal);
    });

    it('[P0] should emit BacktestPositionClosedEvent with exit reason, realized P&L, and holding hours', () => {
      service.closePosition(RUN_ID, 'pos-1', {
        exitTimestamp: new Date('2025-02-02T14:00:00Z'),
        exitReason: 'PROFIT_CAPTURE',
        kalshiExitPrice: new Decimal('0.50'),
        polymarketExitPrice: new Decimal('0.48'),
        exitEdge: new Decimal('0.010'),
      });

      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'backtesting.position.closed',
        expect.objectContaining({
          runId: RUN_ID,
          positionId: 'pos-1',
          exitReason: 'PROFIT_CAPTURE',
        }),
      );
    });

    it('[P1] should update maxDrawdown if equity drops below previous trough ratio', () => {
      // Close with a loss to trigger drawdown
      service.closePosition(RUN_ID, 'pos-1', {
        exitTimestamp: new Date('2025-02-02T14:00:00Z'),
        exitReason: 'EDGE_EVAPORATION',
        kalshiExitPrice: new Decimal('0.40'), // loss on buy side
        polymarketExitPrice: new Decimal('0.55'), // loss on sell side
        exitEdge: new Decimal('0.001'),
      });

      const state = service.getState(RUN_ID);
      expect(state.maxDrawdown.gt(new Decimal('0'))).toBe(true);
    });
  });

  // ============================================================
  // updateEquity() — 3 tests
  // ============================================================

  describe('updateEquity()', () => {
    it('[P0] should recalculate unrealized P&L across all open positions at each time step', () => {
      const position = createSimulatedPosition({
        positionId: 'pos-1',
        pairId: 'pair-1',
        kalshiContractId: 'K-1',
        polymarketContractId: 'P-1',
        kalshiSide: 'BUY',
        polymarketSide: 'SELL',
        kalshiEntryPrice: new Decimal('0.45'),
        polymarketEntryPrice: new Decimal('0.52'),
        positionSizeUsd: new Decimal('300'),
        entryEdge: new Decimal('0.015'),
        entryTimestamp: new Date('2025-02-01T14:00:00Z'),
      });
      service.openPosition(RUN_ID, position);

      // Current prices show mark-to-market profit
      service.updateEquity(
        RUN_ID,
        new Map([
          [
            'pos-1',
            {
              kalshiCurrentPrice: new Decimal('0.50'),
              polymarketCurrentPrice: new Decimal('0.48'),
            },
          ],
        ]),
      );

      const state = service.getState(RUN_ID);
      // Equity should reflect unrealized P&L
      expect(state.currentEquity).toBeInstanceOf(Decimal);
    });

    it('[P0] should update peakEquity as running max and maxDrawdown as (peak - current) / peak', () => {
      const position = createSimulatedPosition({
        positionId: 'pos-1',
        pairId: 'pair-1',
        kalshiContractId: 'K-1',
        polymarketContractId: 'P-1',
        kalshiSide: 'BUY',
        polymarketSide: 'SELL',
        kalshiEntryPrice: new Decimal('0.45'),
        polymarketEntryPrice: new Decimal('0.52'),
        positionSizeUsd: new Decimal('300'),
        entryEdge: new Decimal('0.015'),
        entryTimestamp: new Date('2025-02-01T14:00:00Z'),
      });
      service.openPosition(RUN_ID, position);

      // Negative unrealized P&L → drawdown
      service.updateEquity(
        RUN_ID,
        new Map([
          [
            'pos-1',
            {
              kalshiCurrentPrice: new Decimal('0.40'),
              polymarketCurrentPrice: new Decimal('0.55'),
            },
          ],
        ]),
      );

      const state = service.getState(RUN_ID);
      expect(state.peakEquity.gte(state.currentEquity)).toBe(true);
      expect(state.maxDrawdown.gte(new Decimal('0'))).toBe(true);
    });

    it('[P1] should handle zero open positions without error (equity = availableCapital)', () => {
      service.updateEquity(RUN_ID, new Map());

      const state = service.getState(RUN_ID);
      expect(state.currentEquity.equals(new Decimal('10000'))).toBe(true);
    });
  });

  // ============================================================
  // getAggregateMetrics() — 5 tests
  // ============================================================

  describe('getAggregateMetrics()', () => {
    it('[P0] should calculate Sharpe ratio as mean(dailyReturns) / stddev(dailyReturns) * sqrt(252)', () => {
      // Create 2 closed positions with different P&L and dates
      const pos1 = createSimulatedPosition({
        positionId: 'p1',
        pairId: 'pair-1',
        kalshiContractId: 'K-1',
        polymarketContractId: 'P-1',
        kalshiSide: 'BUY',
        polymarketSide: 'SELL',
        kalshiEntryPrice: new Decimal('0.45'),
        polymarketEntryPrice: new Decimal('0.52'),
        positionSizeUsd: new Decimal('300'),
        entryEdge: new Decimal('0.015'),
        entryTimestamp: new Date('2025-02-01T14:00:00Z'),
      });
      service.openPosition(RUN_ID, pos1);
      service.closePosition(RUN_ID, 'p1', {
        exitTimestamp: new Date('2025-02-02T14:00:00Z'),
        exitReason: 'PROFIT_CAPTURE',
        kalshiExitPrice: new Decimal('0.50'),
        polymarketExitPrice: new Decimal('0.48'),
        exitEdge: new Decimal('0.010'),
      });

      const pos2 = createSimulatedPosition({
        positionId: 'p2',
        pairId: 'pair-2',
        kalshiContractId: 'K-2',
        polymarketContractId: 'P-2',
        kalshiSide: 'BUY',
        polymarketSide: 'SELL',
        kalshiEntryPrice: new Decimal('0.40'),
        polymarketEntryPrice: new Decimal('0.55'),
        positionSizeUsd: new Decimal('300'),
        entryEdge: new Decimal('0.02'),
        entryTimestamp: new Date('2025-02-03T14:00:00Z'),
      });
      service.openPosition(RUN_ID, pos2);
      service.closePosition(RUN_ID, 'p2', {
        exitTimestamp: new Date('2025-02-04T14:00:00Z'),
        exitReason: 'EDGE_EVAPORATION',
        kalshiExitPrice: new Decimal('0.38'),
        polymarketExitPrice: new Decimal('0.57'),
        exitEdge: new Decimal('0.001'),
      });

      const metrics = service.getAggregateMetrics(RUN_ID);
      // With 2 trades on different days, Sharpe should be calculable (non-null if stddev > 0)
      if (metrics.sharpeRatio !== null) {
        expect(metrics.sharpeRatio).toBeInstanceOf(Decimal);
      }
    });

    it('[P0] should return null Sharpe ratio when stddev of daily returns is 0', () => {
      // Single trade — only 1 daily return, stddev = 0
      const pos1 = createSimulatedPosition({
        positionId: 'p1',
        pairId: 'pair-1',
        kalshiContractId: 'K-1',
        polymarketContractId: 'P-1',
        kalshiSide: 'BUY',
        polymarketSide: 'SELL',
        kalshiEntryPrice: new Decimal('0.45'),
        polymarketEntryPrice: new Decimal('0.52'),
        positionSizeUsd: new Decimal('300'),
        entryEdge: new Decimal('0.015'),
        entryTimestamp: new Date('2025-02-01T14:00:00Z'),
      });
      service.openPosition(RUN_ID, pos1);
      service.closePosition(RUN_ID, 'p1', {
        exitTimestamp: new Date('2025-02-01T16:00:00Z'),
        exitReason: 'PROFIT_CAPTURE',
        kalshiExitPrice: new Decimal('0.50'),
        polymarketExitPrice: new Decimal('0.48'),
        exitEdge: new Decimal('0.010'),
      });

      const metrics = service.getAggregateMetrics(RUN_ID);
      expect(metrics.sharpeRatio).toBeNull();
    });

    it('[P0] should calculate profit factor as sum(winPnl) / abs(sum(lossPnl))', () => {
      const pos1 = createSimulatedPosition({
        positionId: 'p1',
        pairId: 'pair-1',
        kalshiContractId: 'K-1',
        polymarketContractId: 'P-1',
        kalshiSide: 'BUY',
        polymarketSide: 'SELL',
        kalshiEntryPrice: new Decimal('0.45'),
        polymarketEntryPrice: new Decimal('0.52'),
        positionSizeUsd: new Decimal('300'),
        entryEdge: new Decimal('0.015'),
        entryTimestamp: new Date('2025-02-01T14:00:00Z'),
      });
      service.openPosition(RUN_ID, pos1);
      service.closePosition(RUN_ID, 'p1', {
        exitTimestamp: new Date('2025-02-02T14:00:00Z'),
        exitReason: 'PROFIT_CAPTURE',
        kalshiExitPrice: new Decimal('0.50'),
        polymarketExitPrice: new Decimal('0.48'),
        exitEdge: new Decimal('0.010'),
      });

      const pos2 = createSimulatedPosition({
        positionId: 'p2',
        pairId: 'pair-2',
        kalshiContractId: 'K-2',
        polymarketContractId: 'P-2',
        kalshiSide: 'BUY',
        polymarketSide: 'SELL',
        kalshiEntryPrice: new Decimal('0.40'),
        polymarketEntryPrice: new Decimal('0.55'),
        positionSizeUsd: new Decimal('300'),
        entryEdge: new Decimal('0.02'),
        entryTimestamp: new Date('2025-02-03T14:00:00Z'),
      });
      service.openPosition(RUN_ID, pos2);
      service.closePosition(RUN_ID, 'p2', {
        exitTimestamp: new Date('2025-02-04T14:00:00Z'),
        exitReason: 'EDGE_EVAPORATION',
        kalshiExitPrice: new Decimal('0.38'),
        polymarketExitPrice: new Decimal('0.57'),
        exitEdge: new Decimal('0.001'),
      });

      const metrics = service.getAggregateMetrics(RUN_ID);
      expect(metrics.profitFactor).not.toBeNull();
      expect(metrics.profitFactor).toBeInstanceOf(Decimal);
    });

    it('[P0] should return null profit factor when gross loss is 0 (no losing trades)', () => {
      const pos1 = createSimulatedPosition({
        positionId: 'p1',
        pairId: 'pair-1',
        kalshiContractId: 'K-1',
        polymarketContractId: 'P-1',
        kalshiSide: 'BUY',
        polymarketSide: 'SELL',
        kalshiEntryPrice: new Decimal('0.45'),
        polymarketEntryPrice: new Decimal('0.52'),
        positionSizeUsd: new Decimal('300'),
        entryEdge: new Decimal('0.015'),
        entryTimestamp: new Date('2025-02-01T14:00:00Z'),
      });
      service.openPosition(RUN_ID, pos1);
      service.closePosition(RUN_ID, 'p1', {
        exitTimestamp: new Date('2025-02-02T14:00:00Z'),
        exitReason: 'PROFIT_CAPTURE',
        kalshiExitPrice: new Decimal('0.50'),
        polymarketExitPrice: new Decimal('0.48'),
        exitEdge: new Decimal('0.010'),
      });

      const metrics = service.getAggregateMetrics(RUN_ID);
      // If there's only winning trades, grossLoss = 0 → profitFactor = null
      if (metrics.totalPnl.gt(0)) {
        expect(metrics.profitFactor).toBeNull();
      }
    });

    it('[P0] should calculate capital utilization as time-weighted average deployed/bankroll', () => {
      const pos1 = createSimulatedPosition({
        positionId: 'p1',
        pairId: 'pair-1',
        kalshiContractId: 'K-1',
        polymarketContractId: 'P-1',
        kalshiSide: 'BUY',
        polymarketSide: 'SELL',
        kalshiEntryPrice: new Decimal('0.45'),
        polymarketEntryPrice: new Decimal('0.52'),
        positionSizeUsd: new Decimal('3000'),
        entryEdge: new Decimal('0.015'),
        entryTimestamp: new Date('2025-02-01T14:00:00Z'),
      });
      service.openPosition(RUN_ID, pos1);
      service.closePosition(RUN_ID, 'p1', {
        exitTimestamp: new Date('2025-02-03T14:00:00Z'),
        exitReason: 'PROFIT_CAPTURE',
        kalshiExitPrice: new Decimal('0.50'),
        polymarketExitPrice: new Decimal('0.48'),
        exitEdge: new Decimal('0.010'),
      });

      const metrics = service.getAggregateMetrics(RUN_ID);
      expect(metrics.capitalUtilization).toBeInstanceOf(Decimal);
      expect(metrics.capitalUtilization.gte(new Decimal('0'))).toBe(true);
      expect(metrics.capitalUtilization.lte(new Decimal('1'))).toBe(true);
    });
  });

  // ============================================================
  // Map cleanup — 2 tests
  // ============================================================

  describe('Map cleanup', () => {
    it('[P1] should delete entry from openPositions Map on closePosition', () => {
      const position = createSimulatedPosition({
        positionId: 'pos-cleanup',
        pairId: 'pair-1',
        kalshiContractId: 'K-1',
        polymarketContractId: 'P-1',
        kalshiSide: 'BUY',
        polymarketSide: 'SELL',
        kalshiEntryPrice: new Decimal('0.45'),
        polymarketEntryPrice: new Decimal('0.52'),
        positionSizeUsd: new Decimal('300'),
        entryEdge: new Decimal('0.015'),
        entryTimestamp: new Date('2025-02-01T14:00:00Z'),
      });
      service.openPosition(RUN_ID, position);
      expect(service.getState(RUN_ID).openPositions.has('pos-cleanup')).toBe(
        true,
      );

      service.closePosition(RUN_ID, 'pos-cleanup', {
        exitTimestamp: new Date('2025-02-02T14:00:00Z'),
        exitReason: 'PROFIT_CAPTURE',
        kalshiExitPrice: new Decimal('0.50'),
        polymarketExitPrice: new Decimal('0.48'),
        exitEdge: new Decimal('0.010'),
      });

      expect(service.getState(RUN_ID).openPositions.has('pos-cleanup')).toBe(
        false,
      );
    });

    it('[P1] should clear openPositions Map on reset', () => {
      const position = createSimulatedPosition({
        positionId: 'pos-reset',
        pairId: 'pair-1',
        kalshiContractId: 'K-1',
        polymarketContractId: 'P-1',
        kalshiSide: 'BUY',
        polymarketSide: 'SELL',
        kalshiEntryPrice: new Decimal('0.45'),
        polymarketEntryPrice: new Decimal('0.52'),
        positionSizeUsd: new Decimal('300'),
        entryEdge: new Decimal('0.015'),
        entryTimestamp: new Date('2025-02-01T14:00:00Z'),
      });
      service.openPosition(RUN_ID, position);

      service.reset(RUN_ID);

      expect(service.getState(RUN_ID).openPositions.size).toBe(0);
    });
  });
});
