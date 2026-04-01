import { Injectable, Logger } from '@nestjs/common';
import { HistoricalDataSource } from '@prisma/client';
import pLimit from 'p-limit';
import { PrismaService } from '../../../common/prisma.service';
import { KalshiHistoricalService } from './kalshi-historical.service';
import { PolymarketHistoricalService } from './polymarket-historical.service';
import { PredexonHistoricalService } from './predexon-historical.service';
import { MatchValidationService } from '../validation/match-validation.service';
import { IngestionQualityAssessorService } from './ingestion-quality-assessor.service';
import { SystemHealthError } from '../../../common/errors/system-health-error';
import { SYSTEM_HEALTH_ERROR_CODES } from '../../../common/errors/system-health-error';
import { withRetry } from '../../../common/utils/with-retry';

export interface FetchResult {
  recordCount: number;
  contractCount: number;
  error?: string;
}

interface TargetContract {
  kalshiTicker: string;
  polymarketTokenId: string;
  operatorApproved: boolean;
  resolutionTimestamp: Date | null;
}

/** 90 days in ms — default lookback for first-time incremental ingestion */
const DEFAULT_LOOKBACK_MS = 90 * 24 * 60 * 60 * 1000;

/** Process 5 targets concurrently to saturate the Predexon 18 req/s pipeline */
const PREDEXON_TARGET_CONCURRENCY = 5;

/** Retry strategy for per-source fetches: 3 attempts, 1s/2s/4s */
const FETCH_RETRY = {
  maxRetries: 2, // 3 total attempts (initial + 2 retries)
  initialDelayMs: 1000,
  backoffMultiplier: 2,
  maxDelayMs: 5000,
};

/**
 * Facade for per-source incremental data fetching.
 * 6 deps rationale: Facade coordinating 3 data sources (Kalshi, Polymarket, Predexon) + validation + quality assessor + persistence
 */
@Injectable()
export class IncrementalFetchService {
  private readonly logger = new Logger(IncrementalFetchService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly kalshiHistorical: KalshiHistoricalService,
    private readonly polymarketHistorical: PolymarketHistoricalService,
    private readonly predexonHistorical: PredexonHistoricalService,
    private readonly matchValidation: MatchValidationService,
    private readonly qualityAssessor: IngestionQualityAssessorService,
  ) {}

  async fetchAll(
    targets: Map<string, TargetContract>,
  ): Promise<Map<HistoricalDataSource, FetchResult>> {
    const results = new Map<HistoricalDataSource, FetchResult>();
    const now = new Date();

    // Platform data — per source error isolation
    // await this.fetchPlatformData(targets, now, results);

    // Third-party data
    await this.fetchThirdPartyData(targets, now, results);

    return results;
  }

