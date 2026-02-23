/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/unbound-method */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import Decimal from 'decimal.js';
import { GasEstimationService } from './gas-estimation.service.js';
import { EVENT_NAMES } from '../../common/events/event-catalog.js';
import { ConfigValidationError } from '../../common/errors/config-validation-error.js';

// Mock viem
const mockGetGasPrice = vi.fn();
vi.mock('viem', () => ({
  createPublicClient: vi.fn(() => ({
    getGasPrice: mockGetGasPrice,
  })),
  http: vi.fn((url: string) => url),
}));
vi.mock('viem/chains', () => ({
  polygon: { id: 137, name: 'Polygon' },
}));

// Mock global fetch for CoinGecko
const mockFetch = vi.fn();
global.fetch = mockFetch;

function makeCoinGeckoResponse(usd: number) {
  return {
    ok: true,
    json: () => Promise.resolve({ 'polygon-ecosystem-token': { usd } }),
  };
}

function makeConfigService(
  overrides: Record<string, unknown> = {},
): Partial<ConfigService> {
  const defaults: Record<string, unknown> = {
    POLYMARKET_RPC_URL: 'https://polygon-rpc.com',
    DETECTION_GAS_ESTIMATE_USD: 0.3,
    GAS_BUFFER_PERCENT: 20,
    GAS_POLL_INTERVAL_MS: 30000,
    GAS_POL_PRICE_FALLBACK_USD: '0.40',
    POLYMARKET_SETTLEMENT_GAS_UNITS: 150000,
  };
  const config = { ...defaults, ...overrides };
  return {
    get: vi.fn(
      (key: string, defaultValue?: unknown) => config[key] ?? defaultValue,
    ),
  };
}

