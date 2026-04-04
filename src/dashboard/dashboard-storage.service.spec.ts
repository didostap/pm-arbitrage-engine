import { Test, TestingModule } from '@nestjs/testing';
import { DashboardStorageService } from './dashboard-storage.service.js';
import { TimescaleStorageService } from '../modules/monitoring/timescale-storage.service.js';
import type { StorageStats } from '../modules/monitoring/timescale-storage.types.js';

describe('DashboardStorageService', () => {
  let service: DashboardStorageService;
  let timescaleStorageService: {
    getStorageStats: ReturnType<typeof vi.fn>;
  };

  const mockStats: StorageStats = {
    totalDatabaseSize: '337 GB',
    tables: [
      {
        tableName: 'historical_prices',
        totalSize: '180 GB',
        compressedSize: '18 GB',
        uncompressedSize: '180 GB',
        compressionRatioPct: 90,
        totalChunks: 90,
        compressedChunks: 80,
      },
      {
        tableName: 'historical_depths',
        totalSize: '151 GB',
        compressedSize: '15 GB',
        uncompressedSize: '151 GB',
        compressionRatioPct: 90.1,
        totalChunks: 75,
        compressedChunks: 65,
      },
      {
        tableName: 'historical_trades',
        totalSize: '5.9 GB',
        compressedSize: '590 MB',
        uncompressedSize: '5.9 GB',
        compressionRatioPct: 90,
        totalChunks: 30,
        compressedChunks: 25,
      },
    ],
  };

  beforeEach(async () => {
    timescaleStorageService = {
      getStorageStats: vi.fn().mockResolvedValue(mockStats),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DashboardStorageService,
        {
          provide: TimescaleStorageService,
          useValue: timescaleStorageService,
        },
      ],
    }).compile();

    service = module.get(DashboardStorageService);
  });

  it('should map StorageStats to StorageStatsDto', async () => {
    const result = await service.getStorageStats();

    expect(result.totalDatabaseSize).toBe('337 GB');
    expect(result.tables).toHaveLength(3);
    expect(result.tables[0]).toEqual(
      expect.objectContaining({
        tableName: 'historical_prices',
        totalSize: '180 GB',
        compressedSize: '18 GB',
        compressionRatioPct: 90,
        totalChunks: 90,
        compressedChunks: 80,
      }),
    );
  });

  it('should handle null compressed sizes', async () => {
    timescaleStorageService.getStorageStats.mockResolvedValue({
      ...mockStats,
      tables: [
        {
          ...mockStats.tables[0],
          compressedSize: null,
          uncompressedSize: null,
        },
      ],
    });

    const result = await service.getStorageStats();

    expect(result.tables[0]!.compressedSize).toBeNull();
    expect(result.tables[0]!.uncompressedSize).toBeNull();
  });
});
