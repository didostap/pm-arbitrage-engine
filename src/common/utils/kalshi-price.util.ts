import { PriceLevel } from '../types/normalized-order-book.type.js';

export interface KalshiNormalizedLevels {
  bids: PriceLevel[];
  asks: PriceLevel[];
}

/**
 * Converts raw Kalshi order book levels from cents to decimal probability.
 * YES levels map directly (cents / 100), NO levels invert (1 - cents / 100).
 * Asks are sorted ascending by price; bids preserve input order.
 */
export function normalizeKalshiLevels(
  yesLevels: [number, number][],
  noLevels: [number, number][],
): KalshiNormalizedLevels {
  const bids: PriceLevel[] = yesLevels.map(([priceCents, qty]) => ({
    price: priceCents / 100,
    quantity: qty,
  }));

  const asks: PriceLevel[] = noLevels.map(([priceCents, qty]) => ({
    price: 1 - priceCents / 100,
    quantity: qty,
  }));

  asks.sort((a, b) => a.price - b.price);

  return { bids, asks };
}
