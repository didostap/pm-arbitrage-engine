import { Injectable, Logger } from '@nestjs/common';
import Decimal from 'decimal.js';
import {
  Prisma,
  type ContractMatch,
  type HistoricalDataSource,
  type HistoricalPrice,
} from '@prisma/client';
import type { IBacktestConfig } from '../../../common/interfaces/backtest-engine.interface';
import { PrismaService } from '../../../common/prisma.service';
import type { NormalizedHistoricalDepth } from '../types/normalized-historical.types';
import type {
  BacktestTimeStep,
  BacktestTimeStepPair,
} from '../types/simulation.types';
import { parseJsonDepthLevels } from '../utils/depth-parsing.utils';

/** Map key: `${platform}:${contractId}`, value: depths sorted timestamp DESC */
export type DepthCache = Map<string, NormalizedHistoricalDepth[]>;

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class BacktestDataLoaderService {
  /** 1 dep: PrismaService — leaf service <=5 */
  private readonly logger = new Logger(BacktestDataLoaderService.name);

  constructor(private readonly prisma: PrismaService) {}

  async loadPairs(config: IBacktestConfig): Promise<ContractMatch[]> {
    return this.prisma.contractMatch.findMany({
      where: {
        operatorApproved: true,
        confidenceScore: { gte: config.minConfidenceScore },
      },
    });
  }

  generateChunkRanges(
    dateRangeStart: Date,
    dateRangeEnd: Date,
    chunkWindowDays: number,
  ): Array<{ start: Date; end: Date }> {
    const chunks: Array<{ start: Date; end: Date }> = [];
    let current = dateRangeStart.getTime();
    const endMs = dateRangeEnd.getTime();
    const chunkMs = chunkWindowDays * ONE_DAY_MS;

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

  async loadPricesForChunk(
    chunkStart: Date,
    chunkEnd: Date,
    endInclusive = false,
  ): Promise<HistoricalPrice[]> {
    return this.prisma.historicalPrice.findMany({
      where: {
        timestamp: endInclusive
          ? { gte: chunkStart, lte: chunkEnd }
          : { gte: chunkStart, lt: chunkEnd },
      },
      orderBy: { timestamp: 'asc' },
    });
  }

  private static readonly DEPTH_BATCH_SIZE = 500;

  async preloadDepthsForChunk(
    contractIds: string[],
    chunkStart: Date,
    chunkEnd: Date,
    endInclusive = false,
  ): Promise<DepthCache> {
    /** Cleanup: depthCache created per-chunk iteration, goes out of scope at end of each loop iteration → GC. No explicit .clear() needed. */
    const dedupedIds = [...new Set(contractIds)];
    const cache: DepthCache = new Map();

    if (dedupedIds.length === 0) return cache;

    try {
      // Batch contract IDs to avoid Prisma napi bridge serialization limits.
      // $queryRaw still marshals parameters through the Rust engine; large arrays crash it.
      for (
        let i = 0;
        i < dedupedIds.length;
        i += BacktestDataLoaderService.DEPTH_BATCH_SIZE
      ) {
        const batch = dedupedIds.slice(
          i,
          i + BacktestDataLoaderService.DEPTH_BATCH_SIZE,
        );
        await this.loadDepthBatch(
          batch,
          chunkStart,
          chunkEnd,
          endInclusive,
          cache,
        );
      }

      // Ensure DESC sort per key (defensive — batch order may interleave)
      for (const entries of cache.values()) {
        entries.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
      }

      return cache;
    } catch (error) {
      // Graceful degradation: modelFill falls back to close-price when depth cache is empty
      this.logger.warn(
        `Depth pre-loading failed, falling back to close-price fills: ${error instanceof Error ? error.message : String(error)}`,
      );
      return cache;
    }
  }

  private async loadDepthBatch(
    batchIds: string[],
    chunkStart: Date,
    chunkEnd: Date,
    endInclusive: boolean,
    cache: DepthCache,
  ): Promise<void> {
    const endCondition = endInclusive
      ? Prisma.sql`AND "timestamp" <= ${chunkEnd}`
      : Prisma.sql`AND "timestamp" < ${chunkEnd}`;

    const records = await this.prisma.$queryRaw<
      Array<{
        platform: string;
        contract_id: string;
        source: HistoricalDataSource;
        bids: unknown;
        asks: unknown;
        timestamp: Date;
        update_type: 'snapshot' | 'price_change' | null;
      }>
    >(Prisma.sql`
      SELECT platform, contract_id, source, bids, asks, "timestamp", update_type
      FROM historical_depths
      WHERE contract_id = ANY(${batchIds}::text[])
        AND "timestamp" >= ${chunkStart}
        ${endCondition}
        AND update_type = 'snapshot'
      ORDER BY "timestamp" DESC
    `);

    for (const record of records) {
      const key = `${record.platform}:${record.contract_id}`;
      const bidsJson = record.bids;
      const asksJson = record.asks;

      if (!Array.isArray(bidsJson) || !Array.isArray(asksJson)) continue;

      const parsed: NormalizedHistoricalDepth = {
        platform: record.platform,
        contractId: record.contract_id,
        source: record.source,
        bids: parseJsonDepthLevels(bidsJson as Array<Record<string, unknown>>),
        asks: parseJsonDepthLevels(asksJson as Array<Record<string, unknown>>),
        timestamp: record.timestamp,
        updateType: record.update_type,
      };

      if (!cache.has(key)) cache.set(key, []);
      cache.get(key)!.push(parsed);
    }
  }

  /**
   * Database-side alignment via $queryRaw.
   * Joins Kalshi + Polymarket prices by minute-truncated timestamp using a lateral
   * join backed by the (platform, contract_id, timestamp) index.
   * Returns ~179K aligned rows per day instead of loading 2.2M raw rows through Prisma's napi bridge.
   */
  async loadAlignedPricesForChunk(
    chunkStart: Date,
    chunkEnd: Date,
    minConfidenceScore: number,
    endInclusive = false,
  ): Promise<BacktestTimeStep[]> {
    const endOp = endInclusive
      ? Prisma.sql`AND k."timestamp" <= ${chunkEnd}`
      : Prisma.sql`AND k."timestamp" < ${chunkEnd}`;
    const endOpPoly = endInclusive
      ? Prisma.sql`AND hp."timestamp" <= ${chunkEnd}`
      : Prisma.sql`AND hp."timestamp" < ${chunkEnd}`;

    const rows = await this.prisma.$queryRaw<
      Array<{
        ts: Date;
        kalshi_contract_id: string;
        polymarket_contract_id: string;
        kalshi_close: Prisma.Decimal;
        polymarket_close: Prisma.Decimal;
        resolution_timestamp: Date | null;
      }>
    >(Prisma.sql`
      SELECT
        k."timestamp" AS ts,
        k.contract_id AS kalshi_contract_id,
        cm.polymarket_clob_token_id AS polymarket_contract_id,
        k.close AS kalshi_close,
        p.close AS polymarket_close,
        cm.resolution_timestamp
      FROM contract_matches cm
      JOIN historical_prices k
        ON k.platform = 'KALSHI'
        AND k.contract_id = cm.kalshi_contract_id
        AND k."timestamp" >= ${chunkStart}
        ${endOp}
      JOIN LATERAL (
        SELECT hp.close FROM historical_prices hp
        WHERE hp.platform = 'POLYMARKET'
          AND hp.contract_id = cm.polymarket_clob_token_id
          AND hp."timestamp" >= date_trunc('minute', k."timestamp")
          AND hp."timestamp" < date_trunc('minute', k."timestamp") + interval '1 minute'
          ${endOpPoly}
        LIMIT 1
      ) p ON true
      WHERE cm.operator_approved = true
        AND cm.polymarket_clob_token_id IS NOT NULL
        AND cm.confidence_score >= ${minConfidenceScore}
      ORDER BY k."timestamp" ASC
    `);

    // Group flat rows into BacktestTimeStep[] (same logic as alignPrices but on pre-aligned data)
    const byTimestamp = new Map<string, BacktestTimeStepPair[]>();
    for (const row of rows) {
      const tsKey = row.ts.toISOString().slice(0, 16) + ':00.000Z';
      if (!byTimestamp.has(tsKey)) byTimestamp.set(tsKey, []);
      byTimestamp.get(tsKey)!.push({
        pairId: `${row.kalshi_contract_id}:${row.polymarket_contract_id}`,
        kalshiContractId: row.kalshi_contract_id,
        polymarketContractId: row.polymarket_contract_id,
        kalshiClose: new Decimal(row.kalshi_close.toString()),
        polymarketClose: new Decimal(row.polymarket_close.toString()),
        resolutionTimestamp: row.resolution_timestamp,
      });
    }

    const timeSteps: BacktestTimeStep[] = [];
    for (const [tsKey, pairs] of byTimestamp) {
      timeSteps.push({ timestamp: new Date(tsKey), pairs });
    }
    timeSteps.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
    return timeSteps;
  }

  /**
   * Lightweight coverage check using MIN/MAX timestamp queries.
   * Returns whether data exists and the coverage percentage of the date range.
   */
  async checkDataCoverage(
    dateRangeStart: Date,
    dateRangeEnd: Date,
  ): Promise<{ hasData: boolean; coveragePct: number }> {
    const [oldest, newest] = await Promise.all([
      this.prisma.historicalPrice.findFirst({
        where: { timestamp: { gte: dateRangeStart, lte: dateRangeEnd } },
        orderBy: { timestamp: 'asc' },
        select: { timestamp: true },
      }),
      this.prisma.historicalPrice.findFirst({
        where: { timestamp: { gte: dateRangeStart, lte: dateRangeEnd } },
        orderBy: { timestamp: 'desc' },
        select: { timestamp: true },
      }),
    ]);

    if (!oldest || !newest) return { hasData: false, coveragePct: 0 };

    const dateRangeMs = dateRangeEnd.getTime() - dateRangeStart.getTime();
    const coveredMs = newest.timestamp.getTime() - oldest.timestamp.getTime();
    const coveragePct = dateRangeMs > 0 ? coveredMs / dateRangeMs : 0;

    return { hasData: true, coveragePct };
  }
}

/**
 * Pure standalone function for nearest-depth lookup from pre-loaded cache.
 * Binary search on timestamp-sorted (descending) array for the first entry
 * where depth.timestamp <= queryTimestamp.
 * Returns null if cache has no entry for the key or no depth <= query timestamp.
 */
export function findNearestDepthFromCache(
  depthCache: DepthCache,
  platform: string,
  contractId: string,
  timestamp: Date,
): NormalizedHistoricalDepth | null {
  const key = `${platform}:${contractId}`;
  const entries = depthCache.get(key);
  if (!entries || entries.length === 0) return null;

  const queryMs = timestamp.getTime();

  // entries sorted DESC by timestamp — binary search for first entry <= queryTimestamp
  let lo = 0;
  let hi = entries.length - 1;
  let result: NormalizedHistoricalDepth | null = null;

  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const entry = entries[mid];
    if (!entry) break;
    const midMs = entry.timestamp.getTime();

    if (midMs <= queryMs) {
      result = entry;
      hi = mid - 1; // look for a closer (more recent) match that's still <= query
    } else {
      lo = mid + 1; // midMs > queryMs, look later in the DESC array
    }
  }

  return result;
}
