import { Injectable, Inject, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { CronJob } from 'cron';
import { PrismaService } from '../../common/prisma.service.js';
import { KnowledgeBaseService } from './knowledge-base.service.js';
import type {
  IContractCatalogProvider,
  ResolutionOutcome,
} from '../../common/interfaces/contract-catalog-provider.interface.js';
import { PlatformApiError } from '../../common/errors/platform-api-error.js';
import {
  EVENT_NAMES,
  ResolutionPollCompletedEvent,
} from '../../common/events/index.js';
import type { ResolutionPollStats } from '../../common/events/resolution-poll-completed.event.js';
import {
  KALSHI_CATALOG_TOKEN,
  POLYMARKET_CATALOG_TOKEN,
} from '../../common/interfaces/contract-catalog-provider.interface.js';

@Injectable()
export class ResolutionPollerService {
  private readonly logger = new Logger(ResolutionPollerService.name);
  private readonly batchSize: number;
  private isRunning = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly knowledgeBase: KnowledgeBaseService,
    @Inject(KALSHI_CATALOG_TOKEN)
    private readonly kalshiCatalog: IContractCatalogProvider,
    @Inject(POLYMARKET_CATALOG_TOKEN)
    private readonly polymarketCatalog: IContractCatalogProvider,
    private readonly eventEmitter: EventEmitter2,
    private readonly configService: ConfigService,
    private readonly schedulerRegistry: SchedulerRegistry,
  ) {
    this.batchSize = this.configService.get<number>(
      'RESOLUTION_POLLER_BATCH_SIZE',
      100,
    );
  }

  onModuleInit(): void {
    const enabled = this.configService.get<string>(
      'RESOLUTION_POLLER_ENABLED',
      'true',
    );
    if (enabled !== 'true') {
      this.logger.log({ message: 'Resolution poller disabled' });
      return;
    }
    const cronExpr = this.configService.get<string>(
      'RESOLUTION_POLLER_CRON_EXPRESSION',
      '0 0 6 * * *',
    );
    const job = new CronJob(cronExpr, () => {
      void this.runPoll();
    });
    this.schedulerRegistry.addCronJob('resolution-poller', job);
    job.start();
    this.logger.log({
      message: 'Resolution poller enabled',
      data: { cron: cronExpr, batchSize: this.batchSize },
    });
  }

  async runPoll(): Promise<ResolutionPollStats> {
    if (this.isRunning) {
      this.logger.warn({
        message: 'Resolution poller already running, skipping',
      });
      return {
        totalChecked: 0,
        newlyResolved: 0,
        diverged: 0,
        skippedInvalid: 0,
        pendingOnePlatform: 0,
        errors: 0,
      };
    }

    this.isRunning = true;
    const stats: ResolutionPollStats = {
      totalChecked: 0,
      newlyResolved: 0,
      diverged: 0,
      skippedInvalid: 0,
      pendingOnePlatform: 0,
      errors: 0,
    };

    try {
      const matches = await this.prisma.contractMatch.findMany({
        where: {
          operatorApproved: true,
          resolutionTimestamp: null,
          resolutionDate: { not: null, lt: new Date() },
        },
        orderBy: { resolutionDate: 'asc' },
        take: this.batchSize,
      });

      for (const match of matches) {
        stats.totalChecked++;

        try {
          // Sequential calls to respect platform rate limits (never parallel)
          const kalshiResult = await this.fetchResolution(
            this.kalshiCatalog,
            match.kalshiContractId,
            'Kalshi',
          );
          const polyResult = await this.fetchResolution(
            this.polymarketCatalog,
            match.polymarketContractId,
            'Polymarket',
          );

          if (!kalshiResult || !polyResult) {
            stats.errors++;
            continue;
          }

          // Handle invalid outcomes (voided/cancelled markets)
          if (
            kalshiResult.outcome === 'invalid' ||
            polyResult.outcome === 'invalid'
          ) {
            stats.skippedInvalid++;
            const notes = `Platform voided market (Kalshi: ${kalshiResult.outcome ?? 'n/a'}, Polymarket: ${polyResult.outcome ?? 'n/a'})`;
            await this.prisma.contractMatch.update({
              where: { matchId: match.matchId },
              data: {
                divergenceNotes: notes,
                resolutionTimestamp: new Date(),
              },
            });
            this.logger.warn({
              message: 'Market voided/cancelled, skipping resolution',
              data: {
                matchId: match.matchId,
                kalshiOutcome: kalshiResult.outcome,
                polyOutcome: polyResult.outcome,
              },
            });
            continue;
          }

          // One settled, one not → skip for next run
          if (!kalshiResult.settled || !polyResult.settled) {
            stats.pendingOnePlatform++;
            this.logger.log({
              message: 'Partial settlement, will retry next run',
              data: {
                matchId: match.matchId,
                kalshiSettled: kalshiResult.settled,
                polySettled: polyResult.settled,
              },
            });
            continue;
          }

          // Both settled with valid outcomes
          await this.knowledgeBase.recordResolution(
            match.matchId,
            polyResult.outcome!,
            kalshiResult.outcome!,
          );

          stats.newlyResolved++;

          // Check if diverged (recordResolution already emits event)
          if (
            polyResult.outcome!.toLowerCase() !==
            kalshiResult.outcome!.toLowerCase()
          ) {
            stats.diverged++;
          }
        } catch (error) {
          stats.errors++;
          this.logger.error({
            message: 'Resolution check failed for match',
            data: {
              matchId: match.matchId,
              error: error instanceof Error ? error.message : String(error),
            },
          });
        }
      }
    } catch (error) {
      this.logger.error({
        message: 'Resolution poll failed unexpectedly',
        data: {
          error: error instanceof Error ? error.message : String(error),
          statsAtFailure: stats,
        },
      });
    } finally {
      this.isRunning = false;
      this.eventEmitter.emit(
        EVENT_NAMES.RESOLUTION_POLL_COMPLETED,
        new ResolutionPollCompletedEvent(stats),
      );
      this.logger.log({
        message: 'Resolution poll completed',
        data: stats,
      });
    }

    return stats;
  }

  private async fetchResolution(
    catalog: IContractCatalogProvider,
    contractId: string,
    platformName: string,
  ): Promise<ResolutionOutcome | null> {
    try {
      return await catalog.getContractResolution(contractId);
    } catch (error) {
      if (error instanceof PlatformApiError) {
        this.logger.error({
          message: `${platformName} resolution check API error`,
          data: {
            contractId,
            code: error.code,
            error: error.message,
          },
        });
      } else {
        this.logger.error({
          message: `${platformName} resolution check unexpected error`,
          data: {
            contractId,
            error: error instanceof Error ? error.message : String(error),
          },
        });
      }
      return null;
    }
  }
}
