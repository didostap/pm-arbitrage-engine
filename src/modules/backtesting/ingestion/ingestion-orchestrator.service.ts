import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import Decimal from 'decimal.js';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { PrismaService } from '../../../common/prisma.service';
import { KalshiHistoricalService } from './kalshi-historical.service';
import { PolymarketHistoricalService } from './polymarket-historical.service';
import { DataQualityService } from './data-quality.service';
import { EVENT_NAMES } from '../../../common/events/event-catalog';
import { BacktestDataIngestedEvent } from '../../../common/events/backtesting.events';
import { IngestionProgressDto } from '../dto/ingestion-progress.dto';
import type { DataQualityFlags } from '../../../common/types/historical-data.types';

interface TargetContract {
  kalshiTicker: string;
  polymarketTokenId: string;
  operatorApproved: boolean;
  resolutionTimestamp: Date | null;
}

/** Max records to query back from DB for quality assessment */
const QUALITY_SAMPLE_LIMIT = 10_000;

@Injectable()
export class IngestionOrchestratorService {
  private readonly logger = new Logger(IngestionOrchestratorService.name);

  /** Cleanup: .clear() at run start, entries .delete() on completion/failure */
  private progressMap = new Map<string, IngestionProgressDto>();

  /** P6: Concurrency guard — only one ingestion run at a time */
  private _isRunning = false;

  get isRunning(): boolean {
    return this._isRunning;
  }

