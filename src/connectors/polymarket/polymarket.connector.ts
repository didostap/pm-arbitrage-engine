import Decimal from 'decimal.js';
import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ClobClient, Side } from '@polymarket/clob-client';
import { Wallet } from '@ethersproject/wallet';
import type { IPlatformConnector } from '../../common/interfaces/index.js';
import type {
  CancelResult,
  FeeSchedule,
  NormalizedOrderBook,
  OrderParams,
  OrderResult,
  OrderStatusResult,
  PlatformHealth,
  Position,
} from '../../common/types/index.js';
import { PlatformId } from '../../common/types/index.js';
import {
  PlatformApiError,
  RETRY_STRATEGIES,
} from '../../common/errors/index.js';
import { withRetry } from '../../common/utils/index.js';
import { RateLimiter } from '../../common/utils/rate-limiter.js';
import { OrderBookNormalizerService } from '../../modules/data-ingestion/order-book-normalizer.service.js';
import { POLYMARKET_ERROR_CODES } from './polymarket-error-codes.js';
import { GasEstimationService } from './gas-estimation.service.js';
import { PolymarketWebSocketClient } from './polymarket-websocket.client.js';
import type { PolymarketOrderBookMessage } from './polymarket.types.js';
import {
  POLYMARKET_MAKER_FEE,
  POLYMARKET_TAKER_FEE,
} from './polymarket.types.js';

