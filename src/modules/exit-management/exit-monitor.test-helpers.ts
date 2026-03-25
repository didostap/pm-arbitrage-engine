import { vi } from 'vitest';
import { Test } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ConfigService } from '@nestjs/config';
import Decimal from 'decimal.js';
import { ExitMonitorService } from './exit-monitor.service';
import { ExitExecutionService } from './exit-execution.service';
import { ExitDataSourceService } from './exit-data-source.service';
import { ThresholdEvaluatorService } from './threshold-evaluator.service';
import { PositionRepository } from '../../persistence/repositories/position.repository';
import { OrderRepository } from '../../persistence/repositories/order.repository';
import { PrismaService } from '../../common/prisma.service';
import {
  KALSHI_CONNECTOR_TOKEN,
  POLYMARKET_CONNECTOR_TOKEN,
} from '../../connectors/connector.constants';
import { RISK_MANAGER_TOKEN } from '../risk-management/risk-management.constants';
import { PlatformId } from '../../common/types/platform.type';
import {
  asPositionId,
  asOrderId,
  asPairId,
  asContractId,
  asMatchId,
} from '../../common/types/branded.type';
import {
  createMockPlatformConnector,
  createMockRiskManager,
} from '../../test/mock-factories.js';

export function createMockPosition(overrides: Record<string, unknown> = {}) {
  return {
    positionId: asPositionId('pos-1'),
    pairId: asPairId('pair-1'),
    kalshiOrderId: asOrderId('order-kalshi-1'),
    polymarketOrderId: asOrderId('order-poly-1'),
    kalshiSide: 'buy',
    polymarketSide: 'sell',
    entryPrices: { kalshi: '0.62', polymarket: '0.65' },
    sizes: { kalshi: '100', polymarket: '100' },
    expectedEdge: new Decimal('0.03'),
    status: 'OPEN',
    pair: {
      matchId: asMatchId('pair-1'),
      kalshiContractId: asContractId('kalshi-contract-1'),
      polymarketContractId: asContractId('poly-contract-1'),
      polymarketClobTokenId: 'mock-clob-token-1',
      primaryLeg: 'kalshi',
      resolutionDate: null,
    },
    kalshiOrder: {
      orderId: asOrderId('order-kalshi-1'),
      platform: 'KALSHI',
      side: 'buy',
      price: new Decimal('0.62'),
      size: new Decimal('100'),
      fillPrice: new Decimal('0.62'),
      fillSize: new Decimal('100'),
      status: 'FILLED',
    },
    polymarketOrder: {
      orderId: asOrderId('order-poly-1'),
      platform: 'POLYMARKET',
      side: 'sell',
      price: new Decimal('0.65'),
      size: new Decimal('100'),
      fillPrice: new Decimal('0.65'),
      fillSize: new Decimal('100'),
      status: 'FILLED',
    },
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

export interface ExitMonitorTestContext {
  service: ExitMonitorService;
  exitExecutionService: ExitExecutionService;
  exitDataSourceService: ExitDataSourceService;
  positionRepository: Record<string, ReturnType<typeof vi.fn>>;
  orderRepository: Record<string, ReturnType<typeof vi.fn>>;
  kalshiConnector: ReturnType<typeof createMockPlatformConnector>;
  polymarketConnector: ReturnType<typeof createMockPlatformConnector>;
  riskManager: ReturnType<typeof createMockRiskManager>;
  eventEmitter: Record<string, ReturnType<typeof vi.fn>>;
  prisma: Record<string, Record<string, ReturnType<typeof vi.fn>>>;
  thresholdEvaluator: Record<string, ReturnType<typeof vi.fn>>;
}

export async function createExitMonitorTestModule(): Promise<ExitMonitorTestContext> {
  const positionRepository: ExitMonitorTestContext['positionRepository'] = {
    findByStatusWithOrders: vi.fn().mockResolvedValue([]),
    findByIdWithOrders: vi.fn().mockResolvedValue(createMockPosition()),
    updateStatus: vi.fn().mockResolvedValue({}),
    closePosition: vi.fn().mockResolvedValue({}),
    updateStatusWithAccumulatedPnl: vi.fn().mockResolvedValue({}),
  };

  const orderRepository: ExitMonitorTestContext['orderRepository'] = {
    create: vi.fn().mockImplementation((data: Record<string, unknown>) => ({
      orderId: asOrderId(`exit-order-${Date.now()}`),
      ...data,
    })),
    findById: vi.fn(),
    findByPairId: vi.fn().mockResolvedValue([]),
  };

  const kalshiConnector = createMockPlatformConnector(PlatformId.KALSHI, {
    getOrderBook: vi.fn().mockResolvedValue({
      platformId: PlatformId.KALSHI,
      contractId: asContractId('kalshi-contract-1'),
      bids: [{ price: 0.66, quantity: 500 }],
      asks: [{ price: 0.68, quantity: 500 }],
      timestamp: new Date(),
    }),
    getFeeSchedule: vi.fn().mockReturnValue({
      platformId: PlatformId.KALSHI,
      makerFeePercent: 0,
      takerFeePercent: 2,
      description: 'Kalshi fees',
    }),
    submitOrder: vi.fn().mockResolvedValue({
      orderId: asOrderId('kalshi-exit-1'),
      status: 'filled',
      filledPrice: 0.66,
      filledQuantity: 100,
      timestamp: new Date(),
    }),
  });

  const polymarketConnector = createMockPlatformConnector(
    PlatformId.POLYMARKET,
    {
      getOrderBook: vi.fn().mockResolvedValue({
        platformId: PlatformId.POLYMARKET,
        contractId: asContractId('poly-contract-1'),
        bids: [{ price: 0.62, quantity: 500 }],
        asks: [{ price: 0.64, quantity: 500 }],
        timestamp: new Date(),
      }),
      getFeeSchedule: vi.fn().mockReturnValue({
        platformId: PlatformId.POLYMARKET,
        makerFeePercent: 0,
        takerFeePercent: 1,
        description: 'Polymarket fees',
      }),
      submitOrder: vi.fn().mockResolvedValue({
        orderId: asOrderId('poly-exit-1'),
        status: 'filled',
        filledPrice: 0.62,
        filledQuantity: 100,
        timestamp: new Date(),
      }),
    },
  );

  const riskManager = createMockRiskManager();

  const eventEmitter: ExitMonitorTestContext['eventEmitter'] = {
    emit: vi.fn(),
  };

  const thresholdEvaluator: ExitMonitorTestContext['thresholdEvaluator'] = {
    evaluate: vi.fn().mockReturnValue({
      triggered: false,
      currentEdge: new Decimal('0.01'),
      currentPnl: new Decimal('0.50'),
      capturedEdgePercent: new Decimal('16.7'),
    }),
  };

  const prisma: ExitMonitorTestContext['prisma'] = {
    openPosition: {
      update: vi.fn().mockResolvedValue({}),
    },
  };

  const configService = {
    get: vi.fn().mockImplementation((key: string, defaultVal: unknown) => {
      if (key === 'WS_STALENESS_THRESHOLD_MS') return 60000;
      return defaultVal;
    }),
  };

  const module = await Test.createTestingModule({
    providers: [
      ExitMonitorService,
      ExitExecutionService,
      ExitDataSourceService,
      { provide: PositionRepository, useValue: positionRepository },
      { provide: OrderRepository, useValue: orderRepository },
      { provide: KALSHI_CONNECTOR_TOKEN, useValue: kalshiConnector },
      { provide: POLYMARKET_CONNECTOR_TOKEN, useValue: polymarketConnector },
      { provide: RISK_MANAGER_TOKEN, useValue: riskManager },
      { provide: EventEmitter2, useValue: eventEmitter },
      { provide: ThresholdEvaluatorService, useValue: thresholdEvaluator },
      { provide: PrismaService, useValue: prisma },
      { provide: ConfigService, useValue: configService },
    ],
  }).compile();

  const service = module.get(ExitMonitorService);
  const exitExecutionService = module.get(ExitExecutionService);
  const exitDataSourceService = module.get(ExitDataSourceService);

  return {
    service,
    exitExecutionService,
    exitDataSourceService,
    positionRepository,
    orderRepository,
    kalshiConnector,
    polymarketConnector,
    riskManager,
    eventEmitter,
    prisma,
    thresholdEvaluator,
  };
}

export function setupOrderCreateMock(
  orderRepository: ExitMonitorTestContext['orderRepository'],
): void {
  let orderCounter = 0;
  orderRepository.create!.mockImplementation(
    (data: Record<string, unknown>) => ({
      orderId: asOrderId(`exit-order-${++orderCounter}`),
      ...data,
    }),
  );
}
