import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Platform, HistoricalDataSource } from '@prisma/client';
import { PrismaService } from '../../../common/prisma.service';
import {
  SystemHealthError,
  SYSTEM_HEALTH_ERROR_CODES,
} from '../../../common/errors/system-health-error';
import type { IngestionMetadata } from '../../../common/types/historical-data.types';
import {
  bulkInsertPrices,
  bulkInsertDepth,
  bulkInsertTrades,
  type PriceRecord,
  type DepthRecord,
  type TradeRecord,
} from './predexon-bulk-insert';

const MAX_RETRIES = 3;
const HTTP_TIMEOUT_MS = 30_000;
const EFFECTIVE_RATE = 18; // 90% of Dev tier 20 req/s — 429 retry logic handles bursts
const MIN_INTERVAL_MS = 1000 / EFFECTIVE_RATE;
const PAGE_SIZE = 200;
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
/** Flush accumulated records when buffer exceeds this size */
const FLUSH_SIZE = 2000;

// Predexon candlestick response shape
interface PredexonCandlestick {
  end_period_ts: number;
  price: {
    open: number;
    high: number;
    low: number;
    close: number;
    open_dollars?: string;
    high_dollars?: string;
    low_dollars?: string;
    close_dollars?: string;
  };
  volume: number;
  trades_count?: number;
}

interface PredexonCandlestickResponse {
  condition_id: string;
  candlesticks: PredexonCandlestick[];
}

// Predexon Polymarket orderbook response (uses bids/asks)
interface PredexonPolymarketOrderbookSnapshot {
  assetId?: string;
  hash?: string;
  timestamp: number;
  bids: Array<{ price: number; size: number }>;
  asks: Array<{ price: number; size: number }>;
}

interface PredexonPolymarketOrderbookResponse {
  snapshots: PredexonPolymarketOrderbookSnapshot[];
  pagination: {
    limit: number;
    count: number;
    has_more: boolean;
    pagination_key?: string;
  };
}

// Predexon Kalshi orderbook response (uses yes_bids/yes_asks + extra fields)
interface PredexonKalshiOrderbookSnapshot {
  ticker: string;
  timestamp: number;
  yes_bids: Array<{ price: number; size: number }>;
  yes_asks: Array<{ price: number; size: number }>;
  best_bid?: number;
  best_ask?: number;
  bid_depth?: number;
  ask_depth?: number;
  sequence?: number;
}

interface PredexonKalshiOrderbookResponse {
  snapshots: PredexonKalshiOrderbookSnapshot[];
  pagination: {
    limit: number;
    count: number;
    has_more: boolean;
    pagination_key?: string;
  };
}

// Predexon trades response shape
interface PredexonTrade {
  id: string;
  timestamp: number;
  price: number;
  size: number;
  side: string;
}

interface PredexonTradesResponse {
  trades: PredexonTrade[];
  pagination: {
    limit: number;
    count: number;
    has_more: boolean;
    pagination_key?: string;
  };
}

