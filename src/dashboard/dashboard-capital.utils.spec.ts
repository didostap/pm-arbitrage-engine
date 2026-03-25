import { describe, it, expect } from 'vitest';
import Decimal from 'decimal.js';
import { computeModeCapital } from './dashboard-capital.utils';

describe('computeModeCapital', () => {
  it('should compute bankroll, deployed, available, reserved', () => {
    const result = computeModeCapital('10000', {
      totalCapitalDeployed: new Decimal('500'),
      reservedCapital: new Decimal('100'),
    });

    expect(result.bankroll).toBe('10000');
    expect(result.deployed).toBe('500');
    expect(result.reserved).toBe('100');
    expect(result.available).toBe('9400');
  });

  it('should floor available at zero when over-deployed', () => {
    const result = computeModeCapital('10000', {
      totalCapitalDeployed: new Decimal('9000'),
      reservedCapital: new Decimal('2000'),
    });

    expect(result.available).toBe('0');
  });

  it('should handle null risk state', () => {
    const result = computeModeCapital('10000', null);

    expect(result.deployed).toBe('0');
    expect(result.reserved).toBe('0');
    expect(result.available).toBe('10000');
  });

  it('should handle undefined risk state', () => {
    const result = computeModeCapital('5000');

    expect(result.bankroll).toBe('5000');
    expect(result.deployed).toBe('0');
    expect(result.reserved).toBe('0');
    expect(result.available).toBe('5000');
  });

  it('should handle Prisma Decimal fields via toString()', () => {
    const prismaDecimal = { toString: () => '1234.56' };
    const result = computeModeCapital('10000', {
      totalCapitalDeployed: prismaDecimal,
      reservedCapital: prismaDecimal,
    });

    expect(result.deployed).toBe('1234.56');
    expect(result.reserved).toBe('1234.56');
    expect(result.available).toBe('7530.88');
  });
});
