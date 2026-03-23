import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import Decimal from 'decimal.js';
import {
  FinancialMath,
  calculateVwapClosePrice,
  calculateVwapWithFillInfo,
  calculateLegPnl,
} from './financial-math';
import { FeeSchedule } from '../types/platform.type';
import { PlatformId } from '../types/platform.type';
import type { NormalizedOrderBook } from '../types/normalized-order-book.type';
import type { ContractId } from '../types/branded.type';

interface CsvScenario {
  scenario_name: string;
  buy_price: string;
  sell_price: string;
  buy_fee_pct: string;
  sell_fee_pct: string;
  gas_estimate_usd: string;
  position_size_usd: string;
  expected_gross_edge: string;
  expected_net_edge: string;
  expected_passes_filter: string;
  notes: string;
}

// Minimal CSV parser — handles quoted fields but not escaped quotes ("") or newlines
// within fields. Sufficient for our controlled test data CSV.
function loadCsvScenarios(): CsvScenario[] {
  const csvPath = resolve(
    __dirname,
    '../../modules/arbitrage-detection/__tests__/edge-calculation-scenarios.csv',
  );
  const raw = readFileSync(csvPath, 'utf-8');
  const lines = raw
    .split('\n')
    .filter((line) => line.trim() && !line.startsWith('#'));

  const header = lines[0]!.split(',');
  return lines.slice(1).map((line) => {
    // Handle commas inside notes (last field may contain commas)
    const parts: string[] = [];
    let current = '';
    let inQuotes = false;
    for (const char of line) {
      if (char === '"') {
        inQuotes = !inQuotes;
      } else if (char === ',' && !inQuotes) {
        parts.push(current);
        current = '';
      } else {
        current += char;
      }
    }
    parts.push(current);

    const record: Record<string, string> = {};
    header.forEach((h, i) => {
      record[h.trim()] = (parts[i] || '').trim();
    });
    return record as unknown as CsvScenario;
  });
}

function makeFeeSchedule(takerFeePercent: number): FeeSchedule {
  return {
    platformId: PlatformId.KALSHI,
    makerFeePercent: 0,
    takerFeePercent,
    description: 'test fee schedule',
  };
}

const THRESHOLD = new Decimal('0.008'); // 0.80%

