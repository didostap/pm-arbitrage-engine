export interface DepthLevel {
  price: number;
  size: number;
}

/**
 * Parses JSON depth levels from Prisma Json columns into native numbers.
 * Input: Array<{ price: string; size: string }> (as stored in HistoricalDepth.bids/asks)
 * Output: Array<{ price: number; size: number }>
 *
 * Native number is used because depth levels feed VWAP fill estimation,
 * not financial settlement — Decimal precision is unnecessary here.
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
      price: Number(l.price),
      size: Number(l.size),
    }));
}

function isNumericValue(v: string | number): boolean {
  const n = Number(v);
  return Number.isFinite(n);
}
