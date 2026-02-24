import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import * as fs from 'fs/promises';
import {
  CsvTradeLogService,
  TradeLogRecord,
  escapeCsvField,
  formatCsvRow,
  getCsvHeader,
  formatDateUTC,
} from './csv-trade-log.service.js';

// Mock fs/promises
vi.mock('fs/promises');

// Suppress logger output
vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});

function makeRecord(overrides: Partial<TradeLogRecord> = {}): TradeLogRecord {
  return {
    timestamp: '2026-02-24T12:00:00.000Z',
    platform: 'KALSHI',
    contractId: 'contract-123',
    side: 'buy',
    price: '0.55',
    size: '100',
    fillPrice: '0.5501',
    fees: '0.50',
    gas: '0',
    edge: '0.012',
    pnl: '0',
    positionId: 'pos-abc-123',
    pairId: 'pair-xyz-456',
    isPaper: false,
    correlationId: 'corr-001',
    ...overrides,
  };
}

describe('CsvTradeLogService', () => {
  let service: CsvTradeLogService;
  let mockConfigService: { get: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    vi.clearAllMocks();

    mockConfigService = {
      get: vi.fn((key: string) => {
        const config: Record<string, string> = {
          CSV_TRADE_LOG_DIR: '/tmp/test-trade-logs',
          CSV_ENABLED: 'true',
        };
        return config[key];
      }),
    };

    // Default fs mocks — happy path
    vi.mocked(fs.mkdir).mockResolvedValue(undefined);
    vi.mocked(fs.access).mockResolvedValue(undefined);
    vi.mocked(fs.appendFile).mockResolvedValue(undefined);
    vi.mocked(fs.stat).mockRejectedValue(
      Object.assign(new Error('ENOENT'), { code: 'ENOENT' }),
    );

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CsvTradeLogService,
        { provide: ConfigService, useValue: mockConfigService },
      ],
    }).compile();

    service = module.get(CsvTradeLogService);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('onModuleInit', () => {
    it('should create directory if missing and enable logging', async () => {
      await service.onModuleInit();

      expect(fs.mkdir).toHaveBeenCalledWith('/tmp/test-trade-logs', {
        recursive: true,
      });
      expect(fs.access).toHaveBeenCalled();
      expect(service.isEnabled()).toBe(true);
    });

    it('should disable gracefully if directory is not writable', async () => {
      vi.mocked(fs.access).mockRejectedValue(new Error('EACCES'));
      const errorSpy = vi.spyOn(Logger.prototype, 'error');

      await service.onModuleInit();

      expect(service.isEnabled()).toBe(false);
      expect(errorSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          code: 4008,
        }),
      );
    });

    it('should use default directory when env var is not set', async () => {
      mockConfigService.get.mockReturnValue(undefined);

      const module2 = await Test.createTestingModule({
        providers: [
          CsvTradeLogService,
          { provide: ConfigService, useValue: mockConfigService },
        ],
      }).compile();

      const service2 = module2.get(CsvTradeLogService);
      await service2.onModuleInit();

      expect(fs.mkdir).toHaveBeenCalledWith(
        expect.stringContaining('data/trade-logs'),
        { recursive: true },
      );
    });

    it('should disable logging when CSV_ENABLED=false', async () => {
      mockConfigService.get.mockImplementation((key: string) => {
        if (key === 'CSV_ENABLED') return 'false';
        if (key === 'CSV_TRADE_LOG_DIR') return '/tmp/test-trade-logs';
        return undefined;
      });

      const module2 = await Test.createTestingModule({
        providers: [
          CsvTradeLogService,
          { provide: ConfigService, useValue: mockConfigService },
        ],
      }).compile();

      const service2 = module2.get(CsvTradeLogService);
      await service2.onModuleInit();

      expect(service2.isEnabled()).toBe(false);
    });
  });

  describe('logTrade', () => {
    beforeEach(async () => {
      await service.onModuleInit();
    });

    it('should create file with header on first write', async () => {
      const record = makeRecord();

      await service.logTrade(record);

      // stat throws ENOENT → file doesn't exist → write header + row
      expect(fs.appendFile).toHaveBeenCalledTimes(2);
      // First call: header
      const firstCall = vi.mocked(fs.appendFile).mock.calls[0];
      expect(firstCall?.[1]).toContain('timestamp,platform,contract_id');
      // Second call: data row
      const secondCall = vi.mocked(fs.appendFile).mock.calls[1];
      expect(secondCall?.[1]).toContain('2026-02-24T12:00:00.000Z');
    });

    it('should append to existing file on subsequent writes', async () => {
      // File exists
      vi.mocked(fs.stat).mockResolvedValue({ size: 100 } as fs.FileHandle &
        import('fs').Stats);

      const record = makeRecord();
      await service.logTrade(record);

      // Only one appendFile call (data row, no header)
      expect(fs.appendFile).toHaveBeenCalledTimes(1);
    });

    it('should skip writes when disabled', async () => {
      vi.mocked(fs.access).mockRejectedValue(new Error('EACCES'));
      await service.onModuleInit(); // re-init to disable

      await service.logTrade(makeRecord());

      // No appendFile calls after init
      const appendCalls = vi.mocked(fs.appendFile).mock.calls;
      expect(appendCalls.length).toBe(0);
    });

    it('should rotate files at date boundary', async () => {
      const record1 = makeRecord({ timestamp: '2026-02-24T23:59:59.000Z' });
      const record2 = makeRecord({ timestamp: '2026-02-25T00:00:01.000Z' });

      await service.logTrade(record1);
      await service.logTrade(record2);

      const filenames = vi
        .mocked(fs.appendFile)
        .mock.calls.map((call) => call[0] as string);

      const file1 = filenames.find((f) => f.includes('trades-2026-02-24.csv'));
      const file2 = filenames.find((f) => f.includes('trades-2026-02-25.csv'));
      expect(file1).toBeDefined();
      expect(file2).toBeDefined();
    });

    it('should log SystemHealthError(4008) on write failure and not throw', async () => {
      vi.mocked(fs.appendFile).mockRejectedValue(new Error('ENOSPC'));
      const errorSpy = vi.spyOn(Logger.prototype, 'error');

      // Should NOT throw
      await expect(service.logTrade(makeRecord())).resolves.toBeUndefined();

      expect(errorSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          code: 4008,
          component: 'csv-trade-logging',
        }),
      );
    });

    it('should serialize concurrent writes via write queue (no duplicate headers)', async () => {
      // Both calls see file doesn't exist
      vi.mocked(fs.stat).mockRejectedValue(
        Object.assign(new Error('ENOENT'), { code: 'ENOENT' }),
      );

      // Make appendFile slow on first call to simulate concurrency
      let callCount = 0;
      vi.mocked(fs.appendFile).mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          // After first header write, make stat return that file exists
          vi.mocked(fs.stat).mockResolvedValue({ size: 100 } as fs.FileHandle &
            import('fs').Stats);
        }
        return Promise.resolve();
      });

      // Fire two concurrent writes for same date
      const p1 = service.logTrade(makeRecord());
      const p2 = service.logTrade(makeRecord());
      await Promise.all([p1, p2]);

      // Count header writes (calls containing 'timestamp,platform')
      const headerWrites = vi
        .mocked(fs.appendFile)
        .mock.calls.filter((call) =>
          String(call[1]).includes('timestamp,platform,contract_id'),
        );
      expect(headerWrites.length).toBe(1);
    });

    it('should not block subsequent writes when one write fails', async () => {
      vi.mocked(fs.appendFile)
        .mockRejectedValueOnce(new Error('ENOSPC')) // header fails
        .mockResolvedValue(undefined); // subsequent succeed

      // Re-mock stat to always say file doesn't exist (since header failed)
      vi.mocked(fs.stat).mockRejectedValue(
        Object.assign(new Error('ENOENT'), { code: 'ENOENT' }),
      );

      await service.logTrade(makeRecord());
      await service.logTrade(makeRecord());

      // Second write should still attempt
      expect(vi.mocked(fs.appendFile).mock.calls.length).toBeGreaterThan(1);
    });
  });
});