describe('FinancialMath', () => {
  const scenarios = loadCsvScenarios();

  describe('CSV scenario validation', () => {
    it('should load at least 15 scenarios', () => {
      expect(scenarios.length).toBeGreaterThanOrEqual(15);
    });
  });

  describe('calculateGrossEdge', () => {
    scenarios.forEach((s) => {
      it(`should compute correct gross edge for ${s.scenario_name}`, () => {
        const result = FinancialMath.calculateGrossEdge(
          new Decimal(s.buy_price),
          new Decimal(s.sell_price),
        );
        expect(result.toFixed(20)).toBe(
          new Decimal(s.expected_gross_edge).toFixed(20),
        );
      });
    });
  });

  describe('calculateNetEdge', () => {
    scenarios.forEach((s) => {
      it(`should compute correct net edge for ${s.scenario_name}`, () => {
        const grossEdge = new Decimal(s.expected_gross_edge);
        const result = FinancialMath.calculateNetEdge(
          grossEdge,
          new Decimal(s.buy_price),
          new Decimal(s.sell_price),
          makeFeeSchedule(parseFloat(s.buy_fee_pct)),
          makeFeeSchedule(parseFloat(s.sell_fee_pct)),
          new Decimal(s.gas_estimate_usd),
          new Decimal(s.position_size_usd),
        );
        expect(result.toFixed(20)).toBe(
          new Decimal(s.expected_net_edge).toFixed(20),
        );
      });
    });
  });

  describe('isAboveThreshold', () => {
    scenarios.forEach((s) => {
      it(`should correctly filter ${s.scenario_name}`, () => {
        const netEdge = new Decimal(s.expected_net_edge);
        const result = FinancialMath.isAboveThreshold(netEdge, THRESHOLD);
        const expectedPassesFilter = s.expected_passes_filter === 'true';
        expect(result).toBe(expectedPassesFilter);
      });
    });
  });

  describe('NaN/Infinity guards', () => {
    it('should reject NaN buyPrice in calculateGrossEdge', () => {
      expect(() =>
        FinancialMath.calculateGrossEdge(new Decimal(NaN), new Decimal('0.5')),
      ).toThrowError(/buyPrice must not be NaN/);
    });

    it('should reject Infinity sellPrice in calculateGrossEdge', () => {
      expect(() =>
        FinancialMath.calculateGrossEdge(
          new Decimal('0.5'),
          new Decimal(Infinity),
        ),
      ).toThrowError(/sellPrice must not be Infinity/);
    });

    it('should reject NaN in calculateNetEdge', () => {
      expect(() =>
        FinancialMath.calculateNetEdge(
          new Decimal(NaN),
          new Decimal('0.5'),
          new Decimal('0.5'),
          makeFeeSchedule(2.0),
          makeFeeSchedule(1.5),
          new Decimal('0.10'),
          new Decimal('100'),
        ),
      ).toThrowError(/grossEdge must not be NaN/);
    });

    it('should reject NaN takerFeePercent in calculateNetEdge', () => {
      expect(() =>
        FinancialMath.calculateNetEdge(
          new Decimal('0.05'),
          new Decimal('0.5'),
          new Decimal('0.5'),
          makeFeeSchedule(NaN),
          makeFeeSchedule(1.5),
          new Decimal('0.10'),
          new Decimal('100'),
        ),
      ).toThrowError(/buyFeeSchedule.takerFeePercent must not be NaN/);
    });

    it('should reject zero positionSizeUsd', () => {
      expect(() =>
        FinancialMath.calculateNetEdge(
          new Decimal('0.05'),
          new Decimal('0.5'),
          new Decimal('0.5'),
          makeFeeSchedule(2.0),
          makeFeeSchedule(1.5),
          new Decimal('0.10'),
          new Decimal('0'),
        ),
      ).toThrowError(/positionSizeUsd must not be zero/);
    });

    it('should reject NaN in isAboveThreshold', () => {
      expect(() =>
        FinancialMath.isAboveThreshold(new Decimal(NaN), new Decimal('0.008')),
      ).toThrowError(/netEdge must not be NaN/);
    });
  });

  describe('calculateTakerFeeRate', () => {
    it('should use takerFeeForPrice callback when present (dynamic fee)', () => {
      const schedule = makeFeeSchedule(1.75);
      schedule.takerFeeForPrice = (price: number) => 0.07 * (1 - price);

      const rate = FinancialMath.calculateTakerFeeRate(
        new Decimal('0.50'),
        schedule,
      );
      // 0.07 × (1 - 0.50) = 0.035
      expect(rate.toNumber()).toBeCloseTo(0.035, 10);
    });

    it('should fall back to takerFeePercent / 100 when callback absent', () => {
      const schedule = makeFeeSchedule(2.0);

      const rate = FinancialMath.calculateTakerFeeRate(
        new Decimal('0.50'),
        schedule,
      );
      // 2.0 / 100 = 0.02
      expect(rate.toNumber()).toBe(0.02);
    });

    it('should return 0 at price boundaries with dynamic fee', () => {
      const schedule = makeFeeSchedule(1.75);
      schedule.takerFeeForPrice = (price: number) => {
        if (price <= 0 || price >= 1) return 0;
        return 0.07 * (1 - price);
      };

      expect(
        FinancialMath.calculateTakerFeeRate(
          new Decimal('0'),
          schedule,
        ).toNumber(),
      ).toBe(0);
      expect(
        FinancialMath.calculateTakerFeeRate(
          new Decimal('1'),
          schedule,
        ).toNumber(),
      ).toBe(0);
    });

    it('should compute correct rate at midpoint (P=0.50)', () => {
      const schedule = makeFeeSchedule(1.75);
      schedule.takerFeeForPrice = (price: number) => {
        if (price <= 0 || price >= 1) return 0;
        return 0.07 * (1 - price);
      };

      const rate = FinancialMath.calculateTakerFeeRate(
        new Decimal('0.50'),
        schedule,
      );
      // 0.07 × 0.50 = 0.035; fee per contract = 0.035 × 0.50 = 0.0175 = 1.75%
      expect(rate.toNumber()).toBeCloseTo(0.035, 10);
    });

    it('should handle both-sides dynamic scenario', () => {
      const kalshiSchedule = makeFeeSchedule(1.75);
      kalshiSchedule.takerFeeForPrice = (price: number) => {
        if (price <= 0 || price >= 1) return 0;
        return 0.07 * (1 - price);
      };
      const polySchedule = makeFeeSchedule(2.0); // flat, no callback

      const kalshiRate = FinancialMath.calculateTakerFeeRate(
        new Decimal('0.45'),
        kalshiSchedule,
      );
      const polyRate = FinancialMath.calculateTakerFeeRate(
        new Decimal('0.52'),
        polySchedule,
      );

      // Kalshi: 0.07 × (1-0.45) = 0.07 × 0.55 = 0.0385
      expect(kalshiRate.toNumber()).toBeCloseTo(0.0385, 10);
      // Polymarket: flat 2.0 / 100 = 0.02
      expect(polyRate.toNumber()).toBe(0.02);
    });

    it('should handle IEEE 754 roundtrip without significant precision loss', () => {
      const schedule = makeFeeSchedule(1.75);
      schedule.takerFeeForPrice = (price: number) => 0.07 * (1 - price);

      // 0.1 is not exactly representable in IEEE 754; verify precision is acceptable
      const rate = FinancialMath.calculateTakerFeeRate(
        new Decimal('0.1'),
        schedule,
      );
      // 0.07 × (1-0.1) = 0.063 — verify within 1e-15 tolerance
      expect(rate.toNumber()).toBeCloseTo(0.063, 14);
    });
  });

  describe('computeEntryCostBaseline', () => {
    it('returns negative baseline for realistic spread + fees', () => {
      const result = FinancialMath.computeEntryCostBaseline({
        kalshiEntryPrice: new Decimal('0.62'),
        polymarketEntryPrice: new Decimal('0.65'),
        kalshiSide: 'buy',
        polymarketSide: 'sell',
        kalshiSize: new Decimal('100'),
        polymarketSize: new Decimal('100'),
        entryClosePriceKalshi: new Decimal('0.60'),
        entryClosePricePolymarket: new Decimal('0.67'),
        entryKalshiFeeRate: new Decimal('0.02'),
        entryPolymarketFeeRate: new Decimal('0.02'),
      });
      // Kalshi buy@0.62, close bid=0.60 → spread = 0.02
      // Poly sell@0.65, close ask=0.67 → spread = 0.02
      // spreadCost = (0.02 * 100) + (0.02 * 100) = 4.0
      // entryExitFees = (0.60 * 100 * 0.02) + (0.67 * 100 * 0.02) = 1.2 + 1.34 = 2.54
      // baseline = -(4.0 + 2.54) = -6.54
      expect(result.toNumber()).toBeCloseTo(-6.54, 8);
    });

    it('returns zero baseline when all entry fields are null', () => {
      const result = FinancialMath.computeEntryCostBaseline({
        kalshiEntryPrice: new Decimal('0.62'),
        polymarketEntryPrice: new Decimal('0.65'),
        kalshiSide: 'buy',
        polymarketSide: 'sell',
        kalshiSize: new Decimal('100'),
        polymarketSize: new Decimal('100'),
        entryClosePriceKalshi: null,
        entryClosePricePolymarket: null,
        entryKalshiFeeRate: null,
        entryPolymarketFeeRate: null,
      });
      expect(result.isZero()).toBe(true);
    });

    it('returns zero baseline when any entry field is null (partial)', () => {
      const result = FinancialMath.computeEntryCostBaseline({
        kalshiEntryPrice: new Decimal('0.62'),
        polymarketEntryPrice: new Decimal('0.65'),
        kalshiSide: 'buy',
        polymarketSide: 'sell',
        kalshiSize: new Decimal('100'),
        polymarketSize: new Decimal('100'),
        entryClosePriceKalshi: new Decimal('0.60'),
        entryClosePricePolymarket: new Decimal('0.67'),
        entryKalshiFeeRate: null,
        entryPolymarketFeeRate: new Decimal('0.02'),
      });
      expect(result.isZero()).toBe(true);
    });

    it('clamps negative spread to zero', () => {
      // Close price better than fill → negative spread → clamped
      const result = FinancialMath.computeEntryCostBaseline({
        kalshiEntryPrice: new Decimal('0.62'),
        polymarketEntryPrice: new Decimal('0.65'),
        kalshiSide: 'buy',
        polymarketSide: 'sell',
        kalshiSize: new Decimal('100'),
        polymarketSize: new Decimal('100'),
        entryClosePriceKalshi: new Decimal('0.64'), // better than fill
        entryClosePricePolymarket: new Decimal('0.63'), // better than fill
        entryKalshiFeeRate: new Decimal('0.02'),
        entryPolymarketFeeRate: new Decimal('0.02'),
      });
      // Spreads clamped to 0, only exit fees contribute
      // entryExitFees = (0.64 * 100 * 0.02) + (0.63 * 100 * 0.02) = 1.28 + 1.26 = 2.54
      // baseline = -(0 + 2.54) = -2.54
      expect(result.toNumber()).toBeCloseTo(-2.54, 8);
    });

    it('handles zero spread (close prices equal fill prices)', () => {
      const result = FinancialMath.computeEntryCostBaseline({
        kalshiEntryPrice: new Decimal('0.62'),
        polymarketEntryPrice: new Decimal('0.65'),
        kalshiSide: 'buy',
        polymarketSide: 'sell',
        kalshiSize: new Decimal('100'),
        polymarketSize: new Decimal('100'),
        entryClosePriceKalshi: new Decimal('0.62'),
        entryClosePricePolymarket: new Decimal('0.65'),
        entryKalshiFeeRate: new Decimal('0.02'),
        entryPolymarketFeeRate: new Decimal('0.02'),
      });
      // spreadCost = 0
      // entryExitFees = (0.62 * 100 * 0.02) + (0.65 * 100 * 0.02) = 1.24 + 1.30 = 2.54
      // baseline = -(0 + 2.54) = -2.54
      expect(result.toNumber()).toBeCloseTo(-2.54, 8);
    });
  });
});

