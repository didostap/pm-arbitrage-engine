import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DepthAnalysisService } from './depth-analysis.service';
import { PlatformId } from '../../common/types/platform.type';
import { EVENT_NAMES } from '../../common/events/event-catalog';
import { DepthCheckFailedEvent } from '../../common/events/execution.events';
import { PlatformApiError } from '../../common/errors/platform-api-error';
import { createMockPlatformConnector } from '../../test/mock-factories.js';
import { DataDivergenceService } from '../data-ingestion/data-divergence.service';
import { asContractId } from '../../common/types/branded.type';
import type { NormalizedOrderBook } from '../../common/types/index';

// ──────────────────────────────────────────────────────────────
// Factory helpers
// ──────────────────────────────────────────────────────────────

function makeKalshiOrderBook(
  overrides?: Partial<NormalizedOrderBook>,
): NormalizedOrderBook {
  return {
    platformId: PlatformId.KALSHI,
    contractId: asContractId('kalshi-contract-1'),
    bids: [{ price: 0.44, quantity: 500 }],
    asks: [{ price: 0.45, quantity: 500 }],
    timestamp: new Date(),
    ...overrides,
  };
}

function makePolymarketOrderBook(
  overrides?: Partial<NormalizedOrderBook>,
): NormalizedOrderBook {
  return {
    platformId: PlatformId.POLYMARKET,
    contractId: asContractId('pm-contract-1'),
    bids: [{ price: 0.55, quantity: 500 }],
    asks: [{ price: 0.56, quantity: 500 }],
    timestamp: new Date(),
    ...overrides,
  };
}

function createConfigService(overrides: Record<string, string> = {}): {
  get: ReturnType<typeof vi.fn>;
} {
  const defaults: Record<string, string> = {
    DUAL_LEG_MIN_DEPTH_RATIO: '1.0',
    ...overrides,
  };
  return {
    get: vi.fn((key: string, defaultValue?: string) => {
      return defaults[key] ?? defaultValue;
    }),
  };
}

// ──────────────────────────────────────────────────────────────
// Test Suite
// ──────────────────────────────────────────────────────────────