  constructor(
    private readonly prisma: PrismaService,
    private readonly kalshiHistorical: KalshiHistoricalService,
    private readonly polymarketHistorical: PolymarketHistoricalService,
    private readonly dataQuality: DataQualityService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  /** Cleanup: rebuilt each run, not persisted across runs */
  async buildTargetList(): Promise<Map<string, TargetContract>> {
    const matches = await this.prisma.contractMatch.findMany({
      where: { operatorApproved: true },
      select: {
        matchId: true,
        kalshiContractId: true,
        polymarketClobTokenId: true,
        operatorApproved: true,
        resolutionTimestamp: true,
      },
    });

    const targets = new Map<string, TargetContract>();
    for (const m of matches) {
      if (!m.polymarketClobTokenId) continue;
      targets.set(m.matchId, {
        kalshiTicker: m.kalshiContractId,
        polymarketTokenId: m.polymarketClobTokenId,
        operatorApproved: m.operatorApproved,
        resolutionTimestamp: m.resolutionTimestamp,
      });
    }

    return targets;
  }

  async runIngestion(dto: {
    dateRangeStart: Date;
    dateRangeEnd: Date;
  }): Promise<void> {
    // P6: Reject concurrent runs
    if (this._isRunning) {
      throw new Error(
        'Ingestion already in progress — wait for the current run to complete',
      );
    }

    this._isRunning = true;
    const correlationId = randomUUID();
    this.progressMap.clear();

    // P16: Structured start log
    this.logger.log({
      message: 'Ingestion run started',
      correlationId,
      dateRange: {
        start: dto.dateRangeStart.toISOString(),
        end: dto.dateRangeEnd.toISOString(),
      },
    });

    try {
      const targets = await this.buildTargetList();
      const dateRange = {
        start: dto.dateRangeStart,
        end: dto.dateRangeEnd,
      };

      this.logger.log({
        message: `Built target list: ${targets.size} contracts`,
        correlationId,
      });

      for (const [matchId, target] of targets) {
        const progressKey = `${matchId}`;
        this.progressMap.set(progressKey, {
          source: 'all',
          contractId: matchId,
          status: 'in-progress',
          recordsIngested: 0,
          errors: [],
        });

        try {
          let totalRecords = 0;

          // P4 + P16: Emit per source/contract events with structured logs

          // Kalshi prices
          this.logger.log({
            message: `Ingesting Kalshi prices for ${target.kalshiTicker}`,
            correlationId,
            matchId,
          });
          const kp = await this.kalshiHistorical.ingestPrices(
            target.kalshiTicker,
            dateRange,
          );
          totalRecords += kp.recordCount;
          this.eventEmitter.emit(
            EVENT_NAMES.BACKTEST_DATA_INGESTED,
            new BacktestDataIngestedEvent({
              source: 'KALSHI_API',
              platform: 'kalshi',
              contractId: target.kalshiTicker,
              recordCount: kp.recordCount,
              dateRange,
              correlationId,
            }),
          );

          // Kalshi trades
          this.logger.log({
            message: `Ingesting Kalshi trades for ${target.kalshiTicker}`,
            correlationId,
            matchId,
          });
          const kt = await this.kalshiHistorical.ingestTrades(
            target.kalshiTicker,
            dateRange,
          );
          totalRecords += kt.recordCount;
          this.eventEmitter.emit(
            EVENT_NAMES.BACKTEST_DATA_INGESTED,
            new BacktestDataIngestedEvent({
              source: 'KALSHI_API',
              platform: 'kalshi',
              contractId: target.kalshiTicker,
              recordCount: kt.recordCount,
              dateRange,
              correlationId,
            }),
          );

          // Polymarket prices
          this.logger.log({
            message: `Ingesting Polymarket prices for ${target.polymarketTokenId}`,
            correlationId,
            matchId,
          });
          const pp = await this.polymarketHistorical.ingestPrices(
            target.polymarketTokenId,
            dateRange,
          );
          totalRecords += pp.recordCount;
          this.eventEmitter.emit(
            EVENT_NAMES.BACKTEST_DATA_INGESTED,
            new BacktestDataIngestedEvent({
              source: 'POLYMARKET_API',
              platform: 'polymarket',
              contractId: target.polymarketTokenId,
              recordCount: pp.recordCount,
              dateRange,
              correlationId,
            }),
          );

          // Polymarket/Goldsky trades
          this.logger.log({
            message: `Ingesting Goldsky trades for ${target.polymarketTokenId}`,
            correlationId,
            matchId,
          });
          const pt = await this.polymarketHistorical.ingestTrades(
            target.polymarketTokenId,
            dateRange,
          );
          totalRecords += pt.recordCount;
          this.eventEmitter.emit(
            EVENT_NAMES.BACKTEST_DATA_INGESTED,
            new BacktestDataIngestedEvent({
              source: 'GOLDSKY',
              platform: 'polymarket',
              contractId: target.polymarketTokenId,
              recordCount: pt.recordCount,
              dateRange,
              correlationId,
            }),
          );

          // P3: Run quality assessment on ingested data with actual ContractMatch data
          await this.runQualityAssessment(
            matchId,
            target,
            dateRange,
            correlationId,
          );

          this.progressMap.set(progressKey, {
            source: 'all',
            contractId: matchId,
            status: 'complete',
            recordsIngested: totalRecords,
            errors: [],
          });

          // P16: Structured completion log
          this.logger.log({
            message: `Ingestion complete for ${matchId}: ${totalRecords} records`,
            correlationId,
            matchId,
            totalRecords,
          });
        } catch (error: unknown) {
          const msg = error instanceof Error ? error.message : String(error);
          this.logger.error(`Ingestion failed for ${matchId}: ${msg}`);
          this.progressMap.set(progressKey, {
            source: 'all',
            contractId: matchId,
            status: 'failed',
            recordsIngested: 0,
            errors: [msg],
          });
        }
      }

      // P16: Structured run completion log
      this.logger.log({
        message: 'Ingestion run completed',
        correlationId,
        contractsProcessed: targets.size,
      });
    } finally {
      this._isRunning = false;
    }
  }

  getProgress(): IngestionProgressDto[] {
    return Array.from(this.progressMap.values());
  }

  /**
   * P3: Query ingested data from DB and run quality assessment.
   * Updates records with quality flags and emits warning events.
   */
  private async runQualityAssessment(
    matchId: string,
    target: TargetContract,
    dateRange: { start: Date; end: Date },
    correlationId: string,
  ): Promise<void> {
    // Survivorship bias — use actual ContractMatch data
    const survivorFlags = this.dataQuality.assessSurvivorshipBias(matchId, {
      operatorApproved: target.operatorApproved,
      resolutionTimestamp: target.resolutionTimestamp,
    });

    // Query Kalshi prices for quality assessment
    const kalshiPrices = await this.prisma.historicalPrice.findMany({
      where: {
        contractId: target.kalshiTicker,
        platform: 'KALSHI',
        timestamp: { gte: dateRange.start, lte: dateRange.end },
      },
      orderBy: { timestamp: 'asc' },
      take: QUALITY_SAMPLE_LIMIT,
    });

    const kalshiPriceFlags =
      kalshiPrices.length > 0
        ? this.dataQuality.assessPriceQuality(
            kalshiPrices.map((p) => ({
              platform: p.platform,
              contractId: p.contractId,
              source: p.source,
              intervalMinutes: p.intervalMinutes,
              timestamp: p.timestamp,
              open: new Decimal(p.open.toString()),
              high: new Decimal(p.high.toString()),
              low: new Decimal(p.low.toString()),
              close: new Decimal(p.close.toString()),
              volume: p.volume ? new Decimal(p.volume.toString()) : null,
              openInterest: p.openInterest
                ? new Decimal(p.openInterest.toString())
                : null,
            })),
            1,
          )
        : null;

    // Query Kalshi trades for quality assessment
    const kalshiTrades = await this.prisma.historicalTrade.findMany({
      where: {
        contractId: target.kalshiTicker,
        platform: 'KALSHI',
        timestamp: { gte: dateRange.start, lte: dateRange.end },
      },
      orderBy: { timestamp: 'asc' },
      take: QUALITY_SAMPLE_LIMIT,
    });

    const kalshiTradeFlags =
      kalshiTrades.length > 0
        ? this.dataQuality.assessTradeQuality(
            kalshiTrades.map((t) => ({
              platform: t.platform,
              contractId: t.contractId,
              source: t.source,
              externalTradeId: t.externalTradeId,
              price: new Decimal(t.price.toString()),
              size: new Decimal(t.size.toString()),
              side: t.side,
              timestamp: t.timestamp,
            })),
          )
        : null;

    // Merge all flags and emit warnings if any issues found
    const allFlagSets: Array<{
      source: string;
      platform: string;
      contractId: string;
      flags: DataQualityFlags;
    }> = [];

    if (this.hasQualityIssues(survivorFlags)) {
      allFlagSets.push({
        source: 'survivorship',
        platform: 'both',
        contractId: matchId,
        flags: survivorFlags,
      });
    }

    if (kalshiPriceFlags && this.hasQualityIssues(kalshiPriceFlags)) {
      allFlagSets.push({
        source: 'KALSHI_API',
        platform: 'kalshi',
        contractId: target.kalshiTicker,
        flags: kalshiPriceFlags,
      });

      // Persist quality flags on Kalshi price records
      await this.prisma.historicalPrice.updateMany({
        where: {
          contractId: target.kalshiTicker,
          platform: 'KALSHI',
          timestamp: { gte: dateRange.start, lte: dateRange.end },
        },
        data: { qualityFlags: kalshiPriceFlags as unknown as Prisma.JsonValue },
      });
    }

    if (kalshiTradeFlags && this.hasQualityIssues(kalshiTradeFlags)) {
      allFlagSets.push({
        source: 'KALSHI_API',
        platform: 'kalshi',
        contractId: target.kalshiTicker,
        flags: kalshiTradeFlags,
      });

      // Persist quality flags on Kalshi trade records
      await this.prisma.historicalTrade.updateMany({
        where: {
          contractId: target.kalshiTicker,
          platform: 'KALSHI',
          timestamp: { gte: dateRange.start, lte: dateRange.end },
        },
        data: { qualityFlags: kalshiTradeFlags as unknown as Prisma.JsonValue },
      });
    }

    for (const entry of allFlagSets) {
      this.dataQuality.emitQualityWarning(
        entry.source,
        entry.platform,
        entry.contractId,
        entry.flags,
        correlationId,
      );
    }
  }

  private hasQualityIssues(flags: DataQualityFlags): boolean {
    return (
      flags.hasGaps ||
      flags.hasSuspiciousJumps ||
      flags.hasSurvivorshipBias ||
      flags.hasStaleData ||
      flags.hasLowVolume
    );
  }
}
