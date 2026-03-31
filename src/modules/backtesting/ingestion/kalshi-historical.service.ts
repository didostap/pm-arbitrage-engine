import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Decimal from 'decimal.js';
import { HistoricalDataSource, Platform, Prisma } from '@prisma/client';
import { PrismaService } from '../../../common/prisma.service';
import type { IHistoricalDataProvider } from '../../../common/interfaces/historical-data-provider.interface';
import type { IngestionMetadata } from '../../../common/types/historical-data.types';
import {
  SystemHealthError,
  SYSTEM_HEALTH_ERROR_CODES,
} from '../../../common/errors/system-health-error';

const CUTOFF_TTL_MS = 3_600_000; // 1 hour
const BATCH_SIZE = 500;
const EFFECTIVE_RATE = 10; // 50% of Basic tier 20 req/s — headroom for burst detection
const MIN_INTERVAL_MS = 1000 / EFFECTIVE_RATE; // 100ms
const MAX_RETRIES = 5;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const LIVE_CHUNK_MS = 6 * 24 * 60 * 60 * 1000; // 6 days — 8,640 1-min candles, under 10K cap

interface KalshiCandlestick {
  end_period_ts: number;
  open?: string;
  high?: string;
  low?: string;
  close?: string;
  volume?: string;
  open_interest?: string;
  price?: { open?: string; high?: string; low?: string; close?: string };
}

interface KalshiTrade {
  trade_id?: string;
  id?: string;
  yes_price_dollars: string;
  no_price_dollars?: string;
  taker_side: string;
  count_fp?: string;
  count?: string;
  created_time: string;
}

interface KalshiLiveCandlestick {
  end_period_ts: number;
  price?: {
    open_dollars?: string;
    high_dollars?: string;
    low_dollars?: string;
    close_dollars?: string;
  };
  volume_fp?: string;
  open_interest_fp?: string;
}

interface KalshiLiveCandlestickBatchResponse {
  markets: Array<{
    market_ticker: string;
    candlesticks: KalshiLiveCandlestick[];
  }>;
}

interface KalshiCutoff {
  market_settled_ts: Date;
  trades_created_ts: Date;
  orders_updated_ts: Date;
}

