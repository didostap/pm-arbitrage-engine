import { Logger } from '@nestjs/common';
import { createSign, constants as cryptoConstants } from 'crypto';
import WebSocket from 'ws';
import {
  NormalizedOrderBook,
  PlatformId,
  PriceLevel,
} from '../../common/types/index.js';
import { RETRY_STRATEGIES } from '../../common/errors/index.js';
import type {
  KalshiOrderbookDeltaMsg,
  KalshiOrderbookSnapshotMsg,
  KalshiWebSocketMessage,
  LocalOrderbookState,
} from './kalshi.types.js';

/** Raw Kalshi order book format (prices in cents) */
export interface KalshiOrderBook {
  market_ticker: string;
  yes: [number, number][]; // [[price_cents, quantity], ...]
  no: [number, number][]; // [[price_cents, quantity], ...]
  seq?: number; // Optional sequence number for WebSocket
}

export interface KalshiWebSocketConfig {
  apiKeyId: string;
  privateKeyPem: string;
  wsUrl: string;
}

/**
 * WebSocket client for Kalshi real-time orderbook data.
 * Maintains local orderbook state by applying delta updates to snapshots.
 * Reconnects with exponential backoff on disconnect.
 */
export class KalshiWebSocketClient {
  private readonly logger = new Logger(KalshiWebSocketClient.name);
  private ws: WebSocket | null = null;
  private orderbookState = new Map<string, LocalOrderbookState>();
  private lastSequence = new Map<string, number>();
  private subscribers: Array<(book: NormalizedOrderBook) => void> = [];
  private subscriptions = new Set<string>();
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private isConnected = false;
  private shouldReconnect = true;
  private commandId = 0;

  constructor(private readonly config: KalshiWebSocketConfig) {}

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        const wsPath = new URL(this.config.wsUrl).pathname;
        const headers = this.generateAuthHeaders('GET', wsPath);

        this.ws = new WebSocket(this.config.wsUrl, { headers });

        this.ws.on('open', () => {
          this.isConnected = true;
          this.reconnectAttempt = 0;
          this.logger.log({
            message: 'WebSocket connected',
            module: 'connector',
            timestamp: new Date().toISOString(),
            platformId: PlatformId.KALSHI,
          });

          // Resubscribe to all tickers after reconnect
          for (const ticker of this.subscriptions) {
            this.sendSubscribe(ticker);
          }

          resolve();
        });

        this.ws.on('message', (data: WebSocket.Data) => {
          this.handleMessage(data);
        });

        this.ws.on('close', (code: number, reason: Buffer) => {
          this.isConnected = false;
          this.logger.warn({
            message: 'WebSocket disconnected',
            module: 'connector',
            timestamp: new Date().toISOString(),
            platformId: PlatformId.KALSHI,
            metadata: { code, reason: reason.toString() },
          });
          this.scheduleReconnect();
        });

        this.ws.on('error', (error: Error) => {
          this.logger.error({
            message: 'WebSocket error',
            module: 'connector',
            timestamp: new Date().toISOString(),
            platformId: PlatformId.KALSHI,
            metadata: { error: error.message },
          });
          if (!this.isConnected) {
            reject(error instanceof Error ? error : new Error(String(error)));
          }
        });
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  disconnect(): void {
    this.shouldReconnect = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.isConnected = false;
    this.orderbookState.clear();
    this.lastSequence.clear();
  }

  subscribe(ticker: string): void {
    this.subscriptions.add(ticker);
    if (this.isConnected) {
      this.sendSubscribe(ticker);
    }
  }

  unsubscribe(ticker: string): void {
    this.subscriptions.delete(ticker);
    this.orderbookState.delete(ticker);
    this.lastSequence.delete(ticker);
    if (this.isConnected && this.ws) {
      this.ws.send(
        JSON.stringify({
          id: ++this.commandId,
          cmd: 'unsubscribe',
          params: {
            channels: ['orderbook_delta'],
            market_ticker: ticker,
          },
        }),
      );
    }
  }

  onUpdate(callback: (book: NormalizedOrderBook) => void): void {
    this.subscribers.push(callback);
  }

  getConnectionStatus(): boolean {
    return this.isConnected;
  }

  private sendSubscribe(ticker: string): void {
    if (!this.ws) return;
    this.ws.send(
      JSON.stringify({
        id: ++this.commandId,
        cmd: 'subscribe',
        params: {
          channels: ['orderbook_delta'],
          market_ticker: ticker,
        },
      }),
    );
  }

  private handleMessage(data: WebSocket.Data): void {
    try {
      const raw =
        typeof data === 'string'
          ? data
          : Buffer.isBuffer(data)
            ? data.toString('utf-8')
            : Buffer.from(data as ArrayBuffer).toString('utf-8');
      const message = JSON.parse(raw) as KalshiWebSocketMessage;

      switch (message.type) {
        case 'orderbook_snapshot':
          this.handleSnapshot(message.msg as KalshiOrderbookSnapshotMsg);
          break;
        case 'orderbook_delta':
          this.handleDelta(message.msg as KalshiOrderbookDeltaMsg);
          break;
        case 'error':
          this.logger.error({
            message: 'WebSocket server error',
            module: 'connector',
            timestamp: new Date().toISOString(),
            platformId: PlatformId.KALSHI,
            metadata: { msg: message.msg },
          });
          break;
        default:
          break;
      }
    } catch {
      this.logger.warn({
        message: 'Failed to parse WebSocket message',
        module: 'connector',
        timestamp: new Date().toISOString(),
      });
    }
  }

