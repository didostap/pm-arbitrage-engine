import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../../../common/prisma.service';
import { IncrementalFetchService } from './incremental-fetch.service';
import { IngestionOrchestratorService } from './ingestion-orchestrator.service';
import { EVENT_NAMES } from '../../../common/events/event-catalog';
import {
  IncrementalDataStaleEvent,
  IncrementalDataFreshnessUpdatedEvent,
} from '../../../common/events/backtesting.events';
import type { IncrementalSourceSummary } from '../../../common/events/backtesting.events';
import { getThresholdKey } from '../dto/data-source-freshness.dto';

/**
 * Coordinator for incremental historical data refresh.
 * Leaf service (5 deps): PrismaService, EventEmitter2, ConfigService,
 * IncrementalFetchService, IngestionOrchestratorService.
 *
 * Handles: scheduling, concurrency guard, DataSourceFreshness tracking,
 * staleness detection, event emission.
 */
@Injectable()
export class IncrementalIngestionService implements OnModuleInit {
  private readonly logger = new Logger(IncrementalIngestionService.name);
  /** Cleanup: set true on handleCron entry, false in finally block */
  private _isRunning = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
    private readonly configService: ConfigService,
    private readonly fetchService: IncrementalFetchService,
    private readonly orchestrator: IngestionOrchestratorService,
  ) {}

  onModuleInit(): void {
    setTimeout(() => {
      void this.runIncrementalRefresh();
    }, 1000);
  }

  @Cron(process.env.INCREMENTAL_INGESTION_CRON_EXPRESSION ?? '0 0 2 * * *', {
    timeZone: 'UTC',
  })
  async handleCron(): Promise<void> {
    const enabled = this.configService.get<boolean>(
      'INCREMENTAL_INGESTION_ENABLED',
    );
    if (enabled !== true) {
      this.logger.debug('Incremental ingestion disabled — skipping cron tick');
      return;
    }

    if (this._isRunning) {
      this.logger.debug(
        'Incremental ingestion already running — skipping cron tick',
      );
      return;
    }

    if (this.orchestrator.isRunning) {
      this.logger.debug(
        'Full ingestion already running — skipping incremental cron tick',
      );
      return;
    }

    this._isRunning = true;
    try {
      await this.runIncrementalRefresh();
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.error(`Incremental refresh failed: ${msg}`);
    } finally {
      this._isRunning = false;
    }
  }

  private async runIncrementalRefresh(): Promise<void> {
    const targets = await this.orchestrator.buildTargetList();
    const results = await this.fetchService.fetchAll(targets);
    const now = new Date();

    // Upsert DataSourceFreshness per source
    const sourceSummaries: IncrementalSourceSummary[] = [];
    for (const [source, result] of results.entries()) {
      const hasFailed = !!result.error;
      const status = hasFailed ? 'failed' : 'success';

      await this.prisma.dataSourceFreshness.upsert({
        where: { source },
        update: {
          status,
          recordsFetched: result.recordCount,
          contractsUpdated: result.contractCount,
          lastAttemptAt: now,
          ...(hasFailed
            ? { errorMessage: result.error }
            : { lastSuccessfulAt: now, errorMessage: null }),
        },
        create: {
          source,
          status,
          recordsFetched: result.recordCount,
          contractsUpdated: result.contractCount,
          lastAttemptAt: now,
          ...(hasFailed
            ? { errorMessage: result.error }
            : { lastSuccessfulAt: now }),
        },
      });

      sourceSummaries.push({
        source,
        recordsFetched: result.recordCount,
        contractsUpdated: result.contractCount,
        status,
        lastSuccessfulAt: hasFailed ? null : now,
      });
    }

    // Check staleness for all sources
    await this.checkStaleness();

    // Emit freshness update event
    this.eventEmitter.emit(
      EVENT_NAMES.INCREMENTAL_DATA_FRESHNESS_UPDATED,
      new IncrementalDataFreshnessUpdatedEvent({ sources: sourceSummaries }),
    );
  }

  private async checkStaleness(): Promise<void> {
    const freshness = await this.prisma.dataSourceFreshness.findMany();
    const now = Date.now();

    for (const row of freshness) {
      const thresholdKey = getThresholdKey(row.source);
      const thresholdMs =
        Number(this.configService.get(thresholdKey)) || 129_600_000;

      if (!row.lastSuccessfulAt) {
        // Never fetched — always stale
        this.eventEmitter.emit(
          EVENT_NAMES.INCREMENTAL_DATA_STALE,
          new IncrementalDataStaleEvent({
            source: row.source,
            lastSuccessfulAt: null,
            thresholdMs,
            ageMs: Number.MAX_SAFE_INTEGER,
            severity: 'error',
          }),
        );
        continue;
      }

      const ageMs = now - row.lastSuccessfulAt.getTime();
      if (ageMs > thresholdMs) {
        this.eventEmitter.emit(
          EVENT_NAMES.INCREMENTAL_DATA_STALE,
          new IncrementalDataStaleEvent({
            source: row.source,
            lastSuccessfulAt: row.lastSuccessfulAt,
            thresholdMs,
            ageMs,
            severity: ageMs > thresholdMs * 2 ? 'error' : 'warning',
          }),
        );
      }
    }
  }
}
