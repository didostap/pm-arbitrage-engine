/* eslint-disable @typescript-eslint/unbound-method */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { SchedulerService } from './scheduler.service';
import { TradingEngineService } from './trading-engine.service';
import { ConfigValidationError } from '../common/errors';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock the NTP utility to avoid real network calls in tests
vi.mock('../common/utils', async () => {
  const actual = await vi.importActual('../common/utils');
  return {
    ...actual,
    syncAndMeasureDrift: vi.fn().mockResolvedValue({
      driftMs: 50,
      serverUsed: 'pool.ntp.org',
      timestamp: new Date(),
    }),
  };
});

describe('SchedulerService', () => {
  let service: SchedulerService;
  let tradingEngine: TradingEngineService;
  let configService: ConfigService;
  let schedulerRegistry: SchedulerRegistry;

  /** Configurable overrides for ConfigService.get() */
  let configOverrides: Record<string, number>;

  beforeEach(async () => {
    configOverrides = {};

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SchedulerService,
        {
          provide: ConfigService,
          useValue: {
            get: vi.fn(
              (key: string, defaultValue: number): number =>
                configOverrides[key] ?? defaultValue,
            ),
          },
        },
        {
          provide: TradingEngineService,
          useValue: {
            executeCycle: vi.fn().mockResolvedValue(undefined),
            isCycleInProgress: vi.fn().mockReturnValue(false),
          },
        },
        {
          provide: SchedulerRegistry,
          useValue: {
            addInterval: vi.fn(),
            deleteInterval: vi.fn(),
          },
        },
        {
          provide: EventEmitter2,
          useValue: {
            emit: vi.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<SchedulerService>(SchedulerService);
    tradingEngine = module.get<TradingEngineService>(TradingEngineService);
    configService = module.get<ConfigService>(ConfigService);
    schedulerRegistry = module.get<SchedulerRegistry>(SchedulerRegistry);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('onModuleInit', () => {
    it('should register polling interval with SchedulerRegistry', () => {
      service.onModuleInit();

      expect(schedulerRegistry.addInterval).toHaveBeenCalledWith(
        'pollingCycle',
        expect.any(Object),
      );
    });

    it('should use POLLING_INTERVAL_MS from config', () => {
      service.onModuleInit();

      expect(configService.get).toHaveBeenCalledWith(
        'POLLING_INTERVAL_MS',
        30000,
      );
    });

    it('should log scheduler initialization', () => {
      const logSpy = vi.spyOn(service['logger'], 'log');
      service.onModuleInit();

      expect(logSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining('Scheduler initialized'),
        }),
      );
    });
  });

  describe('handlePollingCycle', () => {
    beforeEach(() => {
      service.onModuleInit(); // default window 0/24 — always active
    });

    it('should call trading engine executeCycle when no cycle in progress', async () => {
      await service['handlePollingCycle']();

      expect(tradingEngine.executeCycle).toHaveBeenCalled();
    });

    it('should skip cycle if already in progress', async () => {
      vi.mocked(tradingEngine.isCycleInProgress).mockReturnValueOnce(true);

      await service['handlePollingCycle']();

      expect(tradingEngine.executeCycle).not.toHaveBeenCalled();
    });

    it('should log skipped interval when cycle in progress', async () => {
      vi.mocked(tradingEngine.isCycleInProgress).mockReturnValueOnce(true);
      const debugSpy = vi.spyOn(service['logger'], 'debug');

      await service['handlePollingCycle']();

      expect(debugSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining('Skipping'),
        }),
      );
    });

    it('should not throw if executeCycle fails', async () => {
      vi.mocked(tradingEngine.executeCycle).mockRejectedValueOnce(
        new Error('Cycle failed'),
      );

      await expect(service['handlePollingCycle']()).resolves.not.toThrow();
    });
  });

  // ── AC-5: isWithinTradingWindow ─────────────────────────────────────

  describe('isWithinTradingWindow — normal window (14/21)', () => {
    beforeEach(() => {
      configOverrides['TRADING_WINDOW_START_UTC'] = 14;
      configOverrides['TRADING_WINDOW_END_UTC'] = 21;
      service.onModuleInit();
    });

    it.each([
      [15, true],
      [14, true], // start inclusive
      [10, false],
      [21, false], // end exclusive
      [0, false],
    ])('hour %i → %s', (hour, expected) => {
      expect(service['isWithinTradingWindow'](hour)).toBe(expected);
    });
  });

  describe('isWithinTradingWindow — midnight-spanning window (22/6)', () => {
    beforeEach(() => {
      configOverrides['TRADING_WINDOW_START_UTC'] = 22;
      configOverrides['TRADING_WINDOW_END_UTC'] = 6;
      service.onModuleInit();
    });

    it.each([
      [23, true],
      [3, true],
      [22, true], // start inclusive
      [6, false], // end exclusive
      [10, false],
      [14, false],
    ])('hour %i → %s', (hour, expected) => {
      expect(service['isWithinTradingWindow'](hour)).toBe(expected);
    });
  });

  describe('isWithinTradingWindow — default window (0/24)', () => {
    beforeEach(() => {
      service.onModuleInit(); // defaults: start=0, end=24
    });

    it.each([0, 6, 12, 18, 23])('hour %i → always true', (hour) => {
      expect(service['isWithinTradingWindow'](hour)).toBe(true);
    });
  });

  // ── AC-3: handlePollingCycle trading window gate ────────────────────

  describe('handlePollingCycle — trading window gate', () => {
    it('outside window: executeCycle NOT called, log emitted', async () => {
      configOverrides['TRADING_WINDOW_START_UTC'] = 14;
      configOverrides['TRADING_WINDOW_END_UTC'] = 21;
      service.onModuleInit();

      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-03-24T10:00:00Z')); // hour 10 — outside

      const logSpy = vi.spyOn(service['logger'], 'log');
      await service['handlePollingCycle']();

      expect(tradingEngine.executeCycle).not.toHaveBeenCalled();
      expect(logSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'Skipping trading cycle — outside configured trading window',
          data: expect.objectContaining({
            currentHour: 10,
            windowStart: 14,
            windowEnd: 21,
          }),
        }),
      );
    });

    it('inside window: executeCycle called normally', async () => {
      configOverrides['TRADING_WINDOW_START_UTC'] = 14;
      configOverrides['TRADING_WINDOW_END_UTC'] = 21;
      service.onModuleInit();

      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-03-24T15:00:00Z')); // hour 15 — inside

      await service['handlePollingCycle']();

      expect(tradingEngine.executeCycle).toHaveBeenCalled();
    });

    it('checks trading window before cycle-in-progress', async () => {
      configOverrides['TRADING_WINDOW_START_UTC'] = 14;
      configOverrides['TRADING_WINDOW_END_UTC'] = 21;
      service.onModuleInit();

      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-03-24T10:00:00Z')); // outside window
      vi.mocked(tradingEngine.isCycleInProgress).mockReturnValue(true);

      await service['handlePollingCycle']();

      // Should skip due to window — never reaches cycle-in-progress check
      expect(tradingEngine.isCycleInProgress).not.toHaveBeenCalled();
      expect(tradingEngine.executeCycle).not.toHaveBeenCalled();
    });

    it('default window (0/24): executeCycle always called', async () => {
      service.onModuleInit(); // defaults

      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-03-24T03:00:00Z')); // any hour

      await service['handlePollingCycle']();

      expect(tradingEngine.executeCycle).toHaveBeenCalled();
    });
  });

  // ── AC-6: Config validation ─────────────────────────────────────────

  describe('validateTradingWindow (startup)', () => {
    it('start = 24 → ConfigValidationError', () => {
      configOverrides['TRADING_WINDOW_START_UTC'] = 24;
      configOverrides['TRADING_WINDOW_END_UTC'] = 6;

      expect(() => service.onModuleInit()).toThrow(ConfigValidationError);
    });

    it('end = 0 → ConfigValidationError', () => {
      configOverrides['TRADING_WINDOW_START_UTC'] = 14;
      configOverrides['TRADING_WINDOW_END_UTC'] = 0;

      expect(() => service.onModuleInit()).toThrow(ConfigValidationError);
    });

    it('start === end → ConfigValidationError', () => {
      configOverrides['TRADING_WINDOW_START_UTC'] = 10;
      configOverrides['TRADING_WINDOW_END_UTC'] = 10;

      expect(() => service.onModuleInit()).toThrow(ConfigValidationError);
    });
  });

  // ── AC-2: Hot-reload ────────────────────────────────────────────────

  describe('reloadTradingWindow', () => {
    beforeEach(() => {
      service.onModuleInit(); // defaults: 0/24
    });

    it('updates window values and validates', () => {
      service.reloadTradingWindow({
        tradingWindowStartUtc: 14,
        tradingWindowEndUtc: 21,
      });

      // Verify private fields updated
      expect(service['tradingWindowStartUtc']).toBe(14);
      expect(service['tradingWindowEndUtc']).toBe(21);
    });

    it('updates only start when end omitted, preserving current end', () => {
      service.reloadTradingWindow({ tradingWindowStartUtc: 14 });

      expect(service['tradingWindowStartUtc']).toBe(14);
      expect(service['tradingWindowEndUtc']).toBe(24); // default preserved
    });

    it('updates only end when start omitted, preserving current start', () => {
      service.reloadTradingWindow({ tradingWindowEndUtc: 18 });

      expect(service['tradingWindowStartUtc']).toBe(0); // default preserved
      expect(service['tradingWindowEndUtc']).toBe(18);
    });

    it('invalid values log warning and preserve current values', () => {
      service.reloadTradingWindow({
        tradingWindowStartUtc: 14,
        tradingWindowEndUtc: 21,
      });

      const warnSpy = vi.spyOn(service['logger'], 'warn');

      // Try to reload with invalid values (start === end)
      service.reloadTradingWindow({
        tradingWindowStartUtc: 10,
        tradingWindowEndUtc: 10,
      });

      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining('Invalid trading window'),
        }),
      );
      // Values preserved
      expect(service['tradingWindowStartUtc']).toBe(14);
      expect(service['tradingWindowEndUtc']).toBe(21);
    });
  });

  // ── AC-7: Paper/live boundary ────────────────────────────────────────

  describe('paper/live mode boundary', () => {
    it('trading window applies identically regardless of mode (no mode-dependent branching)', () => {
      // This test verifies that the trading window logic has no isPaper branching.
      // The SchedulerService has no mode awareness — it gates cycles uniformly.
      configOverrides['TRADING_WINDOW_START_UTC'] = 14;
      configOverrides['TRADING_WINDOW_END_UTC'] = 21;
      service.onModuleInit();

      // Inside window
      expect(service['isWithinTradingWindow'](15)).toBe(true);

      // Outside window
      expect(service['isWithinTradingWindow'](10)).toBe(false);

      // No isPaper field exists on SchedulerService — uniform behavior
      expect(service).not.toHaveProperty('isPaper');
    });
  });
});
