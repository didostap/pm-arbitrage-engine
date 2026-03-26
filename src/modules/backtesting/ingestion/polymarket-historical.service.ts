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

/** USDC.e collateral token address on Polygon PoS — verified from Polymarket docs */
export const USDC_ASSET_ID = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';

const VALID_SIDES = new Set(['buy', 'sell']);

interface GoldskyOrderFilledEvent {
  id: string;
  transactionHash: string;
  timestamp: string;
  maker: string;
  taker: string;
  makerAssetId: string;
  takerAssetId: string;
  makerAmountFilled: string;
  takerAmountFilled: string;
  fee: string;
}

interface PolymarketPricePoint {
  t: number;
  p: number;
}

const BATCH_SIZE = 500;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const GOLDSKY_PAGE_SIZE = 1000;
const GOLDSKY_EFFECTIVE_RATE = 70; // 70% of 100 req/s
const GOLDSKY_MIN_INTERVAL_MS = 1000 / GOLDSKY_EFFECTIVE_RATE;
const THROTTLE_RESPONSE_TIME_MS = 5000;
const THROTTLE_BACKOFF_MS = 10_000;
const HTTP_TIMEOUT_MS = 30_000;

@Injectable()
export class PolymarketHistoricalService implements IHistoricalDataProvider {
  private readonly logger = new Logger(PolymarketHistoricalService.name);
  private readonly clobApiUrl: string;
  private readonly goldskyUrl: string;
  private lastGoldskyRequestTs = 0;
  private _isThrottled = false;

