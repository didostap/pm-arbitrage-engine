import type Decimal from 'decimal.js';

export const PRICE_FEED_SERVICE_TOKEN = 'IPriceFeedService';

/**
 * Provides current close prices and fee rates for position P&L enrichment.
 * Consumers inject via PRICE_FEED_SERVICE_TOKEN — never import connectors directly.
 */
export interface IPriceFeedService {
  /**
   * Returns the close price for a position leg:
   *   buy side → best BID (selling to close)
   *   sell side → best ASK (buying to close)
   * Returns null if order book unavailable or empty.
   */
  getCurrentClosePrice(
    platform: string,
    contractId: string,
    side: 'buy' | 'sell',
  ): Promise<Decimal | null>;

  /**
   * Returns the VWAP close price for a position leg, walking order book depth.
   * Returns null if order book unavailable or empty.
   * depthSufficient: false when total available depth < positionSize.
   */
  getVwapClosePrice(
    platform: string,
    contractId: string,
    side: 'buy' | 'sell',
    positionSize: Decimal,
  ): Promise<{ price: Decimal; depthSufficient: boolean } | null>;

  /**
   * Returns the taker fee rate as a decimal (e.g., 0.02 = 2%).
   * Kalshi: dynamic based on fee schedule tier + price.
   * Polymarket: flat rate from config.
   */
  getTakerFeeRate(platform: string, price: Decimal): Decimal;
}
