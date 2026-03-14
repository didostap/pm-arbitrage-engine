import Decimal from 'decimal.js';

/**
 * Calculate capital deployed for a single leg of a position.
 * Buy-side: size × price (you pay price per contract).
 * Sell-side: size × (1 - price) (your collateral is the complement).
 */
export function calculateLegCapital(
  side: string,
  price: Decimal,
  size: Decimal,
): Decimal {
  const effectivePrice = side === 'sell' ? new Decimal(1).minus(price) : price;
  return size.mul(effectivePrice);
}
