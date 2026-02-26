/** Polymarket-specific types for WebSocket and API interactions. */

/** Polymarket fee structure (CLOB fees, excludes on-chain gas) */
export const POLYMARKET_TAKER_FEE = 0.02; // 2% taker fee
export const POLYMARKET_MAKER_FEE = 0.0; // 0% maker fee

export interface PolymarketWebSocketConfig {
  wsUrl: string;
  eventEmitter: import('@nestjs/event-emitter').EventEmitter2;
}

export interface PolymarketOrderBookMessage {
  asset_id: string;
  market: string;
  timestamp: number;
  bids: Array<{ price: string; size: string }>;
  asks: Array<{ price: string; size: string }>;
  hash: string;
}

/**
 * Individual price change entry within a price_change WebSocket message.
 * Contains trade info + updated top-of-book after the trade.
 */
export interface PolymarketPriceChangeEntry {
  asset_id: string;
  price: string;
  size: string;
  side: string;
  hash: string;
  best_bid: string;
  best_ask: string;
}

/**
 * Polymarket WebSocket `price_change` message.
 * Sent when a trade occurs — contains updated best bid/ask for affected assets.
 * Note: `price_changes` is an array (one entry per affected asset in the market).
 */
export interface PolymarketPriceChangeMessage {
  market: string;
  price_changes: PolymarketPriceChangeEntry[];
  timestamp: string;
  event_type: 'price_change';
}

export interface PolymarketApiCredentials {
  key: string;
  secret: string;
  passphrase: string;
}