function makeOrderBook(
  bids: Array<{ price: number; quantity: number }>,
  asks: Array<{ price: number; quantity: number }>,
): NormalizedOrderBook {
  return {
    platformId: 'kalshi' as unknown as NormalizedOrderBook['platformId'],
    contractId: 'test-contract' as ContractId,
    bids,
    asks,
    timestamp: new Date(),
  };
}

describe('calculateVwapClosePrice', () => {
  it('single-level book — returns that level price', () => {
    const book = makeOrderBook([{ price: 0.6, quantity: 100 }], []);
    const result = calculateVwapClosePrice(book, 'buy', new Decimal('50'));
    expect(result).not.toBeNull();
    expect(result!.toNumber()).toBe(0.6);
  });

  it('multi-level book — correct weighted average (sell-to-close walks bids)', () => {
    // Bids: 0.60 × 30, 0.58 × 70 → fill 50 from top
    // VWAP = (0.60*30 + 0.58*20) / 50 = (18 + 11.6) / 50 = 0.592
    const book = makeOrderBook(
      [
        { price: 0.6, quantity: 30 },
        { price: 0.58, quantity: 70 },
      ],
      [],
    );
    const result = calculateVwapClosePrice(book, 'buy', new Decimal('50'));
    expect(result).not.toBeNull();
    expect(result!.toNumber()).toBeCloseTo(0.592, 10);
  });

  it('multi-level book — buy-to-close walks asks lowest-first', () => {
    // Asks: 0.40 × 20, 0.42 × 80 → fill 50 from bottom
    // VWAP = (0.40*20 + 0.42*30) / 50 = (8 + 12.6) / 50 = 0.412
    const book = makeOrderBook(
      [],
      [
        { price: 0.4, quantity: 20 },
        { price: 0.42, quantity: 80 },
      ],
    );
    const result = calculateVwapClosePrice(book, 'sell', new Decimal('50'));
    expect(result).not.toBeNull();
    expect(result!.toNumber()).toBeCloseTo(0.412, 10);
  });

  it('partial depth — returns VWAP across all available levels', () => {
    // Only 30 available, need 50 → VWAP across all 30
    const book = makeOrderBook(
      [
        { price: 0.6, quantity: 20 },
        { price: 0.58, quantity: 10 },
      ],
      [],
    );
    const result = calculateVwapClosePrice(book, 'buy', new Decimal('50'));
    expect(result).not.toBeNull();
    // VWAP = (0.60*20 + 0.58*10) / 30 = (12 + 5.8) / 30 = 0.59333...
    expect(result!.toNumber()).toBeCloseTo(17.8 / 30, 10);
  });

  it('zero-depth side — returns null', () => {
    const book = makeOrderBook([], [{ price: 0.4, quantity: 100 }]);
    // buy side → walk bids, but bids empty
    const result = calculateVwapClosePrice(book, 'buy', new Decimal('50'));
    expect(result).toBeNull();
  });

  it('empty order book — returns null', () => {
    const book = makeOrderBook([], []);
    expect(calculateVwapClosePrice(book, 'buy', new Decimal('50'))).toBeNull();
    expect(calculateVwapClosePrice(book, 'sell', new Decimal('50'))).toBeNull();
  });

  it('zero position size — returns null', () => {
    const book = makeOrderBook([{ price: 0.6, quantity: 100 }], []);
    expect(calculateVwapClosePrice(book, 'buy', new Decimal('0'))).toBeNull();
  });

  it('negative position size — returns null', () => {
    const book = makeOrderBook([{ price: 0.6, quantity: 100 }], []);
    expect(calculateVwapClosePrice(book, 'buy', new Decimal('-10'))).toBeNull();
  });

  it('position size exactly matches available depth', () => {
    const book = makeOrderBook(
      [
        { price: 0.6, quantity: 30 },
        { price: 0.58, quantity: 20 },
      ],
      [],
    );
    const result = calculateVwapClosePrice(book, 'buy', new Decimal('50'));
    expect(result).not.toBeNull();
    // VWAP = (0.60*30 + 0.58*20) / 50 = (18 + 11.6) / 50 = 0.592
    expect(result!.toNumber()).toBeCloseTo(0.592, 10);
  });
});