@Injectable()
export class PredexonHistoricalService {
  private readonly logger = new Logger(PredexonHistoricalService.name);
  private readonly baseUrl: string;
  private readonly apiKey: string;
  /** Promise chain serializing rate-limit acquisition across concurrent callers */
  private rateLimitChain: Promise<void> = Promise.resolve();
  private lastRequestTs = 0;

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
  ) {
    this.apiKey = this.configService.get<string>('PREDEXON_API_KEY') ?? '';
    this.baseUrl =
      this.configService.get<string>('PREDEXON_BASE_URL') ??
      'https://api.predexon.com';
  }

  // ─── Polymarket Candlesticks (replaces OddsPipe OHLCV) ─────────────────────

  async ingestPolymarketPrices(
    conditionId: string,
    dateRange: { start: Date; end: Date },
  ): Promise<IngestionMetadata> {
    const startMs = Date.now();
    let totalRecords = 0;
    const buffer: PriceRecord[] = [];

    // Chunk into 30-day windows (Predexon 1h interval max range)
    const chunks = this.chunkDateRange(dateRange, THIRTY_DAYS_MS);

    for (const chunk of chunks) {
      const url = `${this.baseUrl}/v2/polymarket/candlesticks/${conditionId}?interval=60&start_time=${Math.floor(chunk.start.getTime() / 1000)}&end_time=${Math.floor(chunk.end.getTime() / 1000)}`;

      const data =
        await this.fetchJsonWithRetry<PredexonCandlestickResponse>(url);
      if (!data) continue;

      for (const c of data.candlesticks ?? []) {
        buffer.push({
          platform: Platform.POLYMARKET,
          contractId: conditionId,
          source: HistoricalDataSource.PREDEXON,
          intervalMinutes: 60,
          timestamp: new Date(c.end_period_ts * 1000),
          open: c.price.open_dollars ?? String(c.price.open),
          high: c.price.high_dollars ?? String(c.price.high),
          low: c.price.low_dollars ?? String(c.price.low),
          close: c.price.close_dollars ?? String(c.price.close),
          volume: c.volume != null ? String(c.volume) : null,
        });
      }

      if (buffer.length >= FLUSH_SIZE) {
        totalRecords += await bulkInsertPrices(this.prisma, buffer.splice(0));
      }
    }
    if (buffer.length > 0) {
      totalRecords += await bulkInsertPrices(this.prisma, buffer);
    }

    return {
      source: HistoricalDataSource.PREDEXON,
      platform: 'polymarket',
      contractId: conditionId,
      recordCount: totalRecords,
      dateRange,
      durationMs: Date.now() - startMs,
    };
  }

  // ─── Polymarket Orderbook History (replaces PMXT Archive) ───────────────────

  async ingestPolymarketDepth(
    tokenId: string,
    dateRange: { start: Date; end: Date },
  ): Promise<IngestionMetadata> {
    const startMs = Date.now();
    let totalRecords = 0;
    let paginationKey: string | undefined;
    let hasMore = true;
    const buffer: DepthRecord[] = [];

    while (hasMore) {
      try {
        const params = new URLSearchParams({
          token_id: tokenId,
          start_time: String(Math.floor(dateRange.start.getTime())),
          end_time: String(Math.floor(dateRange.end.getTime())),
          limit: String(PAGE_SIZE),
        });
        if (paginationKey) {
          params.set('pagination_key', paginationKey);
        }

        const url = `${this.baseUrl}/v2/polymarket/orderbooks?${params.toString()}`;
        const data =
          await this.fetchJsonWithRetry<PredexonPolymarketOrderbookResponse>(
            url,
          );
        if (!data || !data.snapshots?.length) break;

        for (const s of data.snapshots) {
          buffer.push({
            platform: Platform.POLYMARKET,
            contractId: tokenId,
            source: HistoricalDataSource.PREDEXON,
            bids: s.bids.map((b) => ({
              price: String(b.price),
              size: String(b.size),
            })),
            asks: s.asks.map((a) => ({
              price: String(a.price),
              size: String(a.size),
            })),
            timestamp: new Date(s.timestamp),
            updateType: 'snapshot',
          });
        }

        if (buffer.length >= FLUSH_SIZE) {
          totalRecords += await bulkInsertDepth(this.prisma, buffer.splice(0));
        }

        hasMore = data.pagination.has_more;
        paginationKey = data.pagination.pagination_key;
      } catch (error) {
        this.logger.error(
          `Error ingesting Polymarket depth for ${tokenId}: ${error instanceof Error ? error.message : String(error)}`,
        );
        throw error;
      }
    }
    if (buffer.length > 0) {
      totalRecords += await bulkInsertDepth(this.prisma, buffer);
    }

    return {
      source: HistoricalDataSource.PREDEXON,
      platform: 'polymarket',
      contractId: tokenId,
      recordCount: totalRecords,
      dateRange,
      durationMs: Date.now() - startMs,
    };
  }

  // ─── Polymarket Trades History (replaces Goldsky) ───────────────────────────

  async ingestPolymarketTrades(
    tokenId: string,
    dateRange: { start: Date; end: Date },
  ): Promise<IngestionMetadata> {
    return this.ingestTrades(
      Platform.POLYMARKET,
      tokenId,
      `${this.baseUrl}/v2/polymarket/trades`,
      'token_id',
      dateRange,
    );
  }

  // ─── Kalshi Orderbook History ───────────────────────────────────────────────

  async ingestKalshiDepth(
    ticker: string,
    dateRange: { start: Date; end: Date },
  ): Promise<IngestionMetadata> {
    const startMs = Date.now();
    let totalRecords = 0;
    let paginationKey: string | undefined;
    let hasMore = true;
    const buffer: DepthRecord[] = [];

    while (hasMore) {
      try {
        const params = new URLSearchParams({
          ticker,
          start_time: String(Math.floor(dateRange.start.getTime())),
          end_time: String(Math.floor(dateRange.end.getTime())),
          limit: String(PAGE_SIZE),
        });
        if (paginationKey) {
          params.set('pagination_key', paginationKey);
        }

        const url = `${this.baseUrl}/v2/kalshi/orderbooks?${params.toString()}`;
        const data =
          await this.fetchJsonWithRetry<PredexonKalshiOrderbookResponse>(url);
        if (!data || !data.snapshots?.length) break;

        for (const s of data.snapshots) {
          buffer.push({
            platform: Platform.KALSHI,
            contractId: ticker,
            source: HistoricalDataSource.PREDEXON,
            bids: s.yes_bids.map((b) => ({
              price: String(b.price),
              size: String(b.size),
            })),
            asks: s.yes_asks.map((a) => ({
              price: String(a.price),
              size: String(a.size),
            })),
            timestamp: new Date(s.timestamp),
            updateType: 'snapshot',
          });
        }

        if (buffer.length >= FLUSH_SIZE) {
          totalRecords += await bulkInsertDepth(this.prisma, buffer.splice(0));
        }

        hasMore = data.pagination.has_more;
        paginationKey = data.pagination.pagination_key;
      } catch (error) {
        this.logger.error(
          `Error ingesting Kalshi depth for ${ticker}: ${error instanceof Error ? error.message : String(error)}`,
        );
        throw error;
      }
    }
    if (buffer.length > 0) {
      totalRecords += await bulkInsertDepth(this.prisma, buffer);
    }

    return {
      source: HistoricalDataSource.PREDEXON,
      platform: 'kalshi',
      contractId: ticker,
      recordCount: totalRecords,
      dateRange,
      durationMs: Date.now() - startMs,
    };
  }

  // ─── Kalshi Trades History ──────────────────────────────────────────────────

  async ingestKalshiTrades(
    ticker: string,
    dateRange: { start: Date; end: Date },
  ): Promise<IngestionMetadata> {
    return this.ingestTrades(
      Platform.KALSHI,
      ticker,
      `${this.baseUrl}/v2/kalshi/trades`,
      'ticker',
      dateRange,
    );
  }

  // ─── Shared Trades Ingestion ────────────────────────────────────────────────

  private async ingestTrades(
    platform: Platform,
    contractId: string,
    baseEndpoint: string,
    idParamName: string,
    dateRange: { start: Date; end: Date },
  ): Promise<IngestionMetadata> {
    const startMs = Date.now();
    let totalRecords = 0;
    let paginationKey: string | undefined;
    let hasMore = true;
    const buffer: TradeRecord[] = [];

    while (hasMore) {
      const params = new URLSearchParams({
        [idParamName]: contractId,
        start_time: String(Math.floor(dateRange.start.getTime())),
        end_time: String(Math.floor(dateRange.end.getTime())),
        limit: String(PAGE_SIZE),
      });
      if (paginationKey) {
        params.set('pagination_key', paginationKey);
      }

      const url = `${baseEndpoint}?${params.toString()}`;
      const data = await this.fetchJsonWithRetry<PredexonTradesResponse>(url);
      if (!data || !data.trades?.length) break;

      for (const t of data.trades) {
        buffer.push({
          platform,
          contractId,
          source: HistoricalDataSource.PREDEXON,
          externalTradeId: t.id,
          price: String(t.price),
          size: String(t.size),
          side: t.side,
          timestamp: new Date(t.timestamp),
        });
      }

      if (buffer.length >= FLUSH_SIZE) {
        totalRecords += await bulkInsertTrades(this.prisma, buffer.splice(0));
      }

      hasMore = data.pagination.has_more;
      paginationKey = data.pagination.pagination_key;
    }
    if (buffer.length > 0) {
      totalRecords += await bulkInsertTrades(this.prisma, buffer);
    }

    return {
      source: HistoricalDataSource.PREDEXON,
      platform: platform === Platform.KALSHI ? 'kalshi' : 'polymarket',
      contractId,
      recordCount: totalRecords,
      dateRange,
      durationMs: Date.now() - startMs,
    };
  }

  // ─── Shared HTTP helpers ────────────────────────────────────────────────────

  private chunkDateRange(
    dateRange: { start: Date; end: Date },
    chunkMs: number,
  ): Array<{ start: Date; end: Date }> {
    const chunks: Array<{ start: Date; end: Date }> = [];
    let current = dateRange.start.getTime();
    const endMs = dateRange.end.getTime();

    while (current < endMs) {
      const chunkEnd = Math.min(current + chunkMs, endMs);
      chunks.push({
        start: new Date(current),
        end: new Date(chunkEnd),
      });
      current = chunkEnd;
    }

    return chunks;
  }

  private async fetchJsonWithRetry<T>(url: string): Promise<T | null> {
    let lastError: Error | undefined;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        const res = await this.fetchWithRateLimit(url);

        if (res.ok) {
          return (await res.json()) as T;
        }

        // 403 = free tier / expired key — graceful degradation
        if (res.status === 403) {
          this.logger.warn(
            'Predexon API key issue (403) — skipping this source',
          );
          return null;
        }

        // 429 = rate limited — retry with backoff
        if (res.status === 429) {
          const retryAfter = res.headers.get('Retry-After');
          const delay = retryAfter
            ? parseInt(retryAfter, 10) * 1000
            : Math.pow(2, attempt + 1) * 1000;
          this.logger.warn(
            `Predexon 429 rate limited (attempt ${attempt + 1}/${MAX_RETRIES}), waiting ${delay}ms`,
          );
          if (attempt < MAX_RETRIES - 1) {
            await new Promise((r) => setTimeout(r, delay));
          }
          lastError = new Error(`Predexon API 429 on attempt ${attempt + 1}`);
          continue;
        }

        // Other 4xx — permanent error
        if (res.status >= 400 && res.status < 500) {
          throw new SystemHealthError(
            SYSTEM_HEALTH_ERROR_CODES.BACKTEST_PREDEXON_API_ERROR,
            `Predexon API ${res.status}: ${url}`,
            'error',
            'PredexonHistoricalService',
          );
        }

        lastError = new Error(
          `Predexon API ${res.status} on attempt ${attempt + 1}`,
        );
        this.logger.warn(lastError.message);
      } catch (error) {
        if (error instanceof SystemHealthError) throw error;
        lastError = error instanceof Error ? error : new Error(String(error));
        this.logger.warn(
          `Predexon fetch attempt ${attempt + 1}/${MAX_RETRIES} failed: ${lastError.message}`,
        );
      }

      if (attempt < MAX_RETRIES - 1) {
        const delay = Math.pow(2, attempt) * 1000;
        const jitter = delay * (0.9 + Math.random() * 0.2);
        await new Promise((r) => setTimeout(r, jitter));
      }
    }

    throw new SystemHealthError(
      SYSTEM_HEALTH_ERROR_CODES.BACKTEST_PREDEXON_API_ERROR,
      `Predexon API failed after ${MAX_RETRIES} attempts: ${url}`,
      'error',
      'PredexonHistoricalService',
      undefined,
      { lastError: lastError?.message },
    );
  }

  private async fetchWithRateLimit(url: string): Promise<Response> {
    // Chain rate-limit acquisition so concurrent callers queue in order.
    // Only the timing check is serialized — the actual fetch runs concurrently.
    await new Promise<void>((resolve) => {
      this.rateLimitChain = this.rateLimitChain.then(async () => {
        const now = Date.now();
        const elapsed = now - this.lastRequestTs;
        if (elapsed < MIN_INTERVAL_MS) {
          await new Promise((r) => setTimeout(r, MIN_INTERVAL_MS - elapsed));
        }
        this.lastRequestTs = Date.now();
        resolve();
      });
    });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
    try {
      return await fetch(url, {
        signal: controller.signal,
        headers: { 'x-api-key': this.apiKey },
      });
    } finally {
      clearTimeout(timeout);
    }
  }
}
