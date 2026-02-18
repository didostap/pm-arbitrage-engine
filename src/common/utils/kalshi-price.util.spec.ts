import { describe, it, expect } from 'vitest';
import { normalizeKalshiLevels } from './kalshi-price.util.js';

describe('normalizeKalshiLevels', () => {
  it('should convert zero price YES level (0 cents → 0.00)', () => {
    const result = normalizeKalshiLevels([[0, 10]], []);
    expect(result.bids).toEqual([{ price: 0, quantity: 10 }]);
    expect(result.asks).toEqual([]);
  });

  it('should convert boundary 100 cents YES level (100 cents → 1.00)', () => {
    const result = normalizeKalshiLevels([[100, 5]], []);
    expect(result.bids).toEqual([{ price: 1, quantity: 5 }]);
  });

  it('should invert NO levels to YES asks (NO 35¢ → YES ask 0.65)', () => {
    const result = normalizeKalshiLevels([], [[35, 10]]);
    expect(result.bids).toEqual([]);
    expect(result.asks).toEqual([{ price: 0.65, quantity: 10 }]);
  });

  it('should sort asks ascending by price', () => {
    const result = normalizeKalshiLevels(
      [],
      [
        [20, 5], // 1 - 0.20 = 0.80
        [40, 10], // 1 - 0.40 = 0.60
        [10, 3], // 1 - 0.10 = 0.90
      ],
    );
    expect(result.asks).toEqual([
      { price: 0.6, quantity: 10 },
      { price: 0.8, quantity: 5 },
      { price: 0.9, quantity: 3 },
    ]);
  });

  it('should handle empty arrays', () => {
    const result = normalizeKalshiLevels([], []);
    expect(result).toEqual({ bids: [], asks: [] });
  });

  it('should handle single-element YES array', () => {
    const result = normalizeKalshiLevels([[50, 20]], []);
    expect(result.bids).toEqual([{ price: 0.5, quantity: 20 }]);
    expect(result.asks).toEqual([]);
  });

  it('should handle single-element NO array', () => {
    const result = normalizeKalshiLevels([], [[50, 20]]);
    expect(result.bids).toEqual([]);
    expect(result.asks).toEqual([{ price: 0.5, quantity: 20 }]);
  });

  it('should preserve bid input order (no re-sorting)', () => {
    const result = normalizeKalshiLevels(
      [
        [40, 10],
        [60, 5],
        [20, 3],
      ],
      [],
    );
    expect(result.bids).toEqual([
      { price: 0.4, quantity: 10 },
      { price: 0.6, quantity: 5 },
      { price: 0.2, quantity: 3 },
    ]);
  });

  it('should handle floating-point precision for non-clean cents (33¢)', () => {
    const result = normalizeKalshiLevels([[33, 10]], [[33, 5]]);
    expect(result.bids[0]?.price).toBeCloseTo(0.33, 10);
    expect(result.asks[0]?.price).toBeCloseTo(0.67, 10);
  });

  it('should produce realistic spread: YES 60¢ bid + NO 35¢ ask', () => {
    const result = normalizeKalshiLevels([[60, 100]], [[35, 50]]);
    expect(result.bids).toEqual([{ price: 0.6, quantity: 100 }]);
    expect(result.asks).toEqual([{ price: 0.65, quantity: 50 }]);
  });
});
