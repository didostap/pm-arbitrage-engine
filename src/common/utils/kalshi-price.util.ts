import Decimal from 'decimal.js';
import { PriceLevel } from '../types/normalized-order-book.type.js';

export interface KalshiNormalizedLevels {
  bids: PriceLevel[];
  asks: PriceLevel[];
}

/**
 * Converts raw Kalshi order book levels to a unified YES-outcome book (decimal 0–1).
 * YES levels map directly (dollar strings); NO levels become YES asks via (1 - priceDollars).
 * Bids are sorted descending (best bid first), asks ascending (best ask first).
 *
 * Input: [priceDollars, quantityFp] string tuples from Kalshi fixed-point API.
 * All arithmetic uses decimal.js internally; results are converted to number
 * at the interface boundary (.toNumber()) to keep NormalizedOrderBookLevel stable.
 */
export function normalizeKalshiLevels(
  yesLevels: [string, string][],
  noLevels: [string, string][],
): KalshiNormalizedLevels {
  const bids: PriceLevel[] = yesLevels.map(([priceDollars, qtyStr]) => ({
    price: new Decimal(priceDollars).toNumber(),
    quantity: new Decimal(qtyStr).toNumber(),
  }));

  const asks: PriceLevel[] = noLevels.map(([priceDollars, qtyStr]) => ({
    price: new Decimal(1).minus(new Decimal(priceDollars)).toNumber(),
    quantity: new Decimal(qtyStr).toNumber(),
  }));

  bids.sort((a, b) => new Decimal(b.price).comparedTo(a.price));
  asks.sort((a, b) => new Decimal(a.price).comparedTo(b.price));

  return { bids, asks };
}
