import { describe, it, expect } from 'vitest';
import Decimal from 'decimal.js';
import {
  computeTakeProfitThreshold,
  calculateExitProximity,
} from './exit-thresholds';

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

describe('calculateExitProximity', () => {
  it('mid-range value (TP direction)', () => {
    // baseline=0, target=10, currentPnl=5 → (5 - 0) / (10 - 0) = 0.5
    const result = calculateExitProximity(
      new Decimal('5'),
      new Decimal('0'),
      new Decimal('10'),
    );
    expect(result.toNumber()).toBe(0.5);
  });

  it('at-threshold returns 1', () => {
    // currentPnl = target → (10 - 0) / (10 - 0) = 1
    const result = calculateExitProximity(
      new Decimal('10'),
      new Decimal('0'),
      new Decimal('10'),
    );
    expect(result.toNumber()).toBe(1);
  });

  it('at-baseline returns 0', () => {
    // currentPnl = baseline → (0 - 0) / (10 - 0) = 0
    const result = calculateExitProximity(
      new Decimal('0'),
      new Decimal('0'),
      new Decimal('10'),
    );
    expect(result.toNumber()).toBe(0);
  });

  it('beyond-threshold clamps to 1', () => {
    // currentPnl = 15, target = 10 → (15 - 0) / (10 - 0) = 1.5 → clamp 1
    const result = calculateExitProximity(
      new Decimal('15'),
      new Decimal('0'),
      new Decimal('10'),
    );
    expect(result.toNumber()).toBe(1);
  });

  it('beyond-baseline clamps to 0', () => {
    // currentPnl = -5, baseline = 0, target = 10 → (-5 - 0) / (10 - 0) = -0.5 → clamp 0
    const result = calculateExitProximity(
      new Decimal('-5'),
      new Decimal('0'),
      new Decimal('10'),
    );
    expect(result.toNumber()).toBe(0);
  });

  it('zero denominator (target === baseline) returns 0', () => {
    const result = calculateExitProximity(
      new Decimal('5'),
      new Decimal('3'),
      new Decimal('3'),
    );
    expect(result.toNumber()).toBe(0);
  });

  it('SL direction: target < baseline — proximity rises as PnL drops', () => {
    // baseline = -2, target = -4.4 (SL), currentPnl = -3.2
    // (currentPnl - baseline) / (target - baseline) = (-3.2 - (-2)) / (-4.4 - (-2)) = -1.2 / -2.4 = 0.5
    const result = calculateExitProximity(
      new Decimal('-3.2'),
      new Decimal('-2'),
      new Decimal('-4.4'),
    );
    expect(result.toNumber()).toBe(0.5);
  });

  it('TP direction: target > baseline — proximity rises as PnL rises', () => {
    // baseline = -2, target = 0.56, currentPnl = -0.72
    // (-0.72 - (-2)) / (0.56 - (-2)) = 1.28 / 2.56 = 0.5
    const result = calculateExitProximity(
      new Decimal('-0.72'),
      new Decimal('-2'),
      new Decimal('0.56'),
    );
    expect(result.toNumber()).toBe(0.5);
  });
});
