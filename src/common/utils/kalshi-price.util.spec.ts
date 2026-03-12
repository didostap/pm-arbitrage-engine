import { describe, it, expect } from 'vitest';
import { normalizeKalshiLevels } from './kalshi-price.util.js';

describe('normalizeKalshiLevels', () => {
  it('should convert zero price YES level (0.00 → 0.00)', () => {
    const result = normalizeKalshiLevels([['0.0000', '10.00']], []);
    expect(result.bids).toEqual([{ price: 0, quantity: 10 }]);
    expect(result.asks).toEqual([]);
  });

  it('should convert boundary 1.00 YES level (1.00 → 1.00)', () => {
    const result = normalizeKalshiLevels([['1.0000', '5.00']], []);
    expect(result.bids).toEqual([{ price: 1, quantity: 5 }]);
  });

  it('should invert NO levels to YES asks (NO $0.35 → YES ask 0.65)', () => {
    const result = normalizeKalshiLevels([], [['0.3500', '10.00']]);
    expect(result.bids).toEqual([]);
    expect(result.asks).toEqual([{ price: 0.65, quantity: 10 }]);
  });

  it('should sort asks ascending by price', () => {
    const result = normalizeKalshiLevels(
      [],
      [
        ['0.2000', '5.00'], // 1 - 0.20 = 0.80
        ['0.4000', '10.00'], // 1 - 0.40 = 0.60
        ['0.1000', '3.00'], // 1 - 0.10 = 0.90
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
    const result = normalizeKalshiLevels([['0.5000', '20.00']], []);
    expect(result.bids).toEqual([{ price: 0.5, quantity: 20 }]);
    expect(result.asks).toEqual([]);
  });

  it('should handle single-element NO array', () => {
    const result = normalizeKalshiLevels([], [['0.5000', '20.00']]);
    expect(result.bids).toEqual([]);
    expect(result.asks).toEqual([{ price: 0.5, quantity: 20 }]);
  });

  it('should sort bids descending (best bid first)', () => {
    const result = normalizeKalshiLevels(
      [
        ['0.4000', '10.00'],
        ['0.6000', '5.00'],
        ['0.2000', '3.00'],
      ],
      [],
    );
    expect(result.bids).toEqual([
      { price: 0.6, quantity: 5 },
      { price: 0.4, quantity: 10 },
      { price: 0.2, quantity: 3 },
    ]);
  });

  it('should handle floating-point precision for non-clean prices ($0.33)', () => {
    const result = normalizeKalshiLevels(
      [['0.3300', '10.00']],
      [['0.3300', '5.00']],
    );
    expect(result.bids[0]?.price).toBeCloseTo(0.33, 10);
    expect(result.asks[0]?.price).toBeCloseTo(0.67, 10);
  });

  it('should produce realistic spread: YES $0.60 bid + NO $0.35 ask', () => {
    const result = normalizeKalshiLevels(
      [['0.6000', '100.00']],
      [['0.3500', '50.00']],
    );
    expect(result.bids).toEqual([{ price: 0.6, quantity: 100 }]);
    expect(result.asks).toEqual([{ price: 0.65, quantity: 50 }]);
  });

  it('should handle subpenny price input', () => {
    const result = normalizeKalshiLevels([['0.1250', '50.00']], []);
    expect(result.bids).toEqual([{ price: 0.125, quantity: 50 }]);
  });

  it('should handle fractional quantity', () => {
    const result = normalizeKalshiLevels([['0.4200', '1.55']], []);
    expect(result.bids).toEqual([{ price: 0.42, quantity: 1.55 }]);
  });
});
