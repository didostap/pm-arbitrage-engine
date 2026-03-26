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
const EFFECTIVE_RATE = 14; // 70% of Basic tier 20 req/s
const MIN_INTERVAL_MS = 1000 / EFFECTIVE_RATE; // ~71ms
const MAX_RETRIES = 3;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

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
    const startMs = Date.now();
    const cutoff = await this.fetchCutoff();

    // P2: Validate date range against cutoff — warn if beyond historical partition
    const endTs = Math.floor(dateRange.end.getTime() / 1000);
    const cutoffTs = Math.floor(cutoff.market_settled_ts.getTime() / 1000);
    if (endTs > cutoffTs) {
      this.logger.warn(
        `Requested end_ts ${endTs} exceeds cutoff ${cutoffTs} for ${contractId} — data beyond cutoff not available in historical partition`,
      );
    }

    // Clamp end to cutoff boundary for historical endpoint
    const effectiveEnd = new Date(
      Math.min(dateRange.end.getTime(), cutoff.market_settled_ts.getTime()),
    );
    if (effectiveEnd <= dateRange.start) {
      return {
        source: HistoricalDataSource.KALSHI_API,
        platform: 'kalshi',
        contractId,
        recordCount: 0,
        dateRange,
        durationMs: Date.now() - startMs,
      };
    }

    // IG-1: Chunk date range into 7-day windows. Kalshi candlestick endpoints have
    // undocumented server-side limits (batch endpoint caps at 10K candles; single-market
    // endpoint likely similar via maxAggregateCandidates). 7 days × 1-min = ~10K candles,
    // which is borderline. Safe for 1-min resolution; reduce to 5 days if truncation observed.
    const chunks = this.chunkDateRange(dateRange.start, effectiveEnd);
    let totalRecords = 0;

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

      // Flush each chunk immediately instead of accumulating
      for (let i = 0; i < records.length; i += BATCH_SIZE) {
        const batch = records.slice(i, i + BATCH_SIZE);
        await this.prisma.historicalPrice.createMany({
          data: batch,
          skipDuplicates: true,
        });
      }
      totalRecords += records.length;
    }

    return {
      source: HistoricalDataSource.KALSHI_API,
      platform: 'kalshi',
      contractId,
      recordCount: totalRecords,
      dateRange,
      durationMs: Date.now() - startMs,
    };
  }

  async ingestTrades(
    contractId: string,
    dateRange: { start: Date; end: Date },
  ): Promise<IngestionMetadata> {
    const startMs = Date.now();
    const cutoff = await this.fetchCutoff();

    // P2: Validate date range against cutoff
    const maxTs = Math.floor(dateRange.end.getTime() / 1000);
    const cutoffTs = Math.floor(cutoff.trades_created_ts.getTime() / 1000);
    if (maxTs > cutoffTs) {
      this.logger.warn(
        `Requested max_ts ${maxTs} exceeds cutoff ${cutoffTs} for ${contractId} — data beyond cutoff not available in historical partition`,
      );
    }

    const effectiveEnd = new Date(
      Math.min(dateRange.end.getTime(), cutoff.trades_created_ts.getTime()),
    );
    if (effectiveEnd <= dateRange.start) {
      return {
        source: HistoricalDataSource.KALSHI_API,
        platform: 'kalshi',
        contractId,
        recordCount: 0,
        dateRange,
        durationMs: Date.now() - startMs,
      };
    }

    let cursor: string | undefined;
    let totalRecords = 0;

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

      // P18 + P5: Flush each page to DB immediately; generate synthetic ID if missing
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
      totalRecords += pageRecords.length;

      cursor = data.cursor || undefined;
    } while (cursor);

    return {
      source: HistoricalDataSource.KALSHI_API,
      platform: 'kalshi',
      contractId,
      recordCount: totalRecords,
      dateRange,
      durationMs: Date.now() - startMs,
    };
  }

  getSupportedSources(): HistoricalDataSource[] {
    return [HistoricalDataSource.KALSHI_API];
  }

  private chunkDateRange(
    start: Date,
    end: Date,
  ): Array<{ start: Date; end: Date }> {
    const chunks: Array<{ start: Date; end: Date }> = [];
    let current = start.getTime();
    const endMs = end.getTime();

    while (current < endMs) {
      const chunkEnd = Math.min(current + SEVEN_DAYS_MS, endMs);
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

      if (res.status >= 400 && res.status < 500) {
        throw new SystemHealthError(
          SYSTEM_HEALTH_ERROR_CODES.BACKTEST_EXTERNAL_API_ERROR,
          `Kalshi API ${res.status}: ${url}`,
          'error',
          'KalshiHistoricalService',
        );
      }

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