  private handleSnapshot(msg: KalshiOrderbookSnapshotMsg): void {
    const state: LocalOrderbookState = {
      seq: msg.seq,
      yes: [...msg.yes],
      no: [...msg.no],
    };
    this.orderbookState.set(msg.market_ticker, state);
    this.lastSequence.set(msg.market_ticker, msg.seq);
    this.emitUpdate(msg.market_ticker, state);
  }

  private handleDelta(msg: KalshiOrderbookDeltaMsg): void {
    const lastSeq = this.lastSequence.get(msg.market_ticker);

    // Sequence gap detection
    if (lastSeq !== undefined && msg.seq !== lastSeq + 1) {
      this.logger.warn({
        message: 'Sequence gap detected, requesting snapshot',
        module: 'connector',
        timestamp: new Date().toISOString(),
        platformId: PlatformId.KALSHI,
        metadata: {
          ticker: msg.market_ticker,
          expected: lastSeq + 1,
          received: msg.seq,
        },
      });
      // Resubscribe to get a fresh snapshot
      this.sendSubscribe(msg.market_ticker);
      return;
    }

    const state = this.orderbookState.get(msg.market_ticker);
    if (!state) {
      this.sendSubscribe(msg.market_ticker);
      return;
    }

    this.applyDelta(state, msg.price, msg.delta, msg.side);
    state.seq = msg.seq;
    this.lastSequence.set(msg.market_ticker, msg.seq);
    this.emitUpdate(msg.market_ticker, state);
  }

  applyDelta(
    state: LocalOrderbookState,
    price: number,
    delta: number,
    side: 'yes' | 'no',
  ): void {
    const levels = side === 'yes' ? state.yes : state.no;
    const levelIndex = levels.findIndex(([p]) => p === price);

    if (delta > 0) {
      if (levelIndex >= 0) {
        const level = levels[levelIndex];
        if (level) {
          level[1] += delta;
        }
      } else {
        levels.push([price, delta]);
        levels.sort((a, b) => b[0] - a[0]);
      }
    } else if (levelIndex >= 0) {
      const level = levels[levelIndex];
      if (level) {
        level[1] += delta;
        if (level[1] <= 0) {
          levels.splice(levelIndex, 1);
        }
      }
    }
  }

  private emitUpdate(ticker: string, state: LocalOrderbookState): void {
    // Transform YES bids: convert cents to decimal
    const bids: PriceLevel[] = state.yes.map(([priceCents, qty]) => ({
      price: priceCents / 100, // 60¢ → 0.60
      quantity: qty,
    }));

    // Transform NO bids to YES asks: invert and convert to decimal
    // NO bid at 35¢ = someone will sell YES at 65¢ (1 - 0.35)
    const asks: PriceLevel[] = state.no.map(([priceCents, qty]) => ({
      price: 1 - priceCents / 100, // NO 35¢ → YES ask 0.65
      quantity: qty,
    }));

    // Sort asks ascending (lowest ask first)
    asks.sort((a, b) => a.price - b.price);

    const normalized: NormalizedOrderBook = {
      platformId: PlatformId.KALSHI,
      contractId: ticker,
      bids,
      asks,
      timestamp: new Date(),
      sequenceNumber: state.seq,
    };

    for (const sub of this.subscribers) {
      sub(normalized);
    }
  }

  private scheduleReconnect(): void {
    if (!this.shouldReconnect) return;

    const { initialDelayMs, maxDelayMs, backoffMultiplier } =
      RETRY_STRATEGIES.WEBSOCKET_RECONNECT;
    const baseDelay = Math.min(
      initialDelayMs * Math.pow(backoffMultiplier, this.reconnectAttempt),
      maxDelayMs,
    );
    // Add jitter (0.5x–1.5x) to prevent thundering herd
    const delay = Math.min(baseDelay * (0.5 + Math.random()), maxDelayMs);

    this.reconnectAttempt++;

    this.logger.log({
      message: 'Scheduling WebSocket reconnection',
      module: 'connector',
      timestamp: new Date().toISOString(),
      platformId: PlatformId.KALSHI,
      metadata: {
        attempt: this.reconnectAttempt,
        delayMs: delay,
      },
    });

    this.reconnectTimer = setTimeout(() => {
      this.orderbookState.clear();
      this.lastSequence.clear();
      this.connect().catch((err: unknown) => {
        const errMsg = err instanceof Error ? err.message : String(err);
        this.logger.error({
          message: 'WebSocket reconnection failed',
          module: 'connector',
          timestamp: new Date().toISOString(),
          platformId: PlatformId.KALSHI,
          metadata: { error: errMsg, attempt: this.reconnectAttempt },
        });
      });
    }, delay);
  }

  /**
   * Generate RSA-PSS auth headers for WebSocket handshake.
   * Uses Node.js crypto directly since KalshiAuth isn't exported from kalshi-typescript.
   */
  private generateAuthHeaders(
    method: string,
    path: string,
  ): Record<string, string> {
    const timestamp = Date.now().toString();
    const message = `${timestamp}${method}${path}`;

    if (!this.config.privateKeyPem) {
      return {
        'KALSHI-ACCESS-KEY': this.config.apiKeyId,
        'KALSHI-ACCESS-SIGNATURE': '',
        'KALSHI-ACCESS-TIMESTAMP': timestamp,
      };
    }

    const sign = createSign('RSA-SHA256');
    sign.update(message);
    sign.end();

    const signature = sign.sign(
      {
        key: this.config.privateKeyPem,
        padding: cryptoConstants.RSA_PKCS1_PSS_PADDING,
        saltLength: cryptoConstants.RSA_PSS_SALTLEN_DIGEST,
      },
      'base64',
    );

    return {
      'KALSHI-ACCESS-KEY': this.config.apiKeyId,
      'KALSHI-ACCESS-SIGNATURE': signature,
      'KALSHI-ACCESS-TIMESTAMP': timestamp,
    };
  }
}
