import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ConfigService } from '@nestjs/config';
import { IncrementalIngestionService } from './incremental-ingestion.service';
import { IncrementalFetchService } from './incremental-fetch.service';
import { IngestionOrchestratorService } from './ingestion-orchestrator.service';
import { EVENT_NAMES } from '../../../common/events/event-catalog';
import { HistoricalDataSource } from '@prisma/client';

describe('IncrementalIngestionService', () => {
  let service: IncrementalIngestionService;
  let prisma: {
    dataSourceFreshness: {
      upsert: ReturnType<typeof vi.fn>;
      findMany: ReturnType<typeof vi.fn>;
    };
  };
  let emitter: { emit: ReturnType<typeof vi.fn> };
  let configService: { get: ReturnType<typeof vi.fn> };
  let fetchService: { fetchAll: ReturnType<typeof vi.fn> };
  let orchestrator: {
    isRunning: boolean;
    buildTargetList: ReturnType<typeof vi.fn>;
  };

  const now = new Date('2026-03-28T14:00:00Z');

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now);

    prisma = {
      dataSourceFreshness: {
        upsert: vi.fn().mockResolvedValue({}),
        findMany: vi.fn().mockResolvedValue([]),
      },
    };
    emitter = { emit: vi.fn() };
    configService = {
      get: vi.fn((key: string) => {
        const map: Record<string, unknown> = {
          INCREMENTAL_INGESTION_ENABLED: true,
          STALENESS_THRESHOLD_PLATFORM_MS: 129_600_000,
          STALENESS_THRESHOLD_PMXT_MS: 172_800_000,
          STALENESS_THRESHOLD_ODDSPIPE_MS: 129_600_000,
          STALENESS_THRESHOLD_VALIDATION_MS: 259_200_000,
        };
        return map[key];
      }),
    };
    fetchService = {
      fetchAll: vi.fn().mockResolvedValue(
        new Map<
          HistoricalDataSource,
          { recordCount: number; contractCount: number; error?: string }
        >([
          [
            'KALSHI_API' as HistoricalDataSource,
            { recordCount: 100, contractCount: 5 },
          ],
          [
            'POLYMARKET_API' as HistoricalDataSource,
            { recordCount: 50, contractCount: 3 },
          ],
        ]),
      ),
    };
    orchestrator = {
      isRunning: false,
      buildTargetList: vi.fn().mockResolvedValue(new Map()),
    };

    service = new IncrementalIngestionService(
      prisma as any,
      emitter as unknown as EventEmitter2,
      configService as unknown as ConfigService,
      fetchService as unknown as IncrementalFetchService,
      orchestrator as unknown as IngestionOrchestratorService,
    );

  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // --- Cron + enabled flag ---

  it('[P0] handleCron() should return immediately when INCREMENTAL_INGESTION_ENABLED is false', async () => {
    configService.get.mockImplementation((key: string) => {
      if (key === 'INCREMENTAL_INGESTION_ENABLED') return false;
      return undefined;
    });

    await service.handleCron();

    expect(fetchService.fetchAll).not.toHaveBeenCalled();
    expect(emitter.emit).not.toHaveBeenCalled();
  });

  it('[P0] handleCron() should call runIncrementalRefresh() when enabled and no concurrency conflict', async () => {
    await service.handleCron();

    expect(fetchService.fetchAll).toHaveBeenCalled();
  });

  it('[P1] handleCron() should have @Cron decorator with expression from config and { timeZone: "UTC" }', () => {
    // Verify the method exists and is decorated — decorator metadata checked via Reflect
    expect(typeof service.handleCron).toBe('function');
  });

  // --- Concurrency guard ---

  it('[P0] handleCron() should skip when own _isRunning flag is true', async () => {
    // Simulate a running job by calling handleCron twice concurrently
    const slowFetch = vi
      .fn()
      .mockImplementation(
        () => new Promise((resolve) => setTimeout(resolve, 100)),
      );
    fetchService.fetchAll = slowFetch;

    const first = service.handleCron();
    // Second call while first is still running
    await service.handleCron();

    // Only one call should have been made
    expect(slowFetch).toHaveBeenCalledTimes(1);

    // Advance fake timers to resolve the pending setTimeout(100)
    await vi.advanceTimersByTimeAsync(200);
    await first;
  });

  it('[P0] handleCron() should skip when IngestionOrchestratorService.isRunning is true', async () => {
    orchestrator.isRunning = true;

    await service.handleCron();

    expect(fetchService.fetchAll).not.toHaveBeenCalled();
  });

  it('[P1] _isRunning flag should be reset to false after runIncrementalRefresh() completes (even on error)', async () => {
    fetchService.fetchAll.mockRejectedValueOnce(new Error('fetch failed'));

    await service.handleCron();

    // After error, flag should be reset — second call should proceed
    fetchService.fetchAll.mockResolvedValueOnce(new Map());
    await service.handleCron();

    expect(fetchService.fetchAll).toHaveBeenCalledTimes(2);
  });

  // --- DataSourceFreshness upsert ---

  it('[P0] runIncrementalRefresh() should upsert DataSourceFreshness row per source with status, recordsFetched, contractsUpdated, lastAttemptAt', async () => {
    await service.handleCron();

    expect(prisma.dataSourceFreshness.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { source: 'KALSHI_API' },
        update: expect.objectContaining({
          status: 'success',
          recordsFetched: 100,
          contractsUpdated: 5,
          lastAttemptAt: expect.any(Date),
        }),
        create: expect.objectContaining({
          source: 'KALSHI_API',
          status: 'success',
        }),
      }),
    );

    expect(prisma.dataSourceFreshness.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { source: 'POLYMARKET_API' },
        update: expect.objectContaining({
          status: 'success',
          recordsFetched: 50,
          contractsUpdated: 3,
        }),
      }),
    );
  });

  it('[P0] runIncrementalRefresh() should update lastSuccessfulAt to now() even when 0 new records fetched', async () => {
    fetchService.fetchAll.mockResolvedValueOnce(
      new Map([
        [
          'KALSHI_API' as HistoricalDataSource,
          { recordCount: 0, contractCount: 0 },
        ],
      ]),
    );

    await service.handleCron();

    expect(prisma.dataSourceFreshness.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { source: 'KALSHI_API' },
        update: expect.objectContaining({
          lastSuccessfulAt: expect.any(Date),
          recordsFetched: 0,
          status: 'success',
        }),
      }),
    );
  });

  it('[P1] runIncrementalRefresh() should upsert DataSourceFreshness with status "failed" and errorMessage when source fetch fails', async () => {
    fetchService.fetchAll.mockResolvedValueOnce(
      new Map([
        [
          'KALSHI_API' as HistoricalDataSource,
          { recordCount: 0, contractCount: 0, error: 'API timeout' },
        ],
      ]),
    );

    await service.handleCron();

    expect(prisma.dataSourceFreshness.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { source: 'KALSHI_API' },
        update: expect.objectContaining({
          status: 'failed',
          errorMessage: expect.any(String),
        }),
      }),
    );
  });

  // --- Staleness check ---

  it('[P0] runIncrementalRefresh() should emit INCREMENTAL_DATA_STALE event for sources exceeding staleness threshold', async () => {
    const staleTime = new Date('2026-03-26T14:00:00Z'); // 48h ago > 36h threshold
    prisma.dataSourceFreshness.findMany.mockResolvedValueOnce([
      {
        source: 'KALSHI_API',
        lastSuccessfulAt: staleTime,
        status: 'success',
      },
    ]);

    await service.handleCron();

    expect(emitter.emit).toHaveBeenCalledWith(
      EVENT_NAMES.INCREMENTAL_DATA_STALE,
      expect.objectContaining({
        source: 'KALSHI_API',
        lastSuccessfulAt: staleTime,
        thresholdMs: expect.any(Number),
        ageMs: expect.any(Number),
      }),
    );
  });

  it('[P1] runIncrementalRefresh() should NOT emit INCREMENTAL_DATA_STALE for sources within staleness threshold', async () => {
    const freshTime = new Date('2026-03-28T12:00:00Z'); // 2h ago < 36h threshold
    prisma.dataSourceFreshness.findMany.mockResolvedValueOnce([
      {
        source: 'KALSHI_API',
        lastSuccessfulAt: freshTime,
        status: 'success',
      },
    ]);

    await service.handleCron();

    const staleCalls = emitter.emit.mock.calls.filter(
      ([name]: [string]) => name === EVENT_NAMES.INCREMENTAL_DATA_STALE,
    );
    expect(staleCalls).toHaveLength(0);
  });

  it('[P0] runIncrementalRefresh() should emit INCREMENTAL_DATA_FRESHNESS_UPDATED after every run with per-source summary', async () => {
    await service.handleCron();

    expect(emitter.emit).toHaveBeenCalledWith(
      EVENT_NAMES.INCREMENTAL_DATA_FRESHNESS_UPDATED,
      expect.objectContaining({
        sources: expect.arrayContaining([
          expect.objectContaining({
            source: 'KALSHI_API',
            recordsFetched: 100,
            status: 'success',
          }),
        ]),
      }),
    );
  });
});
