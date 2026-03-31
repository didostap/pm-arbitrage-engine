/* eslint-disable @typescript-eslint/no-unsafe-assignment -- vitest expect.objectContaining returns any */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { SchedulerRegistry } from '@nestjs/schedule';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ConfigService } from '@nestjs/config';
import { ExternalPairIngestionService } from './external-pair-ingestion.service';
import { ExternalPairProcessorService } from './external-pair-processor.service';
import { CandidateDiscoveryService } from './candidate-discovery.service';
import { ExternalPairEnrichmentService } from './external-pair-enrichment.service';
import { PrismaService } from '../../common/prisma.service';
import { EVENT_NAMES } from '../../common/events/event-catalog';
import { ExternalPairIngestionRunCompletedEvent } from '../../common/events/external-pair-ingestion-run-completed.event';

describe('ExternalPairIngestionService', () => {
  let service: ExternalPairIngestionService;
  let configService: { get: ReturnType<typeof vi.fn> };
  let schedulerRegistry: {
    addCronJob: ReturnType<typeof vi.fn>;
    deleteCronJob: ReturnType<typeof vi.fn>;
  };
  let emitter: { emit: ReturnType<typeof vi.fn> };
  let processor: { processAllProviders: ReturnType<typeof vi.fn> };
  let discoveryService: { isRunning: boolean };

  beforeEach(async () => {
    configService = {
      get: vi.fn().mockImplementation((key: string, defaultValue?: unknown) => {
        const map: Record<string, unknown> = {
          EXTERNAL_PAIR_INGESTION_ENABLED: true,
          EXTERNAL_PAIR_INGESTION_CRON_EXPRESSION: '0 0 6,18 * * *',
        };
        return map[key] ?? defaultValue;
      }),
    };

    schedulerRegistry = {
      addCronJob: vi.fn(),
      deleteCronJob: vi.fn(),
    };

    emitter = { emit: vi.fn() };

    processor = {
      processAllProviders: vi.fn().mockResolvedValue({
        sources: [
          {
            source: 'predexon',
            fetched: 10,
            deduplicated: 3,
            scored: 7,
            autoApproved: 5,
            pendingReview: 1,
            autoRejected: 1,
            scoringFailures: 0,
            unresolvable: 0,
          },
        ],
      }),
    };

    discoveryService = { isRunning: false };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ExternalPairIngestionService,
        { provide: ConfigService, useValue: configService },
        { provide: SchedulerRegistry, useValue: schedulerRegistry },
        { provide: EventEmitter2, useValue: emitter },
        { provide: ExternalPairProcessorService, useValue: processor },
        { provide: CandidateDiscoveryService, useValue: discoveryService },
        {
          provide: ExternalPairEnrichmentService,
          useValue: {
            enrichPairs: vi
              .fn()
              .mockImplementation((pairs: unknown[]) => Promise.resolve(pairs)),
          },
        },
        { provide: PrismaService, useValue: {} },
      ],
    }).compile();

    service = module.get(ExternalPairIngestionService);
  });

  describe('cron + enabled flag', () => {
    it('[P0] handleCron() should return immediately when EXTERNAL_PAIR_INGESTION_ENABLED is not true', async () => {
      configService.get.mockImplementation((key: string) => {
        if (key === 'EXTERNAL_PAIR_INGESTION_ENABLED') return false;
        return undefined;
      });

      await service.handleCron();

      expect(processor.processAllProviders).not.toHaveBeenCalled();
      expect(emitter.emit).not.toHaveBeenCalled();
    });

    it('[P0] handleCron() should call runExternalPairIngestion() when enabled and no concurrency conflict', async () => {
      await service.handleCron();

      expect(processor.processAllProviders).toHaveBeenCalledOnce();
    });

    it('[P1] cron registered via SchedulerRegistry in onModuleInit() with configurable expression from config', () => {
      service.onModuleInit();

      expect(schedulerRegistry.addCronJob).toHaveBeenCalledWith(
        'external-pair-ingestion',
        expect.objectContaining({ start: expect.any(Function) }),
      );
    });
  });

  describe('reloadCron', () => {
    it('[P1] reloadCron() should delete old job, create new job, and start it', () => {
      service.reloadCron('0 0 12 * * *');

      expect(schedulerRegistry.deleteCronJob).toHaveBeenCalledWith(
        'external-pair-ingestion',
      );
      expect(schedulerRegistry.addCronJob).toHaveBeenCalledWith(
        'external-pair-ingestion',
        expect.objectContaining({ start: expect.any(Function) }),
      );
    });

    it('[P1] reloadCron() with invalid expression should keep existing schedule', () => {
      service.reloadCron('NOT_A_CRON');

      expect(schedulerRegistry.deleteCronJob).not.toHaveBeenCalled();
      expect(schedulerRegistry.addCronJob).not.toHaveBeenCalled();
    });
  });

  describe('concurrency guard', () => {
    it('[P0] handleCron() should skip when own _isRunning flag is true', async () => {
      // Start a run that won't resolve
      const neverResolve = new Promise<never>(() => {});
      processor.processAllProviders.mockReturnValue(neverResolve);

      // Fire first call (will hold _isRunning = true)
      const firstRun = service.handleCron();

      // Reset mock to track second call
      processor.processAllProviders.mockResolvedValue({ sources: [] });

      // Fire second call while first is running
      await service.handleCron();

      // processAllProviders should have been called only once (first call)
      expect(processor.processAllProviders).toHaveBeenCalledTimes(1);

      // Clean up: cancel the hanging promise
      firstRun.catch(() => {});
    });

    it('[P0] handleCron() should skip when CandidateDiscoveryService.isRunning is true', async () => {
      discoveryService.isRunning = true;

      await service.handleCron();

      expect(processor.processAllProviders).not.toHaveBeenCalled();
    });

    it('[P1] _isRunning flag should be reset to false after runExternalPairIngestion() completes (even on error)', async () => {
      processor.processAllProviders.mockRejectedValueOnce(
        new Error('Fatal failure'),
      );

      // First call errors — flag should reset
      await service.handleCron();

      // Second call should proceed
      processor.processAllProviders.mockResolvedValue({ sources: [] });
      await service.handleCron();

      expect(processor.processAllProviders).toHaveBeenCalledTimes(2);
    });
  });

  describe('run completion + stats', () => {
    it('[P0] runExternalPairIngestion() should emit ExternalPairIngestionRunCompletedEvent class instance with per-source stats and durationMs', async () => {
      await service.handleCron();

      expect(emitter.emit).toHaveBeenCalledWith(
        EVENT_NAMES.EXTERNAL_PAIR_INGESTION_RUN_COMPLETED,
        expect.any(ExternalPairIngestionRunCompletedEvent),
      );
      const emittedEvent = emitter.emit.mock.calls.find(
        (c: unknown[]) =>
          c[0] === EVENT_NAMES.EXTERNAL_PAIR_INGESTION_RUN_COMPLETED,
      )?.[1] as ExternalPairIngestionRunCompletedEvent;
      expect(emittedEvent.sources).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            source: expect.any(String),
            fetched: expect.any(Number),
          }),
        ]),
      );
      expect(emittedEvent.durationMs).toEqual(expect.any(Number));
    });

    it('[P2] when all providers fail, should emit SystemHealthError(4220) and run completed event', async () => {
      processor.processAllProviders.mockResolvedValue({
        sources: [
          {
            source: 'predexon',
            fetched: 0,
            deduplicated: 0,
            scored: 0,
            autoApproved: 0,
            pendingReview: 0,
            autoRejected: 0,
            scoringFailures: 0,
            unresolvable: 0,
            providerError: 'API down',
          },
          {
            source: 'oddspipe',
            fetched: 0,
            deduplicated: 0,
            scored: 0,
            autoApproved: 0,
            pendingReview: 0,
            autoRejected: 0,
            scoringFailures: 0,
            unresolvable: 0,
            providerError: 'Rate limited',
          },
        ],
      });

      await service.handleCron();

      expect(emitter.emit).toHaveBeenCalledWith(
        EVENT_NAMES.SYSTEM_HEALTH_CRITICAL,
        expect.objectContaining({
          code: 4220,
          message: 'External pair ingestion: all providers failed',
        }),
      );
      expect(emitter.emit).toHaveBeenCalledWith(
        EVENT_NAMES.EXTERNAL_PAIR_INGESTION_RUN_COMPLETED,
        expect.any(ExternalPairIngestionRunCompletedEvent),
      );
    });

    it('[P2] when processAllProviders() throws, should still emit completion event with empty sources', async () => {
      processor.processAllProviders.mockRejectedValueOnce(new Error('Fatal'));

      await service.handleCron();

      expect(emitter.emit).toHaveBeenCalledWith(
        EVENT_NAMES.EXTERNAL_PAIR_INGESTION_RUN_COMPLETED,
        expect.any(ExternalPairIngestionRunCompletedEvent),
      );
      const emittedEvent = emitter.emit.mock.calls.find(
        (c: unknown[]) =>
          c[0] === EVENT_NAMES.EXTERNAL_PAIR_INGESTION_RUN_COMPLETED,
      )?.[1] as ExternalPairIngestionRunCompletedEvent;
      expect(emittedEvent.sources).toEqual([]);
    });

    it('[P1] no startup run — service should NOT call runExternalPairIngestion() in onModuleInit()', () => {
      service.onModuleInit();

      expect(processor.processAllProviders).not.toHaveBeenCalled();
    });
  });
});
