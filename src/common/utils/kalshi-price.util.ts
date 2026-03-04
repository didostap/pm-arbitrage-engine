import Decimal from 'decimal.js';
import { PriceLevel } from '../types/normalized-order-book.type.js';

export interface KalshiNormalizedLevels {
  bids: PriceLevel[];
  asks: PriceLevel[];
}

/**
 * Converts raw Kalshi order book levels to a unified YES-outcome book (decimal 0–1).
 * YES levels map directly (cents / 100); NO levels become YES asks via (1 - cents/100).
 * Bids are sorted descending (best bid first), asks ascending (best ask first).
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

  bids.sort((a, b) => new Decimal(b.price).minus(a.price).toNumber());
  asks.sort((a, b) => new Decimal(a.price).minus(b.price).toNumber());

  return { bids, asks };
}
