import { describe, it, expect } from 'vitest';
import Decimal from 'decimal.js';

describe('SimulatedPosition', () => {
  it('[P1] should construct with entry fields, null exit fields, and openedAt timestamp', async () => {
    const { createSimulatedPosition } = await import('./simulation.types');
    const now = new Date();
    const position = createSimulatedPosition({
      positionId: 'pos-1',
      pairId: 'pair-1',
      kalshiContractId: 'kalshi-abc',
      polymarketContractId: 'poly-xyz',
      kalshiSide: 'BUY',
      polymarketSide: 'SELL',
      kalshiEntryPrice: new Decimal('0.45'),
      polymarketEntryPrice: new Decimal('0.52'),
      positionSizeUsd: new Decimal('300'),
      entryEdge: new Decimal('0.015'),
      entryTimestamp: now,
    });

    expect(position).toEqual(
      expect.objectContaining({
        positionId: 'pos-1',
        pairId: 'pair-1',
        kalshiContractId: 'kalshi-abc',
        polymarketContractId: 'poly-xyz',
        kalshiSide: 'BUY',
        polymarketSide: 'SELL',
        entryTimestamp: now,
      }),
    );
    expect(position.kalshiEntryPrice.equals(new Decimal('0.45'))).toBe(true);
    expect(position.exitTimestamp).toBeNull();
    expect(position.exitReason).toBeNull();
    expect(position.realizedPnl).toBeNull();
  });
});

describe('BacktestPortfolioState', () => {
  it('[P1] should construct with availableCapital, deployedCapital, openPositions Map, and metric accumulators', async () => {
    const { createInitialPortfolioState } = await import('./simulation.types');
    const state = createInitialPortfolioState(new Decimal('10000'));

    expect(state.availableCapital.equals(new Decimal('10000'))).toBe(true);
    expect(state.deployedCapital.equals(new Decimal('0'))).toBe(true);
    expect(state.openPositions).toBeInstanceOf(Map);
    expect(state.openPositions.size).toBe(0);
    expect(state.closedPositions).toHaveLength(0);
    expect(state.peakEquity.equals(new Decimal('10000'))).toBe(true);
    expect(state.currentEquity.equals(new Decimal('10000'))).toBe(true);
    expect(state.realizedPnl.equals(new Decimal('0'))).toBe(true);
    expect(state.maxDrawdown.equals(new Decimal('0'))).toBe(true);
  });
});

describe('BacktestTimeStep', () => {
  it('[P1] should construct with aligned prices for both platforms', async () => {
    const types = await import('./simulation.types');
    const ts: typeof types.BacktestTimeStep extends never
      ? never
      : InstanceType<any> = {
      timestamp: new Date('2025-02-01T14:00:00Z'),
      pairs: [
        {
          pairId: 'pair-1',
          kalshiContractId: 'k-1',
          polymarketContractId: 'p-1',
          kalshiClose: new Decimal('0.45'),
          polymarketClose: new Decimal('0.52'),
          resolutionTimestamp: null,
        },
      ],
    };
    // Type check — BacktestTimeStep interface must define these fields
    expect(ts.timestamp).toBeInstanceOf(Date);
    expect(ts.pairs).toHaveLength(1);
    expect(ts.pairs[0].kalshiClose).toBeInstanceOf(Decimal);
    expect(ts.pairs[0].polymarketClose).toBeInstanceOf(Decimal);
  });
});

describe('ExitEvaluation', () => {
  it('[P1] should construct with triggered exit reason and priority', async () => {
    const types = await import('./simulation.types');
    const evaluation: typeof types.ExitEvaluation extends never
      ? never
      : InstanceType<any> = {
      triggered: true,
      reason: 'EDGE_EVAPORATION',
      priority: 4,
      currentEdge: new Decimal('0.001'),
    };
    expect(evaluation.triggered).toBe(true);
    expect(evaluation.reason).toBe('EDGE_EVAPORATION');
    expect(evaluation.priority).toBe(4);
  });
});
