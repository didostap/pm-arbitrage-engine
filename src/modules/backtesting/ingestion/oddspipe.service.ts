import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Decimal from 'decimal.js';
import { Platform } from '@prisma/client';
import { PrismaService } from '../../../common/prisma.service';
import {
  SystemHealthError,
  SYSTEM_HEALTH_ERROR_CODES,
} from '../../../common/errors/system-health-error';
import type { IngestionMetadata } from '../../../common/types/historical-data.types';
import type { ExternalMatchedPair } from '../types/match-validation.types';

interface OddsPipeCandlestick {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

const BATCH_SIZE = 500;
const MAX_RETRIES = 3;
const HTTP_TIMEOUT_MS = 30_000;
const MIN_INTERVAL_MS = 857; // 70 req/min = ceil(60000/70)
const MAX_HISTORY_DAYS = 30;

@Injectable()
export class OddsPipeService implements OnModuleDestroy {
  private readonly logger = new Logger(OddsPipeService.name);
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private lastRequestTs = 0;

  /** Cleanup: .clear() on service destroy, entries invalidated on re-ingestion */
  private marketIdCache = new Map<string, number | null>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
  ) {
    this.apiKey = this.configService.get<string>('ODDSPIPE_API_KEY') ?? '';
    this.baseUrl =
      this.configService.get<string>('ODDSPIPE_BASE_URL') ??
      'https://oddspipe.com/v1';
  }

  onModuleDestroy(): void {
    this.marketIdCache.clear();
  }

  async resolveMarketId(polymarketTokenId: string): Promise<number | null> {
    // Check cache first
    if (this.marketIdCache.has(polymarketTokenId)) {
      return this.marketIdCache.get(polymarketTokenId) ?? null;
    }

    // Look up contract title from ContractMatch
    const match = await this.prisma.contractMatch.findFirst({
      where: { polymarketClobTokenId: polymarketTokenId },
      select: { polymarketDescription: true },
    });

    if (!match?.polymarketDescription) {
      this.logger.warn(`No ContractMatch found for token ${polymarketTokenId}`);
      this.marketIdCache.set(polymarketTokenId, null);
      return null;
    }

    // Search OddsPipe for matching market
    const title = match.polymarketDescription;
    const searchUrl = `${this.baseUrl}/markets/search?q=${encodeURIComponent(title)}`;
    const res = await this.fetchWithRateLimit(searchUrl);

    if (!res.ok) {
      this.logger.warn(
        `OddsPipe market search failed: ${res.status} for "${title}"`,
      );
      // P-14: Do NOT cache transient API failures — allow retry on next call
      return null;
    }

    const markets = (await res.json()) as Array<{
      id: number;
      title: string;
    }>;

    if (markets.length === 0) {
      this.logger.warn(`No OddsPipe market found for "${title}"`);
      this.marketIdCache.set(polymarketTokenId, null);
      return null;
    }

    // P-8: Select best match with minimum score threshold
    const titleWords = title
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 2); // Lowered from >3 to catch "GDP", "Q3"
    let bestMatch: { id: number; title: string } | null = null;
    let bestScore = 0;

    for (const market of markets) {
      const marketLower = market.title.toLowerCase();
      const score = titleWords.filter((w) => marketLower.includes(w)).length;
      if (score > bestScore) {
        bestScore = score;
        bestMatch = market;
      }
    }

    if (!bestMatch || bestScore === 0) {
      this.logger.warn(
        `No confident OddsPipe match for "${title}" — best score was 0`,
      );
      this.marketIdCache.set(polymarketTokenId, null);
      return null;
    }

