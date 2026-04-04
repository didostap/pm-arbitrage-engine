import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { TimescaleStorageService } from './timescale-storage.service.js';
import { PrismaService } from '../../common/prisma.service.js';
import { ConfigAccessor } from '../../common/config/config-accessor.service.js';
import { EVENT_NAMES } from '../../common/events/event-catalog.js';
import type { EffectiveConfig } from '../../common/config/effective-config.types.js';

describe('TimescaleStorageService', () => {
  let service: TimescaleStorageService;
  let prisma: { $queryRaw: ReturnType<typeof vi.fn> };
  let configAccessor: { get: ReturnType<typeof vi.fn> };
  let eventEmitter: { emit: ReturnType<typeof vi.fn> };

  const mockConfig = {
    retentionDaysHistoricalPrices: 730,
    retentionDaysHistoricalTrades: 365,
    retentionDaysHistoricalDepths: 180,
  } as EffectiveConfig;

  beforeEach(async () => {
    prisma = { $queryRaw: vi.fn() };
    configAccessor = { get: vi.fn().mockResolvedValue(mockConfig) };
    eventEmitter = { emit: vi.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TimescaleStorageService,
        { provide: PrismaService, useValue: prisma },
        { provide: ConfigAccessor, useValue: configAccessor },
        { provide: EventEmitter2, useValue: eventEmitter },
      ],
    }).compile();

    service = module.get(TimescaleStorageService);
  });

  describe('handleRetention (cron)', () => {
    it('should call drop_chunks for each table with correct retention days', async () => {
      prisma.$queryRaw.mockResolvedValue([]);

      await service.handleRetention();

      // 3 tables × 1 drop_chunks call each
      expect(prisma.$queryRaw).toHaveBeenCalledTimes(3);

      // Verify each call includes the correct table and retention days
      const calls = prisma.$queryRaw.mock.calls;

      // Call 0: historical_prices with 730 days
      const call0Sql = String(calls[0][0].strings?.join('') ?? calls[0][0]);
      expect(call0Sql).toContain('drop_chunks');
      expect(call0Sql).toContain('historical_prices');

      // Call 1: historical_depths with 180 days
      const call1Sql = String(calls[1][0].strings?.join('') ?? calls[1][0]);
      expect(call1Sql).toContain('drop_chunks');
      expect(call1Sql).toContain('historical_depths');

      // Call 2: historical_trades with 365 days
      const call2Sql = String(calls[2][0].strings?.join('') ?? calls[2][0]);
      expect(call2Sql).toContain('drop_chunks');
      expect(call2Sql).toContain('historical_trades');
    });

    it('should emit TimescaleRetentionCompletedEvent on success', async () => {
      prisma.$queryRaw.mockResolvedValue([]);

      await service.handleRetention();

      expect(eventEmitter.emit).toHaveBeenCalledWith(
        EVENT_NAMES.TIMESCALE_RETENTION_COMPLETED,
        expect.objectContaining({
          droppedChunks: expect.objectContaining({
            historical_prices: 0,
            historical_depths: 0,
            historical_trades: 0,
          }),
          durationMs: expect.any(Number),
        }),
      );
    });

    it('should never re-throw — retention failure must not block trading', async () => {
      configAccessor.get.mockRejectedValue(new Error('DB connection lost'));

      await expect(service.handleRetention()).resolves.not.toThrow();
    });

    it('should emit event even when configAccessor.get() throws', async () => {
      configAccessor.get.mockRejectedValue(new Error('DB connection lost'));

      await service.handleRetention();

      expect(eventEmitter.emit).toHaveBeenCalledWith(
        EVENT_NAMES.TIMESCALE_RETENTION_COMPLETED,
        expect.objectContaining({
          droppedChunks: expect.any(Object),
          durationMs: expect.any(Number),
        }),
      );
    });

    it('should skip table if retention value is invalid (below minimum)', async () => {
      configAccessor.get.mockResolvedValue({
        ...mockConfig,
        retentionDaysHistoricalPrices: 5, // below 30 minimum
      });
      prisma.$queryRaw.mockResolvedValue([]);

      await service.handleRetention();

      // Only 2 tables should be processed (depths + trades), prices skipped
      expect(prisma.$queryRaw).toHaveBeenCalledTimes(2);
    });

    it('should skip table if retention value is not an integer', async () => {
      configAccessor.get.mockResolvedValue({
        ...mockConfig,
        retentionDaysHistoricalTrades: 365.5, // not integer
      });
      prisma.$queryRaw.mockResolvedValue([]);

      await service.handleRetention();

      // Only 2 tables processed (prices + depths), trades skipped
      expect(prisma.$queryRaw).toHaveBeenCalledTimes(2);
    });

    it('should handle partial failure — error on one table does not stop others', async () => {
      prisma.$queryRaw
        .mockRejectedValueOnce(new Error('table locked'))
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);

      await expect(service.handleRetention()).resolves.not.toThrow();
      expect(prisma.$queryRaw).toHaveBeenCalledTimes(3);
    });
  });

  describe('compressOldChunks', () => {
    it('should query uncompressed chunks and compress each individually', async () => {
      const mockChunks = [
        { chunk_full_name: '_timescaledb_internal._hyper_1_1_chunk' },
        { chunk_full_name: '_timescaledb_internal._hyper_1_2_chunk' },
      ];
      // First 3 calls: chunk queries for each table
      prisma.$queryRaw
        .mockResolvedValueOnce(mockChunks) // prices chunks
        .mockResolvedValueOnce([]) // depths chunks (none)
        .mockResolvedValueOnce([]) // trades chunks (none)
        // Then compress calls for the 2 chunks found
        .mockResolvedValue([]);

      const result = await service.compressOldChunks();

      expect(result.totalChunksCompressed).toBe(2);
      expect(result.tables).toContainEqual(
        expect.objectContaining({
          tableName: 'historical_prices',
          chunksCompressed: 2,
        }),
      );
    });

    it('should return zero when no uncompressed chunks exist', async () => {
      prisma.$queryRaw.mockResolvedValue([]);

      const result = await service.compressOldChunks();

      expect(result.totalChunksCompressed).toBe(0);
      expect(result.tables).toHaveLength(3);
    });

    it('should skip chunk with unexpected name format', async () => {
      const mockChunks = [
        { chunk_full_name: '_timescaledb_internal._hyper_1_1_chunk' },
        { chunk_full_name: "malicious'; DROP TABLE--" },
      ];
      prisma.$queryRaw
        .mockResolvedValueOnce(mockChunks)
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValue([]);

      const result = await service.compressOldChunks();

      // Only the valid chunk should be compressed
      expect(result.totalChunksCompressed).toBe(1);
    });

    it('should continue to next table when chunk listing query fails', async () => {
      prisma.$queryRaw
        .mockRejectedValueOnce(new Error('connection timeout')) // prices listing fails
        .mockResolvedValueOnce([]) // depths listing succeeds
        .mockResolvedValueOnce([]); // trades listing succeeds

      const result = await service.compressOldChunks();

      expect(result.tables).toHaveLength(3);
      expect(result.tables[0]).toEqual(
        expect.objectContaining({
          tableName: 'historical_prices',
          chunksCompressed: 0,
        }),
      );
    });
  });

  describe('getStorageStats', () => {
    it('should return typed StorageStats with total database size and per-table stats', async () => {
      // Total DB size
      prisma.$queryRaw
        .mockResolvedValueOnce([{ pg_size_pretty: '337 GB' }])
        // Per-table compression stats (3 tables via individual calls)
        .mockResolvedValueOnce([
          {
            hypertable_name: 'historical_prices',
            total_chunks: 90,
            compressed_chunks: 80,
            before_compression: '180 GB',
            after_compression: '18 GB',
            compression_ratio_pct: 90,
          },
        ])
        .mockResolvedValueOnce([
          {
            hypertable_name: 'historical_depths',
            total_chunks: 75,
            compressed_chunks: 65,
            before_compression: '151 GB',
            after_compression: '15 GB',
            compression_ratio_pct: 90.1,
          },
        ])
        .mockResolvedValueOnce([
          {
            hypertable_name: 'historical_trades',
            total_chunks: 30,
            compressed_chunks: 25,
            before_compression: '5.9 GB',
            after_compression: '590 MB',
            compression_ratio_pct: 90,
          },
        ])
        // Per-table total sizes (3 calls)
        .mockResolvedValueOnce([{ total_size: '180 GB' }])
        .mockResolvedValueOnce([{ total_size: '151 GB' }])
        .mockResolvedValueOnce([{ total_size: '5.9 GB' }]);

      const stats = await service.getStorageStats();

      expect(stats.totalDatabaseSize).toBe('337 GB');
      expect(stats.tables).toHaveLength(3);
      expect(stats.tables[0]).toEqual(
        expect.objectContaining({
          tableName: 'historical_prices',
          compressionRatioPct: 90,
          totalChunks: 90,
          compressedChunks: 80,
        }),
      );
    });

    it('should handle NULL compression stats (no compressed data yet)', async () => {
      prisma.$queryRaw
        .mockResolvedValueOnce([{ pg_size_pretty: '337 GB' }])
        // Compression stats with NULLs
        .mockResolvedValueOnce([
          {
            hypertable_name: 'historical_prices',
            total_chunks: 90,
            compressed_chunks: 0,
            before_compression: '0 bytes',
            after_compression: '0 bytes',
            compression_ratio_pct: 0,
          },
        ])
        .mockResolvedValueOnce([
          {
            hypertable_name: 'historical_depths',
            total_chunks: 75,
            compressed_chunks: 0,
            before_compression: '0 bytes',
            after_compression: '0 bytes',
            compression_ratio_pct: 0,
          },
        ])
        .mockResolvedValueOnce([
          {
            hypertable_name: 'historical_trades',
            total_chunks: 30,
            compressed_chunks: 0,
            before_compression: '0 bytes',
            after_compression: '0 bytes',
            compression_ratio_pct: 0,
          },
        ])
        .mockResolvedValueOnce([{ total_size: '180 GB' }])
        .mockResolvedValueOnce([{ total_size: '151 GB' }])
        .mockResolvedValueOnce([{ total_size: '5.9 GB' }]);

      const stats = await service.getStorageStats();

      expect(stats.tables[0]!.compressionRatioPct).toBe(0);
    });

    it('should return graceful fallback when DB query fails', async () => {
      prisma.$queryRaw.mockRejectedValue(
        new Error('TimescaleDB extension not installed'),
      );

      const stats = await service.getStorageStats();

      expect(stats.totalDatabaseSize).toBe('unavailable');
      expect(stats.tables).toHaveLength(0);
    });
  });
});