  // TODO remove
  // @ts-expect-error - TODO: implement
  private async fetchPlatformData(
    targets: Map<string, TargetContract>,
    end: Date,
    results: Map<HistoricalDataSource, FetchResult>,
  ): Promise<void> {
    // Kalshi — batch-fetch incremental starts for all contracts, then ingest sequentially
    // Quality checks collected during fetch, run after successful fetch (outside retry)
    let kalshiQualityTasks: Array<{
      matchId: string;
      target: TargetContract;
      dateRange: { start: Date; end: Date };
    }> = [];

    await this.fetchSource(
      'KALSHI_API' as HistoricalDataSource,
      results,
      async () => {
        kalshiQualityTasks = []; // Reset on retry
        const kalshiTickers = [...targets.values()].map((t) => t.kalshiTicker);
        const [priceStarts, tradeStarts] = await Promise.all([
          this.batchGetIncrementalStarts(
            'KALSHI_API' as HistoricalDataSource,
            kalshiTickers,
            'price',
          ),
          this.batchGetIncrementalStarts(
            'KALSHI_API' as HistoricalDataSource,
            kalshiTickers,
            'trade',
          ),
        ]);

        let totalRecords = 0;
        let contractCount = 0;

        for (const [matchId, target] of targets) {
          try {
            const priceStart = priceStarts.get(target.kalshiTicker)!;
            const tradeStart = tradeStarts.get(target.kalshiTicker)!;
            const prices = await this.kalshiHistorical.ingestPrices(
              target.kalshiTicker,
              { start: priceStart, end },
            );
            const trades = await this.kalshiHistorical.ingestTrades(
              target.kalshiTicker,
              { start: tradeStart, end },
            );
            totalRecords += prices.recordCount + trades.recordCount;
            contractCount++;
            const qualityStart = new Date(
              Math.min(priceStart.getTime(), tradeStart.getTime()),
            );
            kalshiQualityTasks.push({
              matchId,
              target,
              dateRange: { start: qualityStart, end },
            });
          } catch (error) {
            this.logger.error(
              `Kalshi fetch failed: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
        return { recordCount: totalRecords, contractCount };
      },
    );

    for (const task of kalshiQualityTasks) {
      await this.runQualityCheck(task.matchId, task.target, task.dateRange);
    }

    // Polymarket — batch-fetch incremental starts, then ingest with concurrency
    // Quality checks collected during fetch, run after successful fetch (outside retry)
    let polyQualityTasks: Array<{
      matchId: string;
      target: TargetContract;
      dateRange: { start: Date; end: Date };
    }> = [];

    await this.fetchSource(
      'POLYMARKET_API' as HistoricalDataSource,
      results,
      async () => {
        polyQualityTasks = []; // Reset on retry
        const polyTokenIds = [...targets.values()].map(
          (t) => t.polymarketTokenId,
        );
        const priceStarts = await this.batchGetIncrementalStarts(
          'POLYMARKET_API' as HistoricalDataSource,
          polyTokenIds,
          'price',
        );

        let totalRecords = 0;
        let contractCount = 0;
        const POLY_BATCH = 5;
        const entries = [...targets.entries()];

        for (let i = 0; i < entries.length; i += POLY_BATCH) {
          try {
            const batch = entries.slice(i, i + POLY_BATCH);
            const batchResults = await Promise.allSettled(
              batch.map(async ([matchId, target]) => {
                const start = priceStarts.get(target.polymarketTokenId)!;
                const dateRange = { start, end };
                const prices = await this.polymarketHistorical.ingestPrices(
                  target.polymarketTokenId,
                  dateRange,
                );
                polyQualityTasks.push({ matchId, target, dateRange });
                return prices.recordCount;
              }),
            );
            for (const result of batchResults) {
              if (result.status === 'fulfilled') {
                totalRecords += result.value;
                contractCount++;
              } else {
                this.logger.warn(
                  `Polymarket contract ingestion failed: ${result.reason}`,
                );
              }
            }
          } catch (error) {
            this.logger.error(
              `Polymarket fetch failed: ${error instanceof Error ? error.message : String(error)}`,
            );
            throw error;
          }
        }
        return { recordCount: totalRecords, contractCount };
      },
    );

    for (const task of polyQualityTasks) {
      await this.runQualityCheck(task.matchId, task.target, task.dateRange);
    }

    // Goldsky (Polymarket on-chain trades) — batch-fetch incremental starts
    await this.fetchSource(
      'GOLDSKY' as HistoricalDataSource,
      results,
      async () => {
        const polyTokenIds = [...targets.values()].map(
          (t) => t.polymarketTokenId,
        );
        const tradeStarts = await this.batchGetIncrementalStarts(
          'GOLDSKY' as HistoricalDataSource,
          polyTokenIds,
          'trade',
        );

        let totalRecords = 0;
        let contractCount = 0;
        for (const [, target] of targets) {
          try {
            const start = tradeStarts.get(target.polymarketTokenId)!;
            const dateRange = { start, end };
            const trades = await this.polymarketHistorical.ingestTrades(
              target.polymarketTokenId,
              dateRange,
            );
            totalRecords += trades.recordCount;
            contractCount++;
          } catch (error) {
            this.logger.error(
              `Goldsky fetch failed: ${error instanceof Error ? error.message : String(error)}`,
            );
            // throw error;
          }
        }
        return { recordCount: totalRecords, contractCount };
      },
    );
  }

  private async fetchThirdPartyData(
    targets: Map<string, TargetContract>,
    end: Date,
    results: Map<HistoricalDataSource, FetchResult>,
  ): Promise<void> {
    // Predexon Polymarket Depth (replaces PMXT Archive)
    await this.fetchSource(
      'PREDEXON' as HistoricalDataSource,
      results,
      async () => {
        // Deduplicate: multiple matches may reference the same contracts
        const uniqueTargets = new Map<string, TargetContract>();
        for (const target of targets.values()) {
          const key = `${target.polymarketTokenId}:${target.kalshiTicker}`;
          if (!uniqueTargets.has(key)) {
            uniqueTargets.set(key, target);
          }
        }

        const polyTokenIds = [
          ...new Set(
            [...uniqueTargets.values()].map((t) => t.polymarketTokenId),
          ),
        ];
        const kalshiTickers = [
          ...new Set([...uniqueTargets.values()].map((t) => t.kalshiTicker)),
        ];
        const [polyDepthStarts, polyPriceStarts, kalshiDepthStarts] =
          await Promise.all([
            this.batchGetIncrementalStarts(
              'PREDEXON' as HistoricalDataSource,
              polyTokenIds,
              'depth',
            ),
            this.batchGetIncrementalStarts(
              'PREDEXON' as HistoricalDataSource,
              polyTokenIds,
              'price',
            ),
            this.batchGetIncrementalStarts(
              'PREDEXON' as HistoricalDataSource,
              kalshiTickers,
              'depth',
            ),
          ]);

        let totalRecords = 0;
        let contractCount = 0;
        const limit = pLimit(PREDEXON_TARGET_CONCURRENCY);

        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        let counter = 0;
        const settled = await Promise.allSettled(
          [...uniqueTargets.values()].map((target) =>
            limit(async () => {
              counter++;

              const priceStart =
                polyPriceStarts.get(target.polymarketTokenId) ?? end;
              const polyDepthStart =
                polyDepthStarts.get(target.polymarketTokenId) ?? end;
              const kalshiDepthStart =
                kalshiDepthStarts.get(target.kalshiTicker) ?? end;

              const [priceResult, polyDepthResult, kalshiDepthResult] =
                await Promise.allSettled([
                  this.predexonHistorical.ingestPolymarketPrices(
                    target.polymarketTokenId,
                    { start: priceStart, end },
                  ),
                  this.predexonHistorical.ingestPolymarketDepth(
                    target.polymarketTokenId,
                    { start: polyDepthStart, end },
                  ),
                  this.predexonHistorical.ingestKalshiDepth(
                    target.kalshiTicker,
                    { start: kalshiDepthStart, end },
                  ),
                ]);

              let records = 0;
              for (const r of [
                priceResult,
                polyDepthResult,
                kalshiDepthResult,
              ]) {
                if (r.status === 'fulfilled') {
                  records += r.value.recordCount;
                } else {
                  this.logger.warn(
                    `Predexon ingest failed for ${target.polymarketTokenId}: ${r.reason}`,
                  );
                }
              }
              return records;
            }),
          ),
        );

        for (const r of settled) {
          if (r.status === 'fulfilled') {
            totalRecords += r.value;
            contractCount++;
          }
        }
        return { recordCount: totalRecords, contractCount };
      },
    );

    // Match validation re-run
    await this.runMatchValidation(results);
  }

  private async runMatchValidation(
    results: Map<HistoricalDataSource, FetchResult>,
  ): Promise<void> {
    try {
      const correlationId = `incremental-validation-${Date.now()}`;

      // Query previous report for externalOnlyCount comparison
      const previousReports = await this.prisma.matchValidationReport.findMany({
        orderBy: { runTimestamp: 'desc' },
        take: 1,
        select: { externalOnlyCount: true },
      });
      const previousExternalOnly = previousReports[0]?.externalOnlyCount ?? 0;

      const report = await this.matchValidation.runValidation(
        {},
        correlationId,
      );

      // Compare externalOnlyCount with previous report
      if (report && typeof report.externalOnlyCount === 'number') {
        const delta = report.externalOnlyCount - previousExternalOnly;
        if (delta > 0) {
          this.logger.warn(
            `External-only matches increased by ${delta} (previous: ${previousExternalOnly}, current: ${report.externalOnlyCount})`,
          );
        }
      }

      if (!results.has('PREDEXON' as HistoricalDataSource)) {
        results.set('PREDEXON' as HistoricalDataSource, {
          recordCount: 0,
          contractCount: 0,
        });
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Match validation re-run failed: ${msg}`);
    }
  }

  private async fetchSource(
    source: HistoricalDataSource,
    results: Map<HistoricalDataSource, FetchResult>,
    fn: () => Promise<{ recordCount: number; contractCount: number }>,
  ): Promise<void> {
    try {
      const result = await withRetry(fn, FETCH_RETRY, (attempt, error) => {
        this.logger.warn(`Retry ${attempt} for ${source}: ${error.message}`);
      });
      results.set(source, result);
    } catch (error) {
      const sysError =
        error instanceof SystemHealthError
          ? error
          : new SystemHealthError(
              SYSTEM_HEALTH_ERROR_CODES.BACKTEST_INGESTION_FAILURE,
              `Incremental fetch failed for ${source}: ${error instanceof Error ? error.message : String(error)}`,
              'warning',
              'IncrementalFetchService',
            );
      this.logger.error(sysError.message);
      results.set(source, {
        recordCount: 0,
        contractCount: 0,
        error: sysError.message,
      });
    }
  }

  /**
   * Batch-fetch incremental start timestamps for multiple contracts concurrently.
   * Uses parallel aggregate queries (one per contract) instead of sequential calls.
   */
  private async batchGetIncrementalStarts(
    source: HistoricalDataSource,
    contractIds: string[],
    table: 'price' | 'trade' | 'depth' = 'price',
  ): Promise<Map<string, Date>> {
    if (contractIds.length === 0) return new Map();

    const model =
      table === 'trade'
        ? this.prisma.historicalTrade
        : table === 'depth'
          ? this.prisma.historicalDepth
          : this.prisma.historicalPrice;

    const defaultStart = new Date(Date.now() - DEFAULT_LOOKBACK_MS);

    // Process in batches of 10 to avoid exhausting the Prisma connection pool (limit: 21)
    const BATCH_SIZE = 10;
    const results: Array<{ contractId: string; timestamp: Date }> = [];
    for (let i = 0; i < contractIds.length; i += BATCH_SIZE) {
      const batch = contractIds.slice(i, i + BATCH_SIZE);
      const batchResults = await Promise.all(
        batch.map(async (contractId) => {
          const result = await (
            model as typeof this.prisma.historicalPrice
          ).aggregate({
            where: { source, contractId },
            _max: { timestamp: true },
          });
          return {
            contractId,
            timestamp: result._max.timestamp ?? defaultStart,
          };
        }),
      );
      results.push(...batchResults);
    }

    return new Map(results.map((r) => [r.contractId, r.timestamp]));
  }

  /** Single-contract convenience wrapper — used by OddsPipe per-contract error isolation */
  // TODO remove
  // @ts-expect-error - TODO: remove
  private async getIncrementalStart(
    source: HistoricalDataSource,
    contractId: string,
    table: 'price' | 'trade' | 'depth' = 'price',
  ): Promise<Date> {
    const map = await this.batchGetIncrementalStarts(
      source,
      [contractId],
      table,
    );
    return map.get(contractId)!;
  }

  private async runQualityCheck(
    matchId: string,
    target: TargetContract,
    dateRange: { start: Date; end: Date },
  ): Promise<void> {
    try {
      const correlationId = `incremental-quality-${matchId}-${Date.now()}`;
      await this.qualityAssessor.runQualityAssessment(
        matchId,
        target,
        dateRange,
        correlationId,
      );
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Quality check failed for ${matchId}: ${msg}`);
    }
  }
}