describe('calculateLegPnl', () => {
  it('buy-side profit', () => {
    // Bought at 0.55, close at 0.60, size 100
    const result = calculateLegPnl(
      'buy',
      new Decimal('0.55'),
      new Decimal('0.60'),
      new Decimal('100'),
    );
    expect(result.toNumber()).toBe(5.0);
  });

  it('buy-side loss', () => {
    const result = calculateLegPnl(
      'buy',
      new Decimal('0.55'),
      new Decimal('0.50'),
      new Decimal('100'),
    );
    expect(result.toNumber()).toBe(-5.0);
  });

  it('sell-side profit', () => {
    // Sold at 0.45, close at 0.40, size 100
    const result = calculateLegPnl(
      'sell',
      new Decimal('0.45'),
      new Decimal('0.40'),
      new Decimal('100'),
    );
    expect(result.toNumber()).toBe(5.0);
  });

  it('sell-side loss', () => {
    const result = calculateLegPnl(
      'sell',
      new Decimal('0.45'),
      new Decimal('0.50'),
      new Decimal('100'),
    );
    expect(result.toNumber()).toBe(-5.0);
  });

  it('zero-size position returns 0', () => {
    const result = calculateLegPnl(
      'buy',
      new Decimal('0.55'),
      new Decimal('0.60'),
      new Decimal('0'),
    );
    expect(result.toNumber()).toBe(0);
  });
});

