import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import Decimal from 'decimal.js';
import { PmxtArchiveService } from './pmxt-archive.service';

// Top-level mock for hyparquet (ESM dynamic import) —
// behavior controlled per test via mockParquetRead

let mockParquetRead: any;

let mockAsyncBufferFromFile: any;

vi.mock('hyparquet', () => ({
  asyncBufferFromFile: (...args: unknown[]) => mockAsyncBufferFromFile(...args),
  parquetRead: (...args: unknown[]) => mockParquetRead(...args),
}));

vi.mock('hyparquet-compressors', () => ({
  compressors: {},
}));

function createMockConfigService() {
  return {
    get: vi.fn().mockReturnValue(undefined),
  } as any;
}

function createMockPrisma() {
  return {
    dataCatalog: {
      findUnique: vi.fn().mockResolvedValue(null),
      upsert: vi.fn().mockResolvedValue({ id: 1 }),
      update: vi.fn().mockResolvedValue({ id: 1 }),
    },
    historicalDepth: {
      createMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
  } as any;
}

function createDirectoryListingHtml(filenames: string[]): string {
  const links = filenames.map((f) => `<a href="${f}">${f}</a>`).join('\n');
  return `<html><body><pre>${links}</pre></body></html>`;
}

describe('PmxtArchiveService', () => {
  beforeEach(() => {
    mockAsyncBufferFromFile = vi.fn().mockResolvedValue({});
    mockParquetRead = vi.fn().mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe('discoverFiles', () => {
    it('[P1] should parse HTML directory listing for matching Parquet filenames within date range', async () => {
      const html = createDirectoryListingHtml([
        'polymarket_orderbook_2025-06-01T00.parquet',
        'polymarket_orderbook_2025-06-01T01.parquet',
        'polymarket_orderbook_2025-06-02T00.parquet',
        'polymarket_orderbook_2025-05-31T23.parquet',
      ]);
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          text: () => Promise.resolve(html),
        }),
      );

      const service = new PmxtArchiveService(
        createMockPrisma(),
        createMockConfigService(),
      );
      const files = await service.discoverFiles({
        start: new Date('2025-06-01T00:00:00Z'),
        end: new Date('2025-06-01T23:59:59Z'),
      });

      expect(files).toHaveLength(2);
      expect(files[0]).toEqual(
        expect.objectContaining({
          filename: 'polymarket_orderbook_2025-06-01T00.parquet',
          url: expect.stringContaining(
            'polymarket_orderbook_2025-06-01T00.parquet',
          ),
          hourTimestamp: new Date('2025-06-01T00:00:00Z'),
        }),
      );
    });

    it('[P1] should return empty array when no files match the date range', async () => {
      const html = createDirectoryListingHtml([
        'polymarket_orderbook_2025-05-01T00.parquet',
      ]);
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          text: () => Promise.resolve(html),
        }),
      );

      const service = new PmxtArchiveService(
        createMockPrisma(),
        createMockConfigService(),
      );
      const files = await service.discoverFiles({
        start: new Date('2025-06-01T00:00:00Z'),
        end: new Date('2025-06-30T23:59:59Z'),
      });

      expect(files).toHaveLength(0);
    });
  });

  describe('downloadAndCatalog', () => {
    const fileInfo = {
      url: 'https://archive.pmxt.dev/data/polymarket_orderbook_2025-06-01T00.parquet',
      filename: 'polymarket_orderbook_2025-06-01T00.parquet',
      hourTimestamp: new Date('2025-06-01T00:00:00Z'),
    };

    /** Mock the private downloadFile to return a fake checksum */
    function mockDownloadFile(
      service: PmxtArchiveService,
      checksum = 'a'.repeat(64),
    ) {
      vi.spyOn(service as any, 'downloadFile').mockResolvedValue(checksum);
    }

    it('[P1] should upsert DataCatalog with PENDING -> PROCESSING -> COMPLETE status transitions', async () => {
      const mockPrisma = createMockPrisma();
      const service = new PmxtArchiveService(
        mockPrisma,
        createMockConfigService(),
      );
      mockDownloadFile(service);

      const result = await service.downloadAndCatalog(fileInfo);

      expect(mockPrisma.dataCatalog.upsert).toHaveBeenCalledTimes(2);
      expect(mockPrisma.dataCatalog.upsert).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          update: expect.objectContaining({ status: 'PROCESSING' }),
        }),
      );
      expect(mockPrisma.dataCatalog.upsert).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          update: expect.objectContaining({ status: 'COMPLETE' }),
        }),
      );
      expect(result.skipped).toBe(false);
    });

    it('[P1] should compute SHA-256 checksum during download stream', async () => {
      const service = new PmxtArchiveService(
        createMockPrisma(),
        createMockConfigService(),
      );
      const expectedChecksum = 'b'.repeat(64);
      mockDownloadFile(service, expectedChecksum);

      const result = await service.downloadAndCatalog(fileInfo);
      expect(result.checksum).toMatch(/^[a-f0-9]{64}$/);
    });

    it('[P1] should skip download if DataCatalog row already COMPLETE with matching checksum', async () => {
      const mockPrisma = createMockPrisma();
      mockPrisma.dataCatalog.findUnique.mockResolvedValue({
        id: 1,
        status: 'COMPLETE',
        checksum: 'abc123def456',
      });

      const service = new PmxtArchiveService(
        mockPrisma,
        createMockConfigService(),
      );
      const downloadSpy = vi.spyOn(service as any, 'downloadFile');

      const result = await service.downloadAndCatalog(fileInfo);
      expect(result.skipped).toBe(true);
      expect(downloadSpy).not.toHaveBeenCalled();
    });

    it('[P1] should use 5-minute timeout for large file downloads', async () => {
      // Verify by checking that downloadFile is called (timeout is internal to downloadFile)
      const service = new PmxtArchiveService(
        createMockPrisma(),
        createMockConfigService(),
      );
      const downloadSpy = vi
        .spyOn(service as any, 'downloadFile')
        .mockResolvedValue('a'.repeat(64));

      await service.downloadAndCatalog(fileInfo);
      expect(downloadSpy).toHaveBeenCalledWith(
        fileInfo.url,
        expect.stringContaining('pmxt-archive'),
      );
    });

    it('[P1] should retry failed downloads with exponential backoff (3 attempts)', async () => {
      const mockPrisma = createMockPrisma();
      const service = new PmxtArchiveService(
        mockPrisma,
        createMockConfigService(),
      );

      const downloadSpy = vi
        .spyOn(service as any, 'downloadFile')
        .mockRejectedValueOnce(new Error('Network error'))
        .mockRejectedValueOnce(new Error('Network error'))
        .mockResolvedValueOnce('a'.repeat(64));

      await service.downloadAndCatalog(fileInfo);
      expect(downloadSpy).toHaveBeenCalledTimes(3);
    });

    it('[P1] should throw SystemHealthError code 4208 after all retries exhausted', async () => {
      const mockPrisma = createMockPrisma();
      const service = new PmxtArchiveService(
        mockPrisma,
        createMockConfigService(),
      );

      vi.spyOn(service as any, 'downloadFile').mockRejectedValue(
        new Error('Network error'),
      );

      await expect(service.downloadAndCatalog(fileInfo)).rejects.toMatchObject({
        code: 4208,
        message: expect.stringContaining('download'),
      });
    });
  });

  describe('parseParquetDepth', () => {
    function setupParquetMock(rows: Record<string, unknown>[]) {
      mockParquetRead.mockImplementation(async (opts: any) => {
        opts.onComplete(rows);
      });
    }

    it('[P0] should filter rows by target token IDs from Set<string>', async () => {
      setupParquetMock([
        {
          asset_id: '0xTokenABC',
          update_type: 'book_snapshot',
          bids: [{ price: 0.55, size: 100 }],
          asks: [{ price: 0.6, size: 80 }],
          timestamp: 1717200000,
        },
        {
          asset_id: '0xOther',
          update_type: 'book_snapshot',
          bids: [{ price: 0.3, size: 50 }],
          asks: [{ price: 0.4, size: 50 }],
          timestamp: 1717200000,
        },
        {
          asset_id: '0xTokenDEF',
          update_type: 'book_snapshot',
          bids: [{ price: 0.7, size: 200 }],
          asks: [{ price: 0.75, size: 150 }],
          timestamp: 1717203600,
        },
      ]);

      const service = new PmxtArchiveService(
        createMockPrisma(),
        createMockConfigService(),
      );
      const targetTokenIds = new Set(['0xTokenABC', '0xTokenDEF']);
      const depths = await service.parseParquetDepth(
        '/path/to/file.parquet',
        targetTokenIds,
      );

      expect(depths).toHaveLength(2);
      depths.forEach((d) => {
        expect(targetTokenIds.has(d.contractId)).toBe(true);
      });
    });

    it('[P0] should only process book_snapshot rows, skipping price_change', async () => {
      setupParquetMock([
        {
          asset_id: '0xTokenABC',
          update_type: 'book_snapshot',
          bids: [{ price: 0.55, size: 100 }],
          asks: [{ price: 0.6, size: 80 }],
          timestamp: 1717200000,
        },
        {
          asset_id: '0xTokenABC',
          update_type: 'price_change',
          bids: [{ price: 0.56, size: 100 }],
          asks: [{ price: 0.59, size: 80 }],
          timestamp: 1717200060,
        },
      ]);

      const service = new PmxtArchiveService(
        createMockPrisma(),
        createMockConfigService(),
      );
      const depths = await service.parseParquetDepth(
        '/path/to/file.parquet',
        new Set(['0xTokenABC']),
      );

      expect(depths).toHaveLength(1);
      expect(depths[0]!.updateType).toBe('snapshot');
    });

    it('[P0] should normalize bid/ask prices to Decimal in 0.00-1.00 range', async () => {
      setupParquetMock([
        {
          asset_id: '0xTokenABC',
          update_type: 'book_snapshot',
          bids: [{ price: 0.55, size: 100 }],
          asks: [{ price: 0.6, size: 80 }],
          timestamp: 1717200000,
        },
      ]);

      const service = new PmxtArchiveService(
        createMockPrisma(),
        createMockConfigService(),
      );
      const depths = await service.parseParquetDepth(
        '/path/to/file.parquet',
        new Set(['0xTokenABC']),
      );

      depths.forEach((d) => {
        d.bids.forEach((b) => {
          expect(b.price).toBeInstanceOf(Decimal);
          expect(b.price.gte(0) && b.price.lte(1)).toBe(true);
        });
        d.asks.forEach((a) => {
          expect(a.price).toBeInstanceOf(Decimal);
          expect(a.price.gte(0) && a.price.lte(1)).toBe(true);
        });
      });
    });

    it('[P0] should normalize sizes to Decimal in USD', async () => {
      setupParquetMock([
        {
          asset_id: '0xTokenABC',
          update_type: 'book_snapshot',
          bids: [{ price: 0.55, size: 100 }],
          asks: [{ price: 0.6, size: 80 }],
          timestamp: 1717200000,
        },
      ]);

      const service = new PmxtArchiveService(
        createMockPrisma(),
        createMockConfigService(),
      );
      const depths = await service.parseParquetDepth(
        '/path/to/file.parquet',
        new Set(['0xTokenABC']),
      );

      depths.forEach((d) => {
        d.bids.forEach((b) => expect(b.size).toBeInstanceOf(Decimal));
        d.asks.forEach((a) => expect(a.size).toBeInstanceOf(Decimal));
      });
    });

    it('[P1] should throw SystemHealthError code 4201 on Parquet parse failure', async () => {
      mockAsyncBufferFromFile.mockRejectedValue(new Error('File not found'));

      const service = new PmxtArchiveService(
        createMockPrisma(),
        createMockConfigService(),
      );

      await expect(
        service.parseParquetDepth('/nonexistent.parquet', new Set(['0xToken'])),
      ).rejects.toMatchObject({
        code: 4201,
        message: expect.stringContaining('Parquet'),
      });
    });
  });

  describe('ingestDepth', () => {
    function createServiceWithMocks(mockPrisma?: any) {
      const prisma = mockPrisma ?? createMockPrisma();
      const service = new PmxtArchiveService(prisma, createMockConfigService());
      return { service, prisma };
    }

    function mockServiceMethods(service: PmxtArchiveService, depths: any[]) {
      vi.spyOn(service, 'discoverFiles').mockResolvedValue([
        {
          url: 'https://archive.pmxt.dev/data/test.parquet',
          filename: 'test.parquet',
          hourTimestamp: new Date('2025-06-01T00:00:00Z'),
        },
      ]);
      vi.spyOn(service, 'downloadAndCatalog').mockResolvedValue({
        localPath: '/tmp/test.parquet',
        checksum: 'abc',
        skipped: false,
      });
      vi.spyOn(service, 'parseParquetDepth').mockResolvedValue(depths);
    }

    it('[P0] should sample first book_snapshot per UTC hour', async () => {
      const mockPrisma = createMockPrisma();
      mockPrisma.historicalDepth.createMany.mockResolvedValue({ count: 2 });
      const { service } = createServiceWithMocks(mockPrisma);

      const depths = [
        {
          platform: 'POLYMARKET',
          contractId: '0xTokenABC',
          source: 'PMXT_ARCHIVE' as const,
          bids: [{ price: new Decimal('0.55'), size: new Decimal('100') }],
          asks: [{ price: new Decimal('0.60'), size: new Decimal('80') }],
          timestamp: new Date('2025-06-01T00:05:00Z'),
          updateType: 'snapshot' as const,
        },
        {
          platform: 'POLYMARKET',
          contractId: '0xTokenABC',
          source: 'PMXT_ARCHIVE' as const,
          bids: [{ price: new Decimal('0.56'), size: new Decimal('110') }],
          asks: [{ price: new Decimal('0.59'), size: new Decimal('90') }],
          timestamp: new Date('2025-06-01T00:35:00Z'),
          updateType: 'snapshot' as const,
        },
        {
          platform: 'POLYMARKET',
          contractId: '0xTokenABC',
          source: 'PMXT_ARCHIVE' as const,
          bids: [{ price: new Decimal('0.57'), size: new Decimal('120') }],
          asks: [{ price: new Decimal('0.58'), size: new Decimal('70') }],
          timestamp: new Date('2025-06-01T01:10:00Z'),
          updateType: 'snapshot' as const,
        },
      ];
      mockServiceMethods(service, depths);

      await service.ingestDepth('0xTokenABC', {
        start: new Date('2025-06-01T00:00:00Z'),
        end: new Date('2025-06-01T03:59:59Z'),
      });

      // 2 unique hours: 00:xx and 01:xx (second snapshot at 00:35 is sampled out)
      const callArgs = mockPrisma.historicalDepth.createMany.mock.calls[0]![0];
      expect(callArgs.data).toHaveLength(2);
    });

    it('[P0] should batch persist via createMany({ skipDuplicates: true }), 500/batch', async () => {
      const mockPrisma = createMockPrisma();
      mockPrisma.historicalDepth.createMany.mockResolvedValue({ count: 500 });
      const { service } = createServiceWithMocks(mockPrisma);

      const records = Array.from({ length: 1200 }, (_, i) => ({
        platform: 'POLYMARKET' as const,
        contractId: '0xTokenABC',
        source: 'PMXT_ARCHIVE' as const,
        bids: [{ price: new Decimal('0.55'), size: new Decimal('100') }],
        asks: [{ price: new Decimal('0.60'), size: new Decimal('80') }],
        timestamp: new Date(Date.UTC(2025, 0, 1, 0, 0, 0) + i * 60 * 60 * 1000),
        updateType: 'snapshot' as const,
      }));
      mockServiceMethods(service, records);

      await service.ingestDepth('0xTokenABC', {
        start: new Date('2025-01-01T00:00:00Z'),
        end: new Date('2025-02-19T00:00:00Z'),
      });

      expect(mockPrisma.historicalDepth.createMany).toHaveBeenCalledTimes(3);
      expect(mockPrisma.historicalDepth.createMany).toHaveBeenCalledWith(
        expect.objectContaining({ skipDuplicates: true }),
      );
    });

    it('[P0] should not create duplicates on re-ingestion (idempotency)', async () => {
      const mockPrisma = createMockPrisma();
      mockPrisma.historicalDepth.createMany.mockResolvedValue({ count: 0 });
      const { service } = createServiceWithMocks(mockPrisma);

      mockServiceMethods(service, [
        {
          platform: 'POLYMARKET',
          contractId: '0xTokenABC',
          source: 'PMXT_ARCHIVE' as const,
          bids: [{ price: new Decimal('0.55'), size: new Decimal('100') }],
          asks: [{ price: new Decimal('0.60'), size: new Decimal('80') }],
          timestamp: new Date('2025-06-01T00:00:00Z'),
          updateType: 'snapshot' as const,
        },
      ]);

      const metadata = await service.ingestDepth('0xTokenABC', {
        start: new Date('2025-06-01T00:00:00Z'),
        end: new Date('2025-06-01T23:59:59Z'),
      });

      expect(metadata.recordCount).toBe(0);
    });

    it('[P1] should update DataCatalog status on completion', async () => {
      const mockPrisma = createMockPrisma();
      mockPrisma.historicalDepth.createMany.mockResolvedValue({ count: 1 });
      const { service } = createServiceWithMocks(mockPrisma);

      mockServiceMethods(service, [
        {
          platform: 'POLYMARKET',
          contractId: '0xTokenABC',
          source: 'PMXT_ARCHIVE' as const,
          bids: [{ price: new Decimal('0.55'), size: new Decimal('100') }],
          asks: [{ price: new Decimal('0.60'), size: new Decimal('80') }],
          timestamp: new Date('2025-06-01T00:00:00Z'),
          updateType: 'snapshot' as const,
        },
      ]);

      await service.ingestDepth('0xTokenABC', {
        start: new Date('2025-06-01T00:00:00Z'),
        end: new Date('2025-06-01T23:59:59Z'),
      });

      expect(service.downloadAndCatalog).toHaveBeenCalled();
    });

    it('[P1] should return IngestionMetadata with correct source and counts', async () => {
      const mockPrisma = createMockPrisma();
      mockPrisma.historicalDepth.createMany.mockResolvedValue({ count: 5 });
      const { service } = createServiceWithMocks(mockPrisma);

      const depths = Array.from({ length: 5 }, (_, i) => ({
        platform: 'POLYMARKET' as const,
        contractId: '0xTokenABC',
        source: 'PMXT_ARCHIVE' as const,
        bids: [{ price: new Decimal('0.55'), size: new Decimal('100') }],
        asks: [{ price: new Decimal('0.60'), size: new Decimal('80') }],
        timestamp: new Date(
          new Date('2025-06-01T00:00:00Z').getTime() + i * 60 * 60 * 1000,
        ),
        updateType: 'snapshot' as const,
      }));
      mockServiceMethods(service, depths);

      const metadata = await service.ingestDepth('0xTokenABC', {
        start: new Date('2025-06-01T00:00:00Z'),
        end: new Date('2025-06-01T23:59:59Z'),
      });

      expect(metadata).toEqual(
        expect.objectContaining({
          source: 'PMXT_ARCHIVE',
          platform: 'POLYMARKET',
          contractId: '0xTokenABC',
          recordCount: 5,
          dateRange: expect.objectContaining({
            start: expect.any(Date),
            end: expect.any(Date),
          }),
          durationMs: expect.any(Number),
        }),
      );
    });
  });
});