describe('DepthAnalysisService', () => {
  let service: DepthAnalysisService;
  let kalshiConnector: ReturnType<typeof createMockPlatformConnector>;
  let polymarketConnector: ReturnType<typeof createMockPlatformConnector>;
  let eventEmitter: { emit: ReturnType<typeof vi.fn> };
  let dataDivergenceService: {
    getDivergenceStatus: ReturnType<typeof vi.fn>;
  };
  let configService: ReturnType<typeof createConfigService>;

  beforeEach(async () => {
    kalshiConnector = createMockPlatformConnector(PlatformId.KALSHI);
    polymarketConnector = createMockPlatformConnector(PlatformId.POLYMARKET);
    eventEmitter = { emit: vi.fn() };
    dataDivergenceService = {
      getDivergenceStatus: vi.fn().mockReturnValue('normal'),
    };
    configService = createConfigService();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DepthAnalysisService,
        { provide: EventEmitter2, useValue: eventEmitter },
        { provide: DataDivergenceService, useValue: dataDivergenceService },
        { provide: ConfigService, useValue: configService },
      ],
    }).compile();

    service = module.get<DepthAnalysisService>(DepthAnalysisService);
  });

  // ════════════════════════════════════════════════════════════════
  // Constructor config validation
  // ════════════════════════════════════════════════════════════════

  describe('constructor config validation', () => {
    it('should throw SystemHealthError for invalid DUAL_LEG_MIN_DEPTH_RATIO (0)', async () => {
      await expect(
        Test.createTestingModule({
          providers: [
            DepthAnalysisService,
            { provide: EventEmitter2, useValue: eventEmitter },
            {
              provide: DataDivergenceService,
              useValue: dataDivergenceService,
            },
            {
              provide: ConfigService,
              useValue: createConfigService({
                DUAL_LEG_MIN_DEPTH_RATIO: '0',
              }),
            },
          ],
        }).compile(),
      ).rejects.toThrow('Invalid DUAL_LEG_MIN_DEPTH_RATIO');
    });

    it('should throw SystemHealthError for DUAL_LEG_MIN_DEPTH_RATIO > 1', async () => {
      await expect(
        Test.createTestingModule({
          providers: [
            DepthAnalysisService,
            { provide: EventEmitter2, useValue: eventEmitter },
            {
              provide: DataDivergenceService,
              useValue: dataDivergenceService,
            },
            {
              provide: ConfigService,
              useValue: createConfigService({
                DUAL_LEG_MIN_DEPTH_RATIO: '1.5',
              }),
            },
          ],
        }).compile(),
      ).rejects.toThrow('Invalid DUAL_LEG_MIN_DEPTH_RATIO');
    });

    it('should throw SystemHealthError for NaN DUAL_LEG_MIN_DEPTH_RATIO', async () => {
      await expect(
        Test.createTestingModule({
          providers: [
            DepthAnalysisService,
            { provide: EventEmitter2, useValue: eventEmitter },
            {
              provide: DataDivergenceService,
              useValue: dataDivergenceService,
            },
            {
              provide: ConfigService,
              useValue: createConfigService({
                DUAL_LEG_MIN_DEPTH_RATIO: 'not-a-number',
              }),
            },
          ],
        }).compile(),
      ).rejects.toThrow('Invalid DUAL_LEG_MIN_DEPTH_RATIO');
    });
  });

  // ════════════════════════════════════════════════════════════════
  // getAvailableDepth
  // ════════════════════════════════════════════════════════════════

  describe('getAvailableDepth', () => {
    it('should return total quantity at or below target price for buy side', async () => {
      kalshiConnector.getOrderBook.mockResolvedValue(
        makeKalshiOrderBook({
          asks: [
            { price: 0.4, quantity: 10 },
            { price: 0.45, quantity: 20 },
            { price: 0.5, quantity: 30 },
          ],
        }),
      );

      const depth = await service.getAvailableDepth(
        kalshiConnector,
        'kalshi-contract-1',
        'buy',
        0.45,
        PlatformId.KALSHI,
      );

      // Only asks at ≤0.45: 10 + 20 = 30
      expect(depth).toBe(30);
    });

    it('should return total quantity at or above target price for sell side', async () => {
      polymarketConnector.getOrderBook.mockResolvedValue(
        makePolymarketOrderBook({
          bids: [
            { price: 0.5, quantity: 15 },
            { price: 0.55, quantity: 25 },
            { price: 0.6, quantity: 35 },
          ],
        }),
      );

      const depth = await service.getAvailableDepth(
        polymarketConnector,
        'pm-contract-1',
        'sell',
        0.55,
        PlatformId.POLYMARKET,
      );

      // Only bids at ≥0.55: 25 + 35 = 60
      expect(depth).toBe(60);
    });

    it('should return 0 for empty order book', async () => {
      kalshiConnector.getOrderBook.mockResolvedValue(
        makeKalshiOrderBook({ asks: [], bids: [] }),
      );

      const depth = await service.getAvailableDepth(
        kalshiConnector,
        'kalshi-contract-1',
        'buy',
        0.45,
        PlatformId.KALSHI,
      );

      expect(depth).toBe(0);
    });

    it('should return 0 on API error (fail-closed)', async () => {
      kalshiConnector.getOrderBook.mockRejectedValue(
        new PlatformApiError(
          1002,
          'Rate limit exceeded',
          PlatformId.KALSHI,
          'warning',
        ),
      );

      const depth = await service.getAvailableDepth(
        kalshiConnector,
        'kalshi-contract-1',
        'buy',
        0.45,
        PlatformId.KALSHI,
      );

      expect(depth).toBe(0);
    });

    it('should emit DepthCheckFailedEvent on API error', async () => {
      kalshiConnector.getOrderBook.mockRejectedValue(
        new PlatformApiError(
          1002,
          'Rate limit exceeded',
          PlatformId.KALSHI,
          'warning',
        ),
      );

      await service.getAvailableDepth(
        kalshiConnector,
        'kalshi-contract-1',
        'buy',
        0.45,
        PlatformId.KALSHI,
      );

      const depthFailedCalls = eventEmitter.emit.mock.calls.filter(
        (call: unknown[]) => call[0] === EVENT_NAMES.DEPTH_CHECK_FAILED,
      );
      expect(depthFailedCalls).toHaveLength(1);

      const event = depthFailedCalls[0]![1] as DepthCheckFailedEvent;
      expect(event).toBeInstanceOf(DepthCheckFailedEvent);
      expect(event.platform).toBe(PlatformId.KALSHI);
      expect(event.contractId).toBe('kalshi-contract-1');
      expect(event.side).toBe('buy');
      expect(event.errorType).toBe('PlatformApiError');
      expect(event.errorMessage).toBe('Rate limit exceeded');
    });

    it('should emit structured warning log on API error', async () => {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      const warnSpy = vi.spyOn((service as any).logger as Logger, 'warn');
      kalshiConnector.getOrderBook.mockRejectedValue(
        new PlatformApiError(
          1002,
          'Rate limit exceeded',
          PlatformId.KALSHI,
          'warning',
        ),
      );

      await service.getAvailableDepth(
        kalshiConnector,
        'kalshi-contract-1',
        'buy',
        0.45,
        PlatformId.KALSHI,
      );

      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'Depth query failed',
          module: 'execution',
          platform: PlatformId.KALSHI,
          contractId: 'kalshi-contract-1',
          side: 'buy',
          errorMessage: 'Rate limit exceeded',
        }),
      );
    });

    it('should handle generic Error on API failure', async () => {
      kalshiConnector.getOrderBook.mockRejectedValue(
        new Error('Connection timeout'),
      );

      const depth = await service.getAvailableDepth(
        kalshiConnector,
        'kalshi-contract-1',
        'buy',
        0.45,
        PlatformId.KALSHI,
      );

      expect(depth).toBe(0);
      const depthFailedCalls = eventEmitter.emit.mock.calls.filter(
        (call: unknown[]) => call[0] === EVENT_NAMES.DEPTH_CHECK_FAILED,
      );
      const event = depthFailedCalls[0]![1] as DepthCheckFailedEvent;
      expect(event.errorType).toBe('Error');
      expect(event.errorMessage).toBe('Connection timeout');
    });
  });

  // ════════════════════════════════════════════════════════════════
  // classifyDataSource
  // ════════════════════════════════════════════════════════════════

  describe('classifyDataSource', () => {
    it('should return "polling" when lastWsUpdateAt is null', () => {
      expect(service.classifyDataSource(null, new Date(), 60000)).toBe(
        'polling',
      );
    });

    it('should return "websocket" when WS data is fresh', () => {
      const now = new Date();
      const recent = new Date(now.getTime() - 5000);
      expect(service.classifyDataSource(recent, now, 60000)).toBe('websocket');
    });

    it('should return "stale_fallback" when WS data is stale', () => {
      const now = new Date();
      const old = new Date(now.getTime() - 90000);
      expect(service.classifyDataSource(old, now, 60000)).toBe(
        'stale_fallback',
      );
    });

    it('should return "stale_fallback" at exact threshold boundary', () => {
      const now = new Date();
      const exact = new Date(now.getTime() - 60000);
      expect(service.classifyDataSource(exact, now, 60000)).toBe(
        'stale_fallback',
      );
    });

    it('should return "websocket" 1ms before threshold', () => {
      const now = new Date();
      const justBefore = new Date(now.getTime() - 59999);
      expect(service.classifyDataSource(justBefore, now, 60000)).toBe(
        'websocket',
      );
    });
  });

  // ════════════════════════════════════════════════════════════════
  // validateDualLegDepth
  // ════════════════════════════════════════════════════════════════

  describe('validateDualLegDepth', () => {
    it('should pass when both legs have sufficient depth', async () => {
      kalshiConnector.getOrderBook.mockResolvedValue(
        makeKalshiOrderBook({ asks: [{ price: 0.45, quantity: 200 }] }),
      );
      polymarketConnector.getOrderBook.mockResolvedValue(
        makePolymarketOrderBook({ bids: [{ price: 0.55, quantity: 200 }] }),
      );

      const result = await service.validateDualLegDepth({
        primaryConnector: kalshiConnector,
        primaryContractId: 'kalshi-contract-1',
        primarySide: 'buy',
        primaryPrice: 0.45,
        primaryPlatform: PlatformId.KALSHI,
        secondaryConnector: polymarketConnector,
        secondaryContractId: 'pm-contract-1',
        secondarySide: 'sell',
        secondaryPrice: 0.55,
        secondaryPlatform: PlatformId.POLYMARKET,
        idealCount: 100,
      });

      expect(result.passed).toBe(true);
      expect(result.primaryDepth).toBe(200);
      expect(result.secondaryDepth).toBe(200);
      expect(result.minDepthRequired).toBe(100);
    });

    it('should fail when primary has insufficient depth', async () => {
      kalshiConnector.getOrderBook.mockResolvedValue(
        makeKalshiOrderBook({ asks: [{ price: 0.45, quantity: 5 }] }),
      );
      polymarketConnector.getOrderBook.mockResolvedValue(
        makePolymarketOrderBook({ bids: [{ price: 0.55, quantity: 200 }] }),
      );

      const result = await service.validateDualLegDepth({
        primaryConnector: kalshiConnector,
        primaryContractId: 'kalshi-contract-1',
        primarySide: 'buy',
        primaryPrice: 0.45,
        primaryPlatform: PlatformId.KALSHI,
        secondaryConnector: polymarketConnector,
        secondaryContractId: 'pm-contract-1',
        secondarySide: 'sell',
        secondaryPrice: 0.55,
        secondaryPlatform: PlatformId.POLYMARKET,
        idealCount: 100,
      });

      expect(result.passed).toBe(false);
      expect(result.primaryDepth).toBe(5);
      if (!result.passed) {
        expect(result.reason).toContain('insufficient dual-leg depth');
        expect(result.reason).toContain('kalshi');
      }
    });

    it('should fail when secondary has insufficient depth', async () => {
      kalshiConnector.getOrderBook.mockResolvedValue(
        makeKalshiOrderBook({ asks: [{ price: 0.45, quantity: 200 }] }),
      );
      polymarketConnector.getOrderBook.mockResolvedValue(
        makePolymarketOrderBook({ bids: [{ price: 0.55, quantity: 3 }] }),
      );

      const result = await service.validateDualLegDepth({
        primaryConnector: kalshiConnector,
        primaryContractId: 'kalshi-contract-1',
        primarySide: 'buy',
        primaryPrice: 0.45,
        primaryPlatform: PlatformId.KALSHI,
        secondaryConnector: polymarketConnector,
        secondaryContractId: 'pm-contract-1',
        secondarySide: 'sell',
        secondaryPrice: 0.55,
        secondaryPlatform: PlatformId.POLYMARKET,
        idealCount: 100,
      });

      expect(result.passed).toBe(false);
      expect(result.secondaryDepth).toBe(3);
      if (!result.passed) {
        expect(result.reason).toContain('insufficient dual-leg depth');
        expect(result.reason).toContain('polymarket');
      }
    });

    it('should fail-closed when primary API errors (depth returns 0)', async () => {
      kalshiConnector.getOrderBook.mockRejectedValue(
        new Error('Kalshi API timeout'),
      );
      polymarketConnector.getOrderBook.mockResolvedValue(
        makePolymarketOrderBook({ bids: [{ price: 0.55, quantity: 200 }] }),
      );

      const result = await service.validateDualLegDepth({
        primaryConnector: kalshiConnector,
        primaryContractId: 'kalshi-contract-1',
        primarySide: 'buy',
        primaryPrice: 0.45,
        primaryPlatform: PlatformId.KALSHI,
        secondaryConnector: polymarketConnector,
        secondaryContractId: 'pm-contract-1',
        secondarySide: 'sell',
        secondaryPrice: 0.55,
        secondaryPlatform: PlatformId.POLYMARKET,
        idealCount: 100,
      });

      expect(result.passed).toBe(false);
      expect(result.primaryDepth).toBe(0);
    });

    it('should fail-closed when secondary API errors', async () => {
      kalshiConnector.getOrderBook.mockResolvedValue(
        makeKalshiOrderBook({ asks: [{ price: 0.45, quantity: 200 }] }),
      );
      polymarketConnector.getOrderBook.mockRejectedValue(
        new Error('Polymarket API error'),
      );

      const result = await service.validateDualLegDepth({
        primaryConnector: kalshiConnector,
        primaryContractId: 'kalshi-contract-1',
        primarySide: 'buy',
        primaryPrice: 0.45,
        primaryPlatform: PlatformId.KALSHI,
        secondaryConnector: polymarketConnector,
        secondaryContractId: 'pm-contract-1',
        secondarySide: 'sell',
        secondaryPrice: 0.55,
        secondaryPlatform: PlatformId.POLYMARKET,
        idealCount: 100,
      });

      expect(result.passed).toBe(false);
      expect(result.secondaryDepth).toBe(0);
    });

    it('should use configured dualLegMinDepthRatio for threshold', async () => {
      // Recreate with ratio=0.5
      const module: TestingModule = await Test.createTestingModule({
        providers: [
          DepthAnalysisService,
          { provide: EventEmitter2, useValue: eventEmitter },
          { provide: DataDivergenceService, useValue: dataDivergenceService },
          {
            provide: ConfigService,
            useValue: createConfigService({
              DUAL_LEG_MIN_DEPTH_RATIO: '0.5',
            }),
          },
        ],
      }).compile();
      const customService =
        module.get<DepthAnalysisService>(DepthAnalysisService);

      // idealCount=100, ratio=0.5, minDepthRequired=50
      kalshiConnector.getOrderBook.mockResolvedValue(
        makeKalshiOrderBook({ asks: [{ price: 0.45, quantity: 60 }] }),
      );
      polymarketConnector.getOrderBook.mockResolvedValue(
        makePolymarketOrderBook({ bids: [{ price: 0.55, quantity: 60 }] }),
      );

      const result = await customService.validateDualLegDepth({
        primaryConnector: kalshiConnector,
        primaryContractId: 'kalshi-contract-1',
        primarySide: 'buy',
        primaryPrice: 0.45,
        primaryPlatform: PlatformId.KALSHI,
        secondaryConnector: polymarketConnector,
        secondaryContractId: 'pm-contract-1',
        secondarySide: 'sell',
        secondaryPrice: 0.55,
        secondaryPlatform: PlatformId.POLYMARKET,
        idealCount: 100,
      });

      // 60 >= 50, so passes
      expect(result.passed).toBe(true);
      expect(result.minDepthRequired).toBe(50);
    });

    it('should log warning on depth gate rejection', async () => {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      const warnSpy = vi.spyOn((service as any).logger as Logger, 'warn');

      kalshiConnector.getOrderBook.mockResolvedValue(
        makeKalshiOrderBook({ asks: [{ price: 0.45, quantity: 5 }] }),
      );
      polymarketConnector.getOrderBook.mockResolvedValue(
        makePolymarketOrderBook({ bids: [{ price: 0.55, quantity: 200 }] }),
      );

      await service.validateDualLegDepth({
        primaryConnector: kalshiConnector,
        primaryContractId: 'kalshi-contract-1',
        primarySide: 'buy',
        primaryPrice: 0.45,
        primaryPlatform: PlatformId.KALSHI,
        secondaryConnector: polymarketConnector,
        secondaryContractId: 'pm-contract-1',
        secondarySide: 'sell',
        secondaryPrice: 0.55,
        secondaryPlatform: PlatformId.POLYMARKET,
        idealCount: 100,
      });

      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'Dual-leg depth gate rejected opportunity',
          module: 'execution',
        }),
      );
    });
  });

  // ════════════════════════════════════════════════════════════════
  // reloadConfig
  // ════════════════════════════════════════════════════════════════

  describe('reloadConfig', () => {
    it('should update dualLegMinDepthRatio', async () => {
      service.reloadConfig({ dualLegMinDepthRatio: '0.3' });

      // idealCount=100, ratio=0.3, minDepthRequired=30
      kalshiConnector.getOrderBook.mockResolvedValue(
        makeKalshiOrderBook({ asks: [{ price: 0.45, quantity: 40 }] }),
      );
      polymarketConnector.getOrderBook.mockResolvedValue(
        makePolymarketOrderBook({ bids: [{ price: 0.55, quantity: 40 }] }),
      );

      const result = await service.validateDualLegDepth({
        primaryConnector: kalshiConnector,
        primaryContractId: 'kalshi-contract-1',
        primarySide: 'buy',
        primaryPrice: 0.45,
        primaryPlatform: PlatformId.KALSHI,
        secondaryConnector: polymarketConnector,
        secondaryContractId: 'pm-contract-1',
        secondarySide: 'sell',
        secondaryPrice: 0.55,
        secondaryPlatform: PlatformId.POLYMARKET,
        idealCount: 100,
      });

      // 40 >= 30, passes with ratio=0.3
      expect(result.passed).toBe(true);
      expect(result.minDepthRequired).toBe(30);
    });

    it('should ignore invalid dualLegMinDepthRatio values', async () => {
      service.reloadConfig({ dualLegMinDepthRatio: '0' });

      // Should still use original 1.0
      kalshiConnector.getOrderBook.mockResolvedValue(
        makeKalshiOrderBook({ asks: [{ price: 0.45, quantity: 50 }] }),
      );
      polymarketConnector.getOrderBook.mockResolvedValue(
        makePolymarketOrderBook({ bids: [{ price: 0.55, quantity: 50 }] }),
      );

      const result = await service.validateDualLegDepth({
        primaryConnector: kalshiConnector,
        primaryContractId: 'kalshi-contract-1',
        primarySide: 'buy',
        primaryPrice: 0.45,
        primaryPlatform: PlatformId.KALSHI,
        secondaryConnector: polymarketConnector,
        secondaryContractId: 'pm-contract-1',
        secondarySide: 'sell',
        secondaryPrice: 0.55,
        secondaryPlatform: PlatformId.POLYMARKET,
        idealCount: 100,
      });

      // 50 < 100 (ratio=1.0 unchanged), fails
      expect(result.passed).toBe(false);
      expect(result.minDepthRequired).toBe(100);
    });

    it('should ignore NaN dualLegMinDepthRatio', () => {
      service.reloadConfig({ dualLegMinDepthRatio: 'invalid' });
      // No throw — silently ignored. Verify via log:
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      const logSpy = vi.spyOn((service as any).logger as Logger, 'log');
      service.reloadConfig({ dualLegMinDepthRatio: 'abc' });
      expect(logSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'DepthAnalysis config reloaded',
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          data: expect.objectContaining({
            dualLegMinDepthRatio: 1.0,
          }),
        }),
      );
    });
  });

  // ════════════════════════════════════════════════════════════════
  // getDivergenceStatus
  // ════════════════════════════════════════════════════════════════

  describe('getDivergenceStatus', () => {
    it('should return no divergence when both platforms normal', () => {
      dataDivergenceService.getDivergenceStatus.mockReturnValue('normal');

      const result = service.getDivergenceStatus();

      expect(result.divergenceDetected).toBe(false);
      expect(result.kalshi).toBe('normal');
      expect(result.polymarket).toBe('normal');
    });

    it('should detect divergence when kalshi is divergent', () => {
      dataDivergenceService.getDivergenceStatus
        .mockReturnValueOnce('divergent')
        .mockReturnValueOnce('normal');

      const result = service.getDivergenceStatus();

      expect(result.divergenceDetected).toBe(true);
      expect(result.kalshi).toBe('divergent');
    });

    it('should detect divergence when polymarket is divergent', () => {
      dataDivergenceService.getDivergenceStatus
        .mockReturnValueOnce('normal')
        .mockReturnValueOnce('divergent');

      const result = service.getDivergenceStatus();

      expect(result.divergenceDetected).toBe(true);
      expect(result.polymarket).toBe('divergent');
    });

    it('should detect divergence when both platforms divergent', () => {
      dataDivergenceService.getDivergenceStatus.mockReturnValue('divergent');

      const result = service.getDivergenceStatus();

      expect(result.divergenceDetected).toBe(true);
    });

    it('should call DataDivergenceService with correct platform IDs', () => {
      service.getDivergenceStatus();

      expect(dataDivergenceService.getDivergenceStatus).toHaveBeenCalledWith(
        PlatformId.KALSHI,
      );
      expect(dataDivergenceService.getDivergenceStatus).toHaveBeenCalledWith(
        PlatformId.POLYMARKET,
      );
    });
  });
});