    this.marketIdCache.set(polymarketTokenId, bestMatch.id);
    return bestMatch.id;
  }

  async ingestPrices(
    oddsPipeMarketId: number,
    contractId: string,
    dateRange: { start: Date; end: Date },
  ): Promise<IngestionMetadata> {
    const startMs = Date.now();

    // Clamp date range to 30 days (free tier limit)
    const clampedRange = this.clampDateRange(dateRange);

    // Fetch candlesticks
    const startSec = Math.floor(clampedRange.start.getTime() / 1000);
    const endSec = Math.floor(clampedRange.end.getTime() / 1000);
    const url = `${this.baseUrl}/markets/${oddsPipeMarketId}/candlesticks?interval=1h&start=${startSec}&end=${endSec}`;

    const candles = await this.fetchWithRetry(url);

    // Normalize to Prisma-ready records
    const records = candles.map((c) => ({
      platform: Platform.POLYMARKET,
      contractId,
      source: 'ODDSPIPE' as const,
      intervalMinutes: 60,
      timestamp: new Date(c.timestamp * 1000),
      open: new Decimal(String(c.open)),
      high: new Decimal(String(c.high)),
      low: new Decimal(String(c.low)),
      close: new Decimal(String(c.close)),
      volume: new Decimal(String(c.volume)),
      openInterest: null,
    }));

    // Batch persist
    let totalInserted = 0;
    for (let i = 0; i < records.length; i += BATCH_SIZE) {
      const batch = records.slice(i, i + BATCH_SIZE);
      const result = await this.prisma.historicalPrice.createMany({
        data: batch,
        skipDuplicates: true,
      });
      totalInserted += result.count;
    }

    return {
      source: 'ODDSPIPE',
      platform: Platform.POLYMARKET,
      contractId,
      recordCount: totalInserted,
      dateRange: clampedRange,
      durationMs: Date.now() - startMs,
    };
  }

  async fetchMatchedPairs(minSpread?: number): Promise<ExternalMatchedPair[]> {
    const params = new URLSearchParams();
    if (minSpread !== undefined) {
      params.set('min_spread', String(minSpread));
    }

    const queryString = params.toString();
    const url = `${this.baseUrl}/spreads${queryString ? `?${queryString}` : ''}`;

    const response = await this.fetchJsonWithRetry<{
      items?: Array<{
        polymarket?: { title?: string; yes_price?: number };
        kalshi?: { title?: string; yes_price?: number };
        spread?: { yes_diff?: number };
      }>;
    }>(url);

    // P-13: Validate response shape
    if (!response.items || !Array.isArray(response.items)) {
      throw new SystemHealthError(
        SYSTEM_HEALTH_ERROR_CODES.BACKTEST_ODDSPIPE_API_ERROR,
        'OddsPipe /spreads returned unexpected shape: missing or non-array "items" field',
        'error',
        'oddspipe',
      );
    }

    return response.items.map((item) => {
      if (!item.polymarket || !item.kalshi || !item.spread) {
        throw new SystemHealthError(
          SYSTEM_HEALTH_ERROR_CODES.BACKTEST_ODDSPIPE_API_ERROR,
          'OddsPipe spread item missing polymarket, kalshi, or spread sub-object',
          'error',
          'oddspipe',
        );
      }

      return {
        polymarketId: null,
        kalshiId: null,
        polymarketTitle: item.polymarket.title ?? '',
        kalshiTitle: item.kalshi.title ?? '',
        source: 'oddspipe' as const,
        similarity: null,
        spreadData: {
          yesDiff: item.spread.yes_diff ?? 0,
          polyYesPrice: item.polymarket.yes_price ?? 0,
          kalshiYesPrice: item.kalshi.yes_price ?? 0,
        },
      };
    });
  }

  private clampDateRange(dateRange: { start: Date; end: Date }): {
    start: Date;
    end: Date;
  } {
    const maxMs = MAX_HISTORY_DAYS * 24 * 60 * 60 * 1000;
    const rangeMs = dateRange.end.getTime() - dateRange.start.getTime();

    if (rangeMs > maxMs) {
      const clampedStart = new Date(dateRange.end.getTime() - maxMs);
      this.logger.warn(
        `OddsPipe date range exceeds ${MAX_HISTORY_DAYS} days, clamping start from ${dateRange.start.toISOString()} to ${clampedStart.toISOString()}`,
      );
      return { start: clampedStart, end: dateRange.end };
    }

    return dateRange;
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

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
    try {
      return await fetch(url, {
        ...options,
        signal: controller.signal,
        headers: {
          ...((options?.headers as Record<string, string>) ?? {}),
          'X-API-Key': this.apiKey,
        },
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  private async fetchJsonWithRetry<T>(url: string): Promise<T> {
    return this.fetchWithRetryRaw(url) as Promise<T>;
  }

  private async fetchWithRetry(url: string): Promise<OddsPipeCandlestick[]> {
    return this.fetchWithRetryRaw(url) as Promise<OddsPipeCandlestick[]>;
  }

  private async fetchWithRetryRaw(url: string): Promise<unknown> {
    let lastError: Error | undefined;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        const res = await this.fetchWithRateLimit(url);

        if (res.ok) {
          return await res.json();
        }

        if (res.status >= 400 && res.status < 500) {
          throw new SystemHealthError(
            SYSTEM_HEALTH_ERROR_CODES.BACKTEST_ODDSPIPE_API_ERROR,
            `OddsPipe API ${res.status}: ${url}`,
            'error',
            'oddspipe',
          );
        }

        lastError = new Error(
          `OddsPipe API ${res.status} on attempt ${attempt + 1}`,
        );
        this.logger.warn(lastError.message);
      } catch (error) {
        if (error instanceof SystemHealthError) throw error;
        lastError = error instanceof Error ? error : new Error(String(error));
        this.logger.warn(
          `OddsPipe fetch attempt ${attempt + 1}/${MAX_RETRIES} failed: ${lastError.message}`,
        );
      }

      if (attempt < MAX_RETRIES - 1) {
        const delay = Math.pow(2, attempt) * 1000;
        const jitter = delay * (0.9 + Math.random() * 0.2);
        await new Promise((r) => setTimeout(r, jitter));
      }
    }

    throw new SystemHealthError(
      SYSTEM_HEALTH_ERROR_CODES.BACKTEST_ODDSPIPE_API_ERROR,
      `OddsPipe API failed after ${MAX_RETRIES} attempts: ${url}`,
      'error',
      'oddspipe',
      undefined,
      { lastError: lastError?.message },
    );
  }
}
