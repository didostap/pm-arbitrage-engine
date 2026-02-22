import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ExposureAlertScheduler } from './exposure-alert-scheduler.service';
import { SingleLegResolutionService } from './single-leg-resolution.service';
import { PositionRepository } from '../../persistence/repositories/position.repository';
import { OrderRepository } from '../../persistence/repositories/order.repository';
import {
  KALSHI_CONNECTOR_TOKEN,
  POLYMARKET_CONNECTOR_TOKEN,
} from '../../connectors/connector.constants';
import { EVENT_NAMES } from '../../common/events/event-catalog';
import { PlatformId } from '../../common/types/platform.type';
import { createMockPlatformConnector } from '../../test/mock-factories.js';

vi.mock('../../common/services/correlation-context', () => ({
  getCorrelationId: () => 'test-correlation-id',
}));

function createMockPosition(overrides: Record<string, unknown> = {}) {
  return {
    positionId: 'pos-1',
    pairId: 'pair-1',
    kalshiOrderId: 'order-kalshi-1',
    polymarketOrderId: null,
    kalshiSide: 'buy',
    polymarketSide: 'sell',
    expectedEdge: 0.08,
    status: 'SINGLE_LEG_EXPOSED',
    entryPrices: { kalshi: '0.45', polymarket: '0.55' },
    sizes: { kalshi: '200', polymarket: '182' },
    pair: {
      matchId: 'pair-1',
      kalshiContractId: 'kalshi-contract-1',
      polymarketContractId: 'poly-contract-1',
    },
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe('ExposureAlertScheduler', () => {
  let scheduler: ExposureAlertScheduler;
  let positionRepository: Record<string, ReturnType<typeof vi.fn>>;
  let orderRepository: Record<string, ReturnType<typeof vi.fn>>;
  let kalshiConnector: ReturnType<typeof createMockPlatformConnector>;
  let polymarketConnector: ReturnType<typeof createMockPlatformConnector>;
  let eventEmitter: Record<string, ReturnType<typeof vi.fn>>;
  let resolutionService: Record<string, ReturnType<typeof vi.fn>>;

  const mockFilledOrder = {
    orderId: 'order-kalshi-1',
    platform: 'KALSHI',
    contractId: 'kalshi-contract-1',
    pairId: 'pair-1',
    side: 'buy',
    price: 0.45,
    size: 200,
    status: 'FILLED',
    fillPrice: 0.45,
    fillSize: 200,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const mockPnlResult = {
    pnlScenarios: {
      closeNowEstimate: '-2.00',
      retryAtCurrentPrice: '0.06',
      holdRiskAssessment: 'EXPOSED',
    },
    recommendedActions: ['Retry at current price'],
    currentPrices: {
      kalshi: { bestBid: 0.44, bestAsk: 0.46 },
      polymarket: { bestBid: 0.54, bestAsk: 0.56 },
    },
  };

  beforeEach(async () => {
    positionRepository = {
      findByStatus: vi.fn().mockResolvedValue([]),
      findByStatusWithPair: vi.fn().mockResolvedValue([]),
      findByIdWithPair: vi.fn(),
      findById: vi.fn(),
      findByPairId: vi.fn(),
      create: vi.fn(),
      updateStatus: vi.fn(),
      updateWithOrder: vi.fn(),
    };

    orderRepository = {
      findById: vi.fn().mockResolvedValue(mockFilledOrder),
      create: vi.fn(),
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

    eventEmitter = {
      emit: vi.fn(),
    };

    resolutionService = {
      buildPnlScenarios: vi.fn().mockResolvedValue(mockPnlResult),
      retryLeg: vi.fn(),
      closeLeg: vi.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ExposureAlertScheduler,
        { provide: PositionRepository, useValue: positionRepository },
        { provide: OrderRepository, useValue: orderRepository },
        { provide: KALSHI_CONNECTOR_TOKEN, useValue: kalshiConnector },
        { provide: POLYMARKET_CONNECTOR_TOKEN, useValue: polymarketConnector },
        { provide: EventEmitter2, useValue: eventEmitter },
        {
          provide: SingleLegResolutionService,
          useValue: resolutionService,
        },
      ],
    }).compile();

    scheduler = module.get(ExposureAlertScheduler);
  });

  it('should re-emit exposure events for exposed positions with fresh P&L', async () => {
    const position = createMockPosition();
    positionRepository.findByStatusWithPair!.mockResolvedValue([position]);

    await scheduler.checkExposedPositions();

    expect(resolutionService.buildPnlScenarios).toHaveBeenCalled();
    expect(eventEmitter.emit).toHaveBeenCalledWith(
      EVENT_NAMES.SINGLE_LEG_EXPOSURE_REMINDER,
      expect.objectContaining({
        positionId: 'pos-1',
        pairId: 'pair-1',
      }),
    );
  });

  it('should NOT emit SINGLE_LEG_EXPOSURE (only REMINDER)', async () => {
    const position = createMockPosition();
    positionRepository.findByStatusWithPair!.mockResolvedValue([position]);

    await scheduler.checkExposedPositions();

    expect(eventEmitter.emit).not.toHaveBeenCalledWith(
      EVENT_NAMES.SINGLE_LEG_EXPOSURE,
      expect.anything(),
    );
  });

  it('should skip re-emission when connector is disconnected', async () => {
    const position = createMockPosition();
    positionRepository.findByStatusWithPair!.mockResolvedValue([position]);
    kalshiConnector.getHealth.mockReturnValue({ status: 'disconnected' });

    await scheduler.checkExposedPositions();

    expect(eventEmitter.emit).not.toHaveBeenCalled();
  });

  it('should debounce re-emissions within 55 seconds', async () => {
    const position = createMockPosition();
    positionRepository.findByStatusWithPair!.mockResolvedValue([position]);

    // First call should emit
    await scheduler.checkExposedPositions();
    expect(eventEmitter.emit).toHaveBeenCalledTimes(1);

    // Second call immediately after should be debounced
    await scheduler.checkExposedPositions();
    expect(eventEmitter.emit).toHaveBeenCalledTimes(1); // Still 1
  });

  it('should isolate errors between positions', async () => {
    const pos1 = createMockPosition({ positionId: 'pos-1' });
    const pos2 = createMockPosition({ positionId: 'pos-2' });
    positionRepository.findByStatusWithPair!.mockResolvedValue([pos1, pos2]);

    // First position: order not found
    orderRepository.findById!.mockResolvedValueOnce(null);

    // Second position: normal
    orderRepository.findById!.mockResolvedValueOnce(mockFilledOrder);

    await scheduler.checkExposedPositions();

    // Second position should still get its alert
    expect(eventEmitter.emit).toHaveBeenCalledWith(
      EVENT_NAMES.SINGLE_LEG_EXPOSURE_REMINDER,
      expect.objectContaining({ positionId: 'pos-2' }),
    );
  });

  it('should not emit when no exposed positions exist', async () => {
    positionRepository.findByStatusWithPair!.mockResolvedValue([]);

    await scheduler.checkExposedPositions();

    expect(eventEmitter.emit).not.toHaveBeenCalled();
  });

  it('should use findByStatusWithPair to avoid N+1 queries', async () => {
    positionRepository.findByStatusWithPair!.mockResolvedValue([]);

    await scheduler.checkExposedPositions();

    expect(positionRepository.findByStatusWithPair).toHaveBeenCalledWith({
      in: ['SINGLE_LEG_EXPOSED', 'EXIT_PARTIAL'],
    });
    // Should NOT call findByIdWithPair separately
    expect(positionRepository.findByIdWithPair).not.toHaveBeenCalled();
  });

  it('should include EXIT_PARTIAL positions in re-emission', async () => {
    const exitPartialPosition = createMockPosition({
      positionId: 'pos-exit-partial',
      status: 'EXIT_PARTIAL',
    });
    positionRepository.findByStatusWithPair!.mockResolvedValue([
      exitPartialPosition,
    ]);

    await scheduler.checkExposedPositions();

    expect(eventEmitter.emit).toHaveBeenCalledWith(
      EVENT_NAMES.SINGLE_LEG_EXPOSURE_REMINDER,
      expect.objectContaining({
        positionId: 'pos-exit-partial',
      }),
    );
  });
});