@Injectable()
export class KalshiHistoricalService implements IHistoricalDataProvider {
  private readonly logger = new Logger(KalshiHistoricalService.name);
  private readonly baseUrl: string;
  private cachedCutoff: KalshiCutoff | null = null;
  private cachedAt = 0;
  private lastRequestTs = 0;

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
  ) {
    // P17: Use only ConfigService — env.schema.ts provides the default
    this.baseUrl = this.configService.get<string>(
      'KALSHI_API_BASE_URL',
      'https://api.elections.kalshi.com/trade-api/v2',
    );
  }

  async fetchCutoff(): Promise<KalshiCutoff> {
    if (this.cachedCutoff && Date.now() - this.cachedAt < CUTOFF_TTL_MS) {
      return this.cachedCutoff;
    }

    // P20: Route through fetchWithRetry for error handling
    const res = await this.fetchWithRetry(`${this.baseUrl}/historical/cutoff`);
    const data = (await res.json()) as {
      market_settled_ts: string;
      trades_created_ts: string;
      orders_updated_ts: string;
    };

    this.cachedCutoff = {
      market_settled_ts: new Date(data.market_settled_ts),
      trades_created_ts: new Date(data.trades_created_ts),
      orders_updated_ts: new Date(data.orders_updated_ts),
    };
    this.cachedAt = Date.now();
    return this.cachedCutoff;
  }

  async ingestPrices(
    contractId: string,
    dateRange: { start: Date; end: Date },
  ): Promise<IngestionMetadata> {
    if (dateRange.start >= dateRange.end) {
      this.logger.debug(
        `Skipping prices for ${contractId}: start >= end (${dateRange.start.toISOString()} >= ${dateRange.end.toISOString()})`,
      );
      return {
        source: HistoricalDataSource.KALSHI_API,
        platform: 'kalshi',
        contractId,
        recordCount: 0,
        dateRange,
        durationMs: 0,
      };
    }
    const startMs = Date.now();
    const cutoff = await this.fetchCutoff();

    const cutoffTs = cutoff.market_settled_ts;
    const hasHistorical = dateRange.start < cutoffTs;
    const hasLive = dateRange.end > cutoffTs;

    if (hasHistorical && hasLive) {
      this.logger.debug(
        `Routing prices: historical=true, live=true for ${contractId}`,
      );
    }

    let historicalCount = 0;
    let liveCount = 0;

    // Historical partition — fetch up to cutoff
    if (hasHistorical) {
      // When spanning both partitions, exclude the cutoff second from historical
      // (live partition owns records at cutoffTs). When purely historical, use full range.
      const effectiveEnd = hasLive
        ? new Date(cutoffTs.getTime() - 1000)
        : dateRange.end;
      const chunks = this.chunkDateRange(dateRange.start, effectiveEnd);

      for (const chunk of chunks) {
        const url = new URL(
          `${this.baseUrl}/historical/markets/${contractId}/candlesticks`,
        );
        url.searchParams.set('period_interval', '1');
        url.searchParams.set(
          'start_ts',
          String(Math.floor(chunk.start.getTime() / 1000)),
        );
        url.searchParams.set(
          'end_ts',
          String(Math.floor(chunk.end.getTime() / 1000)),
        );

        try {
          const res = await this.fetchWithRetry(url.toString());
          const data = (await res.json()) as {
            candlesticks?: KalshiCandlestick[];
          };
          const candlesticks = data.candlesticks ?? [];

          const records = candlesticks.map((c) => ({
            platform: Platform.KALSHI,
            contractId,
            source: HistoricalDataSource.KALSHI_API,
            intervalMinutes: 1,
            timestamp: new Date(c.end_period_ts * 1000),
            open: new Decimal(c.open ?? c.price?.open ?? '0'),
            high: new Decimal(c.high ?? c.price?.high ?? '0'),
            low: new Decimal(c.low ?? c.price?.low ?? '0'),
            close: new Decimal(c.close ?? c.price?.close ?? '0'),
            volume: c.volume != null ? new Decimal(c.volume) : null,
            openInterest:
              c.open_interest != null ? new Decimal(c.open_interest) : null,
          }));

          for (let i = 0; i < records.length; i += BATCH_SIZE) {
            const batch = records.slice(i, i + BATCH_SIZE);
            await this.prisma.historicalPrice.createMany({
              data: batch,
              skipDuplicates: true,
            });
          }
          historicalCount += records.length;
        } catch (error) {
          this.logger.error(
            `Error fetching Kalshi prices for ${contractId}: ${error instanceof Error ? error.message : String(error)}`,
          );
          throw error;
        }
      }
    }

    // Live partition — fetch from cutoff onward
    if (hasLive) {
      const liveStart = new Date(
        Math.max(dateRange.start.getTime(), cutoffTs.getTime()),
      );
      liveCount = await this.fetchAndPersistLiveCandlesticks(contractId, {
        start: liveStart,
        end: dateRange.end,
      });
    }

    return {
      source: HistoricalDataSource.KALSHI_API,
      platform: 'kalshi',
      contractId,
      recordCount: historicalCount + liveCount,
      dateRange,
      durationMs: Date.now() - startMs,
    };
  }

  async ingestTrades(
    contractId: string,
    dateRange: { start: Date; end: Date },
  ): Promise<IngestionMetadata> {
    if (dateRange.start >= dateRange.end) {
      this.logger.debug(
        `Skipping trades for ${contractId}: start >= end (${dateRange.start.toISOString()} >= ${dateRange.end.toISOString()})`,
      );
      return {
        source: HistoricalDataSource.KALSHI_API,
        platform: 'kalshi',
        contractId,
        recordCount: 0,
        dateRange,
        durationMs: 0,
      };
    }
    const startMs = Date.now();
    const cutoff = await this.fetchCutoff();

    const tradeCutoffTs = cutoff.trades_created_ts;
    const hasHistorical = dateRange.start < tradeCutoffTs;
    const hasLive = dateRange.end > tradeCutoffTs;

    if (hasHistorical && hasLive) {
      this.logger.debug(
        `Routing trades: historical=true, live=true for ${contractId}`,
      );
    }

    let historicalCount = 0;
    let liveCount = 0;

    // Historical partition — fetch up to cutoff
    if (hasHistorical) {
      // Exclude the cutoff second when spanning (live owns it)
      const effectiveEnd = hasLive
        ? new Date(tradeCutoffTs.getTime() - 1000)
        : dateRange.end;
      let cursor: string | undefined;

      do {
        const url = new URL(`${this.baseUrl}/historical/trades`);
        url.searchParams.set('ticker', contractId);
        url.searchParams.set(
          'min_ts',
          String(Math.floor(dateRange.start.getTime() / 1000)),
        );
        url.searchParams.set(
          'max_ts',
          String(Math.floor(effectiveEnd.getTime() / 1000)),
        );
        url.searchParams.set('limit', '1000');
        if (cursor) {
          url.searchParams.set('cursor', cursor);
        }

        const res = await this.fetchWithRetry(url.toString());
        const data = (await res.json()) as {
          trades?: KalshiTrade[];
          cursor?: string;
        };
        const trades = data.trades ?? [];

        const pageRecords: Prisma.HistoricalTradeCreateManyInput[] = trades.map(
          (t) => ({
            platform: Platform.KALSHI,
            contractId,
            source: HistoricalDataSource.KALSHI_API,
            externalTradeId:
              t.trade_id ??
              t.id ??
              `kalshi-${contractId}-${t.created_time}-${t.yes_price_dollars}`,
            price: new Decimal(t.yes_price_dollars),
            size: new Decimal(t.count_fp ?? t.count ?? '1'),
            side: t.taker_side === 'yes' ? 'buy' : 'sell',
            timestamp: new Date(t.created_time),
          }),
        );

        for (let i = 0; i < pageRecords.length; i += BATCH_SIZE) {
          const batch = pageRecords.slice(i, i + BATCH_SIZE);
          await this.prisma.historicalTrade.createMany({
            data: batch,
            skipDuplicates: true,
          });
        }
        historicalCount += pageRecords.length;

        cursor = data.cursor || undefined;
      } while (cursor);
    }

    // Live partition — fetch from cutoff onward
    if (hasLive) {
      const liveStart = new Date(
        Math.max(dateRange.start.getTime(), tradeCutoffTs.getTime()),
      );
      liveCount = await this.fetchAndPersistLiveTrades(contractId, {
        start: liveStart,
        end: dateRange.end,
      });
    }

    return {
      source: HistoricalDataSource.KALSHI_API,
      platform: 'kalshi',
      contractId,
      recordCount: historicalCount + liveCount,
      dateRange,
      durationMs: Date.now() - startMs,
    };
  }

  getSupportedSources(): HistoricalDataSource[] {
    return [HistoricalDataSource.KALSHI_API];
  }

  private async fetchAndPersistLiveCandlesticks(
    contractId: string,
    dateRange: { start: Date; end: Date },
  ): Promise<number> {
    const chunks = this.chunkDateRange(
      dateRange.start,
      dateRange.end,
      LIVE_CHUNK_MS,
    );
    let count = 0;

    for (const chunk of chunks) {
      const url = new URL(`${this.baseUrl}/markets/candlesticks`);
      url.searchParams.set('market_tickers', contractId);
      url.searchParams.set('period_interval', '1');
      url.searchParams.set(
        'start_ts',
        String(Math.floor(chunk.start.getTime() / 1000)),
      );
      url.searchParams.set(
        'end_ts',
        String(Math.floor(chunk.end.getTime() / 1000)),
      );

      const res = await this.fetchWithRetry(url.toString());
      const data = (await res.json()) as KalshiLiveCandlestickBatchResponse;

      const marketData = data.markets?.find(
        (m) => m.market_ticker === contractId,
      );
      if (!marketData) {
        this.logger.warn(
          `Live candlestick response missing market ${contractId}`,
        );
        continue;
      }

      const records = marketData.candlesticks.map((c) =>
        this.parseLiveCandlestick(c, contractId),
      );

      for (let i = 0; i < records.length; i += BATCH_SIZE) {
        const batch = records.slice(i, i + BATCH_SIZE);
        await this.prisma.historicalPrice.createMany({
          data: batch,
          skipDuplicates: true,
        });
      }
      count += records.length;
    }

    return count;
  }

  private async fetchAndPersistLiveTrades(
    contractId: string,
    dateRange: { start: Date; end: Date },
  ): Promise<number> {
    let count = 0;
    let cursor: string | undefined;

    do {
      const url = new URL(`${this.baseUrl}/markets/trades`);
      url.searchParams.set('ticker', contractId);
      url.searchParams.set(
        'min_ts',
        String(Math.floor(dateRange.start.getTime() / 1000)),
      );
      url.searchParams.set(
        'max_ts',
        String(Math.floor(dateRange.end.getTime() / 1000)),
      );
      url.searchParams.set('limit', '1000');
      if (cursor) {
        url.searchParams.set('cursor', cursor);
      }

      const res = await this.fetchWithRetry(url.toString());
      const data = (await res.json()) as {
        trades?: KalshiTrade[];
        cursor?: string;
      };
      const trades = data.trades ?? [];

      const pageRecords = trades.map((t) => ({
        platform: Platform.KALSHI,
        contractId,
        source: HistoricalDataSource.KALSHI_API,
        externalTradeId:
          t.trade_id ??
          t.id ??
          `kalshi-${contractId}-${t.created_time}-${t.yes_price_dollars}`,
        price: new Decimal(t.yes_price_dollars),
        size: new Decimal(t.count_fp ?? t.count ?? '1'),
        side: t.taker_side === 'yes' ? 'buy' : 'sell',
        timestamp: new Date(t.created_time),
      }));

      for (let i = 0; i < pageRecords.length; i += BATCH_SIZE) {
        const batch = pageRecords.slice(i, i + BATCH_SIZE);
        await this.prisma.historicalTrade.createMany({
          data: batch,
          skipDuplicates: true,
        });
      }
      count += pageRecords.length;
      cursor = data.cursor || undefined;
    } while (cursor);

    return count;
  }

  private parseLiveCandlestick(
    c: KalshiLiveCandlestick,
    contractId: string,
  ): Prisma.HistoricalPriceCreateManyInput {
    return {
      platform: Platform.KALSHI,
      contractId,
      source: HistoricalDataSource.KALSHI_API,
      intervalMinutes: 1,
      timestamp: new Date(c.end_period_ts * 1000),
      open: new Decimal(c.price?.open_dollars ?? '0'),
      high: new Decimal(c.price?.high_dollars ?? '0'),
      low: new Decimal(c.price?.low_dollars ?? '0'),
      close: new Decimal(c.price?.close_dollars ?? '0'),
      volume: c.volume_fp != null ? new Decimal(c.volume_fp) : null,
      openInterest:
        c.open_interest_fp != null ? new Decimal(c.open_interest_fp) : null,
    };
  }

  private chunkDateRange(
    start: Date,
    end: Date,
    chunkMs: number = SEVEN_DAYS_MS,
  ): Array<{ start: Date; end: Date }> {
    const chunks: Array<{ start: Date; end: Date }> = [];
    let current = start.getTime();
    const endMs = end.getTime();

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

  private async fetchWithRateLimit(
    url: string,
    options?: RequestInit,
  ): Promise<Response> {
    const now = Date.now();
    const elapsed = now - this.lastRequestTs;
    if (elapsed < MIN_INTERVAL_MS) {
      await new Promise((r) => setTimeout(r, MIN_INTERVAL_MS - elapsed));
    }
    this.lastRequestTs = Date.now();
    return fetch(url, options);
  }

  private async fetchWithRetry(url: string): Promise<Response> {
    let lastError: Error | undefined;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      const res = await this.fetchWithRateLimit(url);

      if (res.ok) {
        return res;
      }

      // 429 = rate limited — retryable with longer backoff
      if (res.status === 429) {
        const retryAfter = res.headers.get('Retry-After');
        const delay = retryAfter
          ? parseInt(retryAfter, 10) * 1000
          : Math.pow(2, attempt + 1) * 1000; // 2s, 4s, 8s, 16s
        this.logger.warn(
          `Kalshi 429 rate limited (attempt ${attempt + 1}/${MAX_RETRIES}), waiting ${delay}ms`,
        );
        if (attempt < MAX_RETRIES - 1) {
          await new Promise((r) => setTimeout(r, delay));
        }
        lastError = new Error(`Kalshi API 429 on attempt ${attempt + 1}`);
        continue;
      }

      // Other 4xx — permanent client error, throw immediately
      if (res.status >= 400 && res.status < 500) {
        throw new SystemHealthError(
          SYSTEM_HEALTH_ERROR_CODES.BACKTEST_EXTERNAL_API_ERROR,
          `Kalshi API ${res.status}: ${url}`,
          'error',
          'KalshiHistoricalService',
        );
      }

      // 5xx — server error, retry with standard backoff
      lastError = new Error(
        `Kalshi API ${res.status} on attempt ${attempt + 1}`,
      );
      this.logger.warn(lastError.message);

      if (attempt < MAX_RETRIES - 1) {
        const delay = Math.pow(2, attempt) * 1000;
        const jitter = delay * (0.9 + Math.random() * 0.2);
        await new Promise((r) => setTimeout(r, jitter));
      }
    }

    throw new SystemHealthError(
      SYSTEM_HEALTH_ERROR_CODES.BACKTEST_EXTERNAL_API_ERROR,
      `Kalshi API failed after ${MAX_RETRIES} attempts: ${url}`,
      'error',
      'KalshiHistoricalService',
      undefined,
      { lastError: lastError?.message },
    );
  }
}
