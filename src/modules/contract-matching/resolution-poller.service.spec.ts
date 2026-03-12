import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ResolutionPollerService } from './resolution-poller.service';
import type { ConfigService } from '@nestjs/config';
import type { SchedulerRegistry } from '@nestjs/schedule';
import type { EventEmitter2 } from '@nestjs/event-emitter';
import type { PrismaService } from '../../common/prisma.service';
import type { KnowledgeBaseService } from './knowledge-base.service';
import type { IContractCatalogProvider } from '../../common/interfaces/contract-catalog-provider.interface';
import { EVENT_NAMES } from '../../common/events/event-catalog';
import { PlatformApiError } from '../../common/errors/platform-api-error';
import { PlatformId } from '../../common/types/platform.type';

function createMockConfig(
  overrides: Record<string, unknown> = {},
): ConfigService {
  const defaults: Record<string, unknown> = {
    RESOLUTION_POLLER_ENABLED: true,
    RESOLUTION_POLLER_CRON_EXPRESSION: '0 0 6 * * *',
    RESOLUTION_POLLER_BATCH_SIZE: 100,
    ...overrides,
  };
  return {
    get: vi.fn(
      (key: string, defaultVal?: unknown) => defaults[key] ?? defaultVal,
    ),
  } as unknown as ConfigService;
}

function createMatch(overrides: Record<string, unknown> = {}) {
  return {
    matchId: 'match-1',
    polymarketContractId: 'poly-cond-1',
    kalshiContractId: 'kalshi-ticker-1',
    operatorApproved: true,
    resolutionTimestamp: null,
    resolutionDate: new Date('2025-01-01'),
    ...overrides,
  };
}

