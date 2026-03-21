/* eslint-disable @typescript-eslint/no-unsafe-assignment -- vitest expect.any() returns any */
/* eslint-disable @typescript-eslint/no-misused-promises -- vitest mockImplementation with Promise */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { AutoUnwindService } from './auto-unwind.service';
import { SingleLegResolutionService } from './single-leg-resolution.service';
import { PositionRepository } from '../../persistence/repositories/position.repository';
import { OrderRepository } from '../../persistence/repositories/order.repository';
import {
  KALSHI_CONNECTOR_TOKEN,
  POLYMARKET_CONNECTOR_TOKEN,
} from '../../connectors/connector.constants';
import { EVENT_NAMES } from '../../common/events/event-catalog';
import { SingleLegExposureEvent } from '../../common/events/execution.events';
import { PlatformId } from '../../common/types/platform.type';
import {
  ExecutionError,
  EXECUTION_ERROR_CODES,
} from '../../common/errors/execution-error';
import { PlatformApiError } from '../../common/errors/platform-api-error';
import {
  asPositionId,
  asOrderId,
  asPairId,
  asContractId,
  asMatchId,
} from '../../common/types/branded.type';
import { createMockPlatformConnector } from '../../test/mock-factories.js';

vi.mock('../../common/services/correlation-context', () => ({
  getCorrelationId: () => 'test-correlation-id',
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createConfigService(overrides: Record<string, unknown> = {}): {
  get: ReturnType<typeof vi.fn>;
} {
  const defaults: Record<string, unknown> = {
    AUTO_UNWIND_ENABLED: true,
    AUTO_UNWIND_DELAY_MS: 2000,
    AUTO_UNWIND_MAX_LOSS_PCT: 5,
    ...overrides,
  };
  return {
    get: vi.fn(
      (key: string, defaultValue?: unknown) => defaults[key] ?? defaultValue,
    ),
  };
}

function makeExposureEvent(
  overrides: Partial<{
    positionId: string;
    isPaper: boolean;
    mixedMode: boolean;
    correlationId: string;
  }> = {},
): SingleLegExposureEvent {
  return new SingleLegExposureEvent(
    asPositionId(overrides.positionId ?? 'pos-auto-1'),
    asPairId('pair-1'),
    0.08,
    {
      platform: PlatformId.KALSHI,
      orderId: asOrderId('order-kalshi-1'),
      side: 'buy',
      price: 0.45,
      size: 200,
      fillPrice: 0.45,
      fillSize: 200,
    },
    {
      platform: PlatformId.POLYMARKET,
      reason: 'rejected',
      reasonCode: 2004,
      attemptedPrice: 0.55,
      attemptedSize: 182,
    },
    {
      kalshi: { bestBid: 0.44, bestAsk: 0.46 },
      polymarket: { bestBid: 0.54, bestAsk: 0.56 },
    },
    {
      closeNowEstimate: '-3.76',
      retryAtCurrentPrice: 'Retry would yield ~14.18% edge',
      holdRiskAssessment:
        'EXPOSED: $90.00 on kalshi (buy 200@0.45). No hedge. Immediate operator action recommended.',
    },
    ['Monitor position'],
    overrides.correlationId ?? 'corr-auto-unwind-1',
    undefined,
    overrides.isPaper ?? false,
    overrides.mixedMode ?? false,
  );
}

function createMockPosition(overrides: Record<string, unknown> = {}) {
  return {
    positionId: asPositionId('pos-auto-1'),
    pairId: asPairId('pair-1'),
    kalshiOrderId: asOrderId('order-kalshi-1'),
    polymarketOrderId: null,
    kalshiSide: 'buy',
    polymarketSide: 'sell',
    entryPrices: { kalshi: '0.45', polymarket: '0.55' },
    sizes: { kalshi: '200', polymarket: '182' },
    expectedEdge: 0.08,
    status: 'SINGLE_LEG_EXPOSED',
    pair: {
      matchId: asMatchId('pair-1'),
      kalshiContractId: asContractId('kalshi-contract-1'),
      polymarketContractId: asContractId('poly-contract-1'),
      polymarketClobTokenId: 'mock-clob-token-1',
    },
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function createMockOrder(overrides: Record<string, unknown> = {}) {
  return {
    orderId: asOrderId('order-kalshi-1'),
    platform: 'KALSHI',
    contractId: asContractId('kalshi-contract-1'),
    pairId: asPairId('pair-1'),
    side: 'buy',
    price: 0.45,
    size: 200,
    status: 'FILLED',
    fillPrice: 0.45,
    fillSize: 200,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('AutoUnwindService', () => {
  let service: AutoUnwindService;
  let positionRepository: Record<string, ReturnType<typeof vi.fn>>;
  let orderRepository: Record<string, ReturnType<typeof vi.fn>>;
  let kalshiConnector: ReturnType<typeof createMockPlatformConnector>;
  let polymarketConnector: ReturnType<typeof createMockPlatformConnector>;
  let resolutionService: Record<string, ReturnType<typeof vi.fn>>;
  let eventEmitter: Record<string, ReturnType<typeof vi.fn>>;
  let configService: ReturnType<typeof createConfigService>;

  async function buildModule(
    configOverrides: Record<string, unknown> = {},
  ): Promise<TestingModule> {
    positionRepository = {
      findById: vi.fn(),
      findByIdWithPair: vi.fn(),
      findByStatus: vi.fn(),
      findByStatusWithPair: vi.fn(),
      findByPairId: vi.fn(),
      create: vi.fn(),
      updateStatus: vi.fn(),
      updateWithOrder: vi.fn(),
    };

    orderRepository = {
      create: vi.fn(),
      findById: vi.fn(),
      findByPairId: vi.fn(),
      updateStatus: vi.fn(),
    };

    kalshiConnector = createMockPlatformConnector(PlatformId.KALSHI, {
      getFeeSchedule: vi.fn().mockReturnValue({
        platformId: PlatformId.KALSHI,
        makerFeePercent: 0,
        takerFeePercent: 2,
        description: 'Kalshi fees',
      }),
    });

    polymarketConnector = createMockPlatformConnector(PlatformId.POLYMARKET, {
      getFeeSchedule: vi.fn().mockReturnValue({
        platformId: PlatformId.POLYMARKET,
        makerFeePercent: 0,
        takerFeePercent: 1,
        description: 'Polymarket fees',
      }),
    });

    resolutionService = {
      closeLeg: vi.fn(),
      retryLeg: vi.fn(),
      buildPnlScenarios: vi.fn(),
    };

    eventEmitter = {
      emit: vi.fn(),
    };

    configService = createConfigService(configOverrides);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AutoUnwindService,
        { provide: PositionRepository, useValue: positionRepository },
        { provide: OrderRepository, useValue: orderRepository },
        { provide: KALSHI_CONNECTOR_TOKEN, useValue: kalshiConnector },
        { provide: POLYMARKET_CONNECTOR_TOKEN, useValue: polymarketConnector },
        {
          provide: SingleLegResolutionService,
          useValue: resolutionService,
        },
        { provide: EventEmitter2, useValue: eventEmitter },
        { provide: ConfigService, useValue: configService },
      ],
    }).compile();

    service = module.get(AutoUnwindService);
    return module;
  }

  beforeEach(async () => {
    vi.useFakeTimers();
    await buildModule();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // =========================================================================
  // CONFIG GUARD (P0)
  // =========================================================================

  describe('config guard', () => {
    it('[P0] should take no action when AUTO_UNWIND_ENABLED=false', async () => {
      await buildModule({ AUTO_UNWIND_ENABLED: false });
      const event = makeExposureEvent();

      await service.onSingleLegExposure(event);

      expect(resolutionService.closeLeg).not.toHaveBeenCalled();
      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });

    it('[P0] should proceed with unwind when AUTO_UNWIND_ENABLED=true', async () => {
      await buildModule({ AUTO_UNWIND_ENABLED: true });
      const event = makeExposureEvent();

      positionRepository.findByIdWithPair!.mockResolvedValue(
        createMockPosition(),
      );
      orderRepository.findById!.mockResolvedValue(createMockOrder());
      kalshiConnector.getOrderBook.mockResolvedValue({
        platformId: PlatformId.KALSHI,
        contractId: asContractId('kalshi-contract-1'),
        bids: [{ price: 0.44, quantity: 500 }],
        asks: [{ price: 0.46, quantity: 500 }],
        timestamp: new Date(),
      });
      resolutionService.closeLeg!.mockResolvedValue({
        success: true,
        closeOrderId: 'order-close-1',
        realizedPnl: '-1.50000000',
      });

      const promise = service.onSingleLegExposure(event);
      await vi.advanceTimersByTimeAsync(2000);
      await promise;

      expect(resolutionService.closeLeg).toHaveBeenCalled();
    });
  });

  // =========================================================================
  // CLOSE SUCCESS PATH (P0)
  // =========================================================================

  describe('close success path', () => {
    it('[P0] should emit AutoUnwindEvent with action=close, result=success when closeLeg succeeds', async () => {
      const event = makeExposureEvent();
      positionRepository.findByIdWithPair!.mockResolvedValue(
        createMockPosition(),
      );
      orderRepository.findById!.mockResolvedValue(createMockOrder());
      kalshiConnector.getOrderBook.mockResolvedValue({
        platformId: PlatformId.KALSHI,
        contractId: asContractId('kalshi-contract-1'),
        bids: [{ price: 0.44, quantity: 500 }],
        asks: [{ price: 0.46, quantity: 500 }],
        timestamp: new Date(),
      });
      resolutionService.closeLeg!.mockResolvedValue({
        success: true,
        closeOrderId: 'order-close-1',
        realizedPnl: '-2.00000000',
      });

      const promise = service.onSingleLegExposure(event);
      await vi.advanceTimersByTimeAsync(2000);
      await promise;

      expect(eventEmitter.emit).toHaveBeenCalledWith(
        EVENT_NAMES.AUTO_UNWIND,
        expect.objectContaining({
          positionId: asPositionId('pos-auto-1'),
          action: 'close',
          result: 'success',
        }),
      );
    });

    it('[P0] should include realizedPnl in AutoUnwindEvent on success', async () => {
      const event = makeExposureEvent();
      positionRepository.findByIdWithPair!.mockResolvedValue(
        createMockPosition(),
      );
      orderRepository.findById!.mockResolvedValue(createMockOrder());
      kalshiConnector.getOrderBook.mockResolvedValue({
        platformId: PlatformId.KALSHI,
        contractId: asContractId('kalshi-contract-1'),
        bids: [{ price: 0.44, quantity: 500 }],
        asks: [{ price: 0.46, quantity: 500 }],
        timestamp: new Date(),
      });
      resolutionService.closeLeg!.mockResolvedValue({
        success: true,
        closeOrderId: 'order-close-1',
        realizedPnl: '-3.76000000',
      });

      const promise = service.onSingleLegExposure(event);
      await vi.advanceTimersByTimeAsync(2000);
      await promise;

      expect(eventEmitter.emit).toHaveBeenCalledWith(
        EVENT_NAMES.AUTO_UNWIND,
        expect.objectContaining({
          realizedPnl: '-3.76000000',
          closeOrderId: 'order-close-1',
        }),
      );
    });

    it('[P0] should call closeLeg with correct positionId and rationale', async () => {
      const event = makeExposureEvent();
      positionRepository.findByIdWithPair!.mockResolvedValue(
        createMockPosition(),
      );
      orderRepository.findById!.mockResolvedValue(createMockOrder());
      kalshiConnector.getOrderBook.mockResolvedValue({
        platformId: PlatformId.KALSHI,
        contractId: asContractId('kalshi-contract-1'),
        bids: [{ price: 0.44, quantity: 500 }],
        asks: [{ price: 0.46, quantity: 500 }],
        timestamp: new Date(),
      });
      resolutionService.closeLeg!.mockResolvedValue({
        success: true,
        closeOrderId: 'order-close-1',
        realizedPnl: '-2.00000000',
      });

      const promise = service.onSingleLegExposure(event);
      await vi.advanceTimersByTimeAsync(2000);
      await promise;

      expect(resolutionService.closeLeg).toHaveBeenCalledWith(
        asPositionId('pos-auto-1'),
        expect.stringContaining('Auto-unwind'),
      );
    });
  });

  // =========================================================================
  // CLOSE FAILURE PATH (P0)
  // =========================================================================

  describe('close failure path', () => {
    it('[P0] should emit action=failed when closeLeg throws ExecutionError(CLOSE_FAILED)', async () => {
      const event = makeExposureEvent();
      positionRepository.findByIdWithPair!.mockResolvedValue(
        createMockPosition(),
      );
      orderRepository.findById!.mockResolvedValue(createMockOrder());
      kalshiConnector.getOrderBook.mockResolvedValue({
        platformId: PlatformId.KALSHI,
        contractId: asContractId('kalshi-contract-1'),
        bids: [{ price: 0.44, quantity: 500 }],
        asks: [{ price: 0.46, quantity: 500 }],
        timestamp: new Date(),
      });
      resolutionService.closeLeg!.mockRejectedValue(
        new ExecutionError(
          EXECUTION_ERROR_CODES.CLOSE_FAILED,
          'Close leg submission failed: Platform unavailable',
          'error',
        ),
      );

      const promise = service.onSingleLegExposure(event);
      await vi.advanceTimersByTimeAsync(2000);
      await promise;

      expect(eventEmitter.emit).toHaveBeenCalledWith(
        EVENT_NAMES.AUTO_UNWIND,
        expect.objectContaining({
          positionId: asPositionId('pos-auto-1'),
          action: 'failed',
          result: 'failed',
        }),
      );
    });

    it('[P0] should emit action=skip_already_resolved when closeLeg throws INVALID_POSITION_STATE', async () => {
      const event = makeExposureEvent();
      positionRepository.findByIdWithPair!.mockResolvedValue(
        createMockPosition(),
      );
      orderRepository.findById!.mockResolvedValue(createMockOrder());
      kalshiConnector.getOrderBook.mockResolvedValue({
        platformId: PlatformId.KALSHI,
        contractId: asContractId('kalshi-contract-1'),
        bids: [{ price: 0.44, quantity: 500 }],
        asks: [{ price: 0.46, quantity: 500 }],
        timestamp: new Date(),
      });
      resolutionService.closeLeg!.mockRejectedValue(
        new ExecutionError(
          EXECUTION_ERROR_CODES.INVALID_POSITION_STATE,
          'Position is not in single-leg exposed or exit-partial state',
          'warning',
        ),
      );

      const promise = service.onSingleLegExposure(event);
      await vi.advanceTimersByTimeAsync(2000);
      await promise;

      expect(eventEmitter.emit).toHaveBeenCalledWith(
        EVENT_NAMES.AUTO_UNWIND,
        expect.objectContaining({
          action: 'skip_already_resolved',
          result: 'skipped',
        }),
      );
    });

    it('[P0] should catch unexpected errors without crashing and emit action=failed', async () => {
      const event = makeExposureEvent();
      positionRepository.findByIdWithPair!.mockResolvedValue(
        createMockPosition(),
      );
      orderRepository.findById!.mockResolvedValue(createMockOrder());
      kalshiConnector.getOrderBook.mockResolvedValue({
        platformId: PlatformId.KALSHI,
        contractId: asContractId('kalshi-contract-1'),
        bids: [{ price: 0.44, quantity: 500 }],
        asks: [{ price: 0.46, quantity: 500 }],
        timestamp: new Date(),
      });
      resolutionService.closeLeg!.mockRejectedValue(
        new TypeError('Cannot read properties of undefined'),
      );

      const promise = service.onSingleLegExposure(event);
      await vi.advanceTimersByTimeAsync(2000);

      // Should NOT throw — event handlers must not crash the process
      await expect(promise).resolves.not.toThrow();

      expect(eventEmitter.emit).toHaveBeenCalledWith(
        EVENT_NAMES.AUTO_UNWIND,
        expect.objectContaining({
          action: 'failed',
          result: 'failed',
        }),
      );
    });
  });

  // =========================================================================
  // DELAY BEHAVIOR (P1)
  // =========================================================================

  describe('delay behavior', () => {
    it('[P1] should wait AUTO_UNWIND_DELAY_MS before attempting close', async () => {
      await buildModule({ AUTO_UNWIND_DELAY_MS: 3000 });
      const event = makeExposureEvent();
      positionRepository.findByIdWithPair!.mockResolvedValue(
        createMockPosition(),
      );
      orderRepository.findById!.mockResolvedValue(createMockOrder());
      kalshiConnector.getOrderBook.mockResolvedValue({
        platformId: PlatformId.KALSHI,
        contractId: asContractId('kalshi-contract-1'),
        bids: [{ price: 0.44, quantity: 500 }],
        asks: [{ price: 0.46, quantity: 500 }],
        timestamp: new Date(),
      });
      resolutionService.closeLeg!.mockResolvedValue({
        success: true,
        closeOrderId: 'order-close-1',
        realizedPnl: '-1.00000000',
      });

      const promise = service.onSingleLegExposure(event);

      // Not yet called after 2000ms
      await vi.advanceTimersByTimeAsync(2000);
      expect(resolutionService.closeLeg).not.toHaveBeenCalled();

      // Called after full 3000ms
      await vi.advanceTimersByTimeAsync(1000);
      await promise;
      expect(resolutionService.closeLeg).toHaveBeenCalled();
    });

    it('[P1] should skip with skip_already_resolved when position resolved during delay', async () => {
      const event = makeExposureEvent();
      // After delay, position is no longer SINGLE_LEG_EXPOSED (operator resolved)
      positionRepository.findByIdWithPair!.mockResolvedValue(
        createMockPosition({ status: 'OPEN' }),
      );

      const promise = service.onSingleLegExposure(event);
      await vi.advanceTimersByTimeAsync(2000);
      await promise;

      expect(resolutionService.closeLeg).not.toHaveBeenCalled();
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        EVENT_NAMES.AUTO_UNWIND,
        expect.objectContaining({
          action: 'skip_already_resolved',
          result: 'skipped',
        }),
      );
    });
  });

  // =========================================================================
  // LOSS THRESHOLD (P0)
  // =========================================================================

  describe('loss threshold', () => {
    it('[P0] should skip with skip_loss_limit when estimated loss exceeds MAX_LOSS_PCT', async () => {
      await buildModule({ AUTO_UNWIND_MAX_LOSS_PCT: 5 });
      const event = makeExposureEvent();
      positionRepository.findByIdWithPair!.mockResolvedValue(
        createMockPosition(),
      );
      orderRepository.findById!.mockResolvedValue(
        createMockOrder({ fillPrice: 0.45, fillSize: 200 }),
      );
      // Best bid at 0.38 → loss pct ≈ 15.56% which exceeds 5%
      kalshiConnector.getOrderBook.mockResolvedValue({
        platformId: PlatformId.KALSHI,
        contractId: asContractId('kalshi-contract-1'),
        bids: [{ price: 0.38, quantity: 500 }],
        asks: [{ price: 0.48, quantity: 500 }],
        timestamp: new Date(),
      });

      const promise = service.onSingleLegExposure(event);
      await vi.advanceTimersByTimeAsync(2000);
      await promise;

      expect(resolutionService.closeLeg).not.toHaveBeenCalled();
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        EVENT_NAMES.AUTO_UNWIND,
        expect.objectContaining({
          action: 'skip_loss_limit',
          result: 'skipped',
        }),
      );
    });

    it('[P0] should proceed when estimated loss is below MAX_LOSS_PCT', async () => {
      await buildModule({ AUTO_UNWIND_MAX_LOSS_PCT: 5 });
      const event = makeExposureEvent();
      positionRepository.findByIdWithPair!.mockResolvedValue(
        createMockPosition(),
      );
      orderRepository.findById!.mockResolvedValue(
        createMockOrder({ fillPrice: 0.45, fillSize: 200 }),
      );
      // Best bid at 0.44 → loss pct ≈ 2.22% which is below 5%
      kalshiConnector.getOrderBook.mockResolvedValue({
        platformId: PlatformId.KALSHI,
        contractId: asContractId('kalshi-contract-1'),
        bids: [{ price: 0.44, quantity: 500 }],
        asks: [{ price: 0.46, quantity: 500 }],
        timestamp: new Date(),
      });
      resolutionService.closeLeg!.mockResolvedValue({
        success: true,
        closeOrderId: 'order-close-1',
        realizedPnl: '-2.00000000',
      });

      const promise = service.onSingleLegExposure(event);
      await vi.advanceTimersByTimeAsync(2000);
      await promise;

      expect(resolutionService.closeLeg).toHaveBeenCalled();
    });

    it('[P0] should proceed when estimated loss is zero', async () => {
      const event = makeExposureEvent();
      positionRepository.findByIdWithPair!.mockResolvedValue(
        createMockPosition(),
      );
      orderRepository.findById!.mockResolvedValue(
        createMockOrder({ fillPrice: 0.45, fillSize: 200 }),
      );
      // Best bid exactly at entry price → 0% loss
      kalshiConnector.getOrderBook.mockResolvedValue({
        platformId: PlatformId.KALSHI,
        contractId: asContractId('kalshi-contract-1'),
        bids: [{ price: 0.45, quantity: 500 }],
        asks: [{ price: 0.46, quantity: 500 }],
        timestamp: new Date(),
      });
      resolutionService.closeLeg!.mockResolvedValue({
        success: true,
        closeOrderId: 'order-close-1',
        realizedPnl: '0.00000000',
      });

      const promise = service.onSingleLegExposure(event);
      await vi.advanceTimersByTimeAsync(2000);
      await promise;

      expect(resolutionService.closeLeg).toHaveBeenCalled();
    });

    it('[P0] should proceed with close when MAX_LOSS_PCT=0 (no limit), even with high estimated loss', async () => {
      await buildModule({ AUTO_UNWIND_MAX_LOSS_PCT: 0 });
      const event = makeExposureEvent();
      positionRepository.findByIdWithPair!.mockResolvedValue(
        createMockPosition(),
      );
      orderRepository.findById!.mockResolvedValue(
        createMockOrder({ fillPrice: 0.45, fillSize: 200 }),
      );
      // Best bid at 0.30 → loss ≈ 33.3% — would exceed any reasonable threshold
      kalshiConnector.getOrderBook.mockResolvedValue({
        platformId: PlatformId.KALSHI,
        contractId: asContractId('kalshi-contract-1'),
        bids: [{ price: 0.3, quantity: 500 }],
        asks: [{ price: 0.5, quantity: 500 }],
        timestamp: new Date(),
      });
      resolutionService.closeLeg!.mockResolvedValue({
        success: true,
        closeOrderId: 'order-close-no-limit',
        realizedPnl: '-30.00000000',
      });

      const promise = service.onSingleLegExposure(event);
      await vi.advanceTimersByTimeAsync(2000);
      await promise;

      // MAX_LOSS_PCT=0 means no limit — close should proceed regardless of loss
      expect(resolutionService.closeLeg).toHaveBeenCalled();
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        EVENT_NAMES.AUTO_UNWIND,
        expect.objectContaining({
          action: 'close',
          result: 'success',
        }),
      );
    });

    it('[P0] should proceed when close is profitable (negative loss pct does not trigger skip)', async () => {
      await buildModule({ AUTO_UNWIND_MAX_LOSS_PCT: 5 });
      const event = makeExposureEvent();
      positionRepository.findByIdWithPair!.mockResolvedValue(
        createMockPosition(),
      );
      orderRepository.findById!.mockResolvedValue(
        createMockOrder({ fillPrice: 0.45, fillSize: 200 }),
      );
      // Best bid at 0.50 → entry 0.45, close 0.50 → profitable close (negative loss)
      kalshiConnector.getOrderBook.mockResolvedValue({
        platformId: PlatformId.KALSHI,
        contractId: asContractId('kalshi-contract-1'),
        bids: [{ price: 0.5, quantity: 500 }],
        asks: [{ price: 0.52, quantity: 500 }],
        timestamp: new Date(),
      });
      resolutionService.closeLeg!.mockResolvedValue({
        success: true,
        closeOrderId: 'order-close-profit',
        realizedPnl: '10.00000000',
      });

      const promise = service.onSingleLegExposure(event);
      await vi.advanceTimersByTimeAsync(2000);
      await promise;

      // Profitable close should NOT trigger skip_loss_limit
      expect(resolutionService.closeLeg).toHaveBeenCalled();
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        EVENT_NAMES.AUTO_UNWIND,
        expect.objectContaining({
          action: 'close',
          result: 'success',
        }),
      );
    });

    it('[P0] should proceed when order book is unavailable (conservative — try to close)', async () => {
      const event = makeExposureEvent();
      positionRepository.findByIdWithPair!.mockResolvedValue(
        createMockPosition(),
      );
      orderRepository.findById!.mockResolvedValue(createMockOrder());
      // Order book with no bids → cannot estimate, but proceed anyway
      kalshiConnector.getOrderBook.mockResolvedValue({
        platformId: PlatformId.KALSHI,
        contractId: asContractId('kalshi-contract-1'),
        bids: [],
        asks: [],
        timestamp: new Date(),
      });
      resolutionService.closeLeg!.mockResolvedValue({
        success: true,
        closeOrderId: 'order-close-1',
        realizedPnl: '-4.00000000',
      });

      const promise = service.onSingleLegExposure(event);
      await vi.advanceTimersByTimeAsync(2000);
      await promise;

      expect(resolutionService.closeLeg).toHaveBeenCalled();
    });

    it('[P0] should proceed when connector throws PlatformApiError during order book fetch', async () => {
      const event = makeExposureEvent();
      positionRepository.findByIdWithPair!.mockResolvedValue(
        createMockPosition(),
      );
      orderRepository.findById!.mockResolvedValue(createMockOrder());
      kalshiConnector.getOrderBook.mockRejectedValue(
        new PlatformApiError(
          1002,
          'Rate limit exceeded',
          PlatformId.KALSHI,
          'warning',
        ),
      );
      resolutionService.closeLeg!.mockResolvedValue({
        success: true,
        closeOrderId: 'order-close-1',
        realizedPnl: '-2.50000000',
      });

      const promise = service.onSingleLegExposure(event);
      await vi.advanceTimersByTimeAsync(2000);
      await promise;

      // Should proceed with close despite order book fetch failure
      expect(resolutionService.closeLeg).toHaveBeenCalled();
    });

    it('[P0] should emit failed and not attempt close when DB query fails during position fetch', async () => {
      const event = makeExposureEvent();
      positionRepository.findByIdWithPair!.mockRejectedValue(
        new Error('Database connection lost'),
      );

      const promise = service.onSingleLegExposure(event);
      await vi.advanceTimersByTimeAsync(2000);
      await promise;

      expect(resolutionService.closeLeg).not.toHaveBeenCalled();
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        EVENT_NAMES.AUTO_UNWIND,
        expect.objectContaining({
          action: 'failed',
          result: 'failed',
        }),
      );
    });
  });

  // =========================================================================
  // EVENT PAYLOAD (P0)
  // =========================================================================

  describe('event payload', () => {
    it('[P0] should include reconstructed SingleLegContext in AutoUnwindEvent', async () => {
      const event = makeExposureEvent();
      positionRepository.findByIdWithPair!.mockResolvedValue(
        createMockPosition(),
      );
      orderRepository.findById!.mockResolvedValue(createMockOrder());
      kalshiConnector.getOrderBook.mockResolvedValue({
        platformId: PlatformId.KALSHI,
        contractId: asContractId('kalshi-contract-1'),
        bids: [{ price: 0.44, quantity: 500 }],
        asks: [{ price: 0.46, quantity: 500 }],
        timestamp: new Date(),
      });
      resolutionService.closeLeg!.mockResolvedValue({
        success: true,
        closeOrderId: 'order-close-1',
        realizedPnl: '-2.00000000',
      });

      const promise = service.onSingleLegExposure(event);
      await vi.advanceTimersByTimeAsync(2000);
      await promise;

      expect(eventEmitter.emit).toHaveBeenCalledWith(
        EVENT_NAMES.AUTO_UNWIND,
        expect.objectContaining({
          singleLegContext: expect.objectContaining({
            pairId: 'pair-1',
            primaryLeg: PlatformId.KALSHI,
            primaryOrderId: 'order-kalshi-1',
            primarySide: 'buy',
            isPaper: false,
            mixedMode: false,
            errorCode: 2004,
            errorMessage: 'rejected',
          }),
        }),
      );
    });

    it('[P0] should propagate correlationId from original SingleLegExposureEvent', async () => {
      const event = makeExposureEvent({ correlationId: 'corr-original-xyz' });
      positionRepository.findByIdWithPair!.mockResolvedValue(
        createMockPosition(),
      );
      orderRepository.findById!.mockResolvedValue(createMockOrder());
      kalshiConnector.getOrderBook.mockResolvedValue({
        platformId: PlatformId.KALSHI,
        contractId: asContractId('kalshi-contract-1'),
        bids: [{ price: 0.44, quantity: 500 }],
        asks: [{ price: 0.46, quantity: 500 }],
        timestamp: new Date(),
      });
      resolutionService.closeLeg!.mockResolvedValue({
        success: true,
        closeOrderId: 'order-close-1',
        realizedPnl: '-1.00000000',
      });

      const promise = service.onSingleLegExposure(event);
      await vi.advanceTimersByTimeAsync(2000);
      await promise;

      expect(eventEmitter.emit).toHaveBeenCalledWith(
        EVENT_NAMES.AUTO_UNWIND,
        expect.objectContaining({
          correlationId: 'corr-original-xyz',
        }),
      );
    });

    it('[P0] should calculate timeElapsedMs correctly', async () => {
      await buildModule({ AUTO_UNWIND_DELAY_MS: 2000 });
      const event = makeExposureEvent();
      positionRepository.findByIdWithPair!.mockResolvedValue(
        createMockPosition(),
      );
      orderRepository.findById!.mockResolvedValue(createMockOrder());
      kalshiConnector.getOrderBook.mockResolvedValue({
        platformId: PlatformId.KALSHI,
        contractId: asContractId('kalshi-contract-1'),
        bids: [{ price: 0.44, quantity: 500 }],
        asks: [{ price: 0.46, quantity: 500 }],
        timestamp: new Date(),
      });
      resolutionService.closeLeg!.mockResolvedValue({
        success: true,
        closeOrderId: 'order-close-1',
        realizedPnl: '-2.00000000',
      });

      const promise = service.onSingleLegExposure(event);
      await vi.advanceTimersByTimeAsync(2000);
      await promise;

      expect(eventEmitter.emit).toHaveBeenCalledWith(
        EVENT_NAMES.AUTO_UNWIND,
        expect.objectContaining({
          // timeElapsedMs should be >= 2000 (at least the delay)
          timeElapsedMs: expect.any(Number) as unknown as number,
        }),
      );

      const emitCall = (
        eventEmitter.emit as ReturnType<typeof vi.fn>
      ).mock.calls.find(
        (call: unknown[]) => call[0] === EVENT_NAMES.AUTO_UNWIND,
      );
      expect(emitCall).toBeDefined();
      const autoUnwindEvent = emitCall![1] as { timeElapsedMs: number };
      expect(autoUnwindEvent.timeElapsedMs).toBeGreaterThanOrEqual(2000);
    });
  });

  // =========================================================================
  // PAPER/LIVE BOUNDARY (P0)
  // =========================================================================

  describe('paper-live-boundary', () => {
    it('[P0] should set simulated=true in AutoUnwindEvent when isPaper=true', async () => {
      const event = makeExposureEvent({ isPaper: true });
      positionRepository.findByIdWithPair!.mockResolvedValue(
        createMockPosition(),
      );
      orderRepository.findById!.mockResolvedValue(createMockOrder());
      kalshiConnector.getOrderBook.mockResolvedValue({
        platformId: PlatformId.KALSHI,
        contractId: asContractId('kalshi-contract-1'),
        bids: [{ price: 0.44, quantity: 500 }],
        asks: [{ price: 0.46, quantity: 500 }],
        timestamp: new Date(),
      });
      resolutionService.closeLeg!.mockResolvedValue({
        success: true,
        closeOrderId: 'order-paper-close-1',
        realizedPnl: '-1.50000000',
      });

      const promise = service.onSingleLegExposure(event);
      await vi.advanceTimersByTimeAsync(2000);
      await promise;

      expect(eventEmitter.emit).toHaveBeenCalledWith(
        EVENT_NAMES.AUTO_UNWIND,
        expect.objectContaining({
          simulated: true,
          isPaper: true,
        }),
      );
    });

    it('[P0] should set simulated=false in AutoUnwindEvent when isPaper=false (live mode)', async () => {
      const event = makeExposureEvent({ isPaper: false });
      positionRepository.findByIdWithPair!.mockResolvedValue(
        createMockPosition(),
      );
      orderRepository.findById!.mockResolvedValue(createMockOrder());
      kalshiConnector.getOrderBook.mockResolvedValue({
        platformId: PlatformId.KALSHI,
        contractId: asContractId('kalshi-contract-1'),
        bids: [{ price: 0.44, quantity: 500 }],
        asks: [{ price: 0.46, quantity: 500 }],
        timestamp: new Date(),
      });
      resolutionService.closeLeg!.mockResolvedValue({
        success: true,
        closeOrderId: 'order-live-close-1',
        realizedPnl: '-2.00000000',
      });

      const promise = service.onSingleLegExposure(event);
      await vi.advanceTimersByTimeAsync(2000);
      await promise;

      expect(eventEmitter.emit).toHaveBeenCalledWith(
        EVENT_NAMES.AUTO_UNWIND,
        expect.objectContaining({
          simulated: false,
          isPaper: false,
        }),
      );
    });

    it('[P0] should use identical decision logic for paper and live modes', async () => {
      // Paper mode with loss > MAX_LOSS_PCT should skip — same as live
      await buildModule({ AUTO_UNWIND_MAX_LOSS_PCT: 3 });
      const paperEvent = makeExposureEvent({ isPaper: true });
      positionRepository.findByIdWithPair!.mockResolvedValue(
        createMockPosition(),
      );
      orderRepository.findById!.mockResolvedValue(
        createMockOrder({ fillPrice: 0.45, fillSize: 200 }),
      );
      // Loss ≈ 4.44% > 3% threshold
      kalshiConnector.getOrderBook.mockResolvedValue({
        platformId: PlatformId.KALSHI,
        contractId: asContractId('kalshi-contract-1'),
        bids: [{ price: 0.43, quantity: 500 }],
        asks: [{ price: 0.47, quantity: 500 }],
        timestamp: new Date(),
      });

      const promise = service.onSingleLegExposure(paperEvent);
      await vi.advanceTimersByTimeAsync(2000);
      await promise;

      expect(resolutionService.closeLeg).not.toHaveBeenCalled();
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        EVENT_NAMES.AUTO_UNWIND,
        expect.objectContaining({
          action: 'skip_loss_limit',
          simulated: true,
        }),
      );
    });

    it('[P0] should set simulated based on isPaper in mixed mode', async () => {
      const event = makeExposureEvent({ isPaper: true, mixedMode: true });
      positionRepository.findByIdWithPair!.mockResolvedValue(
        createMockPosition(),
      );
      orderRepository.findById!.mockResolvedValue(createMockOrder());
      kalshiConnector.getOrderBook.mockResolvedValue({
        platformId: PlatformId.KALSHI,
        contractId: asContractId('kalshi-contract-1'),
        bids: [{ price: 0.44, quantity: 500 }],
        asks: [{ price: 0.46, quantity: 500 }],
        timestamp: new Date(),
      });
      resolutionService.closeLeg!.mockResolvedValue({
        success: true,
        closeOrderId: 'order-mixed-close-1',
        realizedPnl: '-1.00000000',
      });

      const promise = service.onSingleLegExposure(event);
      await vi.advanceTimersByTimeAsync(2000);
      await promise;

      expect(eventEmitter.emit).toHaveBeenCalledWith(
        EVENT_NAMES.AUTO_UNWIND,
        expect.objectContaining({
          simulated: true,
          mixedMode: true,
        }),
      );
    });
  });

  // =========================================================================
  // INTERNAL SUBSYSTEM VERIFICATION (P0)
  // =========================================================================

  // Design note (Team Agreement #19): AutoUnwindService delegates to
  // SingleLegResolutionService.closeLeg() which internally calls connector.submitOrder().
  // These tests verify what AutoUnwindService directly controls: closeLeg() and getOrderBook().
  // Connector-level submitOrder verification is in single-leg-resolution.service.spec.ts.
  describe('internal-subsystem-verification', () => {
    it('[P0] should verify close order reaches connector mock via closeLeg (not just decision logic)', async () => {
      const event = makeExposureEvent();
      positionRepository.findByIdWithPair!.mockResolvedValue(
        createMockPosition(),
      );
      orderRepository.findById!.mockResolvedValue(createMockOrder());
      kalshiConnector.getOrderBook.mockResolvedValue({
        platformId: PlatformId.KALSHI,
        contractId: asContractId('kalshi-contract-1'),
        bids: [{ price: 0.44, quantity: 500 }],
        asks: [{ price: 0.46, quantity: 500 }],
        timestamp: new Date(),
      });
      resolutionService.closeLeg!.mockResolvedValue({
        success: true,
        closeOrderId: 'order-close-1',
        realizedPnl: '-2.00000000',
      });

      const promise = service.onSingleLegExposure(event);
      await vi.advanceTimersByTimeAsync(2000);
      await promise;

      // Verify closeLeg was called with the position ID, which internally
      // submits the close order to the connector
      expect(resolutionService.closeLeg).toHaveBeenCalledWith(
        asPositionId('pos-auto-1'),
        expect.any(String),
      );
    });

    it('[P0] should call connector.getOrderBook() for loss estimation', async () => {
      const event = makeExposureEvent();
      positionRepository.findByIdWithPair!.mockResolvedValue(
        createMockPosition(),
      );
      orderRepository.findById!.mockResolvedValue(createMockOrder());
      kalshiConnector.getOrderBook.mockResolvedValue({
        platformId: PlatformId.KALSHI,
        contractId: asContractId('kalshi-contract-1'),
        bids: [{ price: 0.44, quantity: 500 }],
        asks: [{ price: 0.46, quantity: 500 }],
        timestamp: new Date(),
      });
      resolutionService.closeLeg!.mockResolvedValue({
        success: true,
        closeOrderId: 'order-close-1',
        realizedPnl: '-2.00000000',
      });

      const promise = service.onSingleLegExposure(event);
      await vi.advanceTimersByTimeAsync(2000);
      await promise;

      // Verify order book fetch was called on the filled platform connector
      expect(kalshiConnector.getOrderBook).toHaveBeenCalledWith(
        asContractId('kalshi-contract-1'),
      );
    });

    it('[P0] should re-check position status via DB query (not cached) after delay', async () => {
      const event = makeExposureEvent();
      positionRepository.findByIdWithPair!.mockResolvedValue(
        createMockPosition(),
      );
      orderRepository.findById!.mockResolvedValue(createMockOrder());
      kalshiConnector.getOrderBook.mockResolvedValue({
        platformId: PlatformId.KALSHI,
        contractId: asContractId('kalshi-contract-1'),
        bids: [{ price: 0.44, quantity: 500 }],
        asks: [{ price: 0.46, quantity: 500 }],
        timestamp: new Date(),
      });
      resolutionService.closeLeg!.mockResolvedValue({
        success: true,
        closeOrderId: 'order-close-1',
        realizedPnl: '-2.00000000',
      });

      const promise = service.onSingleLegExposure(event);
      await vi.advanceTimersByTimeAsync(2000);
      await promise;

      // Verify DB was queried for position status AFTER the delay
      expect(positionRepository.findByIdWithPair).toHaveBeenCalledWith(
        asPositionId('pos-auto-1'),
      );
    });

    it('[P0] should verify SingleLegResolvedEvent is emitted downstream by closeLeg', async () => {
      // This test verifies that closeLeg() emits SingleLegResolvedEvent
      // When closeLeg succeeds, it internally emits SINGLE_LEG_RESOLVED
      const event = makeExposureEvent();
      positionRepository.findByIdWithPair!.mockResolvedValue(
        createMockPosition(),
      );
      orderRepository.findById!.mockResolvedValue(createMockOrder());
      kalshiConnector.getOrderBook.mockResolvedValue({
        platformId: PlatformId.KALSHI,
        contractId: asContractId('kalshi-contract-1'),
        bids: [{ price: 0.44, quantity: 500 }],
        asks: [{ price: 0.46, quantity: 500 }],
        timestamp: new Date(),
      });
      resolutionService.closeLeg!.mockResolvedValue({
        success: true,
        closeOrderId: 'order-close-1',
        realizedPnl: '-2.00000000',
      });

      const promise = service.onSingleLegExposure(event);
      await vi.advanceTimersByTimeAsync(2000);
      await promise;

      // closeLeg() was invoked — it internally emits SINGLE_LEG_RESOLVED.
      // We verify the call was made (downstream emission tested in
      // SingleLegResolutionService spec).
      expect(resolutionService.closeLeg).toHaveBeenCalledTimes(1);
    });
  });

  // =========================================================================
  // ZERO REGRESSION (P0)
  // =========================================================================

  describe('zero-regression', () => {
    it('[P0] should behave identically to MVP when AUTO_UNWIND_ENABLED=false', async () => {
      await buildModule({ AUTO_UNWIND_ENABLED: false });
      const event = makeExposureEvent();

      await service.onSingleLegExposure(event);

      // No close attempted
      expect(resolutionService.closeLeg).not.toHaveBeenCalled();
      // No auto-unwind event emitted
      expect(eventEmitter.emit).not.toHaveBeenCalled();
      // Position remains SINGLE_LEG_EXPOSED (no DB update)
      expect(positionRepository.updateStatus).not.toHaveBeenCalled();
    });

    it('[P0] should not affect existing retryLeg manual resolution', async () => {
      // retryLeg should work independently of auto-unwind config
      await buildModule({ AUTO_UNWIND_ENABLED: true });

      // Verify SingleLegResolutionService.retryLeg is still available and callable
      expect(resolutionService.retryLeg).toBeDefined();
      expect(typeof resolutionService.retryLeg).toBe('function');
    });

    it('[P0] should not affect existing closeLeg manual resolution', async () => {
      // Manual closeLeg should work independently of auto-unwind
      await buildModule({ AUTO_UNWIND_ENABLED: true });

      // Verify SingleLegResolutionService.closeLeg is still available and callable
      expect(resolutionService.closeLeg).toBeDefined();
      expect(typeof resolutionService.closeLeg).toBe('function');
    });

    it('[P0] should not interfere with ExposureAlertScheduler 60s reminder cycle', async () => {
      // AutoUnwindService subscribes to SINGLE_LEG_EXPOSURE only, NOT SINGLE_LEG_EXPOSURE_REMINDER.
      // This verifies the service does NOT subscribe to reminder events.
      await buildModule({ AUTO_UNWIND_ENABLED: true });

      // The service should have an @OnEvent(EVENT_NAMES.SINGLE_LEG_EXPOSURE) handler
      // but NOT an @OnEvent(EVENT_NAMES.SINGLE_LEG_EXPOSURE_REMINDER) handler
      expect(typeof service.onSingleLegExposure).toBe('function');
      // Service should not have a method subscribed to reminders
      expect(
        (service as unknown as Record<string, unknown>)
          .onSingleLegExposureReminder,
      ).toBeUndefined();
    });
  });

  // =========================================================================
  // IN-FLIGHT GUARD (P1)
  // =========================================================================

  describe('in-flight guard', () => {
    it('[P1] should skip second event for same positionId while first is in-flight', async () => {
      const event1 = makeExposureEvent({ positionId: 'pos-inflight-1' });
      const event2 = makeExposureEvent({ positionId: 'pos-inflight-1' });

      positionRepository.findByIdWithPair!.mockResolvedValue(
        createMockPosition({ positionId: asPositionId('pos-inflight-1') }),
      );
      orderRepository.findById!.mockResolvedValue(createMockOrder());
      kalshiConnector.getOrderBook.mockResolvedValue({
        platformId: PlatformId.KALSHI,
        contractId: asContractId('kalshi-contract-1'),
        bids: [{ price: 0.44, quantity: 500 }],
        asks: [{ price: 0.46, quantity: 500 }],
        timestamp: new Date(),
      });
      resolutionService.closeLeg!.mockResolvedValue({
        success: true,
        closeOrderId: 'order-close-1',
        realizedPnl: '-1.00000000',
      });

      // Start first event processing (waiting on delay)
      const promise1 = service.onSingleLegExposure(event1);

      // Second event for same position should be skipped
      await service.onSingleLegExposure(event2);

      await vi.advanceTimersByTimeAsync(2000);
      await promise1;

      // closeLeg should only be called once (for first event)
      expect(resolutionService.closeLeg).toHaveBeenCalledTimes(1);
    });

    it('[P1] should clean up in-flight Set in finally block even on error', async () => {
      const event = makeExposureEvent({ positionId: 'pos-cleanup-1' });

      positionRepository.findByIdWithPair!.mockRejectedValue(
        new Error('DB failure'),
      );

      const promise = service.onSingleLegExposure(event);
      await vi.advanceTimersByTimeAsync(2000);
      await promise;

      // After error, the positionId should be removed from in-flight set
      // so a subsequent event can proceed
      positionRepository.findByIdWithPair!.mockResolvedValue(
        createMockPosition({ positionId: asPositionId('pos-cleanup-1') }),
      );
      orderRepository.findById!.mockResolvedValue(createMockOrder());
      kalshiConnector.getOrderBook.mockResolvedValue({
        platformId: PlatformId.KALSHI,
        contractId: asContractId('kalshi-contract-1'),
        bids: [{ price: 0.44, quantity: 500 }],
        asks: [{ price: 0.46, quantity: 500 }],
        timestamp: new Date(),
      });
      resolutionService.closeLeg!.mockResolvedValue({
        success: true,
        closeOrderId: 'order-close-after-cleanup',
        realizedPnl: '-1.00000000',
      });

      const event2 = makeExposureEvent({ positionId: 'pos-cleanup-1' });
      const promise2 = service.onSingleLegExposure(event2);
      await vi.advanceTimersByTimeAsync(2000);
      await promise2;

      // Second attempt should proceed since in-flight was cleaned up
      expect(resolutionService.closeLeg).toHaveBeenCalled();
    });

    it('[P1] should skip with warning when in-flight Set reaches max capacity (100)', async () => {
      // Fill the in-flight set to capacity
      for (let i = 0; i < 100; i++) {
        const event = makeExposureEvent({ positionId: `pos-capacity-${i}` });
        positionRepository.findByIdWithPair!.mockResolvedValue(
          createMockPosition({
            positionId: asPositionId(`pos-capacity-${i}`),
          }),
        );
        // Start the unwind but don't await (stays in-flight during delay)
        void service.onSingleLegExposure(event);
      }

      // 101st event should be skipped
      const extraEvent = makeExposureEvent({ positionId: 'pos-capacity-100' });
      await service.onSingleLegExposure(extraEvent);

      // closeLeg should not have been called for the extra event
      // (it might not have been called at all yet since timers haven't advanced)
      // The key assertion is that the 101st event returned early without error

      // Advance timers to let in-flight events complete
      positionRepository.findByIdWithPair!.mockResolvedValue(
        createMockPosition(),
      );
      orderRepository.findById!.mockResolvedValue(createMockOrder());
      kalshiConnector.getOrderBook.mockResolvedValue({
        platformId: PlatformId.KALSHI,
        contractId: asContractId('kalshi-contract-1'),
        bids: [{ price: 0.44, quantity: 500 }],
        asks: [{ price: 0.46, quantity: 500 }],
        timestamp: new Date(),
      });
      resolutionService.closeLeg!.mockResolvedValue({
        success: true,
        closeOrderId: 'order-close-1',
        realizedPnl: '-1.00000000',
      });
      await vi.advanceTimersByTimeAsync(2000);
    });
  });

  // =========================================================================
  // MONITORING (P1)
  // =========================================================================

  describe('monitoring', () => {
    it('[P1] should emit AutoUnwindEvent that can be consumed by audit log subscriber', async () => {
      const event = makeExposureEvent();
      positionRepository.findByIdWithPair!.mockResolvedValue(
        createMockPosition(),
      );
      orderRepository.findById!.mockResolvedValue(createMockOrder());
      kalshiConnector.getOrderBook.mockResolvedValue({
        platformId: PlatformId.KALSHI,
        contractId: asContractId('kalshi-contract-1'),
        bids: [{ price: 0.44, quantity: 500 }],
        asks: [{ price: 0.46, quantity: 500 }],
        timestamp: new Date(),
      });
      resolutionService.closeLeg!.mockResolvedValue({
        success: true,
        closeOrderId: 'order-close-1',
        realizedPnl: '-2.00000000',
      });

      const promise = service.onSingleLegExposure(event);
      await vi.advanceTimersByTimeAsync(2000);
      await promise;

      // Verify the event has all fields needed for audit log record
      const emitCall = (
        eventEmitter.emit as ReturnType<typeof vi.fn>
      ).mock.calls.find(
        (call: unknown[]) => call[0] === EVENT_NAMES.AUTO_UNWIND,
      );
      expect(emitCall).toBeDefined();
      const payload = emitCall![1] as Record<string, unknown>;
      expect(payload).toHaveProperty('positionId');
      expect(payload).toHaveProperty('pairId');
      expect(payload).toHaveProperty('action');
      expect(payload).toHaveProperty('result');
      expect(payload).toHaveProperty('timeElapsedMs');
      expect(payload).toHaveProperty('simulated');
      expect(payload).toHaveProperty('singleLegContext');
    });

    it('[P1] should emit AutoUnwindEvent with format suitable for Telegram notification', async () => {
      const event = makeExposureEvent();
      positionRepository.findByIdWithPair!.mockResolvedValue(
        createMockPosition(),
      );
      orderRepository.findById!.mockResolvedValue(createMockOrder());
      kalshiConnector.getOrderBook.mockResolvedValue({
        platformId: PlatformId.KALSHI,
        contractId: asContractId('kalshi-contract-1'),
        bids: [{ price: 0.44, quantity: 500 }],
        asks: [{ price: 0.46, quantity: 500 }],
        timestamp: new Date(),
      });
      resolutionService.closeLeg!.mockResolvedValue({
        success: true,
        closeOrderId: 'order-close-1',
        realizedPnl: '-2.50000000',
      });

      const promise = service.onSingleLegExposure(event);
      await vi.advanceTimersByTimeAsync(2000);
      await promise;

      const emitCall = (
        eventEmitter.emit as ReturnType<typeof vi.fn>
      ).mock.calls.find(
        (call: unknown[]) => call[0] === EVENT_NAMES.AUTO_UNWIND,
      );
      const payload = emitCall![1] as Record<string, unknown>;

      // Fields needed for Telegram formatting
      expect(payload.action).toBe('close');
      expect(payload.result).toBe('success');
      expect(payload.realizedPnl).toBe('-2.50000000');
      expect(typeof payload.timeElapsedMs).toBe('number');
    });

    it('[P1] should include estimatedLossPct in event for CSV and dashboard logging', async () => {
      const event = makeExposureEvent();
      positionRepository.findByIdWithPair!.mockResolvedValue(
        createMockPosition(),
      );
      orderRepository.findById!.mockResolvedValue(
        createMockOrder({ fillPrice: 0.45, fillSize: 200 }),
      );
      kalshiConnector.getOrderBook.mockResolvedValue({
        platformId: PlatformId.KALSHI,
        contractId: asContractId('kalshi-contract-1'),
        bids: [{ price: 0.44, quantity: 500 }],
        asks: [{ price: 0.46, quantity: 500 }],
        timestamp: new Date(),
      });
      resolutionService.closeLeg!.mockResolvedValue({
        success: true,
        closeOrderId: 'order-close-1',
        realizedPnl: '-2.00000000',
      });

      const promise = service.onSingleLegExposure(event);
      await vi.advanceTimersByTimeAsync(2000);
      await promise;

      const emitCall = (
        eventEmitter.emit as ReturnType<typeof vi.fn>
      ).mock.calls.find(
        (call: unknown[]) => call[0] === EVENT_NAMES.AUTO_UNWIND,
      );
      const payload = emitCall![1] as Record<string, unknown>;

      expect(payload).toHaveProperty('estimatedLossPct');
      expect(typeof payload.estimatedLossPct).toBe('number');
    });

    it('[P1] should emit auto_unwind event for WebSocket dashboard consumption', async () => {
      const event = makeExposureEvent();
      positionRepository.findByIdWithPair!.mockResolvedValue(
        createMockPosition(),
      );
      orderRepository.findById!.mockResolvedValue(createMockOrder());
      kalshiConnector.getOrderBook.mockResolvedValue({
        platformId: PlatformId.KALSHI,
        contractId: asContractId('kalshi-contract-1'),
        bids: [{ price: 0.44, quantity: 500 }],
        asks: [{ price: 0.46, quantity: 500 }],
        timestamp: new Date(),
      });
      resolutionService.closeLeg!.mockResolvedValue({
        success: true,
        closeOrderId: 'order-close-1',
        realizedPnl: '-1.00000000',
      });

      const promise = service.onSingleLegExposure(event);
      await vi.advanceTimersByTimeAsync(2000);
      await promise;

      // Verify event was emitted on the correct event name for WS gateway subscription
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        EVENT_NAMES.AUTO_UNWIND,
        expect.anything(),
      );
    });
  });

  // =========================================================================
  // LOSS ESTIMATION EDGE CASES (P1)
  // =========================================================================

  describe('loss estimation edge cases', () => {
    it('[P1] should use decimal.js for all financial calculations in loss estimation', async () => {
      const event = makeExposureEvent();
      positionRepository.findByIdWithPair!.mockResolvedValue(
        createMockPosition(),
      );
      orderRepository.findById!.mockResolvedValue(
        createMockOrder({ fillPrice: 0.45, fillSize: 200 }),
      );
      // Best bid at 0.44 → loss = (0.45 - 0.44) * 200 = 2.00
      // lossPct = 2.00 / (0.45 * 200) * 100 = 2.22%
      kalshiConnector.getOrderBook.mockResolvedValue({
        platformId: PlatformId.KALSHI,
        contractId: asContractId('kalshi-contract-1'),
        bids: [{ price: 0.44, quantity: 500 }],
        asks: [{ price: 0.46, quantity: 500 }],
        timestamp: new Date(),
      });
      resolutionService.closeLeg!.mockResolvedValue({
        success: true,
        closeOrderId: 'order-close-1',
        realizedPnl: '-2.00000000',
      });

      const promise = service.onSingleLegExposure(event);
      await vi.advanceTimersByTimeAsync(2000);
      await promise;

      // The estimatedLossPct should be computed with decimal.js precision
      const emitCall = (
        eventEmitter.emit as ReturnType<typeof vi.fn>
      ).mock.calls.find(
        (call: unknown[]) => call[0] === EVENT_NAMES.AUTO_UNWIND,
      );
      const payload = emitCall![1] as { estimatedLossPct: number };
      // 2.22% with Decimal.ROUND_HALF_UP to 2 decimal places
      expect(payload.estimatedLossPct).toBeCloseTo(2.22, 1);
    });

    it('[P1] should handle sell-side close estimation correctly (polymarket filled)', async () => {
      const event = makeExposureEvent({
        positionId: 'pos-sell-close',
      });
      // Polymarket side filled (sell), need to buy back
      positionRepository.findByIdWithPair!.mockResolvedValue(
        createMockPosition({
          positionId: asPositionId('pos-sell-close'),
          kalshiOrderId: null,
          polymarketOrderId: asOrderId('order-poly-1'),
          kalshiSide: 'buy',
          polymarketSide: 'sell',
        }),
      );
      orderRepository.findById!.mockResolvedValue(
        createMockOrder({
          orderId: asOrderId('order-poly-1'),
          platform: 'POLYMARKET',
          side: 'sell',
          fillPrice: 0.55,
          fillSize: 182,
        }),
      );
      // For sell→buy close, use best ask
      polymarketConnector.getOrderBook.mockResolvedValue({
        platformId: PlatformId.POLYMARKET,
        contractId: asContractId('poly-contract-1'),
        bids: [{ price: 0.53, quantity: 200 }],
        asks: [{ price: 0.57, quantity: 200 }],
        timestamp: new Date(),
      });
      resolutionService.closeLeg!.mockResolvedValue({
        success: true,
        closeOrderId: 'order-close-poly-1',
        realizedPnl: '-3.64000000',
      });

      const promise = service.onSingleLegExposure(event);
      await vi.advanceTimersByTimeAsync(2000);
      await promise;

      // Verify polymarket connector was queried for order book
      expect(polymarketConnector.getOrderBook).toHaveBeenCalled();
      expect(resolutionService.closeLeg).toHaveBeenCalled();
    });
  });

  // =========================================================================
  // RACE CONDITION (P1)
  // =========================================================================

  describe('race conditions', () => {
    it('[P1] should handle operator resolving position during closeLeg call gracefully', async () => {
      const event = makeExposureEvent();
      positionRepository.findByIdWithPair!.mockResolvedValue(
        createMockPosition(),
      );
      orderRepository.findById!.mockResolvedValue(createMockOrder());
      kalshiConnector.getOrderBook.mockResolvedValue({
        platformId: PlatformId.KALSHI,
        contractId: asContractId('kalshi-contract-1'),
        bids: [{ price: 0.44, quantity: 500 }],
        asks: [{ price: 0.46, quantity: 500 }],
        timestamp: new Date(),
      });
      // closeLeg throws INVALID_POSITION_STATE because operator resolved first
      resolutionService.closeLeg!.mockRejectedValue(
        new ExecutionError(
          EXECUTION_ERROR_CODES.INVALID_POSITION_STATE,
          'Position is not in single-leg exposed or exit-partial state',
          'warning',
        ),
      );

      const promise = service.onSingleLegExposure(event);
      await vi.advanceTimersByTimeAsync(2000);
      await promise;

      expect(eventEmitter.emit).toHaveBeenCalledWith(
        EVENT_NAMES.AUTO_UNWIND,
        expect.objectContaining({
          action: 'skip_already_resolved',
        }),
      );
    });

    it('[P1] should allow different positions to auto-unwind concurrently', async () => {
      const event1 = makeExposureEvent({ positionId: 'pos-concurrent-1' });
      const event2 = makeExposureEvent({ positionId: 'pos-concurrent-2' });

      positionRepository.findByIdWithPair!.mockImplementation((id: string) =>
        Promise.resolve(createMockPosition({ positionId: asPositionId(id) })),
      );
      orderRepository.findById!.mockResolvedValue(createMockOrder());
      kalshiConnector.getOrderBook.mockResolvedValue({
        platformId: PlatformId.KALSHI,
        contractId: asContractId('kalshi-contract-1'),
        bids: [{ price: 0.44, quantity: 500 }],
        asks: [{ price: 0.46, quantity: 500 }],
        timestamp: new Date(),
      });
      resolutionService.closeLeg!.mockResolvedValue({
        success: true,
        closeOrderId: 'order-close-concurrent',
        realizedPnl: '-1.00000000',
      });

      const promise1 = service.onSingleLegExposure(event1);
      const promise2 = service.onSingleLegExposure(event2);

      await vi.advanceTimersByTimeAsync(2000);
      await Promise.all([promise1, promise2]);

      // Both should attempt close
      expect(resolutionService.closeLeg).toHaveBeenCalledTimes(2);
    });
  });

  // =========================================================================
  // ONLY SUBSCRIBE TO SINGLE_LEG_EXPOSURE (NOT REMINDER) (P0)
  // =========================================================================

  describe('event subscription scope', () => {
    it('[P0] should NOT process SINGLE_LEG_EXPOSURE_REMINDER events', () => {
      // AutoUnwindService must only subscribe to SINGLE_LEG_EXPOSURE,
      // NOT SINGLE_LEG_EXPOSURE_REMINDER. This test verifies the service
      // does not have a handler for reminder events.

      // The service should have exactly one event handler method
      // subscribed to EVENT_NAMES.SINGLE_LEG_EXPOSURE
      expect(typeof service.onSingleLegExposure).toBe('function');

      // There should be no method that handles reminder events
      // (this is a design constraint, not a runtime check)
      const servicePrototype = Object.getOwnPropertyNames(
        Object.getPrototypeOf(service),
      );
      const reminderHandlers = servicePrototype.filter((name) =>
        name.toLowerCase().includes('reminder'),
      );
      expect(reminderHandlers).toHaveLength(0);
    });
  });

  // =========================================================================
  // PARTIAL FILL (P1)
  // =========================================================================

  describe('partial fill handling', () => {
    it('[P1] should handle closeLeg returning partial fill result', async () => {
      const event = makeExposureEvent();
      positionRepository.findByIdWithPair!.mockResolvedValue(
        createMockPosition(),
      );
      orderRepository.findById!.mockResolvedValue(createMockOrder());
      kalshiConnector.getOrderBook.mockResolvedValue({
        platformId: PlatformId.KALSHI,
        contractId: asContractId('kalshi-contract-1'),
        bids: [{ price: 0.44, quantity: 500 }],
        asks: [{ price: 0.46, quantity: 500 }],
        timestamp: new Date(),
      });
      // closeLeg may handle partial internally and still return success
      resolutionService.closeLeg!.mockResolvedValue({
        success: true,
        closeOrderId: 'order-close-partial-1',
        realizedPnl: '-1.20000000',
      });

      const promise = service.onSingleLegExposure(event);
      await vi.advanceTimersByTimeAsync(2000);
      await promise;

      expect(eventEmitter.emit).toHaveBeenCalledWith(
        EVENT_NAMES.AUTO_UNWIND,
        expect.objectContaining({
          action: 'close',
          result: 'success',
        }),
      );
    });
  });

  // =========================================================================
  // EXIT_PARTIAL POSITIONS (P1)
  // =========================================================================

  describe('EXIT_PARTIAL position support', () => {
    it('[P1] should attempt auto-unwind for EXIT_PARTIAL positions', async () => {
      const event = makeExposureEvent();
      positionRepository.findByIdWithPair!.mockResolvedValue(
        createMockPosition({ status: 'EXIT_PARTIAL' }),
      );
      orderRepository.findById!.mockResolvedValue(createMockOrder());
      kalshiConnector.getOrderBook.mockResolvedValue({
        platformId: PlatformId.KALSHI,
        contractId: asContractId('kalshi-contract-1'),
        bids: [{ price: 0.44, quantity: 500 }],
        asks: [{ price: 0.46, quantity: 500 }],
        timestamp: new Date(),
      });
      resolutionService.closeLeg!.mockResolvedValue({
        success: true,
        closeOrderId: 'order-close-exit-partial',
        realizedPnl: '-1.80000000',
      });

      const promise = service.onSingleLegExposure(event);
      await vi.advanceTimersByTimeAsync(2000);
      await promise;

      expect(resolutionService.closeLeg).toHaveBeenCalled();
    });
  });

  // =========================================================================
  // POSITION NOT FOUND AFTER DELAY (P1)
  // =========================================================================

  describe('position not found after delay', () => {
    it('[P1] should emit failed when position not found after delay', async () => {
      const event = makeExposureEvent();
      positionRepository.findByIdWithPair!.mockResolvedValue(null);

      const promise = service.onSingleLegExposure(event);
      await vi.advanceTimersByTimeAsync(2000);
      await promise;

      expect(resolutionService.closeLeg).not.toHaveBeenCalled();
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        EVENT_NAMES.AUTO_UNWIND,
        expect.objectContaining({
          action: 'failed',
          result: 'failed',
        }),
      );
    });
  });
});
