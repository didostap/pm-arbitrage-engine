import Decimal from 'decimal.js';
import { PriceLevel } from '../types/normalized-order-book.type.js';

export interface KalshiNormalizedLevels {
  bids: PriceLevel[];
  asks: PriceLevel[];
}

/**
 * Converts raw Kalshi order book levels from cents to decimal probability.
 * YES levels map directly (cents / 100), NO levels invert (1 - cents / 100).
 * Asks are sorted ascending by price; bids preserve input order.
 *
 * All arithmetic uses decimal.js internally; results are converted to number
 * at the interface boundary (.toNumber()) to keep NormalizedOrderBookLevel stable.
 */
export function normalizeKalshiLevels(
  yesLevels: [number, number][],
  noLevels: [number, number][],
): KalshiNormalizedLevels {
  const bids: PriceLevel[] = yesLevels.map(([priceCents, qty]) => ({
    price: new Decimal(priceCents.toString()).div(100).toNumber(),
    quantity: qty,
  }));

  const asks: PriceLevel[] = noLevels.map(([priceCents, qty]) => ({
    price: new Decimal(1)
      .minus(new Decimal(priceCents.toString()).div(100))
      .toNumber(),
    quantity: qty,
  }));

  asks.sort((a, b) => new Decimal(a.price).minus(b.price).toNumber());

  return { bids, asks };
}