@Injectable()
export class PolymarketConnector
  implements IPlatformConnector, OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PolymarketConnector.name);
  private readonly rateLimiter: RateLimiter;
  private clobClient: ClobClient | null = null;
  private wsClient: PolymarketWebSocketClient | null = null;
  private connected = false;
  private lastHeartbeat: Date | null = null;

  private readonly privateKey: string;
  private readonly clobApiUrl: string;
  private readonly wsUrl: string;
  private readonly chainId: number;

  constructor(
    private readonly configService: ConfigService,
    private readonly normalizer: OrderBookNormalizerService,
    private readonly gasEstimation: GasEstimationService,
  ) {
    this.privateKey = this.configService.get<string>(
      'POLYMARKET_PRIVATE_KEY',
      '',
    );
    this.clobApiUrl = this.configService.get<string>(
      'POLYMARKET_CLOB_API_URL',
      'https://clob.polymarket.com',
    );
    this.wsUrl = this.configService.get<string>(
      'POLYMARKET_WS_URL',
      'wss://ws-subscriptions-clob.polymarket.com/ws/market',
    );
    this.chainId = this.configService.get<number>('POLYMARKET_CHAIN_ID', 137);

    // Conservative rate limits: 10 read/s, 5 write/s with 20% safety buffer
    this.rateLimiter = new RateLimiter(8, 4, 1, this.logger);
  }

  async onModuleInit(): Promise<void> {
    if (this.privateKey) {
      await this.connect();
    } else {
      this.logger.warn({
        message:
          'POLYMARKET_PRIVATE_KEY not configured; Polymarket connector will not connect',
        module: 'connector',
        timestamp: new Date().toISOString(),
        platformId: PlatformId.POLYMARKET,
      });
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.disconnect();
  }

  async connect(): Promise<void> {
    this.logger.log({
      message: 'Connecting to Polymarket CLOB API',
      module: 'connector',
      timestamp: new Date().toISOString(),
      platformId: PlatformId.POLYMARKET,
    });

    try {
      // Step 1: Create wallet signer from private key
      let signer: Wallet;
      try {
        signer = new Wallet(this.privateKey);
      } catch (error) {
        throw new PlatformApiError(
          POLYMARKET_ERROR_CODES.UNAUTHORIZED,
          `Invalid private key: ${error instanceof Error ? error.message : String(error)}`,
          PlatformId.POLYMARKET,
          'critical',
        );
      }

      // Step 2: Create temporary client for API key derivation
      const tempClient = new ClobClient(this.clobApiUrl, this.chainId, signer);

      // Step 3: Derive API credentials (L1 → L2)
      // NOTE: @polymarket/clob-client swallows HTTP errors in its error handler
      // and returns { error: string, status: number } instead of throwing.
      // This means createOrDeriveApiKey() returns { key: undefined, secret: undefined, passphrase: undefined }
      // on auth failure. We must validate the returned credentials explicitly.
      let apiCreds: { key: string; secret: string; passphrase: string };
      try {
        apiCreds = await tempClient.createOrDeriveApiKey();
      } catch (error) {
        throw new PlatformApiError(
          POLYMARKET_ERROR_CODES.API_KEY_DERIVATION_FAILED,
          `API key derivation failed: ${error instanceof Error ? error.message : String(error)}`,
          PlatformId.POLYMARKET,
          'critical',
          {
            maxRetries: 1,
            initialDelayMs: 1000,
            maxDelayMs: 1000,
            backoffMultiplier: 1,
          },
        );
      }

      if (!apiCreds?.key || !apiCreds?.secret || !apiCreds?.passphrase) {
        throw new PlatformApiError(
          POLYMARKET_ERROR_CODES.API_KEY_DERIVATION_FAILED,
          'API key derivation returned invalid credentials (key/secret/passphrase undefined). Check POLYMARKET_PRIVATE_KEY configuration.',
          PlatformId.POLYMARKET,
          'critical',
        );
      }

      this.logger.log({
        message: 'API credentials derived successfully',
        module: 'connector',
        timestamp: new Date().toISOString(),
        platformId: PlatformId.POLYMARKET,
      });

      // Step 4: Create authenticated client with signatureType=0 (EOA)
      this.clobClient = new ClobClient(
        this.clobApiUrl,
        this.chainId,
        signer,
        apiCreds,
        0, // SignatureType.EOA
      );

      // Step 5: Initialize WebSocket client
      this.wsClient = new PolymarketWebSocketClient({ wsUrl: this.wsUrl });
      await this.wsClient.connect();

      this.connected = true;
      this.lastHeartbeat = new Date();

      this.logger.log({
        message: 'Polymarket connection established',
        module: 'connector',
        timestamp: new Date().toISOString(),
        platformId: PlatformId.POLYMARKET,
        metadata: { websocketConnected: true },
      });
    } catch (error) {
      this.connected = false;
      if (error instanceof PlatformApiError) throw error;
      throw this.mapError(error);
    }
  }

  disconnect(): Promise<void> {
    this.logger.log({
      message: 'Disconnecting from Polymarket',
      module: 'connector',
      timestamp: new Date().toISOString(),
      platformId: PlatformId.POLYMARKET,
    });

    if (this.wsClient) {
      this.wsClient.disconnect();
      this.wsClient = null;
    }
    this.clobClient = null;
    this.connected = false;
    return Promise.resolve();
  }

  async getOrderBook(contractId: string): Promise<NormalizedOrderBook> {
    if (!this.clobClient) {
      throw new PlatformApiError(
        POLYMARKET_ERROR_CODES.UNAUTHORIZED,
        'ClobClient not initialized — call connect() first',
        PlatformId.POLYMARKET,
        'critical',
      );
    }

    await this.rateLimiter.acquireRead();

    try {
      const response = await withRetry(
        () => this.clobClient!.getOrderBook(contractId),
        RETRY_STRATEGIES.NETWORK_ERROR,
        (attempt, error) => {
          this.logger.warn({
            message: 'Retrying getOrderBook',
            module: 'connector',
            timestamp: new Date().toISOString(),
            platformId: PlatformId.POLYMARKET,
            metadata: { contractId, attempt, error: error.message },
          });
        },
      );

      this.lastHeartbeat = new Date();

      // Convert raw CLOB response to PolymarketOrderBookMessage
      const rawBook: PolymarketOrderBookMessage = {
        asset_id: contractId,
        market: '',
        timestamp: Date.now(),
        bids: response.bids ?? [],
        asks: response.asks ?? [],
        hash: '',
      };

      // Normalize via service (parsing + validation + latency tracking)
      const normalized = this.normalizer.normalizePolymarket(rawBook);

      if (!normalized) {
        this.logger.error({
          message: 'Failed to normalize Polymarket order book',
          module: 'connector',
          timestamp: new Date().toISOString(),
          platformId: PlatformId.POLYMARKET,
          metadata: { contractId },
        });
        throw new PlatformApiError(
          POLYMARKET_ERROR_CODES.INVALID_REQUEST,
          'Invalid order book data from Polymarket API',
          PlatformId.POLYMARKET,
          'error',
        );
      }

      return normalized;
    } catch (error) {
      if (error instanceof PlatformApiError) throw error;
      throw this.mapError(error);
    }
  }

  onOrderBookUpdate(callback: (book: NormalizedOrderBook) => void): void {
    if (this.wsClient) {
      this.wsClient.onUpdate((rawBook: PolymarketOrderBookMessage) => {
        // Normalize raw platform data before invoking callback
        const normalized = this.normalizer.normalizePolymarket(rawBook);

        if (!normalized) {
          this.logger.error({
            message: 'Discarding invalid Polymarket book from WebSocket',
            module: 'connector',
            timestamp: new Date().toISOString(),
            platformId: PlatformId.POLYMARKET,
            metadata: { contractId: rawBook.asset_id },
          });
          return; // Skip callback, don't propagate invalid data
        }

        callback(normalized); // Only invoke callback with valid normalized data
      });
    }
  }

  getHealth(): PlatformHealth {
    const wsConnected = this.wsClient?.getConnectionStatus() ?? false;
    let status: PlatformHealth['status'] = 'disconnected';
    if (this.connected && wsConnected) {
      status = 'healthy';
    } else if (this.connected || wsConnected) {
      status = 'degraded';
    }

    return {
      platformId: PlatformId.POLYMARKET,
      status,
      lastHeartbeat: this.lastHeartbeat,
      latencyMs: null,
    };
  }

  getPlatformId(): PlatformId {
    return PlatformId.POLYMARKET;
  }

  getFeeSchedule(): FeeSchedule {
    return {
      platformId: PlatformId.POLYMARKET,
      makerFeePercent: new Decimal(POLYMARKET_MAKER_FEE).mul(100).toNumber(), // Convert decimal (0.00) to percent (0)
      takerFeePercent: new Decimal(POLYMARKET_TAKER_FEE).mul(100).toNumber(), // Convert decimal (0.02) to percent (2)
      gasEstimateUsd: this.gasEstimation.getGasEstimateUsd().toNumber(),
      description:
        'Polymarket: ~2% taker fee, 0% maker fee. Gas estimate includes 20% buffer for on-chain settlement.',
    };
  }

  getPositions(): Promise<Position[]> {
    throw new Error('getPositions not implemented - Epic 5');
  }

  async submitOrder(params: OrderParams): Promise<OrderResult> {
    if (!this.connected || !this.clobClient) {
      throw new PlatformApiError(
        POLYMARKET_ERROR_CODES.NOT_CONNECTED,
        'Polymarket connector not connected',
        PlatformId.POLYMARKET,
        'error',
      );
    }

    await this.rateLimiter.acquireWrite();

    try {
      // Polymarket prices are already decimal (0.00-1.00), no conversion needed
      // Create and post order via CLOB client
      const orderPayload = await this.clobClient.createOrder({
        tokenID: params.contractId,
        price: params.price,
        side: params.side === 'buy' ? Side.BUY : Side.SELL,
        size: params.quantity,
      });

      const postResponse = (await this.clobClient.postOrder(
        orderPayload,
      )) as Record<string, unknown>;

      this.lastHeartbeat = new Date();

      // Extract order ID from response
      const orderId =
        (postResponse.orderID as string | undefined) ??
        (postResponse.id as string | undefined) ??
        `pm-${Date.now()}`;

      // Check if order was immediately matched
      const status = postResponse.status as string | undefined;

      if (status === 'matched' || status === 'filled') {
        return {
          orderId,
          platformId: PlatformId.POLYMARKET,
          status: 'filled',
          filledQuantity: params.quantity,
          filledPrice: params.price,
          timestamp: new Date(),
        };
      }

      // Poll for fill with 5-second timeout
      const ORDER_POLL_TIMEOUT_MS = 5000;
      const ORDER_POLL_INTERVAL_MS = 500;
      const startTime = Date.now();

      while (Date.now() - startTime < ORDER_POLL_TIMEOUT_MS) {
        await new Promise((resolve) =>
          setTimeout(resolve, ORDER_POLL_INTERVAL_MS),
        );

        try {
          const orderStatus = await this.clobClient.getOrder(orderId);
          const currentStatus = (orderStatus as { status?: string }).status;

          if (currentStatus === 'matched' || currentStatus === 'filled') {
            const filledSize =
              (orderStatus as { filledSize?: number }).filledSize ??
              params.quantity;
            const filledPrice =
              (orderStatus as { filledPrice?: number }).filledPrice ??
              params.price;

            return {
              orderId,
              platformId: PlatformId.POLYMARKET,
              status: 'filled',
              filledQuantity: filledSize,
              filledPrice,
              timestamp: new Date(),
            };
          }

          if (
            currentStatus === 'canceled' ||
            currentStatus === 'cancelled' ||
            currentStatus === 'rejected'
          ) {
            return {
              orderId,
              platformId: PlatformId.POLYMARKET,
              status: 'rejected',
              filledQuantity: 0,
              filledPrice: 0,
              timestamp: new Date(),
            };
          }
        } catch {
          // Poll error — continue polling
        }
      }

      // Timeout — return pending status
      this.logger.warn({
        message: 'Polymarket order pending after 5s timeout',
        module: 'connector',
        timestamp: new Date().toISOString(),
        platformId: PlatformId.POLYMARKET,
        metadata: { orderId, contractId: params.contractId },
      });

      return {
        orderId,
        platformId: PlatformId.POLYMARKET,
        status: 'pending',
        filledQuantity: 0,
        filledPrice: 0,
        timestamp: new Date(),
      };
    } catch (error) {
      throw this.mapError(error);
    }
  }

  async cancelOrder(orderId: string): Promise<CancelResult> {
    if (!this.connected || !this.clobClient) {
      throw new PlatformApiError(
        POLYMARKET_ERROR_CODES.NOT_CONNECTED,
        'Polymarket connector not connected',
        PlatformId.POLYMARKET,
        'error',
      );
    }

    await this.rateLimiter.acquireWrite();

    try {
      await withRetry(
        () => this.clobClient!.cancelOrder({ orderID: orderId }),
        RETRY_STRATEGIES.NETWORK_ERROR,
        (attempt, error) => {
          this.logger.warn({
            message: 'Retrying cancelOrder',
            module: 'connector',
            timestamp: new Date().toISOString(),
            platformId: PlatformId.POLYMARKET,
            metadata: { orderId, attempt, error: error.message },
          });
        },
      );

      this.lastHeartbeat = new Date();
      return { orderId, status: 'cancelled' };
    } catch (error) {
      const message = (
        error instanceof Error ? error.message : String(error)
      ).toLowerCase();

      if (message.includes('not found') || message.includes('404')) {
        return { orderId, status: 'not_found' };
      }
      if (message.includes('already matched') || message.includes('matched')) {
        return { orderId, status: 'already_filled' };
      }
      throw this.mapError(error);
    }
  }

  async getOrder(orderId: string): Promise<OrderStatusResult> {
    if (!this.connected || !this.clobClient) {
      throw new PlatformApiError(
        POLYMARKET_ERROR_CODES.NOT_CONNECTED,
        'Polymarket connector not connected',
        PlatformId.POLYMARKET,
        'error',
      );
    }

    await this.rateLimiter.acquireRead();

    try {
      const orderData = await this.clobClient.getOrder(orderId);
      const rawStatus = (orderData as { status?: string }).status;

      let status: OrderStatusResult['status'];
      if (rawStatus === 'MATCHED' || rawStatus === 'matched') {
        status = 'filled';
      } else if (rawStatus === 'LIVE' || rawStatus === 'live') {
        status = 'pending';
      } else if (
        rawStatus === 'CANCELED' ||
        rawStatus === 'canceled' ||
        rawStatus === 'cancelled'
      ) {
        status = 'cancelled';
      } else {
        status = 'pending';
      }

      const fillSize = (orderData as { filledSize?: number }).filledSize;
      const fillPrice = (orderData as { filledPrice?: number }).filledPrice;

      return {
        orderId,
        status,
        fillPrice: fillPrice ?? undefined,
        fillSize: fillSize ?? undefined,
        rawResponse: orderData,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('not found') || message.includes('404')) {
        return { orderId, status: 'not_found' };
      }
      throw this.mapError(error);
    }
  }

  private mapError(error: unknown): PlatformApiError {
    if (error instanceof PlatformApiError) return error;

    const message = error instanceof Error ? error.message : String(error);

    // Check for axios-style error
    const status =
      (error as { response?: { status?: number } })?.response?.status ??
      undefined;
    const retryAfter = (
      error as { response?: { headers?: Record<string, string> } }
    )?.response?.headers?.['retry-after'];

    if (
      status === 401 ||
      message.includes('UNAUTHORIZED') ||
      message.includes('401')
    ) {
      return new PlatformApiError(
        POLYMARKET_ERROR_CODES.UNAUTHORIZED,
        message,
        PlatformId.POLYMARKET,
        'critical',
      );
    }

    if (
      status === 429 ||
      message.includes('429') ||
      message.includes('rate limit')
    ) {
      const requestPath =
        (error as { response?: { config?: { url?: string } } })?.response
          ?.config?.url ?? 'unknown';
      this.logger.warn({
        message: 'Rate limited by Polymarket',
        module: 'connector',
        timestamp: new Date().toISOString(),
        platformId: PlatformId.POLYMARKET,
        metadata: { retryAfter, requestPath },
      });
      return new PlatformApiError(
        POLYMARKET_ERROR_CODES.RATE_LIMIT,
        message,
        PlatformId.POLYMARKET,
        'warning',
        RETRY_STRATEGIES.RATE_LIMIT,
      );
    }

    if (
      status === 404 ||
      message.includes('not found') ||
      message.includes('404')
    ) {
      return new PlatformApiError(
        POLYMARKET_ERROR_CODES.MARKET_NOT_FOUND,
        message,
        PlatformId.POLYMARKET,
        'warning',
      );
    }

    return new PlatformApiError(
      POLYMARKET_ERROR_CODES.INVALID_REQUEST,
      message,
      PlatformId.POLYMARKET,
      'error',
    );
  }
}
