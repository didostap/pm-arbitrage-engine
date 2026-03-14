import Decimal from 'decimal.js';
import { describe, expect, it } from 'vitest';

import { calculateLegCapital } from './capital.js';

describe('calculateLegCapital', () => {
  it('buy-side: size × price', () => {
    expect(
      calculateLegCapital('buy', new Decimal('0.60'), new Decimal('100')),
    ).toEqual(new Decimal('60'));
  });

  it('sell-side: size × (1 - price)', () => {
    expect(
      calculateLegCapital('sell', new Decimal('0.60'), new Decimal('100')),
    ).toEqual(new Decimal('40'));
  });

  it('sell near 1.0: minimal capital', () => {
    expect(
      calculateLegCapital('sell', new Decimal('0.99'), new Decimal('100')),
    ).toEqual(new Decimal('1'));
  });

  it('sell near 0.0: near-full capital', () => {
    expect(
      calculateLegCapital('sell', new Decimal('0.01'), new Decimal('100')),
    ).toEqual(new Decimal('99'));
  });

  it('buy at 0.5: symmetric', () => {
    expect(
      calculateLegCapital('buy', new Decimal('0.50'), new Decimal('200')),
    ).toEqual(new Decimal('100'));
  });

  it('sell at 0.5: symmetric', () => {
    expect(
      calculateLegCapital('sell', new Decimal('0.50'), new Decimal('200')),
    ).toEqual(new Decimal('100'));
  });

  it('zero price buy: zero capital', () => {
    expect(
      calculateLegCapital('buy', new Decimal('0'), new Decimal('100')),
    ).toEqual(new Decimal('0'));
  });

  it('zero price sell: full capital', () => {
    expect(
      calculateLegCapital('sell', new Decimal('0'), new Decimal('100')),
    ).toEqual(new Decimal('100'));
  });
});
