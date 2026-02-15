/** Polymarket-specific types for WebSocket and API interactions. */

/** Polymarket fee structure (CLOB fees, excludes on-chain gas) */
export const POLYMARKET_TAKER_FEE = 0.02; // 2% taker fee
export const POLYMARKET_MAKER_FEE = 0.0; // 0% maker fee

export interface PolymarketWebSocketConfig {
  wsUrl: string;
}

export interface PolymarketOrderBookMessage {
  asset_id: string;
  market: string;
  timestamp: number;
  bids: Array<{ price: string; size: string }>;
  asks: Array<{ price: string; size: string }>;
  hash: string;
}

export interface PolymarketPriceChangeMessage {
  asset_id: string;
  price: string;
  timestamp: number;
}

export interface PolymarketApiCredentials {
  key: string;
  secret: string;
  passphrase: string;
}
