/** Kalshi WebSocket message types for orderbook updates. */

export interface KalshiOrderbookSnapshotMsg {
  seq: number;
  market_ticker: string;
  yes: Array<[number, number]>;
  no: Array<[number, number]>;
}

export interface KalshiOrderbookDeltaMsg {
  seq: number;
  market_ticker: string;
  price: number;
  delta: number;
  side: 'yes' | 'no';
}

export interface KalshiWebSocketMessage {
  type: 'orderbook_snapshot' | 'orderbook_delta' | 'subscribed' | 'error';
  sid: number;
  msg: KalshiOrderbookSnapshotMsg | KalshiOrderbookDeltaMsg;
}

export interface KalshiSubscribeCommand {
  id: number;
  cmd: 'subscribe' | 'unsubscribe';
  params: {
    channels: string[];
    market_ticker: string;
  };
}

export interface LocalOrderbookState {
  seq: number;
  yes: Array<[number, number]>;
  no: Array<[number, number]>;
}
