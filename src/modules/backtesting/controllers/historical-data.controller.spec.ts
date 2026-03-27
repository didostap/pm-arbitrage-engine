import { describe, it, expect, vi } from 'vitest';
import { Test } from '@nestjs/testing';
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
        ],
      }).compile();

      const controller = module.get(HistoricalDataController);
      const result = await controller.getContractCoverage('0xNonExistent');

      expect(result.data.depth.count).toBe(0);
      expect(result.data.freshness).toEqual({});
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