describe('Pure functions', () => {
  describe('escapeCsvField', () => {
    it('should return plain field unchanged', () => {
      expect(escapeCsvField('hello')).toBe('hello');
    });

    it('should quote field containing comma', () => {
      expect(escapeCsvField('hello,world')).toBe('"hello,world"');
    });

    it('should escape embedded double quotes', () => {
      expect(escapeCsvField('say "hello"')).toBe('"say ""hello"""');
    });

    it('should quote field containing newline', () => {
      expect(escapeCsvField('line1\nline2')).toBe('"line1\nline2"');
    });

    it('should quote field containing carriage return', () => {
      expect(escapeCsvField('line1\rline2')).toBe('"line1\rline2"');
    });

    it('should handle field with comma and quotes combined', () => {
      expect(escapeCsvField('"Yes, I do"')).toBe('"""Yes, I do"""');
    });

    it('should return empty string unchanged', () => {
      expect(escapeCsvField('')).toBe('');
    });

    it('should prefix formula-triggering characters to prevent CSV injection', () => {
      expect(escapeCsvField('=cmd|calc')).toBe("'=cmd|calc");
      expect(escapeCsvField('@SUM(A1)')).toBe("'@SUM(A1)");
    });

    it('should NOT prefix numeric values starting with +/-', () => {
      expect(escapeCsvField('-15.50')).toBe('-15.50');
      expect(escapeCsvField('+1234')).toBe('+1234');
      expect(escapeCsvField('-0')).toBe('-0');
    });
  });

  describe('formatCsvRow', () => {
    it('should format record with correct column order', () => {
      const record: TradeLogRecord = {
        timestamp: '2026-02-24T12:00:00.000Z',
        platform: 'KALSHI',
        contractId: 'c-123',
        side: 'buy',
        price: '0.55',
        size: '100',
        fillPrice: '0.5501',
        fees: '0.50',
        gas: '0',
        edge: '0.012',
        pnl: '0',
        positionId: 'pos-1',
        pairId: 'pair-1',
        isPaper: false,
        correlationId: 'corr-1',
      };

      const row = formatCsvRow(record);
      const fields = row.split(',');
      expect(fields[0]).toBe('2026-02-24T12:00:00.000Z');
      expect(fields[1]).toBe('KALSHI');
      expect(fields[2]).toBe('c-123');
      expect(fields[3]).toBe('buy');
      expect(fields[4]).toBe('0.55');
      expect(fields[5]).toBe('100');
      expect(fields[6]).toBe('0.5501');
      expect(fields[7]).toBe('0.50');
      expect(fields[8]).toBe('0');
      expect(fields[9]).toBe('0.012');
      expect(fields[10]).toBe('0');
      expect(fields[11]).toBe('pos-1');
      expect(fields[12]).toBe('pair-1');
      expect(fields[13]).toBe('false');
      expect(fields[14]).toBe('corr-1');
    });

    it('should format isPaper=true as string', () => {
      const record: TradeLogRecord = {
        timestamp: '2026-02-24T12:00:00.000Z',
        platform: 'POLYMARKET',
        contractId: 'c-456',
        side: 'sell',
        price: '0.45',
        size: '50',
        fillPrice: '0.4499',
        fees: '0',
        gas: '0.30',
        edge: '0.008',
        pnl: '1.50',
        positionId: 'pos-2',
        pairId: 'pair-2',
        isPaper: true,
        correlationId: 'corr-2',
      };

      const row = formatCsvRow(record);
      expect(row).toContain('true');
    });
  });

  describe('getCsvHeader', () => {
    it('should return correct header with all 15 columns', () => {
      const header = getCsvHeader();
      const columns = header.split(',');
      expect(columns).toEqual([
        'timestamp',
        'platform',
        'contract_id',
        'side',
        'price',
        'size',
        'fill_price',
        'fees',
        'gas',
        'edge',
        'pnl',
        'position_id',
        'pair_id',
        'is_paper',
        'correlation_id',
      ]);
    });
  });

  describe('formatDateUTC', () => {
    it('should return YYYY-MM-DD in UTC', () => {
      const date = new Date('2026-02-24T23:59:59.999Z');
      expect(formatDateUTC(date)).toBe('2026-02-24');
    });

    it('should handle date boundary correctly', () => {
      const date = new Date('2026-02-25T00:00:00.000Z');
      expect(formatDateUTC(date)).toBe('2026-02-25');
    });
  });
});