// ==========================================================================
// Story 10-7-2: calculateVwapWithFillInfo — ATDD Red Phase
// ==========================================================================
describe('calculateVwapWithFillInfo (Story 10-7-2)', () => {
  it('single-level book, full fill → filledQty equals positionSize, vwap equals level price', () => {
    const book = makeOrderBook([{ price: 0.6, quantity: 100 }], []);
    const result = calculateVwapWithFillInfo(book, 'buy', new Decimal('50'));
    expect(result).not.toBeNull();
    expect(result!.vwap.toNumber()).toBe(0.6);
    expect(result!.filledQty.toNumber()).toBe(50);
    expect(result!.totalQtyAvailable.toNumber()).toBe(100);
  });

  it('multi-level book, full fill → correct VWAP and filledQty', () => {
    // Bids: 0.60 × 30, 0.58 × 70 → fill 50 from top
    // VWAP = (0.60*30 + 0.58*20) / 50 = 29.6 / 50 = 0.592
    const book = makeOrderBook(
      [
        { price: 0.6, quantity: 30 },
        { price: 0.58, quantity: 70 },
      ],
      [],
    );
    const result = calculateVwapWithFillInfo(book, 'buy', new Decimal('50'));
    expect(result).not.toBeNull();
    expect(result!.vwap.toNumber()).toBeCloseTo(0.592, 10);
    expect(result!.filledQty.toNumber()).toBe(50);
    expect(result!.totalQtyAvailable.toNumber()).toBe(100);
  });

  it('partial fill (book has less than requested) → filledQty < positionSize, VWAP across available', () => {
    // Only 30 available, need 50 → partial fill
    const book = makeOrderBook(
      [
        { price: 0.6, quantity: 20 },
        { price: 0.58, quantity: 10 },
      ],
      [],
    );
    const result = calculateVwapWithFillInfo(book, 'buy', new Decimal('50'));
    expect(result).not.toBeNull();
    expect(result!.filledQty.toNumber()).toBe(30);
    // VWAP = (0.60*20 + 0.58*10) / 30 = 17.8 / 30 ≈ 0.59333
    expect(result!.vwap.toNumber()).toBeCloseTo(17.8 / 30, 10);
    expect(result!.totalQtyAvailable.toNumber()).toBe(30);
  });

  it('empty side → returns null', () => {
    const book = makeOrderBook([], [{ price: 0.4, quantity: 100 }]);
    // buy side walks bids, but bids are empty
    const result = calculateVwapWithFillInfo(book, 'buy', new Decimal('50'));
    expect(result).toBeNull();
  });

  it('zero position size → returns null', () => {
    const book = makeOrderBook([{ price: 0.6, quantity: 100 }], []);
    const result = calculateVwapWithFillInfo(book, 'buy', new Decimal('0'));
    expect(result).toBeNull();
  });

  it('totalQtyAvailable sums all levels correctly', () => {
    const book = makeOrderBook(
      [
        { price: 0.6, quantity: 30 },
        { price: 0.58, quantity: 70 },
        { price: 0.55, quantity: 50 },
      ],
      [],
    );
    const result = calculateVwapWithFillInfo(book, 'buy', new Decimal('10'));
    expect(result).not.toBeNull();
    expect(result!.totalQtyAvailable.toNumber()).toBe(150);
    // Full fill at first level only → vwap = 0.60
    expect(result!.filledQty.toNumber()).toBe(10);
    expect(result!.vwap.toNumber()).toBe(0.6);
  });

  it('closeSide=sell walks asks, multi-level full fill → correct VWAP', () => {
    // Asks: 0.40 × 30, 0.42 × 70 → fill 50 from lowest ask
    // VWAP = (0.40*30 + 0.42*20) / 50 = 20.4 / 50 = 0.408
    const book = makeOrderBook(
      [],
      [
        { price: 0.4, quantity: 30 },
        { price: 0.42, quantity: 70 },
      ],
    );
    const result = calculateVwapWithFillInfo(book, 'sell', new Decimal('50'));
    expect(result).not.toBeNull();
    expect(result!.vwap.toNumber()).toBeCloseTo(0.408, 10);
    expect(result!.filledQty.toNumber()).toBe(50);
    expect(result!.totalQtyAvailable.toNumber()).toBe(100);
  });

  it('closeSide=sell partial fill on asks → correct VWAP for available depth', () => {
    // Only 40 available on asks, need 60 → partial fill
    const book = makeOrderBook(
      [],
      [
        { price: 0.4, quantity: 25 },
        { price: 0.42, quantity: 15 },
      ],
    );
    const result = calculateVwapWithFillInfo(book, 'sell', new Decimal('60'));
    expect(result).not.toBeNull();
    expect(result!.filledQty.toNumber()).toBe(40);
    // VWAP = (0.40*25 + 0.42*15) / 40 = 16.3 / 40 = 0.4075
    expect(result!.vwap.toNumber()).toBeCloseTo(16.3 / 40, 10);
    expect(result!.totalQtyAvailable.toNumber()).toBe(40);
  });
});
