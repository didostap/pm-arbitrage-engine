/** Polymarket error codes (range 1008-1099 within PlatformApiError 1000-1999). */
export const POLYMARKET_ERROR_CODES = {
  /** L1/L2 auth failure — critical, no retry */
  UNAUTHORIZED: 1008,
  /** Rate limited — warning, use RETRY_STRATEGIES.RATE_LIMIT */
  RATE_LIMIT: 1009,
  /** Bad request — error, no retry */
  INVALID_REQUEST: 1010,
  /** Token ID not found — warning, no retry */
  MARKET_NOT_FOUND: 1011,
  /** createOrDeriveApiKey() failed — critical, retry once */
  API_KEY_DERIVATION_FAILED: 1012,
  /** WebSocket connection error — warning, use WEBSOCKET_RECONNECT */
  WEBSOCKET_ERROR: 1013,
  /** Order book data staleness detected — warning, no retry */
  STALE_DATA: 1014,
  /** Connector not connected — error, no retry */
  NOT_CONNECTED: 1015,
  /** Gas estimation failed (RPC or CoinGecko) — warning, fallback to config */
  GAS_ESTIMATION_FAILED: 1016,
  /** Method not implemented — warning, no retry */
  NOT_IMPLEMENTED: 1017,
} as const;
