import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  SystemHealthError,
  SYSTEM_HEALTH_ERROR_CODES,
} from '../../../common/errors/system-health-error';
import type { ExternalMatchedPair } from '../types/match-validation.types';

interface PredexonPair {
  polymarket_condition_id: string;
  kalshi_ticker: string;
  polymarket_title: string;
  kalshi_title: string;
  similarity: number | null;
}

interface PredexonResponse {
  data: PredexonPair[];
  pagination: {
    total: number;
    limit: number;
    offset: number;
    has_more: boolean;
  };
}

const MAX_RETRIES = 3;
const HTTP_TIMEOUT_MS = 30_000;
const MIN_INTERVAL_MS = 72; // 14 req/s effective (70% of Dev tier 20 req/s)
const PAGE_SIZE = 100;
const MAX_PAGES = 100; // Guard against infinite pagination loops

@Injectable()
export class PredexonMatchingService {
  private readonly logger = new Logger(PredexonMatchingService.name);
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private lastRequestTs = 0;

  constructor(private readonly configService: ConfigService) {
    this.apiKey = this.configService.get<string>('PREDEXON_API_KEY') ?? '';
    this.baseUrl =
      this.configService.get<string>('PREDEXON_BASE_URL') ??
      'https://api.predexon.com';
  }

  async fetchMatchedPairs(): Promise<ExternalMatchedPair[]> {
    const allPairs: ExternalMatchedPair[] = [];
    let offset = 0;
    let hasMore = true;
    let pageCount = 0;

    while (hasMore) {
      if (pageCount >= MAX_PAGES) {
        this.logger.warn(
          `Predexon pagination exceeded ${MAX_PAGES} pages — stopping. Collected ${allPairs.length} pairs so far.`,
        );
        break;
      }

      const url = `${this.baseUrl}/v2/matching-markets/pairs?limit=${PAGE_SIZE}&offset=${offset}`;
      const response = await this.fetchWithRetry(url);

      if (response === null) {
        // 403 graceful degradation — return whatever we have (empty on first page)
        return allPairs;
      }

      // P-12: Validate response shape before use
      if (!Array.isArray(response.data)) {
        throw new SystemHealthError(
          SYSTEM_HEALTH_ERROR_CODES.BACKTEST_PREDEXON_API_ERROR,
          `Predexon API returned unexpected response shape: missing or non-array "data" field`,
          'error',
          'predexon',
        );
      }
      if (
        !response.pagination ||
        typeof response.pagination.has_more !== 'boolean'
      ) {
        throw new SystemHealthError(
          SYSTEM_HEALTH_ERROR_CODES.BACKTEST_PREDEXON_API_ERROR,
          `Predexon API returned unexpected response shape: missing or malformed "pagination" field`,
          'error',
          'predexon',
        );
      }

      if (response.data.length === 0) {
        break; // Empty page — no more data
      }

      for (const pair of response.data) {
        allPairs.push({
          polymarketId: pair.polymarket_condition_id,
          kalshiId: pair.kalshi_ticker,
          polymarketTitle: pair.polymarket_title,
          kalshiTitle: pair.kalshi_title,
          source: 'predexon',
          similarity: pair.similarity,
          spreadData: null,
        });
      }

      hasMore = response.pagination.has_more;
      offset += PAGE_SIZE;
      pageCount++;
    }

    return allPairs;
  }

  private async fetchWithRateLimit(url: string): Promise<Response> {
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
        signal: controller.signal,
        headers: {
          'x-api-key': this.apiKey,
        },
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  private async fetchWithRetry(url: string): Promise<PredexonResponse | null> {
    let lastError: Error | undefined;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        const res = await this.fetchWithRateLimit(url);

        if (res.ok) {
          return (await res.json()) as PredexonResponse;
        }

        // 403 = free tier / expired key — graceful degradation
        if (res.status === 403) {
          this.logger.warn(
            'Predexon Dev tier not active — skipping Predexon source',
          );
          return null;
        }

        lastError = new Error(
          `Predexon API ${res.status} on attempt ${attempt + 1}`,
        );
        this.logger.warn(lastError.message);
      } catch (error) {
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
      'predexon',
      undefined,
      { lastError: lastError?.message },
    );
  }
}