describe('ResolutionPollerService', () => {
  let service: ResolutionPollerService;
  let prisma: {
    contractMatch: {
      findMany: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
    };
  };
  let knowledgeBase: { recordResolution: ReturnType<typeof vi.fn> };
  let kalshiCatalog: {
    getContractResolution: ReturnType<typeof vi.fn>;
    getPlatformId: ReturnType<typeof vi.fn>;
  };
  let polymarketCatalog: {
    getContractResolution: ReturnType<typeof vi.fn>;
    getPlatformId: ReturnType<typeof vi.fn>;
  };
  let eventEmitter: { emit: ReturnType<typeof vi.fn> };
  let schedulerRegistry: { addCronJob: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.clearAllMocks();

    prisma = {
      contractMatch: {
        findMany: vi.fn().mockResolvedValue([]),
        update: vi.fn().mockResolvedValue({}),
      },
    };
    knowledgeBase = {
      recordResolution: vi.fn().mockResolvedValue(undefined),
    };
    kalshiCatalog = {
      getContractResolution: vi.fn(),
      getPlatformId: vi.fn().mockReturnValue(PlatformId.KALSHI),
    };
    polymarketCatalog = {
      getContractResolution: vi.fn(),
      getPlatformId: vi.fn().mockReturnValue(PlatformId.POLYMARKET),
    };
    eventEmitter = { emit: vi.fn() };
    schedulerRegistry = { addCronJob: vi.fn() };

    service = new ResolutionPollerService(
      prisma as unknown as PrismaService,
      knowledgeBase as unknown as KnowledgeBaseService,
      kalshiCatalog as unknown as IContractCatalogProvider,
      polymarketCatalog as unknown as IContractCatalogProvider,
      eventEmitter as unknown as EventEmitter2,
      createMockConfig(),
      schedulerRegistry as unknown as SchedulerRegistry,
    );
  });

  describe('onModuleInit', () => {
    it('should register cron job when enabled', () => {
      service.onModuleInit();
      expect(schedulerRegistry.addCronJob).toHaveBeenCalledWith(
        'resolution-poller',
        expect.anything(),
      );
    });

    it('should not register cron job when disabled', () => {
      service = new ResolutionPollerService(
        prisma as unknown as PrismaService,
        knowledgeBase as unknown as KnowledgeBaseService,
        kalshiCatalog as unknown as IContractCatalogProvider,
        polymarketCatalog as unknown as IContractCatalogProvider,
        eventEmitter as unknown as EventEmitter2,
        createMockConfig({ RESOLUTION_POLLER_ENABLED: false }),
        schedulerRegistry as unknown as SchedulerRegistry,
      );
      service.onModuleInit();
      expect(schedulerRegistry.addCronJob).not.toHaveBeenCalled();
    });
  });

  describe('runPoll', () => {
    it('should emit completion event with empty stats when no matches', async () => {
      const stats = await service.runPoll();
      expect(stats.totalChecked).toBe(0);
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        EVENT_NAMES.RESOLUTION_POLL_COMPLETED,
        expect.objectContaining({
          stats: {
            totalChecked: 0,
            newlyResolved: 0,
            diverged: 0,
            skippedInvalid: 0,
            pendingOnePlatform: 0,
            errors: 0,
          },
        }),
      );
    });

    it('should resolve matching outcomes (both yes)', async () => {
      prisma.contractMatch.findMany.mockResolvedValue([createMatch()]);
      kalshiCatalog.getContractResolution.mockResolvedValue({
        outcome: 'yes',
        settled: true,
      });
      polymarketCatalog.getContractResolution.mockResolvedValue({
        outcome: 'yes',
        settled: true,
      });

      const stats = await service.runPoll();

      expect(knowledgeBase.recordResolution).toHaveBeenCalledWith(
        'match-1',
        'yes',
        'yes',
      );
      expect(stats.newlyResolved).toBe(1);
      expect(stats.diverged).toBe(0);
    });

    it('should resolve divergent outcomes and count divergence', async () => {
      prisma.contractMatch.findMany.mockResolvedValue([createMatch()]);
      kalshiCatalog.getContractResolution.mockResolvedValue({
        outcome: 'yes',
        settled: true,
      });
      polymarketCatalog.getContractResolution.mockResolvedValue({
        outcome: 'no',
        settled: true,
      });

      const stats = await service.runPoll();

      expect(knowledgeBase.recordResolution).toHaveBeenCalledWith(
        'match-1',
        'no',
        'yes',
      );
      expect(stats.newlyResolved).toBe(1);
      expect(stats.diverged).toBe(1);
    });

    it('should skip when one platform not settled', async () => {
      prisma.contractMatch.findMany.mockResolvedValue([createMatch()]);
      kalshiCatalog.getContractResolution.mockResolvedValue({
        outcome: 'yes',
        settled: true,
      });
      polymarketCatalog.getContractResolution.mockResolvedValue({
        outcome: null,
        settled: false,
      });

      const stats = await service.runPoll();

      expect(knowledgeBase.recordResolution).not.toHaveBeenCalled();
      expect(stats.pendingOnePlatform).toBe(1);
    });

    it('should handle invalid outcome (voided market)', async () => {
      prisma.contractMatch.findMany.mockResolvedValue([createMatch()]);
      kalshiCatalog.getContractResolution.mockResolvedValue({
        outcome: 'invalid',
        settled: true,
      });
      polymarketCatalog.getContractResolution.mockResolvedValue({
        outcome: 'yes',
        settled: true,
      });

      const stats = await service.runPoll();

      expect(knowledgeBase.recordResolution).not.toHaveBeenCalled();
      expect(stats.skippedInvalid).toBe(1);
      expect(prisma.contractMatch.update).toHaveBeenCalledWith({
        where: { matchId: 'match-1' },
        data: {
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          divergenceNotes: expect.stringContaining('voided'),
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          resolutionTimestamp: expect.any(Date),
        },
      });
    });

    it('should handle API errors gracefully and continue', async () => {
      prisma.contractMatch.findMany.mockResolvedValue([
        createMatch({ matchId: 'match-1' }),
        createMatch({
          matchId: 'match-2',
          polymarketContractId: 'poly-2',
          kalshiContractId: 'kalshi-2',
        }),
      ]);
      kalshiCatalog.getContractResolution
        .mockRejectedValueOnce(
          new PlatformApiError(
            1011,
            'Rate limited',
            PlatformId.KALSHI,
            'warning',
          ),
        )
        .mockResolvedValueOnce({ outcome: 'yes', settled: true });
      polymarketCatalog.getContractResolution
        .mockResolvedValueOnce({ outcome: 'yes', settled: true })
        .mockResolvedValueOnce({ outcome: 'yes', settled: true });

      const stats = await service.runPoll();

      expect(stats.totalChecked).toBe(2);
      expect(stats.errors).toBe(1);
      expect(stats.newlyResolved).toBe(1);
    });

    it('should respect batch size limit', async () => {
      service = new ResolutionPollerService(
        prisma as unknown as PrismaService,
        knowledgeBase as unknown as KnowledgeBaseService,
        kalshiCatalog as unknown as IContractCatalogProvider,
        polymarketCatalog as unknown as IContractCatalogProvider,
        eventEmitter as unknown as EventEmitter2,
        createMockConfig({ RESOLUTION_POLLER_BATCH_SIZE: 5 }),
        schedulerRegistry as unknown as SchedulerRegistry,
      );

      await service.runPoll();

      expect(prisma.contractMatch.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 5 }),
      );
    });

    it('should skip when concurrent run is in progress', async () => {
      let resolveFn: ((value: unknown[]) => void) | undefined;
      prisma.contractMatch.findMany.mockReturnValue(
        new Promise<unknown[]>((resolve) => {
          resolveFn = resolve;
        }),
      );

      const firstPoll = service.runPoll();
      const secondPoll = service.runPoll();

      // Resolve the first poll's findMany
      resolveFn!([]);

      const [first, second] = await Promise.all([firstPoll, secondPoll]);

      // Both should complete with 0 totalChecked
      expect(first.totalChecked).toBe(0);
      expect(second.totalChecked).toBe(0);
      // findMany should be called only once (second run skips)
      expect(prisma.contractMatch.findMany).toHaveBeenCalledTimes(1);
    });

    it('should query correct where clause', async () => {
      await service.runPoll();

      expect(prisma.contractMatch.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            operatorApproved: true,
            resolutionTimestamp: null,
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
            resolutionDate: { not: null, lt: expect.any(Date) },
          },
          orderBy: { resolutionDate: 'asc' },
          take: 100,
        }),
      );
    });

    it('should catch DB errors and still emit completion event', async () => {
      prisma.contractMatch.findMany.mockRejectedValue(new Error('DB error'));

      const stats = await service.runPoll();

      // Error is caught, not propagated — stats reflect 0 work done
      expect(stats.totalChecked).toBe(0);
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        EVENT_NAMES.RESOLUTION_POLL_COMPLETED,
        expect.objectContaining({
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          stats: expect.objectContaining({ totalChecked: 0 }),
        }),
      );
    });
  });
});
