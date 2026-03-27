import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { randomUUID } from 'crypto';
import { PrismaService } from '../../../common/prisma.service';
import { KalshiHistoricalService } from './kalshi-historical.service';
import { PolymarketHistoricalService } from './polymarket-historical.service';
import { PmxtArchiveService } from './pmxt-archive.service';
import { OddsPipeService } from './oddspipe.service';
import { IngestionQualityAssessorService } from './ingestion-quality-assessor.service';
import { EVENT_NAMES } from '../../../common/events/event-catalog';
import { BacktestDataIngestedEvent } from '../../../common/events/backtesting.events';
import { IngestionProgressDto } from '../dto/ingestion-progress.dto';

interface TargetContract {
  kalshiTicker: string;
  polymarketTokenId: string;
  operatorApproved: boolean;
  resolutionTimestamp: Date | null;
}

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

  /** 7 deps rationale: Facade orchestrating 4 data sources + quality assessor + persistence + events */
  constructor(
    private readonly prisma: PrismaService,
    private readonly kalshiHistorical: KalshiHistoricalService,
    private readonly polymarketHistorical: PolymarketHistoricalService,
    private readonly pmxtArchive: PmxtArchiveService,
    private readonly oddsPipe: OddsPipeService,
    private readonly qualityAssessor: IngestionQualityAssessorService,
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

          // PMXT Archive depth — Polymarket only
          try {
            this.logger.log({
              message: `Ingesting PMXT depth for ${target.polymarketTokenId}`,
              correlationId,
              matchId,
            });
            const pmxt = await this.pmxtArchive.ingestDepth(
              target.polymarketTokenId,
              dateRange,
            );
            totalRecords += pmxt.recordCount;
            this.eventEmitter.emit(
              EVENT_NAMES.BACKTEST_DATA_INGESTED,
              new BacktestDataIngestedEvent({
                source: 'PMXT_ARCHIVE',
                platform: 'polymarket',
                contractId: target.polymarketTokenId,
                recordCount: pmxt.recordCount,
                dateRange,
                correlationId,
              }),
            );
          } catch (error: unknown) {
            const msg = error instanceof Error ? error.message : String(error);
            this.logger.warn(
              `PMXT depth ingestion failed for ${target.polymarketTokenId}: ${msg}`,
            );
          }

          // OddsPipe OHLCV — Polymarket only
          try {
            const oddsPipeMarketId = await this.oddsPipe.resolveMarketId(
              target.polymarketTokenId,
            );
            if (oddsPipeMarketId !== null) {
              this.logger.log({
                message: `Ingesting OddsPipe OHLCV for ${target.polymarketTokenId} (market ${oddsPipeMarketId})`,
                correlationId,
                matchId,
              });
              const op = await this.oddsPipe.ingestPrices(
                oddsPipeMarketId,
                target.polymarketTokenId,
                dateRange,
              );
              totalRecords += op.recordCount;
              this.eventEmitter.emit(
                EVENT_NAMES.BACKTEST_DATA_INGESTED,
                new BacktestDataIngestedEvent({
                  source: 'ODDSPIPE',
                  platform: 'polymarket',
                  contractId: target.polymarketTokenId,
                  recordCount: op.recordCount,
                  dateRange,
                  correlationId,
                }),
              );
            } else {
              this.logger.log({
                message: `Skipping OddsPipe for ${target.polymarketTokenId} — no market ID found`,
                correlationId,
                matchId,
              });
            }
          } catch (error: unknown) {
            const msg = error instanceof Error ? error.message : String(error);
            this.logger.warn(
              `OddsPipe ingestion failed for ${target.polymarketTokenId}: ${msg}`,
            );
          }

          // Delegate quality assessment to dedicated service
          await this.qualityAssessor.runQualityAssessment(
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
}
