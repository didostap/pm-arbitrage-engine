import { describe, it, expect, vi } from 'vitest';
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { HistoricalDataController } from './historical-data.controller';
import { IngestionOrchestratorService } from '../ingestion/ingestion-orchestrator.service';
import { PrismaService } from '../../../common/prisma.service';

describe('HistoricalDataController', () => {
  describe('POST /api/backtesting/ingest', () => {
    it('[P1] should accept IngestionTriggerDto and return 202 with accepted status', async () => {
      const mockOrchestrator = {
        runIngestion: vi.fn().mockResolvedValue(undefined),
        getProgress: vi.fn().mockReturnValue([]),
        isRunning: false,
      };

      const module = await Test.createTestingModule({
        controllers: [HistoricalDataController],
        providers: [
          {
            provide: IngestionOrchestratorService,
            useValue: mockOrchestrator,
          },
          {
            provide: PrismaService,
            useValue: {},
          },
          { provide: ConfigService, useValue: { get: vi.fn() } },
        ],
      }).compile();

      const controller = module.get(HistoricalDataController);
      const result = controller.triggerIngestion({
        dateRangeStart: '2025-01-01T00:00:00Z',
        dateRangeEnd: '2025-03-01T00:00:00Z',
      });

      expect(result).toEqual(
        expect.objectContaining({
          data: expect.objectContaining({
            status: 'accepted',
          }),
          timestamp: expect.any(String),
        }),
      );

      // P23: Verify runIngestion is called with correct date arguments
      expect(mockOrchestrator.runIngestion).toHaveBeenCalledWith(
        expect.objectContaining({
          dateRangeStart: expect.any(Date),
          dateRangeEnd: expect.any(Date),
        }),
      );
    });

    it('[P9] should throw BadRequest when dateRangeStart >= dateRangeEnd', async () => {
      const mockOrchestrator = {
        runIngestion: vi.fn(),
        isRunning: false,
      };

      const module = await Test.createTestingModule({
        controllers: [HistoricalDataController],
        providers: [
          {
            provide: IngestionOrchestratorService,
            useValue: mockOrchestrator,
          },
          {
            provide: PrismaService,
            useValue: {},
          },
          { provide: ConfigService, useValue: { get: vi.fn() } },
        ],
      }).compile();

      const controller = module.get(HistoricalDataController);

      expect(() =>
        controller.triggerIngestion({
          dateRangeStart: '2025-03-01T00:00:00Z',
          dateRangeEnd: '2025-01-01T00:00:00Z',
        }),
      ).toThrow('dateRangeStart must be before dateRangeEnd');
    });

    it('[P6] should throw Conflict when ingestion is already running', async () => {
      const mockOrchestrator = {
        runIngestion: vi.fn(),
        isRunning: true,
      };

      const module = await Test.createTestingModule({
        controllers: [HistoricalDataController],
        providers: [
          {
            provide: IngestionOrchestratorService,
            useValue: mockOrchestrator,
          },
          {
            provide: PrismaService,
            useValue: {},
          },
          { provide: ConfigService, useValue: { get: vi.fn() } },
        ],
      }).compile();

      const controller = module.get(HistoricalDataController);

      expect(() =>
        controller.triggerIngestion({
          dateRangeStart: '2025-01-01T00:00:00Z',
          dateRangeEnd: '2025-03-01T00:00:00Z',
        }),
      ).toThrow('Ingestion already in progress');
    });
  });

  describe('GET /api/backtesting/coverage', () => {
    it('[P2] should return per-contract/per-source coverage summary', async () => {
      const mockPrisma = {
        historicalPrice: {
          groupBy: vi.fn().mockResolvedValue([
            {
              platform: 'KALSHI',
              contractId: 'K1',
              _count: { id: 500 },
              _min: { timestamp: new Date('2025-01-01') },
              _max: { timestamp: new Date('2025-03-01') },
            },
          ]),
        },
        historicalTrade: {
          groupBy: vi.fn().mockResolvedValue([
            {
              platform: 'KALSHI',
              contractId: 'K1',
              _count: { id: 200 },
              _min: { timestamp: new Date('2025-01-01') },
              _max: { timestamp: new Date('2025-03-01') },
            },
          ]),
        },
        historicalDepth: {
          groupBy: vi.fn().mockResolvedValue([]),
        },
      };

      const module = await Test.createTestingModule({
        controllers: [HistoricalDataController],
        providers: [
          {
            provide: PrismaService,
            useValue: mockPrisma,
          },
          {
            provide: IngestionOrchestratorService,
            useValue: {},
          },
          { provide: ConfigService, useValue: { get: vi.fn() } },
        ],
      }).compile();

      const controller = module.get(HistoricalDataController);
      const result = await controller.getCoverage();

      expect(result).toEqual(
        expect.objectContaining({
          data: expect.any(Array),
          count: expect.any(Number),
          timestamp: expect.any(String),
        }),
      );
    });
  });

  describe('GET /api/backtesting/coverage/:contractId', () => {
    it('[P2] should return detailed coverage for single contract', async () => {
      const mockPrisma = {
        historicalPrice: {
          count: vi.fn().mockResolvedValue(500),
          aggregate: vi.fn().mockResolvedValue({
            _min: { timestamp: new Date('2025-01-01') },
            _max: { timestamp: new Date('2025-03-01') },
          }),
        },
        historicalTrade: {
          count: vi.fn().mockResolvedValue(200),
          aggregate: vi.fn().mockResolvedValue({
            _min: { timestamp: new Date('2025-01-01') },
            _max: { timestamp: new Date('2025-03-01') },
          }),
        },
        historicalDepth: {
          count: vi.fn().mockResolvedValue(0),
          aggregate: vi.fn().mockResolvedValue({
            _min: { timestamp: null },
            _max: { timestamp: null },
          }),
          groupBy: vi.fn().mockResolvedValue([]),
        },
      };

      const module = await Test.createTestingModule({
        controllers: [HistoricalDataController],
        providers: [
          {
            provide: PrismaService,
            useValue: mockPrisma,
          },
          {
            provide: IngestionOrchestratorService,
            useValue: {},
          },
          { provide: ConfigService, useValue: { get: vi.fn() } },
        ],
      }).compile();

      const controller = module.get(HistoricalDataController);
      const result = await controller.getContractCoverage('KXBTC-24DEC31');

      expect(result).toEqual(
        expect.objectContaining({
          data: expect.objectContaining({
            contractId: 'KXBTC-24DEC31',
          }),
          timestamp: expect.any(String),
        }),
      );
    });
  });

  // ============================================================
  // Story 10-9-1b: Depth Coverage & Freshness Endpoints
  // ============================================================

  describe('GET /api/backtesting/coverage — depth sources (Story 10-9-1b)', () => {
    it('[P2] should include depth source coverage (PMXT_ARCHIVE, ODDSPIPE) alongside price/trade', async () => {
      const mockPrisma = {
        historicalPrice: {
          groupBy: vi.fn().mockResolvedValue([
            {
              platform: 'POLYMARKET',
              contractId: '0x1',
              _count: { id: 100 },
              _min: { timestamp: new Date('2025-06-01') },
              _max: { timestamp: new Date('2025-06-30') },
            },
          ]),
        },
        historicalTrade: {
          groupBy: vi.fn().mockResolvedValue([]),
        },
        historicalDepth: {
          groupBy: vi.fn().mockResolvedValue([
            {
              platform: 'POLYMARKET',
              contractId: '0x1',
              source: 'PMXT_ARCHIVE',
              _count: { id: 720 },
              _min: { timestamp: new Date('2025-06-01') },
              _max: { timestamp: new Date('2025-06-30') },
            },
          ]),
        },
      };

      const module = await Test.createTestingModule({
        controllers: [HistoricalDataController],
        providers: [
          { provide: PrismaService, useValue: mockPrisma },
          { provide: IngestionOrchestratorService, useValue: {} },
          { provide: ConfigService, useValue: { get: vi.fn() } },
        ],
      }).compile();

      const controller = module.get(HistoricalDataController);
      const result = await controller.getCoverage();

      expect(result.data).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: 'depth', source: 'PMXT_ARCHIVE' }),
        ]),
      );
    });
  });

  describe('GET /api/backtesting/coverage/:contractId — freshness (Story 10-9-1b)', () => {
    it('[P2] should include per-source freshness timestamps in response', async () => {
      const mockPrisma = {
        historicalPrice: {
          count: vi.fn().mockResolvedValue(100),
          aggregate: vi.fn().mockResolvedValue({
            _min: { timestamp: new Date('2025-06-01') },
            _max: { timestamp: new Date('2025-06-30') },
          }),
        },
        historicalTrade: {
          count: vi.fn().mockResolvedValue(50),
          aggregate: vi.fn().mockResolvedValue({
            _min: { timestamp: new Date('2025-06-01') },
            _max: { timestamp: new Date('2025-06-30') },
          }),
        },
        historicalDepth: {
          count: vi.fn().mockResolvedValue(720),
          aggregate: vi.fn().mockResolvedValue({
            _min: { timestamp: new Date('2025-06-01') },
            _max: { timestamp: new Date('2025-06-30T12:00:00Z') },
          }),
          groupBy: vi.fn().mockResolvedValue([
            {
              source: 'PMXT_ARCHIVE',
              _max: { timestamp: new Date('2025-06-30T12:00:00Z') },
            },
          ]),
        },
      };

      const module = await Test.createTestingModule({
        controllers: [HistoricalDataController],
        providers: [
          { provide: PrismaService, useValue: mockPrisma },
          { provide: IngestionOrchestratorService, useValue: {} },
          { provide: ConfigService, useValue: { get: vi.fn() } },
        ],
      }).compile();

      const controller = module.get(HistoricalDataController);
      const result = await controller.getContractCoverage('0x1');

      expect(result.data).toEqual(
        expect.objectContaining({
          depth: expect.objectContaining({
            count: 720,
            minTimestamp: expect.any(Date),
            maxTimestamp: expect.any(Date),
          }),
          freshness: expect.objectContaining({
            PMXT_ARCHIVE: expect.any(Date),
          }),
        }),
      );
    });

    it('[P2] should handle empty depth data gracefully', async () => {
      const mockPrisma = {
        historicalPrice: {
          count: vi.fn().mockResolvedValue(0),
          aggregate: vi.fn().mockResolvedValue({
            _min: { timestamp: null },
            _max: { timestamp: null },
          }),
        },
        historicalTrade: {
          count: vi.fn().mockResolvedValue(0),
          aggregate: vi.fn().mockResolvedValue({
            _min: { timestamp: null },
            _max: { timestamp: null },
          }),
        },
        historicalDepth: {
          count: vi.fn().mockResolvedValue(0),
          aggregate: vi.fn().mockResolvedValue({
            _min: { timestamp: null },
            _max: { timestamp: null },
          }),
          groupBy: vi.fn().mockResolvedValue([]),
        },
      };

      const module = await Test.createTestingModule({
        controllers: [HistoricalDataController],
        providers: [
          { provide: PrismaService, useValue: mockPrisma },
          { provide: IngestionOrchestratorService, useValue: {} },
          { provide: ConfigService, useValue: { get: vi.fn() } },
        ],
      }).compile();

      const controller = module.get(HistoricalDataController);
      const result = await controller.getContractCoverage('0xNonExistent');

      expect(result.data.depth.count).toBe(0);
      expect(result.data.freshness).toEqual({});
    });
  });

  // ============================================================
  // Story 10-9-6: Freshness Endpoint
  // ============================================================

  describe('GET /api/backtesting/freshness (Story 10-9-6)', () => {
    const aggregateMock = () =>
      vi.fn().mockResolvedValue({ _max: { timestamp: null } });

    it('[P0] should return all DataSourceFreshness rows with server-computed freshStatus', async () => {
      const nowMs = Date.now();
      const freshTime = new Date(nowMs - 3_600_000); // 1h ago — well within 36h threshold
      const mockPrisma = {
        dataSourceFreshness: {
          findMany: vi.fn().mockResolvedValue([
            {
              source: 'KALSHI_API',
              lastSuccessfulAt: freshTime,
              lastAttemptAt: freshTime,
              recordsFetched: 1247,
              contractsUpdated: 15,
              status: 'success',
              errorMessage: null,
            },
          ]),
        },
        historicalPrice: { aggregate: aggregateMock() },
        historicalTrade: { aggregate: aggregateMock() },
        historicalDepth: { aggregate: aggregateMock() },
      };
      const mockConfig = {
        get: vi.fn(() => 129_600_000), // 36h threshold
      };

      const module = await Test.createTestingModule({
        controllers: [HistoricalDataController],
        providers: [
          { provide: PrismaService, useValue: mockPrisma },
          { provide: IngestionOrchestratorService, useValue: {} },
          { provide: ConfigService, useValue: mockConfig },
        ],
      }).compile();

      const controller = module.get(HistoricalDataController);
      const result = await controller.getFreshness();

      expect(result).toEqual(
        expect.objectContaining({
          data: expect.objectContaining({
            sources: expect.arrayContaining([
              expect.objectContaining({
                source: 'KALSHI_API',
                freshStatus: 'fresh',
                recordsFetched: 1247,
                status: 'success',
              }),
            ]),
            overallFresh: true,
            staleSources: [],
          }),
          timestamp: expect.any(String),
        }),
      );
    });

    it('[P1] freshStatus computation: fresh <50%, warning 50-100%, stale >100%, never when null', async () => {
      const nowMs = Date.now();
      const threshold = 100_000; // 100s for easy testing
      const mockPrisma = {
        dataSourceFreshness: {
          findMany: vi.fn().mockResolvedValue([
            {
              source: 'KALSHI_API',
              lastSuccessfulAt: new Date(nowMs - 30_000),
              lastAttemptAt: null,
              recordsFetched: 0,
              contractsUpdated: 0,
              status: 'success',
              errorMessage: null,
            },
            {
              source: 'POLYMARKET_API',
              lastSuccessfulAt: new Date(nowMs - 60_000),
              lastAttemptAt: null,
              recordsFetched: 0,
              contractsUpdated: 0,
              status: 'success',
              errorMessage: null,
            },
            {
              source: 'GOLDSKY',
              lastSuccessfulAt: new Date(nowMs - 150_000),
              lastAttemptAt: null,
              recordsFetched: 0,
              contractsUpdated: 0,
              status: 'success',
              errorMessage: null,
            },
            {
              source: 'PMXT_ARCHIVE',
              lastSuccessfulAt: null,
              lastAttemptAt: null,
              recordsFetched: 0,
              contractsUpdated: 0,
              status: 'idle',
              errorMessage: null,
            },
          ]),
        },
        historicalPrice: { aggregate: aggregateMock() },
        historicalTrade: { aggregate: aggregateMock() },
        historicalDepth: { aggregate: aggregateMock() },
      };
      const mockConfig = { get: vi.fn(() => threshold) };

      const module = await Test.createTestingModule({
        controllers: [HistoricalDataController],
        providers: [
          { provide: PrismaService, useValue: mockPrisma },
          { provide: IngestionOrchestratorService, useValue: {} },
          { provide: ConfigService, useValue: mockConfig },
        ],
      }).compile();

      const controller = module.get(HistoricalDataController);
      const result = await controller.getFreshness();
      const sources = result.data.sources;

      const bySource = (s: string) => sources.find((x: any) => x.source === s);
      expect(bySource('KALSHI_API')?.freshStatus).toBe('fresh'); // 30% < 50%
      expect(bySource('POLYMARKET_API')?.freshStatus).toBe('warning'); // 60% > 50%
      expect(bySource('GOLDSKY')?.freshStatus).toBe('stale'); // 150% > 100%
      expect(bySource('PMXT_ARCHIVE')?.freshStatus).toBe('never'); // null
    });

    it('[P1] DataSourceFreshnessDto should include all required fields', async () => {
      const nowMs = Date.now();
      const mockPrisma = {
        dataSourceFreshness: {
          findMany: vi.fn().mockResolvedValue([
            {
              source: 'KALSHI_API',
              lastSuccessfulAt: new Date(nowMs - 3_600_000),
              lastAttemptAt: new Date(nowMs - 3_600_000),
              recordsFetched: 100,
              contractsUpdated: 5,
              status: 'success',
              errorMessage: null,
            },
          ]),
        },
        historicalPrice: { aggregate: aggregateMock() },
        historicalTrade: { aggregate: aggregateMock() },
        historicalDepth: { aggregate: aggregateMock() },
      };
      const mockConfig = { get: vi.fn(() => 129_600_000) };

      const module = await Test.createTestingModule({
        controllers: [HistoricalDataController],
        providers: [
          { provide: PrismaService, useValue: mockPrisma },
          { provide: IngestionOrchestratorService, useValue: {} },
          { provide: ConfigService, useValue: mockConfig },
        ],
      }).compile();

      const controller = module.get(HistoricalDataController);
      const result = await controller.getFreshness();
      const dto = result.data.sources[0];

      expect(dto).toEqual(
        expect.objectContaining({
          source: expect.any(String),
          lastSuccessfulAt: expect.any(String),
          lastAttemptAt: expect.any(String),
          recordsFetched: expect.any(Number),
          contractsUpdated: expect.any(Number),
          status: expect.any(String),
          freshStatus: expect.stringMatching(/^(fresh|warning|stale|never)$/),
          stalenessThresholdMs: expect.any(Number),
          timeSinceLastSuccessMs: expect.any(Number),
        }),
      );
    });
    it('[P1] should populate latestDataTimestamp from max timestamp per source', async () => {
      const nowMs = Date.now();
      const dataTs = new Date('2026-03-27T12:00:00Z');
      const mockPrisma = {
        dataSourceFreshness: {
          findMany: vi.fn().mockResolvedValue([
            {
              source: 'KALSHI_API',
              lastSuccessfulAt: new Date(nowMs - 3_600_000),
              lastAttemptAt: new Date(nowMs - 3_600_000),
              recordsFetched: 100,
              contractsUpdated: 5,
              status: 'success',
              errorMessage: null,
            },
          ]),
        },
        historicalPrice: {
          aggregate: vi.fn().mockResolvedValue({ _max: { timestamp: dataTs } }),
        },
        historicalTrade: { aggregate: aggregateMock() },
        historicalDepth: { aggregate: aggregateMock() },
      };
      const mockConfig = { get: vi.fn(() => 129_600_000) };

      const module = await Test.createTestingModule({
        controllers: [HistoricalDataController],
        providers: [
          { provide: PrismaService, useValue: mockPrisma },
          { provide: IngestionOrchestratorService, useValue: {} },
          { provide: ConfigService, useValue: mockConfig },
        ],
      }).compile();

      const controller = module.get(HistoricalDataController);
      const result = await controller.getFreshness();
      const dto = result.data.sources[0];

      expect(dto.latestDataTimestamp).toBe(dataTs.toISOString());
    });

    it('[P2] should return overallFresh: false when no sources exist', async () => {
      const mockPrisma = {
        dataSourceFreshness: {
          findMany: vi.fn().mockResolvedValue([]),
        },
      };
      const mockConfig = { get: vi.fn(() => 129_600_000) };

      const module = await Test.createTestingModule({
        controllers: [HistoricalDataController],
        providers: [
          { provide: PrismaService, useValue: mockPrisma },
          { provide: IngestionOrchestratorService, useValue: {} },
          { provide: ConfigService, useValue: mockConfig },
        ],
      }).compile();

      const controller = module.get(HistoricalDataController);
      const result = await controller.getFreshness();

      expect(result.data.overallFresh).toBe(false);
      expect(result.data.sources).toHaveLength(0);
    });
  });

  describe('module wiring', () => {
    it('[P1] should resolve all DI providers in IngestionModule', async () => {
      const { EventEmitterModule } = await import('@nestjs/event-emitter');
      const { ConfigModule } = await import('@nestjs/config');
      const { BacktestingModule } = await import('../backtesting.module');

      const module = await Test.createTestingModule({
        imports: [
          ConfigModule.forRoot({ isGlobal: true }),
          EventEmitterModule.forRoot(),
          BacktestingModule,
        ],
      }).compile();

      const orchestrator = module.get(IngestionOrchestratorService);
      expect(orchestrator).toBeDefined();
    });

    it('[P1] should resolve PmxtArchiveService and OddsPipeService from IngestionModule (Story 10-9-1b)', async () => {
      const { EventEmitterModule } = await import('@nestjs/event-emitter');
      const { ConfigModule } = await import('@nestjs/config');
      const { BacktestingModule } = await import('../backtesting.module');
      const { PmxtArchiveService } =
        await import('../ingestion/pmxt-archive.service');
      const { OddsPipeService } = await import('../ingestion/oddspipe.service');

      const module = await Test.createTestingModule({
        imports: [
          ConfigModule.forRoot({ isGlobal: true }),
          EventEmitterModule.forRoot(),
          BacktestingModule,
        ],
      }).compile();

      const pmxt = module.get(PmxtArchiveService);
      const oddsPipe = module.get(OddsPipeService);
      expect(pmxt).toBeDefined();
      expect(oddsPipe).toBeDefined();
    });
  });
});
