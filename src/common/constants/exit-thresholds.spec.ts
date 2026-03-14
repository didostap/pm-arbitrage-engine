import { describe, it, expect } from 'vitest';
import Decimal from 'decimal.js';
import { computeTakeProfitThreshold } from './exit-thresholds';

describe('computeTakeProfitThreshold', () => {
  it('normal journey (baseline=0, edge=$3.00) → $2.40', () => {
    // Journey: 0 + (3 - 0) * 0.80 = 2.40 > 0 → use journey
    const result = computeTakeProfitThreshold(
      new Decimal(0),
      new Decimal('3.00'),
    );
    expect(result.toFixed(2)).toBe('2.40');
  });

  it('high-fee fallback — the bug case (baseline=-$8.05, edge=$1.13) → $0.904', () => {
    // Journey: -8.05 + (1.13 - (-8.05)) * 0.80 = -8.05 + 7.344 = -0.706 ≤ 0
    // Fallback: max(0, 1.13 * 0.80) = 0.904
    const result = computeTakeProfitThreshold(
      new Decimal('-8.05'),
      new Decimal('1.13'),
    );
    expect(result.toFixed(3)).toBe('0.904');
  });

  it('extreme spread floor (baseline=-$20, edge=$1.00) → $0.80', () => {
    // Journey: -20 + (1 - (-20)) * 0.80 = -20 + 16.8 = -3.2 ≤ 0
    // Fallback: max(0, 1.0 * 0.80) = 0.80
    const result = computeTakeProfitThreshold(
      new Decimal('-20'),
      new Decimal('1.00'),
    );
    expect(result.toFixed(2)).toBe('0.80');
  });

  it('boundary — journey exactly 0 (baseline=-$4, edge=$1) → fallback $0.80', () => {
    // Journey: -4 + (1 - (-4)) * 0.80 = -4 + 5 * 0.80 = -4 + 4 = 0 ≤ 0
    // Fallback: max(0, 1 * 0.80) = 0.80
    const result = computeTakeProfitThreshold(
      new Decimal('-4'),
      new Decimal('1'),
    );
    expect(result.toFixed(2)).toBe('0.80');
  });

  it('moderate spread — journey positive (baseline=-$1, edge=$3) → $2.20', () => {
    // Journey: -1 + (3 - (-1)) * 0.80 = -1 + 3.20 = 2.20 > 0 → use journey
    const result = computeTakeProfitThreshold(
      new Decimal('-1'),
      new Decimal('3'),
    );
    expect(result.toFixed(2)).toBe('2.20');
  });

  it('very small edge (baseline=-$0.50, edge=$0.01) → $0.008', () => {
    // Journey: -0.50 + (0.01 - (-0.50)) * 0.80 = -0.50 + 0.408 = -0.092 ≤ 0
    // Fallback: max(0, 0.01 * 0.80) = 0.008
    const result = computeTakeProfitThreshold(
      new Decimal('-0.50'),
      new Decimal('0.01'),
    );
    expect(result.toFixed(3)).toBe('0.008');
  });

  it('zero edge (baseline=-$5, edge=$0) → $0.00', () => {
    // Journey: -5 + (0 - (-5)) * 0.80 = -5 + 4 = -1 ≤ 0
    // Fallback: max(0, 0 * 0.80) = max(0, 0) = 0
    const result = computeTakeProfitThreshold(
      new Decimal('-5'),
      new Decimal('0'),
    );
    expect(result.toFixed(2)).toBe('0.00');
  });

  it('legacy position (baseline=$0, edge=$2) → $1.60', () => {
    // Journey: 0 + (2 - 0) * 0.80 = 1.60 > 0 → use journey
    const result = computeTakeProfitThreshold(
      new Decimal('0'),
      new Decimal('2'),
    );
    expect(result.toFixed(2)).toBe('1.60');
  });

  it('extreme ratio (baseline=-$1000, edge=$1) → $0.80', () => {
    // Journey: -1000 + (1 - (-1000)) * 0.80 = -1000 + 800.8 = -199.2 ≤ 0
    // Fallback: max(0, 1 * 0.80) = 0.80
    const result = computeTakeProfitThreshold(
      new Decimal('-1000'),
      new Decimal('1'),
    );
    expect(result.toFixed(2)).toBe('0.80');
  });
});
