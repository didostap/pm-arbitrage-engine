import { describe, it, expect } from 'vitest';
import Decimal from 'decimal.js';
import { getResidualSize } from './residual-size';

describe('getResidualSize', () => {
  const basePosition = {
    kalshiOrderId: 'entry-kalshi-1',
    polymarketOrderId: 'entry-poly-1',
    kalshiOrder: { fillSize: new Decimal('100') },
    polymarketOrder: { fillSize: new Decimal('100') },
  };

  it('should return entry fill sizes for OPEN position with no exit orders', () => {
    const allPairOrders = [
      {
        orderId: 'entry-kalshi-1',
        platform: 'KALSHI',
        fillSize: new Decimal('100'),
      },
      {
        orderId: 'entry-poly-1',
        platform: 'POLYMARKET',
        fillSize: new Decimal('100'),
      },
    ];

    const result = getResidualSize(basePosition, allPairOrders);

    expect(result.kalshi.toString()).toBe('100');
    expect(result.polymarket.toString()).toBe('100');
    expect(result.floored).toBe(false);
  });

  it('should compute residual after partial exit on both platforms', () => {
    const allPairOrders = [
      {
        orderId: 'entry-kalshi-1',
        platform: 'KALSHI',
        fillSize: new Decimal('100'),
      },
      {
        orderId: 'entry-poly-1',
        platform: 'POLYMARKET',
        fillSize: new Decimal('100'),
      },
      {
        orderId: 'exit-kalshi-1',
        platform: 'KALSHI',
        fillSize: new Decimal('30'),
      },
      {
        orderId: 'exit-poly-1',
        platform: 'POLYMARKET',
        fillSize: new Decimal('30'),
      },
    ];

    const result = getResidualSize(basePosition, allPairOrders);

    expect(result.kalshi.toString()).toBe('70');
    expect(result.polymarket.toString()).toBe('70');
  });

  it('should handle multiple partial exits summing up correctly', () => {
    const allPairOrders = [
      {
        orderId: 'entry-kalshi-1',
        platform: 'KALSHI',
        fillSize: new Decimal('100'),
      },
      {
        orderId: 'entry-poly-1',
        platform: 'POLYMARKET',
        fillSize: new Decimal('100'),
      },
      {
        orderId: 'exit-kalshi-1',
        platform: 'KALSHI',
        fillSize: new Decimal('20'),
      },
      {
        orderId: 'exit-poly-1',
        platform: 'POLYMARKET',
        fillSize: new Decimal('20'),
      },
      {
        orderId: 'exit-kalshi-2',
        platform: 'KALSHI',
        fillSize: new Decimal('15'),
      },
      {
        orderId: 'exit-poly-2',
        platform: 'POLYMARKET',
        fillSize: new Decimal('15'),
      },
    ];

    const result = getResidualSize(basePosition, allPairOrders);

    expect(result.kalshi.toString()).toBe('65');
    expect(result.polymarket.toString()).toBe('65');
  });

  it('should floor at zero when exit orders sum to entry size', () => {
    const allPairOrders = [
      {
        orderId: 'entry-kalshi-1',
        platform: 'KALSHI',
        fillSize: new Decimal('100'),
      },
      {
        orderId: 'entry-poly-1',
        platform: 'POLYMARKET',
        fillSize: new Decimal('100'),
      },
      {
        orderId: 'exit-kalshi-1',
        platform: 'KALSHI',
        fillSize: new Decimal('100'),
      },
      {
        orderId: 'exit-poly-1',
        platform: 'POLYMARKET',
        fillSize: new Decimal('100'),
      },
    ];

    const result = getResidualSize(basePosition, allPairOrders);

    expect(result.kalshi.toString()).toBe('0');
    expect(result.polymarket.toString()).toBe('0');
  });

  it('should set floored=false when exits equal entry exactly', () => {
    const allPairOrders = [
      {
        orderId: 'entry-kalshi-1',
        platform: 'KALSHI',
        fillSize: new Decimal('100'),
      },
      {
        orderId: 'entry-poly-1',
        platform: 'POLYMARKET',
        fillSize: new Decimal('100'),
      },
      {
        orderId: 'exit-kalshi-1',
        platform: 'KALSHI',
        fillSize: new Decimal('100'),
      },
      {
        orderId: 'exit-poly-1',
        platform: 'POLYMARKET',
        fillSize: new Decimal('100'),
      },
    ];

    const result = getResidualSize(basePosition, allPairOrders);

    expect(result.kalshi.toString()).toBe('0');
    expect(result.polymarket.toString()).toBe('0');
    expect(result.floored).toBe(false);
  });

  it('should floor at zero defensively when exits exceed entry (data integrity issue)', () => {
    const allPairOrders = [
      {
        orderId: 'entry-kalshi-1',
        platform: 'KALSHI',
        fillSize: new Decimal('100'),
      },
      {
        orderId: 'entry-poly-1',
        platform: 'POLYMARKET',
        fillSize: new Decimal('100'),
      },
      {
        orderId: 'exit-kalshi-1',
        platform: 'KALSHI',
        fillSize: new Decimal('120'),
      },
      {
        orderId: 'exit-poly-1',
        platform: 'POLYMARKET',
        fillSize: new Decimal('110'),
      },
    ];

    const result = getResidualSize(basePosition, allPairOrders);

    expect(result.kalshi.toString()).toBe('0');
    expect(result.polymarket.toString()).toBe('0');
    expect(result.floored).toBe(true);
  });

  it('should handle asymmetric exit sizes across platforms', () => {
    const allPairOrders = [
      {
        orderId: 'entry-kalshi-1',
        platform: 'KALSHI',
        fillSize: new Decimal('100'),
      },
      {
        orderId: 'entry-poly-1',
        platform: 'POLYMARKET',
        fillSize: new Decimal('100'),
      },
      {
        orderId: 'exit-kalshi-1',
        platform: 'KALSHI',
        fillSize: new Decimal('50'),
      },
      {
        orderId: 'exit-poly-1',
        platform: 'POLYMARKET',
        fillSize: new Decimal('30'),
      },
    ];

    const result = getResidualSize(basePosition, allPairOrders);

    expect(result.kalshi.toString()).toBe('50');
    expect(result.polymarket.toString()).toBe('70');
  });

  it('should handle null fillSize on exit orders (treat as zero)', () => {
    const allPairOrders = [
      {
        orderId: 'entry-kalshi-1',
        platform: 'KALSHI',
        fillSize: new Decimal('100'),
      },
      {
        orderId: 'entry-poly-1',
        platform: 'POLYMARKET',
        fillSize: new Decimal('100'),
      },
      {
        orderId: 'exit-kalshi-1',
        platform: 'KALSHI',
        fillSize: null,
      },
    ];

    const result = getResidualSize(basePosition, allPairOrders);

    expect(result.kalshi.toString()).toBe('100');
    expect(result.polymarket.toString()).toBe('100');
  });

  it('should handle position with null entry order IDs gracefully', () => {
    const position = {
      kalshiOrderId: null,
      polymarketOrderId: null,
      kalshiOrder: { fillSize: new Decimal('100') },
      polymarketOrder: { fillSize: new Decimal('100') },
    };

    const allPairOrders = [
      {
        orderId: 'some-order',
        platform: 'KALSHI',
        fillSize: new Decimal('30'),
      },
    ];

    // All orders are treated as exit orders since there are no entry IDs to exclude
    const result = getResidualSize(position, allPairOrders);

    expect(result.kalshi.toString()).toBe('70');
    expect(result.polymarket.toString()).toBe('100');
  });

  it('should use decimal.js for all arithmetic (no floating point errors)', () => {
    const position = {
      kalshiOrderId: 'entry-kalshi-1',
      polymarketOrderId: 'entry-poly-1',
      kalshiOrder: { fillSize: new Decimal('0.3') },
      polymarketOrder: { fillSize: new Decimal('0.3') },
    };

    const allPairOrders = [
      {
        orderId: 'entry-kalshi-1',
        platform: 'KALSHI',
        fillSize: new Decimal('0.3'),
      },
      {
        orderId: 'entry-poly-1',
        platform: 'POLYMARKET',
        fillSize: new Decimal('0.3'),
      },
      {
        orderId: 'exit-kalshi-1',
        platform: 'KALSHI',
        fillSize: new Decimal('0.1'),
      },
      {
        orderId: 'exit-poly-1',
        platform: 'POLYMARKET',
        fillSize: new Decimal('0.1'),
      },
    ];

    const result = getResidualSize(position, allPairOrders);

    // 0.3 - 0.1 = 0.2 exactly (no floating point issues)
    expect(result.kalshi.toString()).toBe('0.2');
    expect(result.polymarket.toString()).toBe('0.2');
  });
});