describe('GasEstimationService', () => {
  let service: GasEstimationService;
  let configService: Partial<ConfigService>;
  let eventEmitter: EventEmitter2;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.useFakeTimers();

    configService = makeConfigService();
    eventEmitter = new EventEmitter2();
    vi.spyOn(eventEmitter, 'emit');

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GasEstimationService,
        { provide: ConfigService, useValue: configService },
        { provide: EventEmitter2, useValue: eventEmitter },
      ],
    }).compile();

    service = module.get<GasEstimationService>(GasEstimationService);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('getGasEstimateUsd', () => {
    it('returns static fallback before first poll', () => {
      const estimate = service.getGasEstimateUsd();
      expect(estimate).toBeInstanceOf(Decimal);
      expect(estimate.toNumber()).toBe(0.3);
    });

    it('returns dynamic estimate after successful poll', async () => {
      mockGetGasPrice.mockResolvedValue(50_000_000_000n);
      mockFetch.mockResolvedValue(makeCoinGeckoResponse(0.5));

      await service.poll();

      const estimate = service.getGasEstimateUsd();
      // (50e9 * 150000 * 0.50 / 1e18) * 1.20 = 0.0045
      expect(estimate.toFixed(6)).toBe('0.004500');
    });

    it('applies configurable buffer percent', async () => {
      configService = makeConfigService({ GAS_BUFFER_PERCENT: 50 });
      eventEmitter = new EventEmitter2();
      vi.spyOn(eventEmitter, 'emit');

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          GasEstimationService,
          { provide: ConfigService, useValue: configService },
          { provide: EventEmitter2, useValue: eventEmitter },
        ],
      }).compile();
      service = module.get<GasEstimationService>(GasEstimationService);

      mockGetGasPrice.mockResolvedValue(50_000_000_000n);
      mockFetch.mockResolvedValue(makeCoinGeckoResponse(0.5));

      await service.poll();

      const estimate = service.getGasEstimateUsd();
      // (50e9 * 150000 * 0.50 / 1e18) * 1.50 = 0.005625
      expect(estimate.toFixed(6)).toBe('0.005625');
    });

    it('uses all decimal.js math — no native JS operators', async () => {
      mockGetGasPrice.mockResolvedValue(100_000_000_000n);
      mockFetch.mockResolvedValue(makeCoinGeckoResponse(1.0));

      await service.poll();

      const estimate = service.getGasEstimateUsd();
      // (100e9 * 150000 * 1.0 / 1e18) * 1.20 = 0.018
      expect(estimate).toBeInstanceOf(Decimal);
      expect(estimate.toFixed(6)).toBe('0.018000');
    });
  });

  describe('fallback behavior', () => {
    it('falls back to cached gas price if RPC fails on subsequent poll', async () => {
      mockGetGasPrice.mockResolvedValue(50_000_000_000n);
      mockFetch.mockResolvedValue(makeCoinGeckoResponse(0.5));
      await service.poll();

      mockGetGasPrice.mockRejectedValue(new Error('RPC down'));
      mockFetch.mockResolvedValue(makeCoinGeckoResponse(0.6));
      await service.poll();

      const estimate = service.getGasEstimateUsd();
      // Cached gas (50 gwei) + new POL (0.6): (50e9*150000*0.60/1e18)*1.20 = 0.0054
      expect(estimate.toFixed(6)).toBe('0.005400');
    });

    it('falls back to cached POL price if CoinGecko fails', async () => {
      mockGetGasPrice.mockResolvedValue(50_000_000_000n);
      mockFetch.mockResolvedValue(makeCoinGeckoResponse(0.5));
      await service.poll();

      mockGetGasPrice.mockResolvedValue(100_000_000_000n);
      mockFetch.mockRejectedValue(new Error('CoinGecko down'));
      await service.poll();

      const estimate = service.getGasEstimateUsd();
      // New gas (100 gwei) + cached POL (0.5): (100e9*150000*0.50/1e18)*1.20 = 0.009
      expect(estimate.toFixed(6)).toBe('0.009000');
    });

    it('falls back to static config if both sources fail and no cache', async () => {
      mockGetGasPrice.mockRejectedValue(new Error('RPC down'));
      mockFetch.mockRejectedValue(new Error('CoinGecko down'));

      await service.poll();

      const estimate = service.getGasEstimateUsd();
      expect(estimate.toNumber()).toBe(0.3);
    });

    it('falls back to POL price env var if CoinGecko never succeeds', async () => {
      mockGetGasPrice.mockResolvedValue(50_000_000_000n);
      mockFetch.mockRejectedValue(new Error('CoinGecko down'));

      await service.poll();

      const estimate = service.getGasEstimateUsd();
      // Gas (50 gwei) + fallback POL ($0.40): (50e9*150000*0.40/1e18)*1.20 = 0.0036
      expect(estimate.toFixed(6)).toBe('0.003600');
    });

    it('uses static config if cache is older than 5 minutes and source keeps failing', async () => {
      mockGetGasPrice.mockResolvedValue(50_000_000_000n);
      mockFetch.mockResolvedValue(makeCoinGeckoResponse(0.5));
      await service.poll();

      vi.advanceTimersByTime(6 * 60 * 1000);

      mockGetGasPrice.mockRejectedValue(new Error('RPC down'));
      mockFetch.mockRejectedValue(new Error('CoinGecko down'));
      await service.poll();

      const estimate = service.getGasEstimateUsd();
      expect(estimate.toNumber()).toBe(0.3);
    });
  });

  describe('polling lifecycle', () => {
    it('starts polling on onModuleInit', async () => {
      mockGetGasPrice.mockResolvedValue(50_000_000_000n);
      mockFetch.mockResolvedValue(makeCoinGeckoResponse(0.5));

      await service.onModuleInit();

      expect(mockGetGasPrice).toHaveBeenCalledTimes(1);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('polls at configured interval', async () => {
      mockGetGasPrice.mockResolvedValue(50_000_000_000n);
      mockFetch.mockResolvedValue(makeCoinGeckoResponse(0.5));

      await service.onModuleInit();
      await vi.advanceTimersByTimeAsync(30000);

      expect(mockGetGasPrice).toHaveBeenCalledTimes(2);
    });

    it('clears interval on onModuleDestroy', async () => {
      mockGetGasPrice.mockResolvedValue(50_000_000_000n);
      mockFetch.mockResolvedValue(makeCoinGeckoResponse(0.5));

      await service.onModuleInit();
      service.onModuleDestroy();
      await vi.advanceTimersByTimeAsync(60000);

      expect(mockGetGasPrice).toHaveBeenCalledTimes(1);
    });
  });

  describe('event emission', () => {
    it('emits platform.gas.updated when gas changes >10%', async () => {
      mockGetGasPrice.mockResolvedValue(50_000_000_000n);
      mockFetch.mockResolvedValue(makeCoinGeckoResponse(0.5));
      await service.poll();

      mockGetGasPrice.mockResolvedValue(75_000_000_000n);
      mockFetch.mockResolvedValue(makeCoinGeckoResponse(0.5));
      await service.poll();

      expect(eventEmitter.emit).toHaveBeenCalledWith(
        EVENT_NAMES.PLATFORM_GAS_UPDATED,
        expect.objectContaining({
          previousEstimateUsd: expect.any(String),
          newEstimateUsd: expect.any(String),
        }),
      );
    });

    it('does not emit event when gas change is <=10%', async () => {
      mockGetGasPrice.mockResolvedValue(50_000_000_000n);
      mockFetch.mockResolvedValue(makeCoinGeckoResponse(0.5));
      await service.poll();

      vi.mocked(eventEmitter.emit).mockClear();

      mockGetGasPrice.mockResolvedValue(52_500_000_000n);
      mockFetch.mockResolvedValue(makeCoinGeckoResponse(0.5));
      await service.poll();

      expect(eventEmitter.emit).not.toHaveBeenCalledWith(
        EVENT_NAMES.PLATFORM_GAS_UPDATED,
        expect.anything(),
      );
    });
  });

  describe('CoinGecko fetch', () => {
    it('parses POL/USD price from CoinGecko response', async () => {
      mockGetGasPrice.mockResolvedValue(50_000_000_000n);
      mockFetch.mockResolvedValue(makeCoinGeckoResponse(0.75));

      await service.poll();

      const estimate = service.getGasEstimateUsd();
      // (50e9 * 150000 * 0.75 / 1e18) * 1.20 = 0.00675
      expect(estimate.toFixed(6)).toBe('0.006750');
    });

    it('handles non-ok CoinGecko response as failure', async () => {
      mockGetGasPrice.mockResolvedValue(50_000_000_000n);
      mockFetch.mockResolvedValue({ ok: false, status: 429 });

      await service.poll();

      const estimate = service.getGasEstimateUsd();
      // Gas + fallback POL ($0.40): (50e9*150000*0.40/1e18)*1.20 = 0.0036
      expect(estimate.toFixed(6)).toBe('0.003600');
    });
  });

  describe('error code', () => {
    it('logs PlatformApiError warning with code 1016 when RPC fails', async () => {
      const loggerSpy = vi.spyOn(service['logger'], 'warn');

      mockGetGasPrice.mockRejectedValue(new Error('RPC timeout'));
      mockFetch.mockResolvedValue(makeCoinGeckoResponse(0.5));

      await service.poll();

      expect(loggerSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining('Gas price fetch failed'),
          code: 1016,
          severity: 'warning',
        }),
      );
    });
  });

  describe('config validation', () => {
    it('throws ConfigValidationError on negative gas units', async () => {
      const badConfig = makeConfigService({
        POLYMARKET_SETTLEMENT_GAS_UNITS: -1,
      });

      await expect(
        Test.createTestingModule({
          providers: [
            GasEstimationService,
            { provide: ConfigService, useValue: badConfig },
            { provide: EventEmitter2, useValue: eventEmitter },
          ],
        }).compile(),
      ).rejects.toThrow(ConfigValidationError);
    });

    it('throws ConfigValidationError on zero poll interval', async () => {
      const badConfig = makeConfigService({ GAS_POLL_INTERVAL_MS: 0 });

      await expect(
        Test.createTestingModule({
          providers: [
            GasEstimationService,
            { provide: ConfigService, useValue: badConfig },
            { provide: EventEmitter2, useValue: eventEmitter },
          ],
        }).compile(),
      ).rejects.toThrow(ConfigValidationError);
    });
  });
});
