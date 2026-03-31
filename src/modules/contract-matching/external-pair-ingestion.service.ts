import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { CronJob } from 'cron';
import { ExternalPairProcessorService } from './external-pair-processor.service';
import { CandidateDiscoveryService } from './candidate-discovery.service';
import { ExternalPairEnrichmentService } from './external-pair-enrichment.service';
import { EVENT_NAMES } from '../../common/events/event-catalog';
import { ExternalPairIngestionRunCompletedEvent } from '../../common/events/external-pair-ingestion-run-completed.event';
import {
  SystemHealthError,
  SYSTEM_HEALTH_ERROR_CODES,
} from '../../common/errors/system-health-error';

/**
 * 6 deps rationale: CandidateDiscoveryService for isRunning concurrency check +
 * ExternalPairEnrichmentService for catalog-based ID resolution — same module
 */
@Injectable()
export class ExternalPairIngestionService implements OnModuleInit {
  private readonly logger = new Logger(ExternalPairIngestionService.name);
  /** Cleanup: reset in finally block of runExternalPairIngestion() */
  private _isRunning = false;

  /** Bidirectional concurrency guard — CandidateDiscoveryService checks this */
  public get isRunning(): boolean {
    return this._isRunning;
  }

  constructor(
    private readonly eventEmitter: EventEmitter2,
    private readonly configService: ConfigService,
    private readonly schedulerRegistry: SchedulerRegistry,
    private readonly processor: ExternalPairProcessorService,
    private readonly discoveryService: CandidateDiscoveryService,
    private readonly enrichmentService: ExternalPairEnrichmentService,
  ) {}

  onModuleInit(): void {
    const enabled = this.configService.get<boolean>(
      'EXTERNAL_PAIR_INGESTION_ENABLED',
    );
    if (enabled !== true) {
      this.logger.log({
        message: 'External pair ingestion disabled',
      });
      return;
    }

    const cronExpr = this.configService.get<string>(
      'EXTERNAL_PAIR_INGESTION_CRON_EXPRESSION',
      '0 0 6,18 * * *',
    );
    const job = new CronJob(cronExpr, () => {
      void this.handleCron();
    });
    this.schedulerRegistry.addCronJob('external-pair-ingestion', job);
    job.start();
    this.logger.log({
      message: 'External pair ingestion enabled',
      data: { cron: cronExpr },
    });
  }

  async handleCron(): Promise<void> {
    const enabled = this.configService.get<boolean>(
      'EXTERNAL_PAIR_INGESTION_ENABLED',
    );
    if (enabled !== true) {
      return;
    }

    if (this._isRunning) {
      this.logger.debug({
        message: 'External pair ingestion skipped — already running',
      });
      return;
    }

    if (this.discoveryService.isRunning) {
      this.logger.debug({
        message:
          'External pair ingestion skipped — CandidateDiscoveryService is running',
      });
      return;
    }

    await this.runExternalPairIngestion();
  }

  /** Story 10-5.2 pattern: hot-reload cron schedule from settings dashboard */
  reloadCron(expression: string): void {
    const jobName = 'external-pair-ingestion';

    let newJob: CronJob;
    try {
      newJob = new CronJob(expression, () => {
        void this.handleCron();
      });
    } catch (error) {
      this.logger.error({
        message: `Invalid cron expression for '${jobName}', keeping existing schedule`,
        data: {
          expression,
          error: error instanceof Error ? error.message : String(error),
        },
      });
      return;
    }

    try {
      this.schedulerRegistry.deleteCronJob(jobName);
    } catch {
      this.logger.warn({
        message: `Cron job '${jobName}' not found for deletion`,
      });
    }

    this.schedulerRegistry.addCronJob(jobName, newJob);
    newJob.start();
    this.logger.log({
      message: `Cron '${jobName}' reloaded`,
      data: { expression },
    });
  }

  private async runExternalPairIngestion(): Promise<void> {
    this._isRunning = true;
    const startMs = Date.now();

    try {
      const result = await this.processor.processAllProviders((pairs) =>
        this.enrichmentService.enrichPairs(pairs),
      );
      const durationMs = Date.now() - startMs;

      const allFailed = result.sources.every((s) => !!s.providerError);
      if (allFailed && result.sources.length > 0) {
        this.logger.warn({
          message:
            'All external pair providers failed — emitting health warning',
          data: {
            sources: result.sources.map((s) => ({
              source: s.source,
              error: s.providerError,
            })),
          },
        });
        this.eventEmitter.emit(
          EVENT_NAMES.SYSTEM_HEALTH_CRITICAL,
          new SystemHealthError(
            SYSTEM_HEALTH_ERROR_CODES.EXTERNAL_PAIR_INGESTION_FAILURE,
            'External pair ingestion: all providers failed',
            'warning',
            'ExternalPairIngestionService',
          ),
        );
      }

      this.eventEmitter.emit(
        EVENT_NAMES.EXTERNAL_PAIR_INGESTION_RUN_COMPLETED,
        new ExternalPairIngestionRunCompletedEvent(result.sources, durationMs),
      );

      this.logger.log({
        message: 'External pair ingestion run completed',
        data: { durationMs, sources: result.sources.length },
      });
    } catch (error) {
      const durationMs = Date.now() - startMs;
      this.logger.error({
        message: 'External pair ingestion run failed',
        data: {
          error: (error as Error).message,
          durationMs,
        },
      });
      this.eventEmitter.emit(
        EVENT_NAMES.EXTERNAL_PAIR_INGESTION_RUN_COMPLETED,
        new ExternalPairIngestionRunCompletedEvent([], durationMs),
      );
    } finally {
      this._isRunning = false;
    }
  }
}
