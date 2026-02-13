import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { readFileSync } from 'fs';
import { Configuration, MarketApi } from 'kalshi-typescript';
import type { IPlatformConnector } from '../../common/interfaces/index.js';
import type {
  CancelResult,
  FeeSchedule,
  NormalizedOrderBook,
  OrderParams,
  OrderResult,
  PlatformHealth,
  Position,
} from '../../common/types/index.js';
import { PlatformId } from '../../common/types/index.js';
import {
  KALSHI_ERROR_CODES,
  PlatformApiError,
  RETRY_STRATEGIES,
} from '../../common/errors/index.js';
import { withRetry } from '../../common/utils/index.js';
import { RateLimiter } from '../../common/utils/rate-limiter.js';
import { KalshiWebSocketClient } from './kalshi-websocket.client.js';

@Injectable()
export class KalshiConnector implements IPlatformConnector, OnModuleDestroy {
  private readonly logger = new Logger(KalshiConnector.name);
  private readonly marketApi: MarketApi;
  private readonly wsClient: KalshiWebSocketClient;
  private readonly rateLimiter: RateLimiter;
  private lastHeartbeat: Date | null = null;
  private connected = false;

  constructor(private readonly configService: ConfigService) {
    const apiKeyId = this.configService.get<string>('KALSHI_API_KEY_ID', '');
    const privateKeyPath = this.configService.get<string>(
      'KALSHI_PRIVATE_KEY_PATH',
      '',
    );
    const baseUrl = this.configService.get<string>(
      'KALSHI_API_BASE_URL',
      'https://demo-api.kalshi.co/trade-api/v2',
    );

    let privateKeyPem = '';
    if (privateKeyPath) {
      try {
        privateKeyPem = readFileSync(privateKeyPath, 'utf-8');
      } catch {
        this.logger.warn({
          message: 'Could not read private key file; authentication will fail',
          module: 'connector',
          timestamp: new Date().toISOString(),
          platformId: PlatformId.KALSHI,
          metadata: { path: privateKeyPath },
        });
      }
    }

    const config = new Configuration({
      apiKey: apiKeyId,
      privateKeyPem,
      basePath: baseUrl,
    });

    this.marketApi = new MarketApi(config);

    this.wsClient = new KalshiWebSocketClient({
      apiKeyId,
      privateKeyPem,
      wsUrl: `${baseUrl.replace('https://', 'wss://')}/trade-api/v2/ws`,
    });

    this.rateLimiter = RateLimiter.fromTier('BASIC', this.logger);
  }

  async connect(): Promise<void> {
    this.logger.log({
      message: 'Connecting to Kalshi',
      module: 'connector',
      timestamp: new Date().toISOString(),
      platformId: PlatformId.KALSHI,
    });

    try {
      await this.wsClient.connect();
      this.connected = true;
      this.lastHeartbeat = new Date();

      this.logger.log({
        message: 'Kalshi connection established',
        module: 'connector',
        timestamp: new Date().toISOString(),
        platformId: PlatformId.KALSHI,
        metadata: {
          websocketConnected: true,
        },
      });
    } catch (error) {
      this.connected = false;
      throw this.mapError(error);
    }
  }

  disconnect(): Promise<void> {
    this.logger.log({
      message: 'Disconnecting from Kalshi',
      module: 'connector',
      timestamp: new Date().toISOString(),
      platformId: PlatformId.KALSHI,
    });

    this.wsClient.disconnect();
    this.connected = false;
    return Promise.resolve();
  }

  async onModuleDestroy(): Promise<void> {
    await this.disconnect();
  }