  get isThrottled(): boolean {
    return this._isThrottled;
  }

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
  ) {
    this.clobApiUrl = this.configService.get<string>(
      'POLYMARKET_CLOB_API_URL',
      'https://clob.polymarket.com',
    );
    this.goldskyUrl = this.configService.get<string>(
      'GOLDSKY_SUBGRAPH_URL',
      'https://api.goldsky.com/api/public/project_cl6mb8i9h0003e201j6li0diw/subgraphs/orderbook-subgraph/0.0.1/gn',
    );
  }

  async ingestPrices(
    contractId: string,
    dateRange: { start: Date; end: Date },
  ): Promise<IngestionMetadata> {
    const startMs = Date.now();
    const chunks = this.chunkDateRange(dateRange.start, dateRange.end);
    let totalRecords = 0;

    for (const chunk of chunks) {
      // P11: Apply backoff when throttled
      if (this._isThrottled) {
        this.logger.warn(
          `Applying ${THROTTLE_BACKOFF_MS}ms backoff due to Cloudflare throttling`,
        );
        await new Promise((r) => setTimeout(r, THROTTLE_BACKOFF_MS));
        this._isThrottled = false;
      }

      const url = new URL(`${this.clobApiUrl}/prices-history`);
      url.searchParams.set('market', contractId);
      url.searchParams.set(
        'startTs',
        String(Math.floor(chunk.start.getTime() / 1000)),
      );
      url.searchParams.set(
        'endTs',
        String(Math.floor(chunk.end.getTime() / 1000)),
      );
      url.searchParams.set('fidelity', '1');

      const fetchStart = Date.now();
      const res = await this.fetchWithTimeout(url.toString());
      const elapsed = Date.now() - fetchStart;

      if (elapsed > THROTTLE_RESPONSE_TIME_MS) {
        this._isThrottled = true;
        this.logger.warn(
          `Cloudflare throttling detected: response took ${elapsed}ms`,
        );
      }

      if (!res.ok) {
        throw new SystemHealthError(
          SYSTEM_HEALTH_ERROR_CODES.BACKTEST_EXTERNAL_API_ERROR,
          `Polymarket prices API ${res.status}`,
          'error',
          'PolymarketHistoricalService',
        );
      }

      const data = (await res.json()) as {
        history?: PolymarketPricePoint[];
      };
      const history = data.history ?? [];

      // P12: Convert float to string before Decimal to avoid IEEE 754 noise
      const records: Prisma.HistoricalPriceCreateManyInput[] = history.map(
        (point) => ({
          platform: Platform.POLYMARKET,
          contractId,
          source: HistoricalDataSource.POLYMARKET_API,
          intervalMinutes: 1,
          timestamp: new Date(point.t * 1000),
          open: new Decimal(String(point.p)),
          high: new Decimal(String(point.p)),
          low: new Decimal(String(point.p)),
          close: new Decimal(String(point.p)),
          volume: null,
          openInterest: null,
        }),
      );

      // P18: Flush each chunk immediately
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
      source: HistoricalDataSource.POLYMARKET_API,
      platform: 'polymarket',
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
    let lastId: string | undefined;
    let hasMore = true;
    let totalRecords = 0;

    while (hasMore) {
      await this.goldskyRateLimit();

      const variables: Record<string, unknown> = {
        timestamp_gte: String(Math.floor(dateRange.start.getTime() / 1000)),
        timestamp_lte: String(Math.floor(dateRange.end.getTime() / 1000)),
        first: GOLDSKY_PAGE_SIZE,
      };
      if (lastId) {
        variables.id_gt = lastId;
      }

      const query = `query OrderFilledEvents($timestamp_gte: BigInt!, $timestamp_lte: BigInt!, $first: Int!, $id_gt: ID) {
  orderFilledEvents(
    where: { timestamp_gte: $timestamp_gte, timestamp_lte: $timestamp_lte, id_gt: $id_gt }
    first: $first
    orderBy: id
    orderDirection: asc
  ) {
    id
    transactionHash
    timestamp
    maker
    taker
    makerAssetId
    takerAssetId
    makerAmountFilled
    takerAmountFilled
    fee
  }
}`;

      // P10: Use fetchWithTimeout for Goldsky — bare fetch can hang indefinitely
      const res = await this.fetchWithTimeout(this.goldskyUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, variables }),
      });

      if (!res.ok) {
        throw new SystemHealthError(
          SYSTEM_HEALTH_ERROR_CODES.BACKTEST_EXTERNAL_API_ERROR,
          `Goldsky API ${res.status}`,
          'error',
          'PolymarketHistoricalService',
        );
      }

      const data = (await res.json()) as {
        data?: { orderFilledEvents?: GoldskyOrderFilledEvent[] };
        errors?: Array<{ message: string }>;
      };

      if (data.errors?.length) {
        throw new SystemHealthError(
          SYSTEM_HEALTH_ERROR_CODES.BACKTEST_EXTERNAL_API_ERROR,
          `Goldsky GraphQL error: ${data.errors[0]!.message}`,
          'error',
          'PolymarketHistoricalService',
        );
      }

      const events = data.data?.orderFilledEvents ?? [];

      if (events.length === 0) {
        hasMore = false;
        break;
      }

      // Client-side filter by target token ID, then flush per page
      const pageRecords: Prisma.HistoricalTradeCreateManyInput[] = [];
      for (const event of events) {
        if (
          event.makerAssetId !== contractId &&
          event.takerAssetId !== contractId
        ) {
          continue;
        }

        const derived = this.deriveTradeFromEvent(event);
        if (derived) {
          pageRecords.push({
            platform: Platform.POLYMARKET,
            contractId,
            source: HistoricalDataSource.GOLDSKY,
            externalTradeId: event.id,
            price: derived.price,
            size: derived.size,
            side: derived.side,
            timestamp: new Date(Number(event.timestamp) * 1000),
          });
        }
      }

      // P18: Flush each page to DB immediately
      for (let i = 0; i < pageRecords.length; i += BATCH_SIZE) {
        const batch = pageRecords.slice(i, i + BATCH_SIZE);
        await this.prisma.historicalTrade.createMany({
          data: batch,
          skipDuplicates: true,
        });
      }
      totalRecords += pageRecords.length;

      // IG-2: Goldsky ID ordering — KNOWN LIMITATION. The Graph docs state entity IDs
      // sort alphanumerically, NOT by creation time. id_gt pagination combined with
      // timestamp_gte/timestamp_lte WHERE clause may miss events whose IDs sort before
      // our cursor. For correctness, switch to orderBy: timestamp + tie-breaking cursor.
      // Accepted risk for MVP: within a bounded time window the omission rate is low.
      // TODO: Switch to timestamp-based pagination in a follow-up story.
      lastId = events[events.length - 1]!.id;
      if (events.length < GOLDSKY_PAGE_SIZE) {
        hasMore = false;
      }
    }

    return {
      source: HistoricalDataSource.GOLDSKY,
      platform: 'polymarket',
      contractId,
      recordCount: totalRecords,
      dateRange,
      durationMs: Date.now() - startMs,
    };
  }

  async importPolyDataBootstrap(
    csvContent: string,
    contractId: string,
  ): Promise<void> {
    const lines = csvContent.trim().split('\n');
    const dataLines = lines.slice(1);

    const records: Prisma.HistoricalTradeCreateManyInput[] = [];
    for (let lineIdx = 0; lineIdx < dataLines.length; lineIdx++) {
      const line = dataLines[lineIdx]!;
      if (!line.trim()) continue;

      const parts = line.split(',');
      // P13: Validate CSV field count
      if (parts.length < 4) {
        this.logger.warn(
          `Skipping malformed CSV line ${lineIdx + 2}: expected 4 columns, got ${parts.length}`,
        );
        continue;
      }

      const [timestamp, price, usdAmount, side] = parts as [
        string,
        string,
        string,
        string,
      ];

      // P13: Validate numeric fields
      const tsNum = Number(timestamp);
      if (isNaN(tsNum) || tsNum <= 0) {
        this.logger.warn(
          `Skipping CSV line ${lineIdx + 2}: invalid timestamp "${timestamp}"`,
        );
        continue;
      }

      let priceDecimal: Decimal;
      let sizeDecimal: Decimal;
      try {
        priceDecimal = new Decimal(price);
        sizeDecimal = new Decimal(usdAmount);
      } catch {
        this.logger.warn(
          `Skipping CSV line ${lineIdx + 2}: invalid numeric value`,
        );
        continue;
      }

      // P13: Validate side enum
      const trimmedSide = side.trim();
      if (!VALID_SIDES.has(trimmedSide)) {
        this.logger.warn(
          `Skipping CSV line ${lineIdx + 2}: invalid side "${trimmedSide}", expected "buy" or "sell"`,
        );
        continue;
      }

      records.push({
        platform: Platform.POLYMARKET,
        contractId,
        source: HistoricalDataSource.POLY_DATA,
        externalTradeId: `polydata-${timestamp}-${contractId}`,
        price: priceDecimal,
        size: sizeDecimal,
        side: trimmedSide,
        timestamp: new Date(tsNum * 1000),
      });
    }

    for (let i = 0; i < records.length; i += BATCH_SIZE) {
      const batch = records.slice(i, i + BATCH_SIZE);
      await this.prisma.historicalTrade.createMany({
        data: batch,
        skipDuplicates: true,
      });
    }
  }

  getSupportedSources(): HistoricalDataSource[] {
    return [
      HistoricalDataSource.POLYMARKET_API,
      HistoricalDataSource.GOLDSKY,
      HistoricalDataSource.POLY_DATA,
    ];
  }

  private deriveTradeFromEvent(
    event: GoldskyOrderFilledEvent,
  ): { price: Decimal; size: Decimal; side: string } | null {
    const makerAsset = event.makerAssetId;
    const takerAsset = event.takerAssetId;

    let usdcAmount: Decimal;
    let tokenAmount: Decimal;
    let side: string;

    if (makerAsset.toLowerCase() === USDC_ASSET_ID.toLowerCase()) {
      side = 'buy';
      usdcAmount = new Decimal(event.makerAmountFilled).div(1e6);
      tokenAmount = new Decimal(event.takerAmountFilled).div(1e6);
    } else if (takerAsset.toLowerCase() === USDC_ASSET_ID.toLowerCase()) {
      side = 'sell';
      usdcAmount = new Decimal(event.takerAmountFilled).div(1e6);
      tokenAmount = new Decimal(event.makerAmountFilled).div(1e6);
    } else {
      return null; // token-to-token trade, skip
    }

    if (tokenAmount.isZero()) return null;

    const price = usdcAmount.div(tokenAmount);
    return { price, size: usdcAmount, side };
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

  private async goldskyRateLimit(): Promise<void> {
    const now = Date.now();
    const elapsed = now - this.lastGoldskyRequestTs;
    if (elapsed < GOLDSKY_MIN_INTERVAL_MS) {
      await new Promise((r) =>
        setTimeout(r, GOLDSKY_MIN_INTERVAL_MS - elapsed),
      );
    }
    this.lastGoldskyRequestTs = Date.now();
  }

  private async fetchWithTimeout(
    url: string,
    init?: RequestInit,
  ): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
    try {
      return await fetch(url, {
        ...init,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
  }
}
