import Decimal from 'decimal.js';

export interface DepthLevel {
  price: Decimal;
  size: Decimal;
}

/**
 * Parses JSON depth levels from Prisma Json columns into typed Decimal values.
 * Input: Array<{ price: string; size: string }> (as stored in HistoricalDepth.bids/asks)
 * Output: Array<{ price: Decimal; size: Decimal }>
 */
export function parseJsonDepthLevels(
  levels: Array<Record<string, unknown>>,
): DepthLevel[] {
  return levels
    .filter(
      (l): l is Record<string, string | number> =>
        l != null &&
        l.price !== undefined &&
        l.price !== null &&
        l.size !== undefined &&
        l.size !== null &&
        (typeof l.price === 'string' || typeof l.price === 'number') &&
        (typeof l.size === 'string' || typeof l.size === 'number') &&
        isNumericValue(l.price) &&
        isNumericValue(l.size),
    )
    .map((l) => ({
      price: new Decimal(String(l.price)),
      size: new Decimal(String(l.size)),
    }));
}

function isNumericValue(v: string | number): boolean {
  const s = String(v);
  if (s === '' || s === 'NaN' || s === 'Infinity' || s === '-Infinity')
    return false;
  try {
    new Decimal(s);
    return true;
  } catch {
    return false;
  }
}