  async getOrderBook(contractId: string): Promise<NormalizedOrderBook> {
    await this.rateLimiter.acquireRead();

    try {
      const response = await withRetry(
        () => this.marketApi.getMarketOrderbook(contractId, 10),
        RETRY_STRATEGIES.NETWORK_ERROR,
        (attempt, error) => {
          this.logger.warn({
            message: 'Retrying getMarketOrderbook',
            module: 'connector',
            timestamp: new Date().toISOString(),
            platformId: PlatformId.KALSHI,
            metadata: { contractId, attempt, error: error.message },
          });
        },
      );

      this.lastHeartbeat = new Date();
      const orderbook = response.data.orderbook;

      // Normalize: convert cents to decimal, transform NO bids to YES asks
      const yesBids = orderbook?.true ?? [];
      const noBids = orderbook?.false ?? [];

      // YES bids → bids (convert cents to decimal)
      const bids = yesBids.map(([priceCents, quantity]: number[]) => ({
        price: (priceCents ?? 0) / 100, // 60¢ → 0.60
        quantity: quantity ?? 0,
      }));

      // NO bids → asks (invert and convert: NO 35¢ → YES ask 0.65)
      const asks = noBids.map(([priceCents, quantity]: number[]) => ({
        price: 1 - (priceCents ?? 0) / 100,
        quantity: quantity ?? 0,
      }));

      // Sort asks ascending
      asks.sort((a, b) => a.price - b.price);

      return {
        platformId: PlatformId.KALSHI,
        contractId,
        bids,
        asks,
        timestamp: new Date(),
      };
    } catch (error) {
      throw this.mapError(error);
    }
  }

  getPositions(): Promise<Position[]> {
    throw new Error('getPositions not implemented - Epic 5 Story 5.1');
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  submitOrder(_params: OrderParams): Promise<OrderResult> {
    throw new Error('submitOrder not implemented - Epic 5 Story 5.1');
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  cancelOrder(_orderId: string): Promise<CancelResult> {
    throw new Error('cancelOrder not implemented - Epic 5 Story 5.1');
  }

  getHealth(): PlatformHealth {
    const wsConnected = this.wsClient.getConnectionStatus();
    let status: PlatformHealth['status'] = 'disconnected';
    if (this.connected && wsConnected) {
      status = 'healthy';
    } else if (this.connected || wsConnected) {
      status = 'degraded';
    }

    return {
      platformId: PlatformId.KALSHI,
      status,
      lastHeartbeat: this.lastHeartbeat,
      latencyMs: null,
    };
  }

  getPlatformId(): PlatformId {
    return PlatformId.KALSHI;
  }

  getFeeSchedule(): FeeSchedule {
    return {
      platformId: PlatformId.KALSHI,
      makerFeePercent: 0,
      takerFeePercent: 0,
      description: 'Kalshi charges no trading fees for standard contracts',
    };
  }

  onOrderBookUpdate(callback: (book: NormalizedOrderBook) => void): void {
    this.wsClient.onUpdate(callback);
  }

  subscribeToTicker(ticker: string): void {
    this.wsClient.subscribe(ticker);
  }

  private mapError(error: unknown): PlatformApiError {
    if (error instanceof PlatformApiError) return error;

    const message = error instanceof Error ? error.message : String(error);

    // Map common API error patterns to specific codes
    if (message.includes('UNAUTHORIZED') || message.includes('401')) {
      return new PlatformApiError(
        KALSHI_ERROR_CODES.UNAUTHORIZED,
        message,
        PlatformId.KALSHI,
        'critical',
      );
    }
    if (message.includes('429') || message.includes('rate limit')) {
      return new PlatformApiError(
        KALSHI_ERROR_CODES.RATE_LIMIT_EXCEEDED,
        message,
        PlatformId.KALSHI,
        'warning',
        RETRY_STRATEGIES.RATE_LIMIT,
      );
    }
    if (message.includes('not found') || message.includes('404')) {
      return new PlatformApiError(
        KALSHI_ERROR_CODES.MARKET_NOT_FOUND,
        message,
        PlatformId.KALSHI,
        'warning',
      );
    }

    return new PlatformApiError(
      KALSHI_ERROR_CODES.INVALID_REQUEST,
      message,
      PlatformId.KALSHI,
      'error',
    );
  }
}
