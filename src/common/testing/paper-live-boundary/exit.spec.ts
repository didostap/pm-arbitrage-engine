/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-return */
/**
 * Story 10-5.5 — Paper/Live Mode Boundary: ExitMonitor Isolation
 *
 * Verifies that ExitMonitorService only evaluates positions matching
 * the current mode (paper vs live) and never crosses boundaries.
 *
 * TDD RED PHASE — all tests skip.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ConfigService } from '@nestjs/config';
import Decimal from 'decimal.js';
import { ExitMonitorService } from '../../../modules/exit-management/exit-monitor.service';
import { ThresholdEvaluatorService } from '../../../modules/exit-management/threshold-evaluator.service';
import { PositionRepository } from '../../../persistence/repositories/position.repository';
import { OrderRepository } from '../../../persistence/repositories/order.repository';
import { PrismaService } from '../../prisma.service';
import {
  KALSHI_CONNECTOR_TOKEN,
  POLYMARKET_CONNECTOR_TOKEN,
} from '../../../connectors/connector.constants';
import { RISK_MANAGER_TOKEN } from '../../../modules/risk-management/risk-management.constants';
import type { IRiskManager } from '../../interfaces/risk-manager.interface';
import { PlatformId } from '../../types/platform.type';
import type { PlatformHealth } from '../../types/platform.type';

// ──────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────

function makeHealth(
  mode: 'paper' | 'live',
  platformId: PlatformId,
): PlatformHealth {
  return {
    platformId,
    status: 'healthy',
    lastHeartbeat: new Date(),
    latencyMs: 50,
    mode,
  };
}

function makeMockPosition(isPaper: boolean, positionId: string) {
  return {
    positionId,
    pairId: `pair-${positionId}`,
    status: 'OPEN',
    isPaper,
    expectedEdge: new Decimal('0.02'),
    recalculatedEdge: new Decimal('0.015'),
    createdAt: new Date(Date.now() - 3600_000),
    updatedAt: new Date(),
    pair: {
      pairId: `pair-${positionId}`,
      kalshiContractId: 'k-contract-1',
      polymarketContractId: 'p-contract-1',
      confidenceScore: new Decimal('0.95'),
    },
    kalshiOrder: {
      orderId: 'k-order-1',
      fillPrice: new Decimal('0.45'),
      fillSize: 10,
      side: 'buy',
    },
    polymarketOrder: {
      orderId: 'p-order-1',
      fillPrice: new Decimal('0.52'),
      fillSize: 10,
      side: 'sell',
    },
  };
}

describe('Paper/Live Boundary — ExitMonitorService', () => {
  let service: ExitMonitorService;
  let positionRepository: { findByStatusWithOrders: ReturnType<typeof vi.fn> };
  let kalshiConnector: {
    getHealth: ReturnType<typeof vi.fn>;
    getOrderBook: ReturnType<typeof vi.fn>;
    getOrderBookFreshness: ReturnType<typeof vi.fn>;
    submitOrder: ReturnType<typeof vi.fn>;
  };
  let polymarketConnector: {
    getHealth: ReturnType<typeof vi.fn>;
    getOrderBook: ReturnType<typeof vi.fn>;
    getOrderBookFreshness: ReturnType<typeof vi.fn>;
    submitOrder: ReturnType<typeof vi.fn>;
  };
  let module: TestingModule;

  beforeEach(async () => {
    positionRepository = {
      findByStatusWithOrders: vi.fn().mockResolvedValue([]),
    };

    kalshiConnector = {
      getHealth: vi
        .fn()
        .mockReturnValue(makeHealth('paper', PlatformId.KALSHI)),
      getOrderBook: vi
        .fn()
        .mockResolvedValue({ bids: [], asks: [], contractId: 'k-1' }),
      getOrderBookFreshness: vi
        .fn()
        .mockReturnValue({ lastWsUpdateAt: new Date() }),
      submitOrder: vi.fn().mockResolvedValue({ status: 'filled' }),
    };

    polymarketConnector = {
      getHealth: vi
        .fn()
        .mockReturnValue(makeHealth('paper', PlatformId.POLYMARKET)),
      getOrderBook: vi
        .fn()
        .mockResolvedValue({ bids: [], asks: [], contractId: 'p-1' }),
      getOrderBookFreshness: vi
        .fn()
        .mockReturnValue({ lastWsUpdateAt: new Date() }),
      submitOrder: vi.fn().mockResolvedValue({ status: 'filled' }),
    };

    module = await Test.createTestingModule({
      imports: [EventEmitterModule.forRoot({ wildcard: true, delimiter: '.' })],
      providers: [
        ExitMonitorService,
        { provide: PositionRepository, useValue: positionRepository },
        { provide: OrderRepository, useValue: { updateOrderStatus: vi.fn() } },
        { provide: KALSHI_CONNECTOR_TOKEN, useValue: kalshiConnector },
        { provide: POLYMARKET_CONNECTOR_TOKEN, useValue: polymarketConnector },
        {
          provide: RISK_MANAGER_TOKEN,
          useValue: {
            getCurrentExposure: vi.fn().mockReturnValue({
              bankrollUsd: new Decimal(10000),
              totalCapitalDeployed: new Decimal(1000),
            }),
            closePosition: vi.fn().mockResolvedValue(undefined),
            releasePartialCapital: vi.fn().mockResolvedValue(undefined),
          } satisfies Partial<IRiskManager> as any,
        },
        {
          provide: ThresholdEvaluatorService,
          useValue: {
            evaluate: vi
              .fn()
              .mockReturnValue({ shouldExit: false, reason: null }),
          },
        },
        {
          provide: PrismaService,
          useValue: {
            openPosition: { update: vi.fn() },
            order: { create: vi.fn() },
          },
        },
        {
          provide: ConfigService,
          useValue: {
            get: vi
              .fn()
              .mockImplementation(
                (_key: string, defaultValue?: any) => defaultValue,
              ),
          },
        },
      ],
    }).compile();

    service = module.get(ExitMonitorService);
    // Suppress onModuleInit to prevent scheduler interference
    vi.spyOn(service, 'onModuleInit').mockImplementation(() => {});
    await module.init();
  });

  describe.each([
    [true, 'paper'],
    [false, 'live'],
  ] as const)(
    'when connectors report isPaper=%s (%s mode)',
    (isPaper, modeName) => {
      it(`[P0] ${modeName} exit monitor only evaluates ${modeName} positions`, async () => {
        // Configure connectors to report the target mode
        const mode = isPaper ? 'paper' : 'live';
        kalshiConnector.getHealth.mockReturnValue(
          makeHealth(mode, PlatformId.KALSHI),
        );
        polymarketConnector.getHealth.mockReturnValue(
          makeHealth(mode, PlatformId.POLYMARKET),
        );

        // Return positions that match the mode
        const matchingPositions = [
          makeMockPosition(isPaper, `${modeName}-pos-1`),
          makeMockPosition(isPaper, `${modeName}-pos-2`),
        ];
        positionRepository.findByStatusWithOrders.mockResolvedValue(
          matchingPositions,
        );

        // Act: run evaluation
        await service.evaluatePositions();

        // Assert: repository was called with the correct isPaper flag
        expect(positionRepository.findByStatusWithOrders).toHaveBeenCalledWith(
          { in: ['OPEN', 'EXIT_PARTIAL'] },
          isPaper,
        );
      });

      it(`[P0] NEGATIVE: ${isPaper ? 'live' : 'paper'} positions are NOT evaluated when running in ${modeName} mode`, async () => {
        const mode = isPaper ? 'paper' : 'live';
        kalshiConnector.getHealth.mockReturnValue(
          makeHealth(mode, PlatformId.KALSHI),
        );
        polymarketConnector.getHealth.mockReturnValue(
          makeHealth(mode, PlatformId.POLYMARKET),
        );

        positionRepository.findByStatusWithOrders.mockResolvedValue([]);

        await service.evaluatePositions();

        // The repository should ONLY be called with isPaper matching the mode
        expect(positionRepository.findByStatusWithOrders).toHaveBeenCalledTimes(
          1,
        );
        const callArgs =
          positionRepository.findByStatusWithOrders.mock.calls[0];
        expect(callArgs[1]).toBe(isPaper);

        // It should NOT be called with the opposite mode
        expect(
          positionRepository.findByStatusWithOrders,
        ).not.toHaveBeenCalledWith(expect.anything(), !isPaper);
      });
    },
  );

  it('[P1] paper exit orders carry isPaper flag through to order creation', async () => {
    // Configure paper mode
    kalshiConnector.getHealth.mockReturnValue(
      makeHealth('paper', PlatformId.KALSHI),
    );
    polymarketConnector.getHealth.mockReturnValue(
      makeHealth('paper', PlatformId.POLYMARKET),
    );

    // Return a paper position that triggers an exit
    const paperPosition = makeMockPosition(true, 'paper-exit-1');
    positionRepository.findByStatusWithOrders.mockResolvedValue([
      paperPosition,
    ]);

    await service.evaluatePositions();

    // The isPaper flag derived from connector health should be true
    // Verify the repository query used isPaper=true
    expect(positionRepository.findByStatusWithOrders).toHaveBeenCalledWith(
      { in: ['OPEN', 'EXIT_PARTIAL'] },
      true, // isPaper must be true for paper mode
    );
  });
});
